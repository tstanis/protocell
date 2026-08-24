/**
 * Dot stability. SPEC.md §11.1, §11.2.
 *
 * This exists because the same class of bug shipped twice, and both times it looked like
 * the cytoplasm was circulating when nothing was:
 *
 *   1. Dot `n` was reassigned to whatever tile the accumulator emitted n-th, so as the
 *      field shifted every dot eased to a completely different tile. A constant swirl.
 *   2. After fixing that, re-homed dots still set their TARGET without resetting their
 *      POSITION — so the few dots whose tile emptied each frame streaked across the cell
 *      while everything else sat still. A tornado.
 *
 * The invariant that kills both: **between two frames, no dot may travel far**. A dot
 * either stays where it is, or it despawns and a new one appears — never a smooth glide
 * from one side to the other, because that is the visual language of FLOW and nothing is
 * flowing.
 */

import { describe, expect, it } from 'vitest';
import { FieldRenderer, LOOK } from '../src/render.js';
import type { FieldFrame } from '@protocell/protocol';

const WIDTH = 40;
const HEIGHT = 40;
const TILE_PX = 8;
const GLU_ID = 0;

/** Interior = a disc, matching the client's own test for the intro cell. */
const isInterior = (x: number, y: number): boolean =>
  Math.hypot(x + 0.5 - WIDTH / 2, y + 0.5 - HEIGHT / 2) < 15;

function frameFrom(fill: (x: number, y: number) => number): FieldFrame {
  const data = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) data[y * WIDTH + x] = fill(x, y);
  }
  return {
    tick: 0,
    lod: 1,
    width: WIDTH,
    height: HEIGHT,
    originX: 0,
    originY: 0,
    speciesIds: [GLU_ID],
    data,
  };
}

const names = { [GLU_ID]: 'glucose' } as Record<number, string>;

/** Snapshot every live dot position. */
function positions(fx: FieldRenderer): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pools = (fx as any).pools as Map<string, Array<{ x: number; y: number }>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const live = (fx as any).live as Map<string, number>;
  for (const [name, pool] of pools) {
    const n = live.get(name) ?? 0;
    for (let i = 0; i < n; i++) out.push({ x: pool[i]!.x, y: pool[i]!.y });
  }
  return out;
}

function maxTravel(a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>): number {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    m = Math.max(m, Math.hypot(b[i]!.x - a[i]!.x, b[i]!.y - a[i]!.y));
  }
  return m;
}

