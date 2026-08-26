/**
 * The renderer. SPEC.md §11, §3.7, and the player's hands on §9.2.
 *
 * HOLDS NO TRUTH. Every number on screen came off the wire this tick; nothing here
 * simulates, integrates, or remembers state the server did not send. §2.1's rule — that
 * the costume must never contradict the truth — is enforced by there being no local state
 * to diverge.
 *
 * Particles are spawned FROM the received field (§11.1), never the reverse: the specific
 * inversion five of nine prototypes fell into (§16.2), and impossible here because this
 * process has no field to write back to.
 */

import {
  decodeFieldFrame,
  type ClientMsg,
  type FieldFrame,
  type ScalarsMsg,
  type ServerMsg,
} from '@protocell/protocol';
import { FieldRenderer, LOOK, addShape } from './render.js';
import { SoftBody } from './softbody.js';

/**
 * Build stamp, shown on the HUD.
 *
 * A stale vite (or a stale sim server) silently serving OLD code has now cost real
 * debugging time twice — once looking for a bug in a fix that was already correct, and
 * once when a membrane that had been made to ooze still appeared frozen. If the number on
 * screen is not the one printed at build time, you are looking at a different program.
 */
const BUILD = __BUILD__;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const W = 700;
const H = 700;
let dpr = 1;
let scale = 1;

