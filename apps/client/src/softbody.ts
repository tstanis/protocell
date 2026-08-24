/**
 * The pressurized soft-body membrane. SPEC.md §11.6, serving §11.5.
 *
 * §11.6 names this exactly: "a ring of points joined by springs with an outward pressure
 * force holding a target area. Pressure target = volume; spring stiffness = membrane
 * tension; underdamped area-constrained motion IS the 'oscillate while maintaining
 * volume' wobble."
 *
 * ── Why this replaced what was here ──────────────────────────────────────────
 * The membrane had been drawn as an oozing analytic curve, then — while fixing a genuine
 * §2.1 violation, where the drawn ring sat somewhere the real membrane tiles were not —
 * it became a ring of axis-aligned squares stamped straight from the tile list. Correct,
 * and completely rigid. §11.5's whole visual language rests on "motion means alive;
 * stillness means death", so a membrane that cannot move says the cell is dead.
 *
 * Both constraints hold here. The soft-body's REST SHAPE is built from the real membrane
 * tiles, so it sits where the membrane actually is; the ooze is a bounded, zero-mean
 * perturbation around that rest shape, and the pressure term drives enclosed area toward
 * the volume the simulation reports. The costume moves without ever claiming a different
 * volume or a different position than the truth it was sent.
 *
 * No DOM in this file — it is pure geometry, so it can be tested headlessly like the sim.
 */

export interface SoftBodyState {
  /** Enclosed area the pressure term drives toward, in px². From the sim's volume. */
  targetArea: number;
  /** §7.3's master variable, 0..1. Stiffens the springs and sharpens the quiver. */
  tension: number;
  /** §13.2's health. Scales all motion — at zero the membrane stills (§11.5). */
  health: number;
  /** §11.7: slow the ooze to a barely-there breath. Must NOT freeze it. */
  /** Set once the cell has burst; the ring goes slack and stops holding its area. */
  lysed: boolean;
  /**
   * The cell's velocity through the world, in canvas px/s (§11.6a).
   *
   * The cell is pinned to the centre of the view, so swimming has no visual signature of
   * its own — §10A.7 already had to add drifting motes to the medium just to say that
   * anything was happening. A body moving through fluid should also deform: the leading
   * edge flattens against the water it is pushing, the trailing edge bulges, and the
   * shear sheds ripples down the sides. That is the second half of making motion legible,
   * and it is free — the shape is already a soft body.
   */
  vx: number;
  vy: number;
}

interface Point {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Rest position, from the real membrane tiles. */
  rx: number;
  ry: number;
  /** Angle around the centroid, used for the ambient forcing. */
  theta: number;
}

/**
 * Tuned for §11.5's brief: "squishy, viscous, constantly and gently oozing — lava-lamp /
 * jellyfish, slow to start and stop, damped, never snappy, low resting amplitude (so
 * stress reads as a departure from calm)."
 *
 * Low stiffness and moderate damping give the slow start/stop; the ambient term keeps it
 * moving at rest so it never settles into a dead circle.
 */
const PRESSURE_K = 2600; // px/s² per unit of relative area error
const SPRING_K = 90; // neighbour spacing, keeps the ring from tangling
const ANCHOR_K = 21; // pull toward the true membrane ring — this is the §2.1 leash
const DAMPING = 2.6; // 1/s. Underdamped on purpose: it should overshoot a little.
const AMBIENT = 104; // px/s² forcing at full health
/** Hard cap on the OOZE, as a fraction of cell radius — bounded around the breathing shape. */
/**
 * Drag and ripple strength, in px/s² (§11.6a). Both scale with sqrt(speed) so the shape
 * responds quickly at a crawl and then saturates, rather than deforming without limit.
 * Capped, because past the leash the membrane just pins and the extra force does nothing
 * but stiffen it.
 */
const DRAG_K = 150;
const DRAG_MAX = 420;
const RIPPLE_K = 90;
const RIPPLE_MAX = 240;

const MAX_OFFSET = 0.13;
/**
 * Ceiling on the breathing scale. §7.4 lyses at 30% radius stretch, so 1.45 leaves
 * headroom without letting a runaway target throw the ring off the canvas.
 */
const MAX_SCALE = 1.45;

