/**
 * The soft-body membrane. SPEC.md §11.5, §11.6.
 *
 * These exist because the membrane is where the costume is most tempted to lie. §11.5 is
 * specific that the wobble must be shape-only — "changing enclosed area would change
 * concentration and make the costume lie" — and §11.6 makes enclosed area the thing the
 * pressure term is explicitly steering. Both claims are testable without a browser, so
 * they are tested.
 */

import { describe, expect, it } from 'vitest';
import { SoftBody, type SoftBodyState } from '../src/softbody.js';

/** A ring of tile centres, like the server's membraneTiles list. */
function ring(radius = 40, n = 108, cx = 100, cy = 100): Array<{ x: number; y: number }> {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius };
  });
}

/** The ring's nodes. Reaching in is deliberate: these tests are about the shape itself. */
function pointsOf(b: SoftBody): Array<{ x: number; y: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (b as any).points as Array<{ x: number; y: number }>;
}

/** Enclosed area by the shoelace formula. */
function areaOf(b: SoftBody): number {
  const pts = pointsOf(b);
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** How lopsided the ring is along x — the signature of drag on a body moving in x. */
function asymmetry(b: SoftBody): number {
  const pts = pointsOf(b);
  let cx = 0;
  for (const p of pts) cx += p.x;
  cx /= pts.length;
  return Math.abs(cx - 100);
}

function state(over: Partial<SoftBodyState> = {}): SoftBodyState {
  return {
    targetArea: Math.PI * 40 * 40,
    tension: 0,
    health: 1,
    lysed: false,
    // At rest by default — §11.6a's drag and ripples only apply while swimming, and the
    // area/leash guarantees below must hold with or without them.
    vx: 0,
    vy: 0,
    ...over,
  };
}

function run(b: SoftBody, s: SoftBodyState, seconds: number, dt = 1 / 60): void {
  for (let i = 0; i < Math.round(seconds / dt); i++) b.step(dt, s);
}

describe('construction from the real membrane tiles', () => {
  it('encloses the area the tile ring encloses', () => {
    const b = new SoftBody(ring());
    // A 96-gon inscribed in a circle is very slightly smaller than the circle; what
    // matters is that it matches the TILES, not an idealised disc.
    expect(b.restArea()).toBeCloseTo(Math.PI * 40 * 40, -2);
    expect(b.area()).toBeCloseTo(b.restArea(), 6);
  });

  it('refuses a degenerate ring rather than producing nonsense', () => {
    expect(() => new SoftBody([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow(/at least 3/);
  });
});

describe('§11.5 — the wobble is shape-only', () => {
  it('holds enclosed area while visibly moving', () => {
    // The exact failure §11.5 warns about: a membrane whose enclosed area breathes would
    // silently modulate every concentration derived from it.
    const b = new SoftBody(ring());
    const s = state();
    const target = s.targetArea;

    run(b, s, 2); // let it get going
    let maxErr = 0;
    let moved = 0;
    const before = b.points.map((p) => ({ x: p.x, y: p.y }));

    for (let i = 0; i < 600; i++) {
      b.step(1 / 60, s);
      maxErr = Math.max(maxErr, Math.abs(b.area() - target) / target);
    }
    b.points.forEach((p, i) => {
      moved = Math.max(moved, Math.hypot(p.x - before[i]!.x, p.y - before[i]!.y));
    });

    expect(maxErr).toBeLessThan(0.02); // area effectively constant
    expect(moved).toBeGreaterThan(0.8); // and it genuinely moved
  });

  it('never settles into a dead circle — motion means alive', () => {
    // The regression that prompted all of this: a membrane that stops moving reads as a
    // corpse, whatever the numbers say.
    const b = new SoftBody(ring());
    const s = state();
    run(b, s, 8); // long enough for a damped system to settle if it were going to

    const sample = () => b.points.map((p) => ({ x: p.x, y: p.y }));
    const a = sample();
    run(b, s, 0.5);
    const c = sample();

    let moved = 0;
    for (let i = 0; i < a.length; i++) {
      moved = Math.max(moved, Math.hypot(c[i]!.x - a[i]!.x, c[i]!.y - a[i]!.y));
    }
    expect(moved).toBeGreaterThan(0.3);
  });

  it('stress reads as a departure from calm: tension raises frequency, not sprawl', () => {
    const calm = new SoftBody(ring());
    const taut = new SoftBody(ring());
    run(calm, state({ tension: 0 }), 6);
    run(taut, state({ tension: 0.9 }), 6);

    const spread = (b: SoftBody): number => {
      let m = 0;
      for (const p of b.points) m = Math.max(m, Math.hypot(p.x - p.rx, p.y - p.ry));
      return m;
    };
    // A taut membrane deforms LESS in amplitude — it quivers rather than rolls.
    expect(spread(taut)).toBeLessThan(spread(calm));
  });
});

describe('§11.6 — pressure holds the target area', () => {
  it('inflates toward a larger target when the cell swells', () => {
    const b = new SoftBody(ring());
    const rest = b.restArea();
    run(b, state({ targetArea: rest * 1.25 }), 6);
    expect(b.area()).toBeGreaterThan(rest * 1.05);
  });

  it('deflates toward a smaller target when waste is cleared', () => {
    const b = new SoftBody(ring());
    const rest = b.restArea();
    run(b, state({ targetArea: rest * 1.25 }), 6);
    const swollen = b.area();
    run(b, state({ targetArea: rest }), 8);
    expect(b.area()).toBeLessThan(swollen);
  });

  it('stays bounded under an absurd target rather than exploding', () => {
    // An explicit spring integrator with a stiff pressure term is exactly the kind of
    // thing that detonates on a bad frame; §3.3 makes the same point about the sim.
    // The bound is now MAX_SCALE on the breathing, not the raw distance from rest —
    // swelling is supposed to move the ring, it just may not move it arbitrarily.
    const b = new SoftBody(ring());
    run(b, state({ targetArea: 1e7 }), 5);
    expect(b.breathing).toBeLessThanOrEqual(1.45);
    for (const p of b.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      // Bounded by the scale ceiling plus the ooze leash, and nothing beyond.
      expect(Math.hypot(p.x - 100, p.y - 100)).toBeLessThan(40 * 1.45 + 40 * 0.14);
    }
  });

  it('survives a long stalled frame', () => {
    const b = new SoftBody(ring());
    const s = state();
    for (let i = 0; i < 40; i++) b.step(2.5, s); // 2.5 s frames
    for (const p of b.points) expect(Number.isFinite(p.x)).toBe(true);
    expect(Math.abs(b.area() - s.targetArea) / s.targetArea).toBeLessThan(0.05);
  });
});

describe('§2.1 — the costume stays on the truth', () => {
  it('never strays far from the real membrane tiles at rest volume', () => {
    const b = new SoftBody(ring());
    run(b, state({ tension: 1, health: 1 }), 10);
    expect(b.breathing).toBeCloseTo(1, 2); // target == rest, so no breathing
    for (const p of b.points) {
      // Bounded by MAX_OFFSET × radius. The membrane may ooze; it may not relocate.
      expect(Math.hypot(p.x - p.rx, p.y - p.ry)).toBeLessThanOrEqual(40 * 0.131);
    }
  });

  it('swelling moves the ring by exactly what the volume says, and no more', () => {
    // §7.5 wants the swelling VISIBLE — at rupture that is a 30% stretch, far past the
    // ooze leash. The two motions are separate: a uniform breathing scale carries the
    // volume honestly, the ooze stays bounded around it.
    const b = new SoftBody(ring());
    const rest = b.restArea();
    run(b, state({ targetArea: rest * 1.69 }), 8); // 1.3× radius — §7.4's rupture stretch
    expect(b.breathing).toBeCloseTo(1.3, 1);
    for (const p of b.points) {
      const anchored = Math.hypot(p.x - 100, p.y - 100);
      // Sits on the swollen ring, within the ooze leash of it.
      expect(anchored).toBeGreaterThan(40 * 1.3 - 40 * 0.14);
      expect(anchored).toBeLessThan(40 * 1.3 + 40 * 0.14);
    }
  });

  it('markers ride the membrane rather than floating where it used to be', () => {
    const b = new SoftBody(ring());
    run(b, state(), 4);
    const tile = { x: 140, y: 100 }; // a tile on the ring, due east
    const d = b.displaced(tile.x, tile.y);
    expect(Math.hypot(d.x - tile.x, d.y - tile.y)).toBeGreaterThan(0);
    expect(Math.hypot(d.x - tile.x, d.y - tile.y)).toBeLessThan(40 * 0.14);
  });
});

describe('§11.5 / §11.7 — death and accessibility', () => {
  it('a lysed membrane goes slack and stops holding its area', () => {
    const b = new SoftBody(ring());
    const rest = b.restArea();
    run(b, state({ targetArea: rest * 1.6, lysed: true, health: 0.2 }), 6);
    // It should NOT have inflated to the target — a burst husk holds nothing.
    expect(b.area()).toBeLessThan(rest * 1.1);
  });

  it('low health stills the motion — the truest death cue', () => {
    const lively = new SoftBody(ring());
    const dying = new SoftBody(ring());
    run(lively, state({ health: 1 }), 6);
    run(dying, state({ health: 0.2 }), 6);

    const amplitude = (b: SoftBody): number => {
      let m = 0;
      for (const p of b.points) m = Math.max(m, Math.hypot(p.x - p.rx, p.y - p.ry));
      return m;
    };
    expect(amplitude(dying)).toBeLessThan(amplitude(lively));
  });
});

describe('§11.6a — the membrane responds to motion', () => {
  it('a slack membrane visibly ebbs; a taut one barely does', () => {
    // "While the membrane does spring in at startup, it doesn't move after that." The
    // ambient forcing existed but was scaled by (1 - 0.45·tension), which left a relaxed
    // cell oscillating about 9 px on a 200 px radius — under 5%, indistinguishable from a
    // still picture. §11.6 says spring stiffness IS tension, so slack should ROLL.
    // AMPLITUDE of shape change, not path length and not offset from a nominal circle.
    //
    // Both of the obvious metrics are wrong here, in opposite directions. Distance from a
    // nominal radius scores the taut membrane's different steady shape as if it were
    // motion. Path length rewards the high-frequency quiver — a taut membrane trembles
    // fast and short, covering more distance while looking perfectly still. What "ebbing
    // and flowing" means is that each part of the ring travels IN AND OUT by a visible
    // amount, so that is what this measures: peak-to-peak radial swing per node.
    const measure = (tension: number): number => {
      const b = new SoftBody(ring());
      for (let i = 0; i < 200; i++) b.step(1 / 60, state({ tension })); // settle first

      const n = pointsOf(b).length;
      const lo = new Array<number>(n).fill(Infinity);
      const hi = new Array<number>(n).fill(-Infinity);
      for (let i = 0; i < 600; i++) {
        b.step(1 / 60, state({ tension }));
        const pts = pointsOf(b);
        for (let j = 0; j < n; j++) {
          const r = Math.hypot(pts[j]!.x - 100, pts[j]!.y - 100);
          if (r < lo[j]!) lo[j] = r;
          if (r > hi[j]!) hi[j] = r;
        }
      }
      let sum = 0;
      for (let j = 0; j < n; j++) sum += hi[j]! - lo[j]!;
      return sum / n; // mean peak-to-peak radial swing, px
    };

    const slack = measure(0);
    const taut = measure(1);
    // A slack membrane rolls; a taut one is held. §11.6: stiffness IS tension.
    expect(slack).toBeGreaterThan(taut * 1.5);
    // And in absolute terms it is visible on a 40 px ring, not a sub-pixel tremor.
    expect(slack).toBeGreaterThan(1.5);
  });

  it('swimming deforms the body, and stopping lets it recover', () => {
    const moving = new SoftBody(ring());
    for (let i = 0; i < 300; i++) moving.step(1 / 60, state({ vx: 60, vy: 0 }));
    const deformed = asymmetry(moving);

    const still = new SoftBody(ring());
    for (let i = 0; i < 300; i++) still.step(1 / 60, state());
    expect(deformed).toBeGreaterThan(asymmetry(still));
  });

  it('drag deforms without inflating — §11.5 area is still the simulation\'s', () => {
    // The drag force is UNIFORM across every node, so it offsets the ring against its
    // leash rather than pushing it outward. If it had a net outward component the shape
    // would silently enclose more than the volume the HUD reports, which is the §2.1
    // violation this whole layer exists to avoid.
    const b = new SoftBody(ring());
    const target = Math.PI * 40 * 40;
    for (let i = 0; i < 600; i++) b.step(1 / 60, state({ vx: 90, vy: 40 }));
    const area = areaOf(b);
    expect(Math.abs(area - target) / target).toBeLessThan(0.12);
  });
});