function resize(): void {
  const cssW = Math.min(canvas.parentElement!.clientWidth, 700);
  dpr = window.devicePixelRatio || 1;
  scale = cssW / W;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round((cssW * H) / W * dpr);
  // BOTH dimensions must be pinned. The stylesheet says `width: 100%`, so with the side
  // panel making the parent ~850px the element was displayed 850 CSS px wide while its
  // bitmap was 700 — stretched horizontally, aspect ratio broken. Clicks survived that
  // (they divide by rect.width and rect.height separately) but hover did not, because it
  // reused the x scale for y, and the error grew toward the bottom of the canvas.
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${(cssW * H) / W}px`;
}
window.addEventListener('resize', resize);
resize();

// ── species look-up, and the §11.3 signatures ────────────────────────────────

let speciesByName: Record<string, number> = {};
let nameById: Record<number, string> = {};

// §11.3's signature table lives in render.ts alongside the renderer that consumes it.
const RESIDUES = ['gly', 'leu', 'lys', 'ala', 'val'] as const;
/**
 * Field species only. The residues are NOT here since §5b — they are an integer inventory
 * with no position, so there is no plane to subscribe to and nothing to spawn dots from.
 * They live in the HUD strip, where a count is always legible and never depends on zoom.
 */
const WATCHED_NAMES = ['glucose', 'atp', 'lactate'];

// ── wire state — the only state this process has ─────────────────────────────

let hello: {
  worldWidth: number;
  worldHeight: number;
  membraneTiles: number[];
  cellRadius: number;
} | null = null;
/** Fast membership test for "is this a legal transporter site" (§6.7). */
let membraneSet = new Set<number>();
/**
 * The membrane tiles a protein can actually go in — see HelloMsg.gateTiles. Distinct from
 * `membraneSet`, which is the whole ring and is what the WALL is drawn from. Highlighting
 * and snapping must use this one: 18.5% of the ring is buried wall that can host nothing.
 */
let gateSet = new Set<number>();
let gateList: number[] = [];

/**
 * Does the thing the bot is carrying get seated in a membrane tile?
 *
 * Transporters and flagella both do; enzymes do not. This started life as four separate
 * `productKind === 'transporter'` checks, which meant a folded FLAGELLUM was invisible to
 * every one of them: no legal-site highlight, and — worse — a click on the membrane fell
 * through to the plain "walk there" branch, so the on-screen hint said "click a membrane
 * tile" and clicking a membrane tile did nothing. Exactly the failure the enzyme hint was
 * fixed for once already, which is the argument for asking the question in ONE place.
 */
function seatsInMembrane(kind: ScalarsMsg['build']['productKind']): boolean {
  return kind === 'transporter' || kind === 'flagellum';
}
/** Membrane tiles that already carry a transporter, from the event stream. */
const placedTransporters = new Set<number>();
/**
 * A membrane tile the player has aimed at while carrying, but which the bot has not
 * reached yet. Seated automatically on arrival, so "click the spot you want" is one
 * gesture rather than walk-then-click-again.
 */
let pendingDeployTile: number | null = null;
let frame: FieldFrame | null = null;
let s: ScalarsMsg | null = null;
let lod = 1;
let t = 0;

/**
 * Where the simulation lives, and which cell to open.
 *
 * Hardcoding `ws://localhost:8787` was correct while the server hosted exactly one world
 * and only ever ran on this machine. Neither is true now (§15.6), and a page served over
 * https cannot open a `ws://` socket at all — the browser blocks the mixed content — so
 * the scheme has to follow the page rather than be asserted.
 *
 *   VITE_SIM_URL   explicit override, for pointing a local client at a deployed sim
 *   ?game=<id>     which cell to open; the server falls back to its own default
 *
 * When neither is set this resolves to the same localhost:8787 it always used, so
 * `npm run server` + `npm run client` is unchanged.
 */
function simUrl(): string {
  const params = new URLSearchParams(location.search);
  const explicit = (import.meta.env?.['VITE_SIM_URL'] as string | undefined) ?? params.get('sim');
  const base =
    explicit ??
    (location.protocol === 'https:'
      ? `wss://${location.host}`
      : location.port === '5173' || location.port === ''
        ? 'ws://localhost:8787'
        : `ws://${location.host}`);
  const game = params.get('game');
  return game ? `${base}?game=${encodeURIComponent(game)}` : base;
}

const socket = new WebSocket(simUrl());
socket.binaryType = 'arraybuffer';

function send(msg: ClientMsg): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function subscribe(): void {
  if (!hello) return;
  const ids = WATCHED_NAMES.map((n) => speciesByName[n]).filter((v): v is number => v !== undefined);
  send({
    t: 'subscribe',
    view: { x: 0, y: 0, w: hello.worldWidth, h: hello.worldHeight, lod, species: ids },
  });
}

socket.addEventListener('open', () => setConn('connected', false));
socket.addEventListener('close', () => setConn('disconnected — the sim is still running', true));
socket.addEventListener('error', () => setConn('connection error', true));

socket.addEventListener('message', (ev) => {
  if (ev.data instanceof ArrayBuffer) {
    frame = decodeFieldFrame(ev.data);
    // Rebuild tint and dot targets ONCE PER RECEIVED FRAME (~30 Hz). The old code redid
    // all of it inside draw() at ~60 Hz — twice as often as the data actually changed.
    fx.ingest(frame, nameById, tilePx(), isInterior);
    return;
  }
  const msg = JSON.parse(ev.data as string) as ServerMsg;
  if (msg.t === 'hello') {
    hello = {
      worldWidth: msg.worldWidth,
      worldHeight: msg.worldHeight,
      membraneTiles: msg.membraneTiles,
      cellRadius: msg.cellRadius,
    };
    membraneSet = new Set(msg.membraneTiles);
    gateSet = new Set(msg.gateTiles);
    gateList = msg.gateTiles;
    // Build the soft-body from the REAL membrane tiles, in canvas px, so the ooze is
    // anchored to where the simulation says the membrane is (§2.1).
    const k0 = Math.min(W / msg.worldWidth, H / msg.worldHeight);
    membrane = new SoftBody(
      msg.membraneTiles.map((tile) => ({
        x: ((tile % msg.worldWidth) + 0.5) * k0,
        y: (Math.floor(tile / msg.worldWidth) + 0.5) * k0,
      })),
    );
    builtAtK = k0; // baseline for the zoom rescale
    nameById = msg.species;
    speciesByName = Object.fromEntries(Object.entries(msg.species).map(([id, n]) => [n, Number(id)]));
    subscribe();
    setStatus(
      'A bare cell, and you are the nanobot inside it — the only assembler this cell has ' +
        '(§1.2). Click to move. Go to the nucleus, take the glycolysis blueprint, then ' +
        'walk the amino acids into a protein one bond at a time.',
    );
  } else if (msg.t === 'scalars') {
    s = msg;
    // Seat a queued transporter the moment the bot gets within reach.
    if (pendingDeployTile !== null) {
      if (!s.bot.carrying) {
        pendingDeployTile = null;
      } else {
        const tx = (pendingDeployTile % hello!.worldWidth) + 0.5;
        const ty = Math.floor(pendingDeployTile / hello!.worldWidth) + 0.5;
        if (Math.hypot(s.bot.x - tx, s.bot.y - ty) <= 2.6) {
          send({ t: 'command', cmd: { op: 'deploy', tile: pendingDeployTile } });
          pendingDeployTile = null;
        }
      }
    }
  } else if (msg.t === 'event') {
    if (msg.kind === 'lysed') {
      setStatus(
        'LYSED. Trapped lactate raised internal osmolarity, water flooded in, and the ' +
          'membrane could not hold. The carrier is life support, not cleanup.',
      );
    } else if (msg.kind === 'folded') {
      setStatus(
        s?.build.productKind === 'transporter'
          ? 'Folded. Now carry it to the membrane: click the tile you want it seated in, ' +
            'and the nanobot will walk it over and embed it there. Where it goes matters — ' +
            'a glucose channel does nothing on the face pointing at the amino-acid zone.'
          : s?.build.productKind === 'flagellum'
          ? 'Folded. Click the membrane tile to anchor it in — and pick the side carefully: ' +
            'a flagellum thrusts along the inward normal, so it pushes the cell AWAY from ' +
            'the face it sits on. Seat it on the east side to swim west.'
          : s?.build.productKind === 'ribosome'
          ? 'Folded. A ribosome goes INSIDE the cell, not in the wall — walk it to the ' +
            'machinery you want kept alive and release it there. It repairs whatever fails ' +
            'within its reach, so where you put it decides what survives (§9.5).'
          : 'Folded — the shape IS the function. An enzyme is a free agent: walk the ' +
            'nanobot to where the substrate is, then press "Release enzyme here".',
      );
    } else if (msg.kind === 'transporterPlaced' && msg.tile !== undefined) {
      placedTransporters.add(msg.tile);
      setStatus('Transporter seated. Its permeability for that species jumps immediately — transport has already started.');
    } else if (msg.kind === 'flagellumPlaced') {
      setStatus(
        'Flagellum anchored. It thrusts along the inward normal — away from the face it ' +
          'sits on — and costs 3.6 ATP/s only while firing, about half an enzyme\'s output. ' +
          'Right-click anywhere to swim that way; coasting is free.',
      );
    } else if (msg.kind === 'enzymePlaced') {
      setStatus('Enzyme released into the cytoplasm. It works wherever substrate reaches it, so distance from supply is a real cost.');
    } else if (msg.kind === 'deployRefused') {
      // The sim already knows exactly why, and used to have it thrown away in favour of
      // one generic sentence that guessed at the cause.
      setStatus(
        msg.reason
          ? `Cannot deploy there — ${msg.reason}`
          : 'Cannot deploy there. A transporter or flagellum must go into a membrane tile the nanobot can reach.',
      );
    }
  }
});

function setConn(text: string, bad: boolean): void {
  const el = document.getElementById('conn')!;
  el.textContent = text;
  el.classList.toggle('bad', bad);
}
function setStatus(text: string): void {
  document.getElementById('status')!.textContent = text;
}

// ── §11.5 the ooze ───────────────────────────────────────────────────────────
//
// §11.5's `memR` harmonic sum used to live here. It has been superseded by the soft body
// in softbody.ts (§11.6, "the right underlying object"), which carries the same three
// harmonics as an ambient FORCE rather than a position — so the motion is damped and
// laggy instead of kinematically exact, and it responds to volume and tension instead of
// merely being scaled by them.
//
// The property that mattered survives and is now tested rather than argued: the forcing
// is zero-mean in theta, so it adds no net area, and enclosed area tracks the volume the
// simulation reports. See apps/client/test/softbody.test.ts.

// ── particles ────────────────────────────────────────────────────────────────
//
// The whole particle system lives in render.ts. It was rewritten after measuring the
// original at 102,798 dots and 205,596 canvas state changes PER FRAME; see the header
// there for what changed and why.

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const fx = new FieldRenderer();

/** §11.6's pressurized loop. Built once `hello` tells us where the membrane really is. */
let membrane: SoftBody | null = null;

/**
 * Is this world tile inside the cell? Dots are spent here; the medium gets tint.
 *
 * A distance test is exact for the disc the intro stamps, and `cellRadius` is the
 * GEOMETRIC radius (not the osmotic one — see the note where the membrane is drawn).
 * Once growth or division makes the boundary non-circular this needs the real role map
 * from the server, the same way membraneTiles already is.
 */
function isInterior(wx: number, wy: number): boolean {
  if (!hello) return false;
  const dx = wx + 0.5 - hello.worldWidth / 2;
  const dy = wy + 0.5 - hello.worldHeight / 2;
  return Math.hypot(dx, dy) < hello.cellRadius - 1;
}

// ── view transform ───────────────────────────────────────────────────────────

/**
 * Camera. Smooth continuous zoom on the wheel, anchored at the cursor.
 *
 * This is separate from the SUBSCRIPTION lod (§3.5), and the split matters: `lod` is how
 * much detail the server sends, `zoom` is how big it is drawn. Wheeling changes the
 * magnification continuously and only steps the subscription when the detail genuinely
 * needs to change — so zooming feels analogue rather than snapping between two fixed
 * resolutions.
 */
const cam = { zoom: 1, x: 0, y: 0, targetZoom: 1 };
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 8;

/** Base px per world tile at zoom 1 — the whole world fits the canvas. */
function baseTilePx(): number {
  if (!hello) return 1;
  return Math.min(W / hello.worldWidth, H / hello.worldHeight);
}
function tilePx(): number {
  return baseTilePx() * cam.zoom;
}
/** Canvas point → world tile coordinates. The inverse of everything drawn below. */
function toTile(px: number, py: number): { x: number; y: number } {
  const k = tilePx();
  return { x: (px - cam.x) / k, y: (py - cam.y) / k };
}

// ── draw ─────────────────────────────────────────────────────────────────────

function draw(): void {
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0e16';
  ctx.fillRect(0, 0, W, H);
  if (!hello || !frame || !s) return;

  // Camera. Everything below draws in world-scaled px, so a single translate here is the
  // whole of pan and zoom — no per-primitive offsets to keep in sync.
  ctx.save();
  ctx.translate(cam.x, cam.y);

  const k = tilePx();
  const cx = (hello.worldWidth / 2) * k;
  const cy = (hello.worldHeight / 2) * k;
  // (radius is the OSMOTIC radius; the drawn shape comes from the soft body instead)
  const { health, tension, lysed } = s;

  // Cytoplasm, clipped to the same oozing loop the membrane is drawn from — so the fill
  // and the outline are the same shape rather than two curves that disagree.
  if (membrane) {
    ctx.save();
    ctx.beginPath();
    membrane.trace(ctx);
    ctx.clip();
    ctx.fillStyle = health > 0.5 ? 'rgba(38,60,82,0.72)' : 'rgba(60,52,50,0.7)';
    ctx.fill();
    ctx.restore();
  }

  // §11.4's LOD handoff, and where nearly all the old cost went: the medium is one
  // scaled blit, not ninety thousand arcs.
  fx.drawTint(ctx, frame, k);
  // Continuum species only. Glucose, lactate and the residues have no interior field
  // since §5a — they are grains, drawn below as the actual objects they are.
  fx.drawDots(ctx, health);
  drawGrains(ctx, health, k);

  // §11.5: the membrane reddens under tension and breaks on lysis.
  //
  // Drawn from the REAL membrane tile list, not from an analytic circle of `radius`.
  // `radius` is the osmotic radius √(volume/π) and drifts as the cell swells, but the
  // membrane tiles sit at the fixed geometric radius until re-tiling exists (§3.6) — so
  // drawing the ring from `radius` put the outline somewhere the membrane was not, and
  // clicks meant to seat a transporter landed on cytoplasm. §2.1: the costume may not
  // contradict the truth, so it now draws the truth it was sent.
  const mg = Math.round(196 + (80 - 196) * tension);
  const mb = Math.round(138 + (74 - 138) * tension);
  const stroke = lysed
    ? 'rgba(200,80,74,0.5)'
    : health > 0.5 ? `rgba(226,${mg},${mb},0.9)` : 'rgba(150,140,120,0.7)';

  if (membrane) {
    // §11.5's ooze, via §11.6's soft body. This replaced a ring of static axis-aligned
    // squares stamped from the tile list — correct in position and completely rigid,
    // which in this visual language reads as a corpse.
    ctx.beginPath();
    membrane.trace(ctx);
    ctx.lineWidth = Math.max(3, k * 0.9);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke;
    ctx.stroke();

    // A slack inner highlight, so the membrane reads as a thick lipid band rather than a
    // drawn outline. Fades out as tension rises — a taut membrane is a thin taut line.
    ctx.lineWidth = Math.max(1, k * 0.3);
    ctx.strokeStyle = lysed
      ? 'rgba(200,80,74,0.2)'
      : `rgba(255,236,196,${(0.28 * (1 - tension)).toFixed(3)})`;
    ctx.stroke();
  }

  // While carrying, light up every legal deployment site — §6.7's finite membrane real
  // estate, made visible at the moment the decision is actually being made.
  // §10A.1 — flagella. Drawn as a tail streaming OUTWARD from the membrane, opposite to
  // the thrust it produces, and beating only while firing. A firing flagellum has to look
  // different from an idle one, because the difference is 3.6 ATP/s.
  // §10A.1a — the body TURNS, and flagella are welded to it. Both their seat on the ring
  // and the direction they push have to be rotated by `facing`, or they are drawn where
  // they no longer are and the cell appears to swim sideways out of its own tail.
  const cf = Math.cos(s.motility.facing);
  const sf = Math.sin(s.motility.facing);
  const ccx = (hello.worldWidth / 2) * k;
  const ccy = (hello.worldHeight / 2) * k;
  for (const f of s.motility.flagella) {
    const tx = (f.tile % hello.worldWidth) + 0.5;
    const ty = Math.floor(f.tile / hello.worldWidth) + 0.5;

    // ROTATE FIRST, THEN DISPLACE — and the order is the whole bug.
    //
    // `displaced()` looks up the ooze offset for the ring point at the ANGLE of the point
    // it is given. Displacing the unrotated seat and rotating the result afterwards takes
    // the offset belonging to one part of the membrane and applies it to another, so the
    // flagellum sat off the wall by the difference between two independent wobbles —
    // visible once the membrane was left breathing at full amplitude (§11.7). Every other
    // membrane marker was already correct because none of them
    // rotate; the flagellum is the only thing welded to a body that turns (§10A.1a).
    const rx = tx * k - ccx;
    const ry = ty * k - ccy;
    const seatX = ccx + rx * cf - ry * sf;
    const seatY = ccy + rx * sf + ry * cf;
    const d = membrane ? membrane.displaced(seatX, seatY) : { x: seatX, y: seatY };
    // Outward is away from the cell, i.e. opposite the thrust direction — also rotated.
    const ox = -(f.dx * cf - f.dy * sf);
    const oy = -(f.dx * sf + f.dy * cf);
    const len = k * (f.firing ? 5.5 : 3.2);

    ctx.strokeStyle = f.firing ? 'rgba(140,220,255,0.95)' : 'rgba(120,150,180,0.45)';
    ctx.lineWidth = Math.max(1.5, k * 0.28);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(d.x, d.y);
    // A sine along the tail — the beat. Frozen when idle, so stillness reads as "off".
    const beat = f.firing ? 1 : 0;
    for (let i = 1; i <= 10; i++) {
      const u = i / 10;
      const wob = Math.sin(u * 7 - t * 14) * k * 0.75 * beat * u;
      ctx.lineTo(d.x + ox * len * u - oy * wob, d.y + oy * len * u + ox * wob);
    }
    ctx.stroke();
    // The basal body, so an idle flagellum is still findable.
    ctx.fillStyle = f.firing ? 'rgba(180,235,255,0.95)' : 'rgba(120,150,180,0.7)';
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(2, k * 0.4), 0, 6.283185);
    ctx.fill();
  }

  // Heading indicator, so steering is visible before the cell has moved anywhere.
  if (s.motility.heading !== null) {
    const hx = cx + Math.cos(s.motility.heading) * (hello.cellRadius * k + 26);
    const hy = cy + Math.sin(s.motility.heading) * (hello.cellRadius * k + 26);
    ctx.strokeStyle = s.motility.stalled ? 'rgba(255,140,120,0.8)' : 'rgba(140,220,255,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(s.motility.heading) * (hello.cellRadius * k + 10),
               cy + Math.sin(s.motility.heading) * (hello.cellRadius * k + 10));
    ctx.lineTo(hx, hy);
    ctx.stroke();
  }

  // Both of these ride the oozing membrane via `displaced()`, rather than sitting at
  // fixed lattice coordinates while the membrane moves out from under them — a marker
  // that detaches from its own wall is exactly the sort of costume/truth mismatch §2.1
  // is about, even when the underlying tile never moved.
  if (s.bot.carrying && seatsInMembrane(s.build.productKind)) {
    ctx.strokeStyle = 'rgba(255,225,140,0.6)';
    ctx.lineWidth = 1.5;
    for (const tile of gateList) {
      const tx = (tile % hello.worldWidth) + 0.5;
      const ty = Math.floor(tile / hello.worldWidth) + 0.5;
      if (Math.hypot(tx - s.bot.x, ty - s.bot.y) > 3) continue;
      const d = membrane ? membrane.displaced(tx * k, ty * k) : { x: tx * k, y: ty * k };
      ctx.beginPath();
      ctx.arc(d.x, d.y, k * 0.55, 0, 6.283185);
      ctx.stroke();
    }
  }

  // §10A.2 — the terrain, drawn in world space so you can see food you have not reached.
  // The world offset: a grid tile (gx,gy) looks at world (gx - cx + motility.x, ...).
  const wox = s.motility.x - hello.worldWidth / 2;
  const woy = s.motility.y - hello.worldHeight / 2;

  // ── Are we moving? ────────────────────────────────────────────────────────
  // §10A keeps the cell fixed on the lattice and moves the WORLD past it, which is the
  // right simulation design (it sidesteps §3.6 re-tiling entirely) and a disaster for
  // legibility on its own: the cell sits dead centre, the membrane does not shift, and the
  // only thing that moved was a patch gradient at alpha 0.10. Measured, the cell was
  // swimming 36 tiles in 8 s — exactly as designed — and the playtest note was "why aren't
  // we actually swimming?"
  //
  // So the medium gets particulate matter: motes fixed in WORLD space that slide past as
  // you swim. Nothing in the simulation moves them and nothing reads them — they are
  // honest parallax, the visual equivalent of looking out of a window. Anchored to a grid
  // of world cells and hashed for position, so they are stable, seamless, and need no
  // state at all.
  {
    const MOTE = 26; // world tiles between motes
    const x0 = Math.floor(wox / MOTE) - 1;
    const y0 = Math.floor(woy / MOTE) - 1;
    const nx = Math.ceil(hello.worldWidth / MOTE) + 3;
    const ny = Math.ceil(hello.worldHeight / MOTE) + 3;
    ctx.fillStyle = 'rgba(150,190,220,0.20)';
    ctx.beginPath();
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const gx2 = x0 + ix;
        const gy2 = y0 + iy;
        // Hash the world cell so each mote sits somewhere fixed and irregular inside it.
        let h = (Math.imul(gx2, 374761393) + Math.imul(gy2, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
        const jx = ((h >>> 8) & 255) / 255;
        const jy = ((h >>> 16) & 255) / 255;
        const wxp = (gx2 + jx) * MOTE;
        const wyp = (gy2 + jy) * MOTE;
        const sx2 = (wxp - wox) * k;
        const sy2 = (wyp - woy) * k;
        if (sx2 < -8 || sy2 < -8 || sx2 > W + 8 || sy2 > H + 8) continue;
        const rr = 0.7 + ((h >>> 24) & 7) * 0.16;
        ctx.moveTo(sx2 + rr, sy2);
        ctx.arc(sx2, sy2, rr, 0, 6.283185);
      }
    }
    ctx.fill();
  }
  for (const patch of s.patches) {
    const px2 = (patch.x - wox) * k;
    const py2 = (patch.y - woy) * k;
    const pr = patch.radius * k;
    if (px2 < -pr * 3 || py2 < -pr * 3 || px2 > W + pr * 3 || py2 > H + pr * 3) continue;
    const look = LOOK[nameById[patch.species] ?? ''];
    const colour = patch.hostile ? '#e2504a' : (look?.colour ?? '#8ad4ff');
    const g = ctx.createRadialGradient(px2, py2, 0, px2, py2, pr * 2);
    // Alpha tracks RICHNESS, so a patch you are stripping visibly fades — §10A.2's
    // "reason to leave a depleting patch" needs to be legible before it is empty.
    // Was 0.10, which is close enough to invisible that the terrain read as an empty
    // void and swimming across it looked like nothing happening.
    g.addColorStop(0, hexA(colour, 0.26 * patch.richness + (patch.hostile ? 0.10 : 0)));
    g.addColorStop(1, hexA(colour, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px2, py2, pr * 2, 0, 6.283185);
    ctx.fill();
    if (patch.hostile) {
      ctx.strokeStyle = hexA(colour, 0.25);
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px2, py2, pr, 0, 6.283185);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Name the deposit ──────────────────────────────────────────────────────
    //
    // A coloured haze is not a destination. §5 types the residues and §9.2 blocks on a
    // SPECIFIC one, so the map has to answer "where is the glycine" in the same vocabulary
    // the bill of materials asks it in — otherwise a shortage names a bead the world does
    // not label. Each deposit gets its own mark, in its own shape (§11.3e), with its name
    // and how much is left.
    const nm = nameById[patch.species] ?? '';
    // GLUCOSE GETS THE SAME TREATMENT AS A RESIDUE, which it did not before: this was
    // gated on RESIDUES, so the three sugar pockets were unlabelled hazes with no name, no
    // count and no harvest ring. That was survivable only because a stale "glucose" label
    // was pinned to the cell pretending to do the job (see below, now removed). "Am I in
    // range of food" is the most-asked range question in the game and it had no answer on
    // screen.
    if (!patch.hostile && look && (nm === 'glucose' || RESIDUES.includes(nm as never))) {
      const fade = 0.25 + 0.75 * patch.richness;
      ctx.fillStyle = hexA(colour, 0.85 * fade);
      ctx.beginPath();
      addShape(ctx, look.shape, px2, py2, 7);
      ctx.fill();

      ctx.fillStyle = hexA(colour, 0.9 * fade);
      ctx.font = '600 11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(nm, px2, py2 - 12);
      // What is LEFT, as a count. A percentage cannot answer "will this last me" — it
      // hides how big the deposit was, so a nearly-full small one and a nearly-full huge
      // one read the same. A count also makes "the source ran out" distinguishable from
      // "my transporter died", which is exactly the confusion a percentage caused.
      ctx.fillStyle = hexA(colour, 0.55 * fade);
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillText(`${patch.remaining} left`, px2, py2 + 20);

      // ── The harvest ring: "am I close enough?" ──────────────────────────────
      //
      // Range used to be a gaussian tail, which is invisible — a channel aimed at a
      // deposit you could plainly see did nothing, with no way to find out why. It is a
      // hard radius now, so it can simply be drawn. Inside it, the ring lights up and the
      // cell is harvesting; outside, it is dashed and dim and you have to go closer.
      const hr = patch.harvestRadius * k;
      const gap = Math.max(0, Math.hypot(patch.x - s.motility.x, patch.y - s.motility.y) - hello.cellRadius);
      const inRange = gap < patch.harvestRadius;

      ctx.strokeStyle = hexA(colour, inRange ? 0.75 : 0.22);
      ctx.lineWidth = inRange ? 2 : 1;
      ctx.setLineDash(inRange ? [] : [5, 6]);
      ctx.beginPath();
      ctx.arc(px2, py2, hr, 0, 6.283185);
      ctx.stroke();
      ctx.setLineDash([]);

      if (inRange) {
        // Say it in words too — a lit ring is only obvious once you already know what it
        // means, and this is the moment the whole supply loop either lands or does not.
        ctx.fillStyle = hexA(colour, 0.95);
        ctx.font = '600 10px -apple-system, sans-serif';
        ctx.fillText('in range — a transporter here draws from it', px2, py2 + hr + 13);
      }

      // The core, where the rate is full.
      ctx.strokeStyle = hexA(colour, 0.3 * fade);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px2, py2, pr, 0, 6.283185);
      ctx.stroke();
    }
  }

  // ── Compass to off-screen deposits ────────────────────────────────────────
  //
  // Naming a deposit only helps once you can see it, and at the default zoom most of them
  // are off the edge. Without this, "go and get gly" means swimming in a hopeful direction
  // and checking — which is the same unguided search that killed the last version of this
  // mechanic, just at a larger scale.
  //
  // The arrow for whatever the current build is BLOCKED on is drawn bright and labelled
  // with the distance; the rest sit faint. So the game answers "what am I looking for and
  // which way is it" at the moment it stops you for want of a bead.
  {
    const blocked = s.build.blockedOn?.reason === 'residue' ? s.build.blockedOn.residue : null;
    const cxp = W / 2;
    const cyp = H / 2;
    for (const patch of s.patches) {
      const nm = nameById[patch.species] ?? '';
      if (!RESIDUES.includes(nm as never) || patch.richness <= 0.02) continue;
      const px2 = (patch.x - wox) * k;
      const py2 = (patch.y - woy) * k;
      const onScreen = px2 > 20 && py2 > 20 && px2 < W - 20 && py2 < H - 20;
      if (onScreen) continue;

      const look = LOOK[nm];
      const hot = nm === blocked;
      const a = Math.atan2(py2 - cyp, px2 - cxp);
      const rad = Math.min(W, H) / 2 - (hot ? 30 : 22);
      const ax = cxp + Math.cos(a) * rad;
      const ay = cyp + Math.sin(a) * rad;
      const colour = look?.colour ?? '#8ad4ff';

      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(a);
      ctx.fillStyle = hexA(colour, hot ? 0.95 : 0.4);
      ctx.beginPath();
      ctx.moveTo(hot ? 11 : 8, 0);
      ctx.lineTo(-6, hot ? 6 : 4.5);
      ctx.lineTo(-6, hot ? -6 : -4.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      if (hot) {
        // Distance in tiles, so "is it worth the trip" is answerable before the trip.
        const dist = Math.hypot(patch.x - s.motility.x, patch.y - s.motility.y);
        ctx.fillStyle = hexA(colour, 0.95);
        ctx.font = '600 11px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${nm} ${dist.toFixed(0)}`, ax - Math.cos(a) * 18, ay - Math.sin(a) * 18 + 4);
      }
    }
  }

  // §9.4 — integrity arcs. A ring that empties as the protein wears, so the cell shows
  // you what is about to fail instead of only what already has.
  for (const tr of s.transporters) {
    if (tr.integrity > 0.75) continue; // healthy proteins stay uncluttered
    const tx = (tr.tile % hello.worldWidth) + 0.5;
    const ty = Math.floor(tr.tile / hello.worldWidth) + 0.5;
    const d = membrane ? membrane.displaced(tx * k, ty * k) : { x: tx * k, y: ty * k };
    ctx.strokeStyle = tr.integrity < 0.25 ? 'rgba(255,120,110,0.95)' : 'rgba(255,200,120,0.7)';
    ctx.lineWidth = Math.max(1.5, k * 0.22);
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(6, k * 1.35), -Math.PI / 2, -Math.PI / 2 + 6.283185 * tr.integrity);
    ctx.stroke();
  }
  for (const e of s.enzymes) {
    if (e.integrity > 0.75) continue;
    const ex = ((e.tile % hello.worldWidth) + 0.5) * k;
    const ey = (Math.floor(e.tile / hello.worldWidth) + 0.5) * k;
    ctx.strokeStyle = e.integrity < 0.25 ? 'rgba(255,120,110,0.95)' : 'rgba(255,200,120,0.7)';
    ctx.lineWidth = Math.max(1.5, k * 0.22);
    ctx.beginPath();
    ctx.arc(ex, ey, Math.max(6, k * 1.5), -Math.PI / 2, -Math.PI / 2 + 6.283185 * e.integrity);
    ctx.stroke();
  }

  // ── §9.5 ribosomes ────────────────────────────────────────────────────────
  // Drawn with their COVERAGE, because siting is the decision the mechanic is about and
  // it cannot be made against an invisible radius.
  for (const r of s.ribosomes) {
    const rx = ((r.tile % hello.worldWidth) + 0.5) * k;
    const ry = (Math.floor(r.tile / hello.worldWidth) + 0.5) * k;
    const reach = s.ribosomeReach * k;

    ctx.strokeStyle = r.job ? 'rgba(150,230,190,0.30)' : 'rgba(150,230,190,0.13)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 6]);
    ctx.beginPath();
    ctx.arc(rx, ry, reach, 0, 6.283185);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(150,230,190,0.9)';
    ctx.beginPath();
    ctx.arc(rx, ry, Math.max(3, k * 0.9), 0, 6.283185);
    ctx.fill();

    if (r.job) {
      // A progress arc, so a working ribosome reads as working from across the cell.
      ctx.strokeStyle = r.blockedOn ? 'rgba(255,160,120,0.95)' : 'rgba(150,230,190,0.95)';
      ctx.lineWidth = Math.max(2, k * 0.35);
      ctx.beginPath();
      ctx.arc(rx, ry, Math.max(6, k * 1.7), -Math.PI / 2, -Math.PI / 2 + 6.283185 * r.progress);
      ctx.stroke();
      if (r.blockedOn) {
        ctx.fillStyle = 'rgba(255,160,120,0.95)';
        ctx.font = '9px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`needs ${r.blockedOn}`, rx, ry - k * 2.4);
      }
    }
  }

  // §9.4 — holes left by denatured proteins, so "something died here" is visible.
  //
  // §9.5b — and an UNCOVERED hole is drawn differently, because it means something
  // categorically different. A vacancy inside a ribosome's circle is a queue; a vacancy
  // outside every circle is a permanent hole, and nothing in the cell is ever going to do
  // anything about it. Drawn identically, the player reasonably assumes repair is coming.
  for (const v of s.vacancies) {
    const vx = ((v.tile % hello.worldWidth) + 0.5) * k;
    const vy = (Math.floor(v.tile / hello.worldWidth) + 0.5) * k;
    const rr = Math.max(3, k * 1.1);
    ctx.strokeStyle = v.covered ? 'rgba(255,120,120,0.6)' : 'rgba(255,80,70,0.95)';
    ctx.lineWidth = v.covered ? 1.5 : 2.2;
    ctx.setLineDash(v.covered ? [2, 3] : []);
    ctx.beginPath();
    ctx.arc(vx, vy, rr, 0, 6.283185);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!v.covered) {
      // A cross, so "out of reach" reads at a glance and without colour vision.
      const d = rr * 0.62;
      ctx.beginPath();
      ctx.moveTo(vx - d, vy - d);
      ctx.lineTo(vx + d, vy + d);
      ctx.moveTo(vx + d, vy - d);
      ctx.lineTo(vx - d, vy + d);
      ctx.stroke();
    }
  }

  // §9.2 step 5's other product: enzymes, floating free in the cytoplasm. These were not
  // drawn at all — the single build that turns the ATP curve around left no mark on
  // screen, so there was no way to tell where it was, whether it was working, or whether
  // it had been placed near its supply (§4.7's whole point).
  for (const e of s.enzymes) {
    const ex = ((e.tile % hello.worldWidth) + 0.5) * k;
    const ey = (Math.floor(e.tile / hello.worldWidth) + 0.5) * k;
    const r = Math.max(5, k * 1.1);

    // A soft halo, brighter while the active site is occupied (§8.1) — a busy enzyme
    // should look busy.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(150,168,200,${e.occupied ? 0.22 : 0.12})`;
    ctx.beginPath();
    ctx.arc(ex, ey, r * 1.9, 0, 6.283185);
    ctx.fill();
    ctx.restore();

    // The folded protein: a small cluster of residue-coloured beads, echoing the chain
    // the player actually assembled rather than an abstract icon.
    const beads = ['leu', 'gly', 'gly', 'lys', 'ala', 'gly', 'leu'];
    beads.forEach((type, i) => {
      const a = (i / beads.length) * 6.283185 + t * 0.25;
      const bx2 = ex + Math.cos(a) * r * 0.6;
      const by2 = ey + Math.sin(a) * r * 0.6;
      ctx.fillStyle = LOOK[type]?.colour ?? '#9aa8c0';
      ctx.beginPath();
      ctx.arc(bx2, by2, Math.max(1.6, r * 0.3), 0, 6.283185);
      ctx.fill();
    });

    // The binding pocket — open when free, closed around a substrate when working.
    ctx.strokeStyle = e.occupied ? 'rgba(255,255,255,0.85)' : 'rgba(255,176,58,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ex, ey, r * 0.34, e.occupied ? 0 : Math.PI * 1.15, e.occupied ? 6.283185 : Math.PI * 1.85);
    ctx.stroke();
  }

  // Seated transporters. These used to be 2px blue dots on a tan membrane — invisible,
  // which made the single most consequential thing the player builds impossible to find.
  // Now: species-coloured, sized to the membrane, ringed, and clearly marked when gated
  // shut (§6.3), with a pulse on the open ones so an active pore reads as active.
  // §9.4 — a worn protein LOOKS worn. Without this, denaturation is a thing that happens
  // to you rather than a thing you can see coming, and the first warning is a hole.
  const wear = (integrity: number): number => 0.35 + 0.65 * Math.max(0, Math.min(1, integrity));

  for (const tr of s.transporters) {
    const tx = (tr.tile % hello.worldWidth) + 0.5;
    const ty = Math.floor(tr.tile / hello.worldWidth) + 0.5;
    const d = membrane ? membrane.displaced(tx * k, ty * k) : { x: tx * k, y: ty * k };
    const look = LOOK[nameById[tr.species] ?? ''];
    const colour = look?.colour ?? '#8ad4ff';
    const r = Math.max(4, k * 0.75);
    const w9 = wear(tr.integrity);

    if (!tr.closed) {
      // A soft glow so an open pore is findable at a glance across the whole ring.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = hexA(colour, (0.16 + 0.06 * Math.sin(t * 2.4 + tr.tile)) * w9);
      ctx.beginPath();
      ctx.arc(d.x, d.y, r * 2.1, 0, 6.283185);
      ctx.fill();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, 6.283185);
    ctx.fillStyle = tr.closed ? 'rgba(28,34,44,0.95)' : hexA(colour, 0.95);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = tr.closed ? hexA(colour, 0.5) : 'rgba(255,255,255,0.85)';
    ctx.stroke();

    // ── Flow, made visible (§6.1, §11.2) ──────────────────────────────────────
    // "To show FLUX, bias dots near a membrane to drift across in the net direction at a
    // rate ∝ computed J." Without this a channel is a static disc and there is no way to
    // see that it runs fast on a steep gradient and stalls near equilibrium — which is
    // §6.1's most counter-intuitive and most important claim.
    if (!tr.closed && Math.abs(tr.flux) > 0.01) {
      const outward = tr.flux > 0; // positive = export
      const nx = (d.x - cx) / (Math.hypot(d.x - cx, d.y - cy) || 1);
      const ny = (d.y - cy) / (Math.hypot(d.x - cx, d.y - cy) || 1);
      // Speed tracks the rate, so a stalling carrier visibly slows to a crawl. The 4 is a
      // full-scale for the ANIMATION, not a unit conversion — flux is particles/s (§5d)
      // and nothing here converts it.
      const speed = Math.min(1, Math.abs(tr.flux) / 4);
      const n = 1 + Math.round(speed * 3);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const ph = ((t * (0.4 + speed * 1.6) + i / n) % 1);
        const along = (outward ? ph : 1 - ph) * r * 4 - r * 2;
        const px2 = d.x + nx * along;
        const py2 = d.y + ny * along;
        const fade = Math.sin(ph * Math.PI);
        ctx.fillStyle = hexA(colour, 0.75 * fade);
        ctx.beginPath();
        ctx.arc(px2, py2, Math.max(1.4, r * 0.22), 0, 6.283185);
        ctx.fill();
      }
      ctx.restore();
    }

    if (tr.closed) {
      // An unmistakable "shut" glyph — a bar across the pore.
      ctx.beginPath();
      ctx.moveTo(d.x - r * 0.55, d.y);
      ctx.lineTo(d.x + r * 0.55, d.y);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = hexA(colour, 0.95);
      ctx.stroke();
    } else if (tr.kind === 'carrier') {
      // Carriers shuttle rather than sit open (§6.4) — a hollow centre distinguishes them
      // from a channel without needing a legend entry of its own.
      ctx.beginPath();
      ctx.arc(d.x, d.y, r * 0.4, 0, 6.283185);
      ctx.fillStyle = 'rgba(10,14,22,0.9)';
      ctx.fill();
    }
  }

  // §12.1's nucleus — the blueprint library, and the place you have to walk to.
  const nx = s.nucleus.x * k; const ny = s.nucleus.y * k; const nr = s.nucleus.r * k;
  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const a = (i / 60) * 6.28;
    const r = nr * (1 + 0.05 * Math.sin(4 * a + t * 0.8));
    const x = nx + Math.cos(a) * r; const y = ny + Math.sin(a) * r;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(120,104,220,0.28)'; ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = s.bot.atNucleus ? 'rgba(210,190,255,0.95)' : 'rgba(182,168,255,0.6)';
  ctx.stroke();
  ctx.fillStyle = 'rgba(200,188,255,0.75)';
  ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('nucleus', nx, ny + nr + 12);

  // §1.2 — the nanobot. Deliberately machine-shaped against all this soft biology: it is
  // the thing that does not belong here, and the arc is about it engineering its own
  // obsolescence.
  const bx = s.bot.x * k; const by = s.bot.y * k;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(90,170,240,0.20)';
  ctx.beginPath(); ctx.arc(bx, by, 13, 0, 6.28); ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.translate(bx, by); ctx.rotate(t * 1.1);
  ctx.fillStyle = 'rgba(206,230,255,0.96)';
  ctx.strokeStyle = 'rgba(120,185,235,0.95)'; ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 6.28;
    const x = Math.cos(a) * 7; const y = Math.sin(a) * 7;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(58,108,168,0.9)';
  ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, 6.28); ctx.fill();
  ctx.restore();

  // the chain being assembled, trailing off the bot (§9.2 step 3)
  if (s.build.chain.length > 0) {
    const folded = s.build.phase !== 'assembling';
    for (let i = 0; i < s.build.chain.length; i++) {
      const type = s.build.chain[i]!;
      const look = LOOK[type];
      if (!look) continue;
      // Assembling: a straight chain. Folding/carrying: collapse it into a compact ring,
      // which is §9.2 step 4's "watching the string snap into working form".
      const fold = folded ? (s.build.phase === 'folding' ? s.build.fold : 1) : 0;
      const lineX = bx + 13 + i * 9;
      const lineY = by - 15;
      const ang = (i / s.build.chain.length) * 6.28;
      const ringX = bx + Math.cos(ang) * 12;
      const ringY = by - 15 + Math.sin(ang) * 12;
      const x = lineX + (ringX - lineX) * fold;
      const y = lineY + (ringY - lineY) * fold;
      ctx.fillStyle = look.colour;
      ctx.beginPath(); ctx.arc(x, y, 3.6, 0, 6.28); ctx.fill();
    }
  }

  if (s.bot.carrying) {
    // Product-specific, because the two deployment idioms need opposite gestures and
    // this label used to say "click a membrane tile" for BOTH. Clicking the membrane
    // does nothing while carrying an enzyme, so the one hint on screen was sending
    // players to the one place that could not work.
    const enzyme = s.build.productKind === 'enzyme';
    ctx.fillStyle = 'rgba(255,225,140,0.95)';
    ctx.font = '10.5px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      enzyme ? 'carrying enzyme — double-click to release it here' : 'carrying — click a membrane tile',
      bx,
      by + 26,
    );
    if (enzyme) {
      // A ring around the bot showing where it would land: an enzyme is released at the
      // nanobot's own position, so the drop site is the bot.
      ctx.strokeStyle = 'rgba(255,225,140,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(bx, by, 15 + Math.sin(t * 3) * 2, 0, 6.283185);
      ctx.stroke();
    }
  }

  // REMOVED: two zone labels, "glucose" and "amino acids", pinned at ±cellRadius.
  //
  // They date from §12.1, when the intro really did have one glucose zone on one face and
  // one amino zone on the other, and a label at a fixed bearing from the cell was true.
  // §5a.11 replaced that with eight deposits in eight specific places, each with its own
  // name, count and harvest ring — but these two stayed, anchored to the CELL rather than
  // to the world, so they swam along with it labelling whatever happened to be off the
  // east and west flanks. "There are two dotted circles anchored to the cell, one says
  // glucose, the other amino acids — this doesn't make sense."
  //
  // The general form, and it is §5b.3's rule pointing the other way: a label anchored to
  // the observer describes nothing. If it names a place it has to live at that place.

  ctx.restore(); // end camera — everything below is screen-space HUD
  // Render cost, on screen. The original client had no way to see that it was drawing a
  // hundred thousand dots a frame, and "it feels slow" is not a number you can act on.
  // The dot count is also §2.1's honesty valve: when the budget clamps, it says so
  // instead of quietly under-drawing a dense region.
  // Tooltip, in screen space so it does not scale or drift with the camera.
  if (hover) {
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const wBox = Math.max(...hover.lines.map((l) => ctx.measureText(l).width)) + 18;
    const hBox = hover.lines.length * 15 + 12;
    const bx2 = Math.min(W - wBox - 6, hover.x + 14);
    const by2 = Math.min(H - hBox - 6, hover.y + 14);
    ctx.fillStyle = 'rgba(10,14,22,0.94)';
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx2, by2, wBox, hBox, 6);
    ctx.fill();
    ctx.stroke();
    hover.lines.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? 'rgba(226,232,242,0.98)' : 'rgba(150,160,175,0.9)';
      ctx.font = i === 0 ? '600 11.5px -apple-system, sans-serif' : '11px -apple-system, sans-serif';
      ctx.fillText(line, bx2 + 9, by2 + 7 + i * 15);
    });
    ctx.textBaseline = 'alphabetic';
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = fps < 45 ? 'rgba(255,140,120,0.75)' : 'rgba(214,218,226,0.4)';
  ctx.fillText(
    (s.atpDissipated > 0.5 ? `wasting ${s.atpDissipated.toFixed(1)} ATP/s as heat · ` : '') +
      `${fps.toFixed(0)} fps · ${fx.lastDotCount} dots${fx.lastClamped ? ' (clamped)' : ''} · ` +
      `zoom ${cam.zoom.toFixed(1)}× · tick ${frame.tick} · build ${BUILD}`,
    W - 10,
    H - 10,
  );
}