export class SoftBody {
  readonly points: Point[] = [];
  private cx = 0;
  private cy = 0;
  private radius = 1;
  private t = 0;
  /**
   * Uniform breathing scale, tracking √(volume / restArea).
   *
   * The membrane's TILES do not move — volume is deliberately decoupled from tile count
   * until re-tiling exists (§3.6) — but §7.5 requires the cell to "visibly swell as solute
   * accumulates", and at rupture that is a 30% stretch. Bounding the drawn shape to the
   * tile ring would mute the single most important warning in the intro.
   *
   * So the two motions are separated: this uniform scale carries the swelling and is an
   * honest function of the volume the simulation reports, while the ooze is a bounded,
   * zero-mean perturbation AROUND the scaled shape. Nothing that resolves a click depends
   * on the drawn position — the client snaps to real membrane tiles — so the costume can
   * breathe without the interaction losing its footing.
   */
  private scale = 1;

  /**
   * Build the rest ring from the ACTUAL membrane tiles. Ordering by angle around the
   * centroid and resampling to a fixed count gives an evenly spaced loop, which the
   * spring term needs, without inventing a shape the simulation did not describe.
   */
  constructor(tileCentres: Array<{ x: number; y: number }>, count = 96) {
    if (tileCentres.length < 3) throw new RangeError('need at least 3 membrane tiles');

    for (const p of tileCentres) {
      this.cx += p.x;
      this.cy += p.y;
    }
    this.cx /= tileCentres.length;
    this.cy /= tileCentres.length;

    const byAngle = tileCentres
      .map((p) => ({
        a: Math.atan2(p.y - this.cy, p.x - this.cx),
        r: Math.hypot(p.x - this.cx, p.y - this.cy),
      }))
      .sort((u, v) => u.a - v.a);

    this.radius = byAngle.reduce((s, p) => s + p.r, 0) / byAngle.length;

    // Resample to `count` evenly spaced angles, taking the mean radius of the real tiles
    // nearest each one. The tile ring is jagged at lattice resolution; this smooths it
    // without moving it.
    for (let i = 0; i < count; i++) {
      const a = -Math.PI + (i / count) * 2 * Math.PI;
      let sum = 0;
      let n = 0;
      for (const p of byAngle) {
        let d = Math.abs(p.a - a);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d < Math.PI / count) {
          sum += p.r;
          n++;
        }
      }
      const r = n > 0 ? sum / n : this.radius;
      const x = this.cx + Math.cos(a) * r;
      const y = this.cy + Math.sin(a) * r;
      this.points.push({ x, y, vx: 0, vy: 0, rx: x, ry: y, theta: a });
    }
  }

  /** Shoelace area of the current loop, in px². */
  area(): number {
    let a = 0;
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const p = this.points[i]!;
      const q = this.points[(i + 1) % n]!;
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  /** Area of the undisturbed rest ring — what the tiles alone enclose. */
  restArea(): number {
    let a = 0;
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const p = this.points[i]!;
      const q = this.points[(i + 1) % n]!;
      a += p.rx * q.ry - q.rx * p.ry;
    }
    return Math.abs(a) / 2;
  }

  /**
   * Advance the ring. Sub-stepped for the same reason the sim is (§3.3): an explicit
   * spring integrator with a stiff pressure term will happily explode on a long frame.
   */
  step(dt: number, s: SoftBodyState): void {
    const sub = 4;
    const h = Math.min(dt, 0.05) / sub;
    for (let k = 0; k < sub; k++) this.substep(h, s);
    this.t += Math.min(dt, 0.05);
  }

  /** The point's anchor, after breathing — this is what the ooze oscillates around. */
  private anchor(p: Point): { x: number; y: number } {
    return {
      x: this.cx + (p.rx - this.cx) * this.scale,
      y: this.cy + (p.ry - this.cy) * this.scale,
    };
  }

  private substep(h: number, s: SoftBodyState): void {
    const n = this.points.length;
    const area = this.area();

    // Ease the breathing scale toward the target rather than snapping — §11.5's "slow to
    // start and stop, damped, never snappy" applies to swelling as much as to the ooze.
    const rest = this.restArea();
    const want = s.lysed
      ? this.scale
      : Math.min(MAX_SCALE, Math.sqrt(Math.max(0.01, s.targetArea / Math.max(1, rest))));
    this.scale += (want - this.scale) * Math.min(1, h * 2.5);

    // §11.5: on death everything stills and the membrane slackens. §11.7
    // must NOT freeze — freezing is what death looks like in this visual language — so it
    // gets a barely-there breath instead of nothing.
    const motion = s.lysed ? 0.05 : 1;
    const vigour = motion * (0.25 + 0.75 * s.health);

    // §11.6: "spring stiffness = membrane tension". Taut membranes resist deformation and
    // quiver at higher frequency; slack ones roll.
    const springK = SPRING_K * (1 + 2.2 * s.tension);
    // Slack membranes ROLL; taut ones only quiver. The tension term used to scale this by
    // (1 - 0.45·tension), which left a relaxed cell moving about 9 px on a 200 px radius —
    // under 5%, which reads as a still picture. A slack membrane should be visibly alive.
    const slack = 1 - Math.min(1, s.tension);
    const ambientAmp = AMBIENT * vigour * (0.35 + 1.45 * slack);
    const quiver = s.tension * 16 * vigour;

    // ── Motion: drag and ripples (§11.6a) ────────────────────────────────────
    const speed = Math.hypot(s.vx, s.vy);
    const moving = speed > 0.5;
    const ux = moving ? s.vx / speed : 0;
    const uy = moving ? s.vy / speed : 0;
    // Sub-linear in speed so a fast cell deforms noticeably without turning into a comet.
    const dragAmp = moving ? Math.min(DRAG_MAX, DRAG_K * Math.sqrt(speed)) * vigour : 0;
    const rippleAmp = moving ? Math.min(RIPPLE_MAX, RIPPLE_K * Math.sqrt(speed)) * vigour : 0;

    // A slack, burst husk stops holding its area at all.
    const pressureK = s.lysed ? PRESSURE_K * 0.05 : PRESSURE_K;
    const areaErr = (s.targetArea - area) / Math.max(1, s.targetArea);

    // Rest spacing along the loop, so the spring term equalises rather than shrinks.
    let restLen = 0;
    for (let i = 0; i < n; i++) {
      const p = this.points[i]!;
      const q = this.points[(i + 1) % n]!;
      restLen += Math.hypot(q.rx - p.rx, q.ry - p.ry);
    }
    restLen /= n;

    for (let i = 0; i < n; i++) {
      const p = this.points[i]!;
      const prev = this.points[(i - 1 + n) % n]!;
      const next = this.points[(i + 1) % n]!;

      // Outward normal from the local tangent.
      let nx = next.y - prev.y;
      let ny = -(next.x - prev.x);
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;

      let fx = 0;
      let fy = 0;

      // Pressure: push out (or pull in) until enclosed area matches the sim's volume.
      fx += nx * pressureK * areaErr;
      fy += ny * pressureK * areaErr;

      // Neighbour springs, both sides.
      for (const q of [prev, next]) {
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = springK * (d - restLen);
        fx += (dx / d) * f;
        fy += (dy / d) * f;
      }

      // Anchor to the (breathing) membrane shape. This is the §2.1 leash: the costume
      // oozes around where the simulation says the membrane is, and cannot wander off it.
      const anc = this.anchor(p);
      fx += (anc.x - p.x) * ANCHOR_K;
      fy += (anc.y - p.y) * ANCHOR_K;

      // Ambient forcing — the ooze itself. Same harmonic form as §11.5's `memR`, applied
      // as a FORCE along the normal rather than as a position, so the result is damped and
      // laggy ("slow to start and stop") instead of kinematically exact.
      //
      // Zero-mean in theta: the three harmonics have distinct non-zero integer
      // frequencies, so they add no net outward push and therefore no net area. The wobble
      // is shape-only, exactly as §11.5 requires, and enclosed area stays the simulation's.
      const th = p.theta;
      const amb =
        Math.sin(3 * th + 0.7 * this.t) * 0.9 +
        Math.sin(5 * th - 0.5 * this.t) * 0.6 +
        Math.sin(2 * th + 1.1 * this.t) * 0.4;
      const trem = Math.sin(9 * th + 7 * this.t) * quiver;
      fx += nx * (amb * ambientAmp + trem);
      fy += ny * (amb * ambientAmp + trem);

      if (moving) {
        // DRAG. A uniform force opposing travel, applied to every node alike. Because the
        // anchors hold the ring in place, a uniform push does not translate the shape — it
        // offsets it against its own leash, flattening the leading edge and bulging the
        // trailing one. Uniform also means it adds no area: this deforms, it does not
        // inflate, which keeps §11.5's area guarantee intact.
        fx -= ux * dragAmp;
        fy -= uy * dragAmp;

        // RIPPLES shed down the flanks. `facing` is +1 at the nose, -1 at the tail, so
        // `1 - facing²` peaks on the sides where the shear actually is. The wave travels
        // backwards along the body, and its normal displacement is zero-mean around the
        // ring for the same reason the ambient term is — distinct integer harmonics.
        const facing = nx * ux + ny * uy;
        const flank = 1 - facing * facing;
        const phase = Math.atan2(ny, nx) - Math.atan2(uy, ux);
        const wave = Math.sin(4 * phase + 9 * this.t) * flank;
        fx += nx * wave * rippleAmp;
        fy += ny * wave * rippleAmp;
      }

      p.vx += fx * h;
      p.vy += fy * h;
      p.vx -= p.vx * DAMPING * h;
      p.vy -= p.vy * DAMPING * h;
      p.x += p.vx * h;
      p.y += p.vy * h;

      // Hard leash. Under normal forces this never binds; if the integrator is ever
      // pushed somewhere strange the failure stays bounded and on-model rather than
      // spraying the ring across the canvas.
      const ox = p.x - anc.x;
      const oy = p.y - anc.y;
      const off = Math.hypot(ox, oy);
      const max = this.radius * MAX_OFFSET;
      if (off > max) {
        p.x = anc.x + (ox / off) * max;
        p.y = anc.y + (oy / off) * max;
        p.vx *= 0.4;
        p.vy *= 0.4;
      }
    }
  }

  /** Trace the loop into a path, smoothed with quadratic midpoints so it reads as fluid. */
  trace(ctx: { moveTo(x: number, y: number): void; quadraticCurveTo(a: number, b: number, c: number, d: number): void; closePath(): void }): void {
    const n = this.points.length;
    const first = this.points[0]!;
    const last = this.points[n - 1]!;
    ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
    for (let i = 0; i < n; i++) {
      const p = this.points[i]!;
      const q = this.points[(i + 1) % n]!;
      ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
    }
    ctx.closePath();
  }

  /**
   * Where a given world point currently sits on the oozing ring. Used so transporter
   * markers ride the membrane instead of floating at fixed lattice coordinates while the
   * membrane moves out from under them.
   */
  displaced(x: number, y: number): { x: number; y: number } {
    const a = Math.atan2(y - this.cy, x - this.cx);
    const n = this.points.length;
    let idx = Math.round(((a + Math.PI) / (2 * Math.PI)) * n) % n;
    if (idx < 0) idx += n;
    const p = this.points[idx]!;
    const anc = this.anchor(p);
    // Carry BOTH motions: the breathing scale and the ooze offset, so a marker stays
    // welded to the piece of membrane it was seated in.
    return { x: this.cx + (x - this.cx) * this.scale + (p.x - anc.x),
             y: this.cy + (y - this.cy) * this.scale + (p.y - anc.y) };
  }

  /**
   * Rescale every cached px position when the zoom changes.
   *
   * World → px is a pure multiply by tilePx, so a zoom change is a uniform scale about
   * the origin. Doing it in place preserves velocities and phase; REBUILDING the body
   * instead — which is what happened first — resets every point to rest, so the membrane
   * visibly snapped flat on each wheel notch and had to re-establish its ooze.
   */
  rescale(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
    this.cx *= factor;
    this.cy *= factor;
    this.radius *= factor;
    for (const p of this.points) {
      p.x *= factor;
      p.y *= factor;
      p.rx *= factor;
      p.ry *= factor;
      p.vx *= factor;
      p.vy *= factor;
    }
  }

  /** Current breathing scale, for callers that need to place things on the ring. */
  get breathing(): number {
    return this.scale;
  }
}