describe('dot identity is stable', () => {
  it('a steady field leaves every dot where it was', () => {
    const fx = new FieldRenderer();
    const f = frameFrom(() => 0.4);
    fx.ingest(f, names, TILE_PX, isInterior);
    const before = positions(fx);
    fx.ingest(f, names, TILE_PX, isInterior);
    expect(before.length).toBeGreaterThan(50);
    expect(maxTravel(before, positions(fx))).toBe(0);
  });

  it('NO DOT GLIDES ACROSS THE CELL as the field evolves', () => {
    // The regression test for both the swirl and the tornado.
    //
    // The measurement window matters, and getting it wrong makes this test worthless: a
    // repositioning happens inside `ingest`, but the GLIDE happened inside `step`, as the
    // tether pulled a dot toward a target on the far side over the following half second.
    // So travel is measured across the STEPS BETWEEN field updates — where a dot should
    // only ever be jittering. A snap at ingest is fine (that is despawn plus spawn); a
    // dot in smooth transit across the cell is the artifact, and it is only visible here.
    const fx = new FieldRenderer();
    fx.ingest(frameFrom(() => 0.4), names, TILE_PX, isInterior);

    for (let n = 1; n <= 40; n++) {
      // A band of concentration sweeping across the cell, falling to GENUINELY ZERO
      // behind it. The zero matters: re-homing only fires once a dot's own tile is
      // essentially empty, so a field with a non-zero floor never exercises the path at
      // all — an earlier version of this test had a 0.15 floor and passed happily with
      // the bug reintroduced.
      const band = (n / 40) * WIDTH;
      fx.ingest(
        frameFrom((x) => 1.2 * Math.exp(-((x - band) ** 2) / 24)),
        names,
        TILE_PX,
        isInterior,
      );

      // Two render frames' worth of motion at 60fps between field updates at 30Hz.
      const settled = positions(fx);
      fx.step(1 / 60, 1);
      fx.step(1 / 60, 1);
      const after = positions(fx);

      // Jitter only. Anything approaching a tile per frame is transit, and the old code
      // reached most of the cell's width.
      expect(maxTravel(settled, after)).toBeLessThan(TILE_PX);
    }
  });

  it('respawns land near where the dot was, not somewhere arbitrary', () => {
    // `targets[i]` bears no relation to where dot i drifted to once re-homing has shuffled
    // the mapping, so a naive respawn can teleport a dot across the cell even when it
    // snaps rather than glides. Nearest-target keeps the change local.
    const fx = new FieldRenderer();
    fx.ingest(frameFrom(() => 0.5), names, TILE_PX, isInterior);
    const before = positions(fx);

    // Empty the left half entirely: every dot there must respawn somewhere.
    fx.ingest(frameFrom((x) => (x < WIDTH / 2 ? 0 : 0.5)), names, TILE_PX, isInterior);
    const after = positions(fx);

    const travelled = [];
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      travelled.push(Math.hypot(after[i]!.x - before[i]!.x, after[i]!.y - before[i]!.y));
    }
    const moved = travelled.filter((d) => d > 1);
    // Some dots must move — half the field emptied. The claim is that the typical move
    // is local rather than cross-cell.
    if (moved.length > 0) {
      const median = moved.sort((a, b) => a - b)[Math.floor(moved.length / 2)]!;
      expect(median).toBeLessThan(WIDTH * TILE_PX * 0.5);
    }
  });

  it('DOTS APPEAR WHERE THE FIELD GREW, not at the bottom of the cell', () => {
    // The order-driven version appended new dots at `targets[cur..want]`, and targets are
    // built in row-major order — so any rise in concentration appeared to fill the cell
    // from the bottom regardless of where it was actually produced. ATP made at an enzyme
    // in the middle showed up along the bottom edge, which is a §2.1 violation of the
    // plainest kind: the picture said one place, the field said another.
    const fx = new FieldRenderer();
    const cy = HEIGHT / 2;

    // A uniform background, so there is already a full pool to grow from.
    fx.ingest(frameFrom(() => 0.05), names, TILE_PX, isInterior);

    // Now add a bright source ABOVE centre — an "enzyme" at y = 14 of 40.
    const srcY = 14;
    fx.ingest(
      frameFrom((x, y) => 0.05 + 1.5 * Math.exp(-(((x - WIDTH / 2) ** 2 + (y - srcY) ** 2) / 8))),
      names,
      TILE_PX,
      isInterior,
    );

    // Where did the dots concentrate? Weight by how far above/below centre they sit.
    const pts = positions(fx);
    const nearSource = pts.filter(
      (p) => Math.hypot(p.x / TILE_PX - WIDTH / 2, p.y / TILE_PX - srcY) < 4,
    ).length;
    const bottomBand = pts.filter((p) => p.y / TILE_PX > cy + 8).length;

    // The source is a few tiles across and the background covers the whole disc, so this
    // is not asking for a majority — only that the source is genuinely denser than a
    // comparably sized patch of the bottom, which the bottom-fill bug reversed.
    expect(nearSource).toBeGreaterThan(8);
    expect(nearSource).toBeGreaterThan(bottomBand * 0.25);
  });

  it('dot count tracks concentration (§11.1) and respects the cap', () => {
    // Densities chosen to sit UNDER the cap, or the proportionality being tested is
    // hidden by the clamp — at 0.2 and 0.8 across a ~700-tile interior both saturate at
    // 300 and the test proves nothing.
    const fx = new FieldRenderer();
    fx.ingest(frameFrom(() => 0.02), names, TILE_PX, isInterior);
    const sparse = positions(fx).length;
    fx.ingest(frameFrom(() => 0.08), names, TILE_PX, isInterior);
    const dense = positions(fx).length;

    expect(sparse).toBeGreaterThan(10);
    expect(dense).toBeGreaterThan(sparse * 2); // ~4x the concentration, ~4x the dots
    expect(dense).toBeLessThanOrEqual(LOOK.glucose!.cap);

    // And the clamp still holds when the field genuinely floods.
    fx.ingest(frameFrom(() => 5), names, TILE_PX, isInterior);
    expect(positions(fx).length).toBeLessThanOrEqual(LOOK.glucose!.cap);
  });

  it('the Brownian walk stays tethered — jitter is not drift', () => {
    // §11.2's motion must read as thermal shimmer in place. Untethered, the same dots
    // read as a current.
    const fx = new FieldRenderer();
    fx.ingest(frameFrom(() => 0.4), names, TILE_PX, isInterior);
    const before = positions(fx);
    for (let i = 0; i < 600; i++) fx.step(1 / 60, 1);
    const after = positions(fx);

    let maxDrift = 0;
    for (let i = 0; i < before.length; i++) {
      maxDrift = Math.max(maxDrift, Math.hypot(after[i]!.x - before[i]!.x, after[i]!.y - before[i]!.y));
    }
    // Ten seconds of jitter, and nothing has wandered more than a tile or two.
    expect(maxDrift).toBeLessThan(TILE_PX * 3);
  });
});

/**
 * §11.3a — how MANY dots, and how often they are re-rolled.
 *
 * The quota rule that replaced the swirl/tornado version was spatially honest but
 * temporally unstable. It walked the interior in row-major order carrying a running
 * accumulator, awarding a dot whenever the sum crossed 1 — so a small change in ONE tile
 * shifted every later crossing onto a different tile, and a large fraction of the dot set
 * was despawned and respawned somewhere else on every received frame.
 *
 * Measured against a live mid-game cell: **22.6% of all dots respawned every frame**, and
 * for lactate it was 52%. That is the flashing. Nothing in the simulation was moving; the
 * renderer was re-rolling the picture 30 times a second.
 *
 * Quotas now come from a fixed per-tile dither of the tile's own concentration, so a tile
 * changes its dot count only when ITS OWN value crosses a threshold: measured churn fell
 * to 1.4%.
 */