// ── the panels ───────────────────────────────────────────────────────────────

const GENE_LIST = [
  { id: 'glycolysisEnzyme', label: 'Glycolysis enzyme', n: 8 },
  { id: 'glucoseChannel', label: 'Glucose channel', n: 6 },
  { id: 'lactateCarrier', label: 'Lactate carrier', n: 7 },
  // §5 — this one carries ONE residue and the player picks which. Before the picker
  // existed the gene was fixed to glycine, so a cell starved of lysine had no way to build
  // a lysine importer: "rare types gate rare proteins" was stated and then made unplayable.
  { id: 'aminoTransporter', label: 'Amino-acid transporter', n: 9, pickResidue: true },
  { id: 'flagellum', label: 'Flagellum', n: 14 },
  // §9.5 — the machine that repairs what denatures. Deliberately the biggest thing here.
  { id: 'ribosome', label: 'Ribosome', n: 22 },
];

/**
 * §5a — draw the countable matter.
 *
 * These are not spawned from a density; each one is a simulation entity that arrived over
 * the wire with an id. The visual language of §11.3e still applies (hexose, triose, bead),
 * but it now describes a thing rather than summarising a field — so a grain the player is
 * watching is the same grain next frame, and when an enzyme eats one it visibly goes.
 */
function drawGrains(ctx: CanvasRenderingContext2D, health: number, k: number): void {
  if (!s || !hello) return;
  const dim = 0.4 + 0.6 * health;
  // Batch by species so this stays two canvas state changes per species, exactly as the
  // dot renderer does — grains are far fewer, so the cost is strictly lower.
  const bySpecies = new Map<string, typeof s.grains>();
  for (const g of s.grains) {
    const name = nameById[g.species] ?? '';
    let arr = bySpecies.get(name);
    if (!arr) { arr = []; bySpecies.set(name, arr); }
    arr.push(g);
  }
  for (const [name, list] of bySpecies) {
    const look = LOOK[name];
    if (!look) continue;
    const [r, gg, b] = rgbOf(look.colour);
    // Fullness is measured against the largest particle of this species on screen, so the
    // client needs no constant from the sim at all. Importing one would put a second copy
    // of the truth in the renderer, which is exactly what §3.7 exists to prevent.
    let unit = 0;
    for (const g of list) if (g.amount > unit) unit = g.amount;

    ctx.fillStyle = `rgba(${r},${gg},${b},${(0.32 * dim).toFixed(3)})`;
    ctx.beginPath();
    for (const g of list) addShape(ctx, look.shape, g.x * k, g.y * k, look.radius + 2.2);
    ctx.fill();

    ctx.fillStyle = `rgba(${r},${gg},${b},${(0.95 * dim).toFixed(3)})`;
    ctx.beginPath();
    for (const g of list) {
      // A part-used bead draws smaller, so "half a lysine left" is something you can see
      // rather than a number you have to hover for.
      const frac = unit > 0 ? Math.max(0.45, g.amount / unit) : 1;
      addShape(ctx, look.shape, g.x * k, g.y * k, look.radius * 0.8 * frac);
    }
    ctx.fill();
  }
}

const RGB_CACHE = new Map<string, [number, number, number]>();
function rgbOf(hex: string): [number, number, number] {
  let v = RGB_CACHE.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    RGB_CACHE.set(hex, v);
  }
  return v;
}

/**
 * §11.3 makes the species signatures "self-teaching", which they are once you know the
 * vocabulary — but nothing on screen said which colour was which, so a cell full of
 * shimmering dots read as undifferentiated soup. A legend is the cheapest possible fix
 * and does not cost the visual language anything.
 */
function buildLegend(): void {
  const box = document.getElementById('legend')!;
  box.innerHTML = '';
  for (const name of ['glucose', 'atp', 'lactate', ...RESIDUES] as const) {
    const look = LOOK[name];
    if (!look) continue;
    const label =
      name === 'atp' ? 'ATP (energy)'
      : name === 'lactate' ? 'lactate (waste)'
      : RESIDUES.includes(name as never) ? `${name} (amino acid)`
      : name;
    const chip = document.createElement('span');
    chip.className = 'chip';

    // Draw the ACTUAL shape, through the same function the field renderer uses. A legend
    // that is separately authored is a legend that drifts out of sync with the picture —
    // and §2.1's whole complaint is about a costume that stops matching what it describes.
    const sw = document.createElement('canvas');
    sw.width = 18;
    sw.height = 18;
    sw.style.verticalAlign = 'middle';
    sw.style.marginRight = '5px';
    const sctx = sw.getContext('2d')!;
    sctx.fillStyle = look.colour;
    sctx.beginPath();
    addShape(sctx, look.shape, 9, 9, 6.5);
    sctx.fill();

    chip.appendChild(sw);

    // What ONE dot is worth. Without this, "fewer dots" just reads as "less of it" — the
    // player needs to know the unit changed, and the residues all share a unit on purpose
    // so their counts can be compared directly (see AMINO_SCALE).
    const text = document.createElement('span');
    // A dot-worth only means something for species that HAVE dots. The residues are a
    // pool now (§5a.9) — the honest label is "read the count", not a density scale.
    // For residues one dot is exactly one peptide bond, which is the useful thing to say.
    text.textContent = RESIDUES.includes(name as never)
      ? `${label} · 1 dot = 1 bond`
      : look.dots ? `${label} · 1 = ${look.scale}` : `${label} · pooled`;
    chip.appendChild(text);
    box.appendChild(chip);
  }
}