describe('quotas are stable in time as well as space (§11.3a)', () => {
  it('a slowly drifting field re-rolls almost nothing', () => {
    const fx = new FieldRenderer();
    const at = (t: number) => frameFrom((x, y) => 0.6 + 0.02 * t + 0.05 * Math.sin((x + y) / 7));

    fx.ingest(at(0), names, TILE_PX, isInterior);
    const before = positions(fx);
    fx.ingest(at(1), names, TILE_PX, isInterior);
    const after = positions(fx);

    expect(before.length).toBeGreaterThan(20);

    // Count dots that kept their exact position. Under the accumulator this collapsed,
    // because the whole assignment shifted; under the dither, only tiles that genuinely
    // crossed a threshold change.
    const kept = new Set(after.map((p) => `${p.x},${p.y}`));
    const survived = before.filter((p) => kept.has(`${p.x},${p.y}`)).length;
    expect(survived / before.length).toBeGreaterThan(0.9);
  });

  it('an UNCHANGED field re-rolls nothing at all, however many times it arrives', () => {
    // The strongest form: identical input must give identical output forever. The
    // accumulator failed this only under drift, but this is the invariant that makes the
    // guarantee legible — and it catches any future use of Math.random in placement.
    const fx = new FieldRenderer();
    const f = frameFrom((x, y) => 0.3 + 0.2 * Math.sin(x / 5) * Math.cos(y / 4));
    fx.ingest(f, names, TILE_PX, isInterior);
    const first = positions(fx);
    for (let i = 0; i < 20; i++) fx.ingest(f, names, TILE_PX, isInterior);
    expect(maxTravel(first, positions(fx))).toBe(0);
    expect(positions(fx).length).toBe(first.length);
  });

  it('density still tracks concentration — the dither is unbiased', () => {
    // The stability must not have been bought by lying about how much is there. Doubling
    // the field must still roughly double the dots.
    // Concentrations in the range the cell actually runs at. The first draft used 0.55
    // and 1.1, which are both far above the cap at the new scale, so it compared two
    // CLAMPED counts and measured nothing — the ratio came out 0.96.
    const fx = new FieldRenderer();
    fx.ingest(frameFrom(() => 0.09), names, TILE_PX, isInterior);
    const single = positions(fx).length;
    fx.ingest(frameFrom(() => 0.18), names, TILE_PX, isInterior);
    const double = positions(fx).length;
    expect(double).toBeLessThan(LOOK.glucose!.cap); // genuinely unclamped, or this proves nothing

    expect(single).toBeGreaterThan(5);
    expect(double / single).toBeGreaterThan(1.7);
    expect(double / single).toBeLessThan(2.3);
  });

  it('one dot is worth much more than it used to be', () => {
    // The player-facing point of the change: ~5x fewer dots for the same field. Asserted
    // against the scale rather than a screenshot, because the scale IS the promise the
    // legend prints ("1 = 1.1").
    expect(LOOK.glucose!.scale).toBeGreaterThanOrEqual(1);
    expect(LOOK.atp!.scale).toBeGreaterThanOrEqual(3);
    // Every amino acid shares one scale, so their dot counts are directly comparable —
    // §9.2 blocks on a specific residue, so "which am I short of" must be readable.
    const aminos = ['gly', 'leu', 'lys', 'ala', 'val'].map((n) => LOOK[n]!.scale);
    expect(new Set(aminos).size).toBe(1);
  });

  it('every species has a distinct-enough shape to survive being small (§11.3)', () => {
    // Colour alone failed: five amino acids plus glucose plus ATP is seven hues in a
    // shimmering overlap. Shape is the channel that survives.
    expect(LOOK.glucose!.shape).toBe('hex'); // a hexose
    expect(LOOK.lactate!.shape).toBe('tri'); // a triose — one hexagon becomes two triangles
    expect(LOOK.atp!.shape).toBe('spark');

    // Every residue gets its OWN shape. One family shape plus five hues put the whole
    // discriminating burden back on colour — which is the failure shape exists to fix, and
    // playtesting found it: "really hard to see which amino acid is which".
    const aminoShapes = ['gly', 'leu', 'lys', 'ala', 'val'].map((n) => LOOK[n]!.shape);
    expect(new Set(aminoShapes).size).toBe(5);
    expect(LOOK.gly!.shape).toBe('circle'); // simplest residue, simplest mark
    expect(LOOK.lys!.shape).toBe('plus'); // positively charged at physiological pH
    // And no residue may collide with a metabolite either.
    for (const sh of aminoShapes) expect(['hex', 'tri', 'spark']).not.toContain(sh);
  });
});