function buildGeneButtons(): void {
  const box = document.getElementById('genes')!;
  box.innerHTML = '';
  for (const g of GENE_LIST) {
    const b = document.createElement('button');
    b.id = `gene_${g.id}`;
    b.innerHTML = `${g.label}<span class="cost">${g.n * 4} ATP</span>`;
    if (g.pickResidue) {
      // The chosen residue rides along with the blueprint request, so the choice is part
      // of what you built rather than something bolted on at the membrane.
      b.addEventListener('click', () =>
        send({ t: 'command', cmd: { op: 'selectGene', gene: g.id, residue: pickedResidue } }),
      );
    } else {
      b.addEventListener('click', () => send({ t: 'command', cmd: { op: 'selectGene', gene: g.id } }));
    }
    box.appendChild(b);

    if (g.pickResidue) {
      const row = document.createElement('div');
      row.className = 'residuepick';
      row.style.cssText = 'display:flex;gap:3px;margin:-2px 0 6px 0;flex-wrap:wrap';
      for (const t of RESIDUES) {
        const chip = document.createElement('button');
        chip.id = `pick_${t}`;
        chip.textContent = t;
        chip.style.cssText =
          'flex:1;min-width:34px;padding:2px 0;font-size:10px;border-radius:4px;cursor:pointer';
        chip.addEventListener('click', () => {
          pickedResidue = t;
          paintResiduePicker();
        });
        row.appendChild(chip);
      }
      box.appendChild(row);
    }
  }
  paintResiduePicker();
}

/** Which amino acid the next amino transporter will carry (§5). */
let pickedResidue = 'lys';

function paintResiduePicker(): void {
  for (const t of RESIDUES) {
    const el = document.getElementById(`pick_${t}`) as HTMLButtonElement | null;
    if (!el) continue;
    const on = t === pickedResidue;
    const colour = LOOK[t]?.colour ?? '#9aa8c0';
    el.style.background = on ? colour : 'rgba(255,255,255,0.05)';
    el.style.color = on ? '#0d1117' : colour;
    el.style.border = `1px solid ${on ? colour : 'rgba(255,255,255,0.12)'}`;
    el.style.fontWeight = on ? '700' : '400';
  }
}
buildGeneButtons();
buildSeekTargets();
buildLegend();

function panels(): void {
  if (!s) return;

  // Gene buttons gate on exactly the predicate the server re-checks (§9.2 step 1).
  const canSelect = s.bot.atNucleus && s.build.phase === 'idle';
  for (const g of GENE_LIST) {
    (document.getElementById(`gene_${g.id}`) as HTMLButtonElement).disabled = !canSelect;
  }
  document.getElementById('genehint')!.textContent = s.bot.atNucleus
    ? s.build.phase === 'idle'
      ? 'At the nucleus. Choose a blueprint.'
      : 'A build is already in progress.'
    : 'Click inside the cell to send the nanobot. It must reach the nucleus to take a blueprint.';

  // Assembly panel
  const name = document.getElementById('buildname')!;
  const beads = document.getElementById('beads')!;
  const blocked = document.getElementById('blocked')!;

  if (s.build.phase === 'idle') {
    name.textContent = 'Nothing under construction.';
    beads.innerHTML = '';
    blocked.textContent = '';
  } else {
    name.textContent =
      s.build.phase === 'folding'
        ? `${s.build.geneName} — folding…`
        : s.build.phase === 'carrying'
          ? `${s.build.geneName} — folded, carry it to its site`
          : `${s.build.geneName} — ${s.build.chain.length}/${s.build.sequence.length} residues, ${s.build.atpCost} ATP total`;

    beads.innerHTML = '';
    s.build.sequence.forEach((type, i) => {
      const el = document.createElement('div');
      el.className = 'bead' + (i < s!.build.chain.length ? ' done' : '') + (i === s!.build.chain.length ? ' next' : '');
      const look = LOOK[type];
      if (look && i < s!.build.chain.length) el.style.background = look.colour;
      else if (look) el.style.borderColor = look.colour;
      el.title = type;
      beads.appendChild(el);
    });

    // §9.2 step 2's blocking case, made readable. A stalled build must be
    // distinguishable from a broken one, or it reads as a bug.
    blocked.textContent = s.build.blockedOn
      ? s.build.blockedOn.reason === 'residue'
        ? `Blocked: no ${s.build.blockedOn.residue.toUpperCase()} within reach. Move the nanobot to where that residue is, or import more.`
        : 'Blocked: not enough ATP nearby to form the next bond.'
      : '';
  }

  // §7.2's answer to "why is my volume climbing", per species. The largest contributor is
  // usually the one to act on — and the action is almost always gating a channel (§6.3).
  const osmo = document.getElementById('osmo')!;
  osmo.innerHTML = '';
  const total = s.osmolarity.reduce((a, b) => a + b.amount, 0) || 1;
  for (const entry of s.osmolarity.slice(0, 5)) {
    if (entry.amount < 0.5) continue;
    const look = LOOK[entry.name];
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML =
      `<i style="background:${look?.colour ?? '#5a6472'}"></i>${entry.name} ` +
      `<b>${entry.amount.toFixed(0)}</b>` +
      `<span style="color:#6b7482">(${((entry.amount / total) * 100).toFixed(0)}%)</span>`;
    osmo.appendChild(chip);
  }
  // Name the biggest non-baseline driver explicitly. "baseline" is the fixed protein and
  // ion load (§5) and is not something the player can do anything about.
  const driver = s.osmolarity.find((e) => e.name !== 'baseline' && e.amount > 1);
  document.getElementById('osmohint')!.textContent = driver
    ? `${driver.name} is the largest thing you can change. If volume keeps climbing, gate the channel importing it, or build something that consumes it.`
    : 'Nothing much accumulating — volume is stable.';

  // §10A — motility, and specifically its RUNNING COST, because §10A.1's tension only
  // exists if the player can read the bill against everything else they could spend on.
  const firing = s.motility.flagella.filter((f) => f.firing).length;
  const motil = document.getElementById('motil')!;
  if (s.motility.flagella.length === 0) {
    motil.textContent = 'No flagella. Build one at the nucleus, then right-click to steer.';
  } else {
    motil.innerHTML =
      `${s.motility.flagella.length} flagella, <b>${firing} firing</b><br>` +
      (firing > 0
        ? `costing <b style="color:#ffb86b">${s.motility.atpPerSecond.toFixed(1)} ATP/s</b> — ` +
          `about ${(s.motility.atpPerSecond / 7.14).toFixed(1)} enzymes' worth of output` +
          (s.motility.stalled ? '<br><b style="color:#ff7a7a">not enough ATP — thrust throttled</b>' : '')
        : 'coasting — free') +
      // Speed as well as position. The cell is pinned to the centre of the view by
      // design (§10A), so without a number there is nothing on screen that says
      // unambiguously "you are moving" — which is exactly how a working 4.5 tiles/s read
      // as "the flagella do nothing".
      `<br><span style="color:#6b7482">position ${s.motility.x.toFixed(0)}, ${s.motility.y.toFixed(0)}` +
      ` · speed ${Math.hypot(s.motility.vx, s.motility.vy).toFixed(1)} tiles/s</span>`;
  }
  (document.getElementById('chemo') as HTMLButtonElement).textContent =
    s.motility.chemotaxis !== null
      ? `Seeking: ${nameById[s.motility.chemotaxis] ?? '?'} — click to stop`
      : 'Seek: off';
  paintSeekTargets();

  // §10A.9 — the seeker's reasoning, worst first.
  //
  // Shown as SLACK rather than as a stock count, because slack is the quantity actually
  // being compared and a stock count would make the choice look wrong: glucose is nearly
  // always the smallest pile and nearly never the most urgent errand, because its pocket
  // is close and its supply chain is usually keeping up.
  const autoBtn = document.getElementById('autoseek') as HTMLButtonElement;
  autoBtn.textContent = s.motility.autoSeek ? 'Auto-seek: ON' : 'Auto-seek: off';
  autoBtn.style.background = s.motility.autoSeek ? 'rgba(120,220,160,0.18)' : '';
  autoBtn.disabled = s.motility.flagella.length === 0;
  autoBtn.title = autoBtn.disabled
    ? 'No flagellum — the cell cannot swim.'
    : 'Head for whichever stock is lowest, and keep doing it';

  const short = document.getElementById('shortages');
  if (short) {
    short.innerHTML = '';
    // Lowest first — the same order the seeker walks, so the leftmost chip is where it is
    // going. Nothing is derived here; these are the counts the sim compared.
    for (const x of s.scarcity.slice(0, 6)) {
      const chip = document.createElement('span');
      const seeking = s.motility.chemotaxis === x.species;
      chip.className = 'chip' + (seeking ? '' : ' short');
      chip.textContent = `${x.name} ${x.count}`;
      chip.title = seeking ? `heading for ${x.name} — the lowest stock` : `${x.count} ${x.name} in the cell`;
      if (seeking) chip.style.outline = '1px solid rgba(120,220,160,0.7)';
      short.appendChild(chip);
    }
  }

  const chemoBtn = document.getElementById('chemo') as HTMLButtonElement;
  chemoBtn.disabled = s.motility.flagella.length === 0;
  chemoBtn.title = chemoBtn.disabled
    ? 'No flagellum — the cell cannot swim.'
    : 'Hand steering to the gradient';
  (document.getElementById('stop') as HTMLButtonElement).disabled = s.motility.heading === null;

  // §9.5b — the one failure the player cannot recover from, said out loud.
  //
  // Immobility on its own is a setback and is left to the disabled controls to convey.
  // This banner fires only when the sim says the loop is actually closed: no flagellum, no
  // ribosome bringing one, and not enough residues or ATP to fold one by hand. That is a
  // dead run, and a dead run that presents as unresponsive buttons is the worst possible
  // way to end a session.
  const strandedEl = document.getElementById('stranded');
  if (strandedEl) {
    strandedEl.style.display = s.stranded ? 'block' : 'none';
    if (s.stranded) {
      const bill = 'gly 4 · ala 3 · val 3 · leu 4';
      strandedEl.textContent =
        `STRANDED — no flagellum, and nothing can build one. A flagellum costs ${bill} and 56 ATP; ` +
        `you have neither the residues nor a ribosome covering the empty tile. Site ribosomes so their ` +
        `circles overlap the membrane, and keep a residue buffer — the motor is the one protein whose ` +
        `loss you cannot walk off.`;
    }
  }

  // §9.5 — a standing readout of the repair crew. Hovering each one works, but "is
  // anything being maintained right now" should be answerable without hunting.
  const ribo = document.getElementById('ribo');
  if (ribo) {
    ribo.innerHTML = '';
    if (s.ribosomes.length === 0) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = 'no ribosomes — repairs are yours to do by hand';
      ribo.appendChild(chip);
    } else {
      const busy = s.ribosomes.filter((r) => r.job).length;
      const stalled = s.ribosomes.filter((r) => r.blockedOn).length;
      const head = document.createElement('span');
      head.className = 'chip' + (stalled > 0 ? ' short' : '');
      head.textContent = `${s.ribosomes.length} ribosome${s.ribosomes.length === 1 ? '' : 's'} · ${busy} working${stalled ? ` · ${stalled} stalled` : ''}`;
      ribo.appendChild(head);
      if (s.vacancies.length > 0) {
        // Split the count, because "3 awaiting repair" hid the case that matters: one of
        // them may be somewhere no ribosome will ever reach, and that one is not waiting
        // for anything.
        const orphaned = s.vacancies.filter((v) => !v.covered).length;
        const v = document.createElement('span');
        v.className = 'chip short';
        v.textContent =
          orphaned > 0
            ? `${s.vacancies.length} awaiting repair · ${orphaned} OUT OF RIBOSOME REACH`
            : `${s.vacancies.length} awaiting repair`;
        v.title = orphaned > 0
          ? 'A vacancy no ribosome covers is never repaired. Site a ribosome within reach of it, or fold the protein by hand.'
          : '';
        ribo.appendChild(v);
      }
      for (const r of s.ribosomes) {
        if (!r.job) continue;
        const chip = document.createElement('span');
        chip.className = 'chip' + (r.blockedOn ? ' short' : '');
        chip.textContent = r.blockedOn
          ? `${r.job}: needs ${r.blockedOn}`
          : `${r.job} ${(r.progress * 100).toFixed(0)}%`;
        ribo.appendChild(chip);
      }
    }
  }

  // Residue pool, flagging any type the current build still needs but cannot cover.
  const pool = document.getElementById('pool')!;
  pool.innerHTML = '';
  const remaining = new Map<string, number>();
  if (s.build.phase === 'assembling') {
    for (let i = s.build.chain.length; i < s.build.sequence.length; i++) {
      const r = s.build.sequence[i]!;
      remaining.set(r, (remaining.get(r) ?? 0) + 1);
    }
  }
  // §5a — the satchel. What the bot is CARRYING is what construction can actually spend,
  // so it is shown separately from what is loose in the cell: a cell full of lysine and an
  // empty satchel is a stall, and those two numbers being merged is what would hide it.
  const sat = document.getElementById('satchel')!;
  sat.innerHTML = '';
  const carried = new Map<string, number>();
  for (const it of s.satchel.items) {
    const n = nameById[it.species] ?? '';
    carried.set(n, (carried.get(n) ?? 0) + it.amount);
  }
  const label = document.createElement('span');
  label.className = 'chip';
  label.textContent = `satchel ${s.satchel.items.length}/${s.satchel.capacity}`;
  sat.appendChild(label);
  for (const [n, amt] of carried) {
    const look = LOOK[n];
    if (!look) continue;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<i style="background:${look.colour}"></i>${n} <b>${amt.toFixed(1)}</b>`;
    sat.appendChild(chip);
  }

  // ── §5b: the residue inventory ────────────────────────────────────────────
  //
  // A COUNT, always on screen, never a function of zoom or camera or cell volume. Every
  // previous version of this made "how much glycine do I have" a question you answered by
  // looking at the cytoplasm and estimating — and the answer changed when you scrolled the
  // wheel. One residue is one peptide bond, so the number here is exactly how many more
  // you can place.
  for (const type of RESIDUES) {
    const have = s.residues[type] ?? 0;
    const need = remaining.get(type) ?? 0;
    const look = LOOK[type]!;
    const short = need > have;

    const chip = document.createElement('span');
    chip.className = 'chip' + (short ? ' short' : '');

    // The swatch is the residue's own shape, drawn through the renderer's own function so
    // the legend, the picker and the inventory can never disagree about what a lysine
    // looks like.
    const sw = document.createElement('canvas');
    sw.width = 16;
    sw.height = 16;
    sw.style.verticalAlign = 'middle';
    sw.style.marginRight = '4px';
    const sc = sw.getContext('2d')!;
    sc.fillStyle = look.colour;
    sc.beginPath();
    addShape(sc, look.shape, 8, 8, 6);
    sc.fill();
    chip.appendChild(sw);

    const txt = document.createElement('span');
    // "have/need" only while a build is asking for that type — otherwise just the stock.
    txt.innerHTML = need > 0
      ? `${type} <b>${have}</b><span style="opacity:.6">/${need}</span>`
      : `${type} <b>${have}</b>`;
    chip.appendChild(txt);
    pool.appendChild(chip);
  }
}

function hud(): void {
  if (!s) return;
  // ATP against its CEILING. A bare number cannot tell "full" from "stalled" — both are
  // a figure that stopped moving — and they call for opposite responses. §12.4 treats a
  // full battery as the intro's cliffhanger, which only lands if you can see it is full.
  const atpEl = document.getElementById('atpv')!;
  const capEl = document.getElementById('atpcap')!;
  const atpBar = document.getElementById('atpbar') as HTMLElement;
  const frac = s.atpCapacity > 0 ? s.atp / s.atpCapacity : 0;
  const full = frac > 0.97;
  atpEl.textContent = s.atp.toFixed(0);
  atpEl.style.color = s.atp < 12 ? '#ff7a7a' : full ? '#8ef0a6' : '#ffe98a';
  capEl.textContent = ` / ${s.atpCapacity.toFixed(0)}${full ? ' — FULL' : ''}`;
  atpBar.style.width = `${Math.min(100, frac * 100)}%`;
  atpBar.style.background = s.atp < 12 ? '#e2504a' : full ? '#6fe3a0' : '#ffe98a';
  document.getElementById('volv')!.textContent = s.volume.toFixed(0);
  const bar = document.getElementById('tbar') as HTMLElement;
  bar.style.width = `${s.tension * 100}%`;
  bar.style.background = s.tension > 0.8 ? '#e2504a' : s.tension > 0.5 ? '#e0a020' : '#6fbf6a';
  (document.getElementById('bleb') as HTMLButtonElement).disabled = s.tension < 0.55;
  (document.getElementById('cancel') as HTMLButtonElement).disabled = s.build.phase === 'idle';
  // Only offer "release" for something that actually gets released.
  //
  // §9.5 — a ribosome is cytoplasmic and is released exactly like an enzyme. Gating this
  // on 'enzyme' alone left a folded ribosome with no way to be placed at all: it is not a
  // membrane protein, so clicking the wall did nothing either.
  const releaseBtn = document.getElementById('release') as HTMLButtonElement;
  const canRelease =
    s.bot.carrying && (s.build.productKind === 'enzyme' || s.build.productKind === 'ribosome');
  releaseBtn.textContent =
    s.build.productKind === 'ribosome' ? 'Release ribosome here' : 'Release enzyme here';
  releaseBtn.disabled = !canRelease;
  // Enabled is not the same as noticeable. This is the only moment the button matters,
  // so it should be the thing on screen that is asking to be pressed.
  releaseBtn.classList.toggle('urgent', canRelease);

  // Same for the bleb: §10.4 calls it the survivable third act, which only works if the
  // player sees the escape while the tension meter is climbing.
  const blebBtn = document.getElementById('bleb') as HTMLButtonElement;
  blebBtn.classList.toggle('urgent', s.tension >= 0.55 && !s.lysed);
}

// ── the loop ─────────────────────────────────────────────────────────────────

let lastT = performance.now();
let fps = 0;
let fpsAccum = 0;
let fpsFrames = 0;
/** Panels touch the DOM; the DOM is slow. Rebuild them at 10 Hz, not 60. */
let lastPanels = 0;

function loop(now: number): void {
  // §2.4's third pair: the sim clock is truth, the render framerate is costume. The ooze
  // wants 60 fps; the grid solves at its own rate in another process entirely.
  const dt = Math.min(0.05, (now - lastT) / 1000);
  t += dt;
  lastT = now;

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
  }

  refreshHover();
  fx.step(dt, s?.health ?? 1);
  if (membrane && s && hello) {
    // Target area is the sim's VOLUME, converted to canvas px². §11.6: "pressure target
    // = volume" — so the shape on screen encloses the number the HUD is showing.
    const k = tilePx();
    membrane.step(dt, {
      targetArea: s.volume * k * k,
      tension: s.tension,
      health: s.health,
      lysed: s.lysed,
      // Velocity in canvas px/s, so the membrane can drag and ripple against its own
      // motion (§11.6a). The cell is pinned to the centre of the view, so without this
      // swimming has no effect on the shape at all.
      vx: s.motility.vx * k,
      vy: s.motility.vy * k,
    });
  }
  draw();
  hud();
  // The original rebuilt every bead and every pool chip with innerHTML + createElement on
  // every animation frame — sixty full DOM teardowns a second for values that change a
  // few times a second at most.
  if (now - lastPanels > 100) {
    lastPanels = now;
    panels();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ── input ────────────────────────────────────────────────────────────────────

/**
 * One click does one of two things, and which one is the §9.2 step 5 distinction:
 * carrying a folded protein makes the click a DEPLOY, otherwise it is a MOVE.
 *
 * The server re-checks every predicate — reachability, membrane-ness, tension — so this
 * is a convenience, not an authority.
 */
canvas.addEventListener('click', (ev) => {
  if (!s || !hello) return;
  // A drag is not a click. Without this, panning ended by walking the nanobot to
  // wherever the drag finished — which is why panning felt broken rather than absent.
  if (dragged > 5) return;
  const rect = canvas.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * W;
  const py = ((ev.clientY - rect.top) / rect.height) * H;
  const p = toTile(px, py);

  // Carrying a MEMBRANE PROTEIN (transporter or flagellum): a click on or near the
  // membrane seats it there; a click anywhere else WALKS THE BOT.
  //
  // That second half is the whole point and the original omitted it — every click while
  // carrying was a deploy, so once a protein folded the bot was stranded wherever it had
  // gathered its residues and could never reach the membrane. The server refused, quite
  // correctly, and the player had no way to fix it. §9.2 step 5 says a transporter "must
  // be CARRIED to a membrane tile"; carrying means walking.
  if (s.bot.carrying && seatsInMembrane(s.build.productKind)) {
    let tile = Math.floor(p.y) * hello.worldWidth + Math.floor(p.x);
    let bestD = gateSet.has(tile) ? 0 : Infinity;
    if (bestD !== 0) {
      // Snap to the nearest real membrane tile, so a click near the ring does what the
      // player obviously meant rather than failing on a half-tile miss. The server still
      // re-checks membrane-ness and reach — this is convenience, not authority.
      for (const m of gateList) {
        const mx = (m % hello.worldWidth) + 0.5;
        const my = Math.floor(m / hello.worldWidth) + 0.5;
        const d = Math.hypot(mx - p.x, my - p.y);
        if (d < bestD) { bestD = d; tile = m; }
      }
    }

    if (bestD <= 3) {
      // Aiming at the membrane. Walk there first if out of reach, so one click always
      // makes progress instead of bouncing off a refusal.
      const tx = (tile % hello.worldWidth) + 0.5;
      const ty = Math.floor(tile / hello.worldWidth) + 0.5;
      if (Math.hypot(s.bot.x - tx, s.bot.y - ty) > 2.6) {
        pendingDeployTile = tile;
        send({ t: 'command', cmd: { op: 'moveTo', x: p.x, y: p.y } });
        setStatus('Walking the protein over to seat it…');
      } else {
        pendingDeployTile = null;
        send({ t: 'command', cmd: { op: 'deploy', tile } });
      }
      return;
    }
    // Not aiming at the membrane at all — just move.
    pendingDeployTile = null;
    send({ t: 'command', cmd: { op: 'moveTo', x: p.x, y: p.y } });
    return;
  }

  // Clicking a seated transporter GATES it (§6.3), rather than walking the bot into the
  // wall. This is the cell's only self-regulation: with more channels than consumers,
  // solute accumulates, volume climbs, and without a way to shut a pore there is nothing
  // the player can do about it but watch. A gate is a conformational change — free,
  // instant, reversible — so it costs nothing but the decision.
  // §5a — clicking a grain picks it up. Checked BEFORE the transporter gate and before
  // the plain move, because a grain is the smallest thing on screen and the most
  // specifically aimed at: if the player has put the cursor on one, that is what they
  // meant. Walking is the fallback, not the other way round.
  if (!s.bot.carrying) {
    let best: (typeof s.grains)[number] | null = null;
    let bestD = 1.4;
    for (const g of s.grains) {
      const d = Math.hypot(g.x - p.x, g.y - p.y);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) {
      const reach = Math.hypot(best.x - s.bot.x, best.y - s.bot.y);
      if (reach <= 3) {
        send({ t: 'command', cmd: { op: 'pickUp', grain: best.id } });
      } else {
        // Out of reach: walk there. One click always makes progress rather than bouncing
        // off a refusal — the same rule the membrane-seating path already follows.
        send({ t: 'command', cmd: { op: 'moveTo', x: best.x, y: best.y } });
        setStatus('Walking over to pick that up…');
      }
      return;
    }
  }

  if (!s.bot.carrying) {
    for (const tr of s.transporters) {
      const tx = (tr.tile % hello.worldWidth) + 0.5;
      const ty = Math.floor(tr.tile / hello.worldWidth) + 0.5;
      if (Math.hypot(tx - p.x, ty - p.y) <= 1.6) {
        send({ t: 'command', cmd: { op: 'gate', tile: tr.tile, open: tr.closed } });
        setStatus(
          tr.closed
            ? 'Channel opened. Transport resumes down its gradient.'
            : 'Channel gated shut. Nothing crosses but the bare bilayer leak — this is how you stop importing something you are drowning in (§6.3).',
        );
        return;
      }
    }
  }

  // Carrying an ENZYME, or carrying nothing: clicking always moves. An enzyme is
  // released by its own button or a double-click, because "click to walk" and "click to
  // drop" cannot both be the same gesture without one of them surprising you.
  send({ t: 'command', cmd: { op: 'moveTo', x: p.x, y: p.y } });
});

document.getElementById('bleb')!.addEventListener('click', () => {
  send({ t: 'command', cmd: { op: 'bleb' } });
});
/**
 * Double-click releases a carried enzyme where the nanobot is standing.
 *
 * A side button was the only way to do this, and the first person to play it went looking
 * for one after the canvas label sent them to the membrane. Single-click has to stay
 * "walk", because positioning the enzyme near its substrate is the actual decision
 * (§4.7) — so the drop needs a second gesture, and double-click is the one people try.
 * The button stays for discoverability and for anyone who cannot double-click.
 */
/**
 * Smooth wheel zoom, anchored under the cursor so the thing you are pointing at stays
 * put. §3.5 makes zoom the game's identity — "moving between scales is core" — so it
 * should feel continuous rather than stepping between two fixed magnifications.
 */
canvas.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    if (!hello) return;
    const rect = canvas.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const py = ((ev.clientY - rect.top) / rect.height) * H;
    const before = toTile(px, py);

    const factor = Math.exp(-ev.deltaY * 0.0015);
    cam.targetZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.targetZoom * factor));
    cam.zoom = cam.targetZoom;

    // Re-anchor so the world point under the cursor does not move.
    const k = tilePx();
    cam.x = px - before.x * k;
    cam.y = py - before.y * k;
    clampCamera();
    rebuildForZoom();
  },
  { passive: false },
);

/**
 * Hover inspection. §2.1 says the numbers are the truth and §11.4 explicitly wants
 * "numbers on hover" — but nothing was inspectable, so every entity on screen was a
 * coloured shape you had to already know the meaning of.
 */
let hover: { x: number; y: number; lines: string[] } | null = null;

function inspectAt(p: { x: number; y: number }): string[] | null {
  if (!s || !hello) return null;

  // §9.5 — a ribosome had no inspector at all, so "is it working?" was unanswerable.
  for (const r of s.ribosomes) {
    const rx = (r.tile % hello.worldWidth) + 0.5;
    const ry = Math.floor(r.tile / hello.worldWidth) + 0.5;
    if (Math.hypot(rx - p.x, ry - p.y) > 2) continue;

    // What it is responsible for: everything within its reach.
    const W2 = hello.worldWidth;
    const reach = s.ribosomeReach;
    const near = (t: number): boolean =>
      Math.hypot((t % W2) - rx, Math.floor(t / W2) - ry) <= reach;
    const covered =
      s.transporters.filter((t) => near(t.tile)).length +
      s.enzymes.filter((e) => near(e.tile)).length;
    const waiting = s.vacancies.filter((v) => near(v.tile)).length;

    return [
      'ribosome',
      r.job
        ? r.blockedOn
          ? `building ${r.job} — STALLED, needs ${r.blockedOn}`
          : `building ${r.job} — ${(r.progress * 100).toFixed(0)}%`
        : waiting > 0
          ? `${waiting} repair(s) waiting but none in reach`
          : 'idle — nothing within reach has failed',
      `maintaining ${covered} protein(s) within ${s.ribosomeReach} tiles`,
      'it rebuilds what fails near it; where you put it decides what survives (§9.5)',
    ];
  }

  for (const tr of s.transporters) {
    const tx = (tr.tile % hello.worldWidth) + 0.5;
    const ty = Math.floor(tr.tile / hello.worldWidth) + 0.5;
    if (Math.hypot(tx - p.x, ty - p.y) > 1.6) continue;
    const name = nameById[tr.species] ?? '?';

    // §5b — a residue transporter is an INSERTER, not a channel, and must not be described
    // as one. It reported `flux = 0` and the client said "at equilibrium", which is the
    // single most misleading thing available: an inserter has no equilibrium, it is either
    // in range of its deposit or it is not, and "equilibrium" tells the player to stop
    // looking for the reason. This says which, and how far away the answer is.
    // §5b.6/§5b.8 — the membrane runs three idioms now, and each needs its own words.
    // Calling any of them "at equilibrium" is wrong: a port is in range or it is not, and
    // an extractor is keeping up or it is not. Neither has an equilibrium.
    if (name === 'lactate') {
      const rate = Math.abs(tr.flux);
      return [
        `lactate carrier${tr.closed ? ' — GATED SHUT' : ''}`,
        tr.closed
          ? 'gated shut — waste is piling up'
          : rate > 0.05
            ? `exporting ${rate.toFixed(2)} particles/s`
            : 'idle — no waste has reached it yet',
        'saturable: a hard Vmax, so two carriers beat one placed better (§6.4, §12.3)',
        'click to gate open/shut',
      ];
    }

    if (RESIDUES.includes(name as never) || name === 'glucose') {
      // The nearest deposit of this species, not the first in the list — glucose has three
      // and reporting range to the wrong one is exactly the bug this text is describing.
      let dep: (typeof s.patches)[number] | undefined;
      let bestD = Infinity;
      for (const q of s.patches) {
        if (q.species !== tr.species || q.hostile) continue;
        const dd = Math.hypot(q.x - s.motility.x, q.y - s.motility.y);
        if (dd < bestD) { bestD = dd; dep = q; }
      }
      const gap = dep
        ? Math.max(0, Math.hypot(dep.x - s.motility.x, dep.y - s.motility.y) - hello.cellRadius)
        : Infinity;
      const inRange = dep !== undefined && gap < dep.harvestRadius;
      const rate = Math.abs(tr.flux);
      return [
        `${name} ${name === 'glucose' ? 'channel' : 'transporter'}${tr.closed ? ' — GATED SHUT' : ''}`,
        tr.closed
          ? 'gated shut — passing nothing'
          : inRange
            ? `drawing ${rate.toFixed(2)} particles/s`
            : `OUT OF RANGE — nothing to draw from here`,
        inRange
          ? `deposit holds ${dep!.remaining} more`
          : dep
            ? `the ${name} deposit is ${gap.toFixed(0)} tiles beyond reach — swim closer`
            : `no ${name} deposit known`,
        'it pulls whole residues into your inventory; there is no gradient (§5b)',
      ];
    }

    const dir = tr.flux > 0.01 ? 'exporting' : tr.flux < -0.01 ? 'importing' : 'at equilibrium';
    return [
      `${name} ${tr.kind}${tr.closed ? ' — GATED SHUT' : ''}`,
      tr.closed ? 'passing nothing but the bilayer leak' : `${dir} ${Math.abs(tr.flux).toFixed(2)}/s`,
      tr.kind === 'carrier'
        ? 'saturable: a hard Vmax ceiling (§6.4)'
        : 'open pore: uncapped, and refluxes if the gradient turns (§6.3)',
      'click to gate open/shut',
    ];
  }

  for (const e of s.enzymes) {
    const ex = (e.tile % hello.worldWidth) + 0.5;
    const ey = Math.floor(e.tile / hello.worldWidth) + 0.5;
    if (Math.hypot(ex - p.x, ey - p.y) > 1.8) continue;
    return [
      'glycolysis enzyme',
      e.occupied ? 'active site occupied — cracking' : 'active site free — waiting for glucose',
      '1 glucose → 2 ATP + 2 lactate',
      'a catalyst: never consumed (§8.1)',
    ];
  }

  if (Math.hypot(s.bot.x - p.x, s.bot.y - p.y) < 2) {
    return [
      'the nanobot — you',
      s.bot.carrying ? 'carrying a folded protein' : 'idle',
      'the only assembler this cell has, until a ribosome (§1.2)',
    ];
  }

  if (Math.hypot(s.nucleus.x - p.x, s.nucleus.y - p.y) < s.nucleus.r + 1) {
    return ['nucleus — the blueprint library', 'bring the nanobot here to take a gene (§9.2)'];
  }

  // §5a — name the bead under the cursor. Shape carries identity at a glance, but five
  // residues is past what any glyph set settles instantly, and the answer to "which one is
  // that" should never be "count the sides".
  {
    let best: (typeof s.grains)[number] | null = null;
    let bestD = 1.4;
    for (const g of s.grains) {
      const d = Math.hypot(g.x - p.x, g.y - p.y);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) {
      const name = nameById[best.species] ?? '?';
      const reach = Math.hypot(best.x - s.bot.x, best.y - s.bot.y);
      const lines = [`${name} — ${best.amount.toFixed(2)} units`];
      if (RESIDUES.includes(name as never)) {
        lines.push(`${(best.amount / 0.25).toFixed(0)} peptide bonds' worth (§9.2)`);
      } else if (name === 'glucose') {
        lines.push('fuel — an enzyme cracks it into 2 ATP and 2 lactate per molecule');
      } else if (name === 'lactate') {
        lines.push('waste — osmotically active, and it is what swells the cell (§7.2)');
      }
      lines.push(reach <= 3 ? 'click to pick it up' : 'click to walk over and pick it up');
      return lines;
    }
  }

  // Nothing specific under the cursor, so report the FIELD there. §11.4 asks for
  // "numbers on hover", and this is the version that matters: the dots are the game's
  // primary visual and there was no way to ask what any of them were. Reading
  // concentrations straight off the last received frame also makes the §2.1 claim
  // checkable by hand — the picture and the number come from the same bytes.
  if (frame && hello) {
    const gx = Math.floor((p.x - frame.originX) / frame.lod);
    const gy = Math.floor((p.y - frame.originY) / frame.lod);
    if (gx >= 0 && gy >= 0 && gx < frame.width && gy < frame.height) {
      const cell = gy * frame.width + gx;
      const inside = isInterior(Math.floor(p.x), Math.floor(p.y));
      const readings: Array<{ name: string; c: number }> = [];
      frame.speciesIds.forEach((id, k) => {
        const c = frame!.data[k * frame!.width * frame!.height + cell] ?? 0;
        if (c > 0.002) readings.push({ name: nameById[id] ?? String(id), c });
      });
      readings.sort((a, b) => b.c - a.c);

      const where = inside ? 'cytoplasm' : 'extracellular medium';
      if (readings.length === 0) return [where, 'nothing measurable here'];
      return [
        `${where} · tile ${gx},${gy}`,
        ...readings.slice(0, 5).map((r) => `${r.name}  ${r.c.toFixed(3)}`),
        readings.length > 5 ? `+${readings.length - 5} more` : 'concentration, not amount (§7.1)',
      ];
    }
  }

  return null;
}

/**
 * Panning. Right-drag, middle-drag, or shift-drag — and ANY drag is a pan rather than a
 * click once it passes a small threshold.
 *
 * The first version only accepted middle or shift, which meant an ordinary left-drag did
 * nothing except fire a `click` on release — so trying to pan walked the nanobot to
 * wherever you let go. That reads as "pan is broken" and is worse than having no pan at
 * all, because it silently does something else.
 */
let panning = false;
let dragged = 0;
let panFrom = { x: 0, y: 0, camX: 0, camY: 0 };

canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

canvas.addEventListener('pointerdown', (ev) => {
  dragged = 0;
  // Right and middle always pan. Left starts as a potential click and promotes to a pan
  // the moment it moves — see pointermove.
  if (ev.button === 2 || ev.button === 1 || ev.shiftKey) {
    ev.preventDefault();
    panning = true;
  }
  panFrom = { x: ev.clientX, y: ev.clientY, camX: cam.x, camY: cam.y };
  canvas.setPointerCapture(ev.pointerId);
});
/** Last pointer position in canvas space, so hover can be re-tested as the world moves. */
let pointer: { x: number; y: number } | null = null;

canvas.addEventListener('pointermove', (ev) => {
  const rect = canvas.getBoundingClientRect();
  // Separate scales for x and y. They are equal whenever the element keeps its aspect
  // ratio, but assuming that is what broke hover: deriving y from the x scale silently
  // skews every vertical hit test the moment the element is stretched.
  const sx = W / rect.width;
  const sy = H / rect.height;

  if (ev.buttons !== 0) {
    dragged = Math.max(dragged, Math.hypot(ev.clientX - panFrom.x, ev.clientY - panFrom.y));
    // A left-drag promotes to a pan once it clearly is one. Below the threshold it stays
    // a click, so a slightly shaky click still walks the bot as intended.
    if (!panning && dragged > 5) panning = true;
  }

  if (panning) {
    cam.x = panFrom.camX + (ev.clientX - panFrom.x) * sx;
    cam.y = panFrom.camY + (ev.clientY - panFrom.y) * sx;
    clampCamera();
    canvas.style.cursor = 'grabbing';
    hover = null;
    return;
  }

  pointer = { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
});

canvas.addEventListener('pointerleave', () => {
  pointer = null;
  hover = null;
});

/**
 * Re-test the hover every frame rather than only on pointermove.
 *
 * Everything under the cursor moves on its own — the bot walks, the membrane oozes, the
 * enzyme's active site opens and closes — so a tooltip computed once at mouse-move time
 * goes stale the instant anything happens, and stops matching what is under the pointer.
 */
function refreshHover(): void {
  if (!pointer || panning) return;
  const lines = inspectAt(toTile(pointer.x, pointer.y));
  hover = lines ? { x: pointer.x, y: pointer.y, lines } : null;
  canvas.style.cursor = lines ? 'pointer' : 'crosshair';
}
canvas.addEventListener('pointerup', () => {
  panning = false;
  canvas.style.cursor = 'crosshair';
});

/** Keep at least part of the world on screen, so you cannot lose the cell entirely. */
function clampCamera(): void {
  if (!hello) return;
  const k = tilePx();
  const worldW = hello.worldWidth * k;
  const worldH = hello.worldHeight * k;
  cam.x = Math.min(W * 0.35, Math.max(W * 0.65 - worldW, cam.x));
  cam.y = Math.min(H * 0.35, Math.max(H * 0.65 - worldH, cam.y));
}

/**
 * Zoom changes px-per-tile, so the soft body and the dot positions — both cached in px —
 * have to be rebuilt. Cheap, and only on an actual zoom change rather than every frame.
 */
/** px-per-tile the cached positions were last built at, so a zoom can rescale them. */
let builtAtK = 0;

function rebuildForZoom(): void {
  if (!hello) return;
  const k = tilePx();
  if (builtAtK <= 0) {
    builtAtK = k;
    return;
  }
  // RESCALE, do not rebuild. World → px is a pure multiply, so a zoom is a uniform scale
  // about the origin; doing it in place keeps every velocity, phase and tether intact.
  // Rebuilding reset the membrane to rest on every wheel notch and left the dots sliding
  // across the cell toward their new homes.
  const factor = k / builtAtK;
  builtAtK = k;
  membrane?.rescale(factor);
  fx.rescale(factor);

  // §3.5: the zoom level IS the grid resolution. Ask for finer data as you go in, coarser
  // as you pull out — the magnification is continuous, the subscription steps.
  const wantLod = cam.zoom >= 1 ? 1 : 2;
  if (wantLod !== lod) {
    lod = wantLod;
    subscribe();
  }
}

canvas.addEventListener('dblclick', (ev) => {
  ev.preventDefault();
  if (!s?.bot.carrying) return;
  if (s.build.productKind !== 'enzyme' && s.build.productKind !== 'ribosome') return;
  send({ t: 'command', cmd: { op: 'deploy' } });
});

/**
 * Steer by right-clicking a destination, since left-click already means "walk the
 * nanobot" and the two are genuinely different verbs: one moves your hands inside the
 * cell, the other moves the whole cell through the world.
 */
canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 2 || !s || !hello || s.motility.flagella.length === 0) return;
  const rect = canvas.getBoundingClientRect();
  const p = toTile(((ev.clientX - rect.left) / rect.width) * W, ((ev.clientY - rect.top) / rect.height) * H);
  // Heading is measured from the CELL, which sits at the centre of its own window.
  const heading = Math.atan2(p.y - hello.worldHeight / 2, p.x - hello.worldWidth / 2);
  send({ t: 'command', cmd: { op: 'steer', heading } });
  setStatus('Swimming. Every firing flagellum costs 3.6 ATP/s — this is ATP you are not building with (§10A.1).');
});

document.getElementById('stop')!.addEventListener('click', () => {
  // Coasting is free, and that is the whole trade: at cell scale there is no momentum, so
  // stopping is instant and costs nothing.
  send({ t: 'command', cmd: { op: 'steer', heading: null } });
  send({ t: 'command', cmd: { op: 'chemotaxis', species: null } });
});

/**
 * Which deposit the cell is steering for. §10A.3 senses a gradient; §5b.11 adds a bearing
 * for deposits too far away to smell, so this is a TARGET picker rather than an on/off
 * switch — a cell that can only ever seek glucose cannot go and get lysine, which is the
 * one thing §12.3's squeeze requires.
 */
function buildSeekTargets(): void {
  const box = document.getElementById('seektargets')!;
  box.innerHTML = '';
  for (const name of ['glucose', ...RESIDUES] as const) {
    const look = LOOK[name];
    if (!look) continue;
    const b = document.createElement('button');
    b.id = `seek_${name}`;
    b.title = `steer toward the ${name} deposit`;
    b.style.cssText =
      'flex:1;min-width:38px;padding:3px 0;font-size:10px;border-radius:4px;cursor:pointer';
    b.textContent = name === 'glucose' ? 'glu' : name;
    b.addEventListener('click', () => {
      const id = speciesByName[name];
      if (id === undefined) return;
      const already = s?.motility.chemotaxis === id;
      send({ t: 'command', cmd: { op: 'chemotaxis', species: already ? null : id } });
      setStatus(
        already
          ? 'Course cleared — steering is yours again.'
          : `Steering for the ${name} deposit. Close in, the cell follows the gradient itself ` +
            `(§10A.3); far out it holds a bearing, because a deposit seven sigma away has no ` +
            `gradient to follow. Hostile patches bend the route either way.`,
      );
    });
    box.appendChild(b);
  }
}

function paintSeekTargets(): void {
  for (const name of ['glucose', ...RESIDUES] as const) {
    const el = document.getElementById(`seek_${name}`) as HTMLButtonElement | null;
    if (!el) continue;
    const id = speciesByName[name];
    const on = s?.motility.chemotaxis !== undefined && s?.motility.chemotaxis === id;
    const colour = LOOK[name]?.colour ?? '#9aa8c0';
    el.style.background = on ? colour : 'rgba(255,255,255,0.05)';
    el.style.color = on ? '#0d1117' : colour;
    el.style.border = `1px solid ${on ? colour : 'rgba(255,255,255,0.12)'}`;
    el.style.fontWeight = on ? '700' : '400';
    el.disabled = !s || s.motility.flagella.length === 0;
    // A DISABLED CONTROL MUST SAY WHY. Greying these out on `flagella.length === 0` and
    // stopping there is what made the hard lock feel like a bug rather than a state: the
    // buttons simply stopped responding, and nothing on screen connected that to the
    // flagellum that had quietly denatured some minutes earlier.
    el.title = el.disabled
      ? 'No flagellum — the cell cannot swim. Fold one (14 residues, 56 ATP) and seat it in the membrane.'
      : `Steer toward ${name}`;
  }
}

document.getElementById('chemo')!.addEventListener('click', () => {
  send({ t: 'command', cmd: { op: 'chemotaxis', species: null } });
  setStatus('Course cleared — steering is yours again.');
});

/**
 * §10A.9 — hand target selection to the cell.
 *
 * The seeker chases whichever resource it is closest to FAILING to resupply in time —
 * runway minus travel, not simply the smallest pile — so it will leave a half-drained
 * glycine deposit to go and eat when glucose's deadline gets nearer than glycine's.
 */
document.getElementById('autoseek')!.addEventListener('click', () => {
  const on = !(s?.motility.autoSeek ?? false);
  send({ t: 'command', cmd: { op: 'autoSeek', on } });
  setStatus(
    on
      ? 'Auto-seek on — the cell heads for whichever stock is lowest, and moves on as the counts change.'
      : 'Auto-seek off — the last course it set is still held; clear it with Seek.',
  );
});


document.getElementById('release')!.addEventListener('click', () => {
  // §9.2 step 5's other half: an enzyme is released into the cytoplasm wherever the bot
  // is standing. Its own button, so that clicking the canvas can stay unambiguously
  // "walk here" even while carrying.
  send({ t: 'command', cmd: { op: 'deploy' } });
});
document.getElementById('cancel')!.addEventListener('click', () => {
  send({ t: 'command', cmd: { op: 'cancelBuild' } });
});
// The wheel handles zoom now, so this button's job is getting you un-lost.
document.getElementById('zoom')!.addEventListener('click', () => {
  cam.zoom = 1;
  cam.targetZoom = 1;
  cam.x = 0;
  cam.y = 0;
  rebuildForZoom();
});
