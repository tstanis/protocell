/**
 * SPEC.md §16.1 — conservation, stability, and the frame-rate regression test.
 */

import { describe, expect, it } from 'vitest';
import { CFL_LIMIT, SIM_DT } from '../src/constants.js';
import { assertCFL, diffuse } from '../src/ops/diffuse.js';
import { CYTOPLASM, EXTRACELLULAR, Grid, Role } from '../src/grid.js';
import { SPECIES_ID } from '../src/species.js';
import { stampCell } from '../src/membrane.js';

const GLU = SPECIES_ID.glucose;

/** A grid that is one uniform fluid compartment, with a VOID frame around it. */
function openBox(w = 40, h = 40): Grid {
  const g = new Grid(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = g.idx(x, y);
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      g.role[i] = edge ? Role.VOID : Role.FLUID;
      g.compartment[i] = edge ? -1 : CYTOPLASM;
    }
  }
  return g;
}

describe('diffusion', () => {
  it('conserves mass to 1e-12 over 10k steps', () => {
    const g = openBox();
    g.set(GLU, g.idx(20, 20), 1000);
    g.set(GLU, g.idx(12, 27), 400);
    const before = g.total(GLU);

    for (let n = 0; n < 10_000; n++) diffuse(g, GLU, 10, SIM_DT);

    // Float32 storage caps this at ~2e-6 relative, which is why the field is Float64 —
    // see the note on Grid.amount. Mass leaking away over a long session is exactly the
    // kind of quiet wrongness §2.1 exists to prevent.
    expect(Math.abs(g.total(GLU) - before) / before).toBeLessThan(1e-12);
  });

  it('leaks nothing into VOID — the reflecting boundary of §17.2', () => {
    const g = openBox(20, 20);
    // Seed hard against the boundary, where an absorbing sink would drain fastest.
    g.set(GLU, g.idx(1, 1), 500);
    const before = g.total(GLU);

    for (let n = 0; n < 2000; n++) diffuse(g, GLU, 10, SIM_DT);

    expect(Math.abs(g.total(GLU) - before) / before).toBeLessThan(1e-12);

    // And the void itself must still be untouched.
    let voidMass = 0;
    for (let i = 0; i < g.tileCount; i++) if (g.role[i] === Role.VOID) voidMass += g.get(GLU, i);
    expect(voidMass).toBe(0);
  });

  it('relaxes toward uniform — equilibrium is death (§2.3)', () => {
    const g = openBox(20, 20);
    g.set(GLU, g.idx(10, 10), 1000);

    for (let n = 0; n < 40_000; n++) diffuse(g, GLU, 10, SIM_DT);

    const vals: number[] = [];
    for (let i = 0; i < g.tileCount; i++) if (g.role[i] === Role.FLUID) vals.push(g.get(GLU, i));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const spread = Math.max(...vals) - Math.min(...vals);

    expect(spread / mean).toBeLessThan(0.01);
  });

  it('never overshoots: values stay within the initial range', () => {
    const g = openBox(24, 24);
    for (let i = 0; i < g.tileCount; i++) if (g.role[i] === Role.FLUID) g.set(GLU, i, 5);
    g.set(GLU, g.idx(12, 12), 100);

    // Sampled rather than checked every step: 5000 × 576 assertions dominated the whole
    // suite's runtime and told us nothing the sampled version misses, since an overshoot
    // is monotone once it starts.
    for (let n = 0; n < 5000; n++) {
      diffuse(g, GLU, 10, SIM_DT);
      if (n % 250 !== 0) continue;
      for (let i = 0; i < g.tileCount; i++) {
        if (g.role[i] !== Role.FLUID) continue;
        const v = g.get(GLU, i);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(5 - 1e-9);
        expect(v).toBeLessThanOrEqual(100 + 1e-9);
      }
    }
  });

  it('does not exchange across a compartment boundary without a membrane', () => {
    const g = new Grid(30, 10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 30; x++) {
        const i = g.idx(x, y);
        g.role[i] = Role.FLUID;
        g.compartment[i] = x < 15 ? CYTOPLASM : EXTRACELLULAR;
        g.set(GLU, i, x < 15 ? 10 : 0);
      }
    }
    const insideBefore = g.totalIn(GLU, CYTOPLASM);

    for (let n = 0; n < 5000; n++) diffuse(g, GLU, 10, SIM_DT);

    // Compartments exchange ONLY through membrane tiles (§4.2). Without one, the
    // gradient must survive indefinitely — that persistence is what makes a cell
    // possible at all.
    expect(g.totalIn(GLU, CYTOPLASM)).toBeCloseTo(insideBefore, 6);
    expect(g.totalIn(GLU, EXTRACELLULAR)).toBeCloseTo(0, 9);
  });
});

describe('CFL stability guard (§3.3)', () => {
  it('accepts a coefficient at the limit', () => {
    expect(() => assertCFL(CFL_LIMIT / SIM_DT, SIM_DT)).not.toThrow();
  });

  it('throws on an oversized coefficient rather than exploding quietly', () => {
    expect(() => assertCFL(CFL_LIMIT / SIM_DT + 1, SIM_DT)).toThrow(/CFL violation/);
  });

  it('throws on an UNSCALED coefficient — the §17.2 defect, caught at the source', () => {
    // The prototypes effectively applied D with dt = 1 (per frame). At any sane D that
    // is far past the limit, so the mistake now fails loudly on the first step instead
    // of producing plausible-looking, refresh-rate-dependent physics.
    expect(() => assertCFL(10, 1)).toThrow(/CFL violation/);
  });
});

describe('timestep independence (§16.1) — the §17.2 regression test', () => {
  it('produces identical state regardless of how real time is delivered', () => {
    // Same simulated duration, delivered in wildly different chunks. Because the sim
    // only ever advances in whole SIM_DT steps, the results must be bit-identical.
    // Under the prototypes' unscaled diffusion this test is unpassable by construction.
    const run = (stepsPerBatch: number): Float64Array => {
      const g = openBox(24, 24);
      g.set(GLU, g.idx(12, 12), 800);
      const totalSteps = 2400;
      for (let done = 0; done < totalSteps; done += stepsPerBatch) {
        const n = Math.min(stepsPerBatch, totalSteps - done);
        for (let k = 0; k < n; k++) diffuse(g, GLU, 10, SIM_DT);
      }
      return g.plane(GLU).slice();
    };

    const a = run(1); // as if 120 fps
    const b = run(4); // as if 30 fps
    const c = run(37); // a deliberately ugly cadence

    expect(Array.from(b)).toEqual(Array.from(a));
    expect(Array.from(c)).toEqual(Array.from(a));
  });
});

describe('penetration depth (§17.3)', () => {
  /**
   * The central claim: with zero-order consumption the steady-state profile falls
   * parabolically from the membrane and hits zero at a FINITE depth, and that depth does
   * NOT depend on cell size. The healthy shell is therefore a fixed thickness — which is
   * what makes the SA:V wall a genuine forcing function rather than a soft penalty.
   */
  function measureShell(radius: number): number {
    const size = Math.ceil(radius * 2) + 12;
    const g = new Grid(size, size);
    const c = size / 2;
    stampCell(g, { cx: c, cy: c, radius });

    const D = 10;
    const k = 0.063; // §13.6
    const c0 = 1.0;

    // Membrane tiles are held at c0 to isolate the transit limit, which is what a
    // penetration-depth measurement is for. The FLUX limit is a separate bottleneck
    // (§17.1) and is measured by scripts/sweep.ts with finite per-tile import.
    // Relaxation time for a shell of ~20 tiles at D=10 is L²/D ≈ 40 s; 12k steps is 100 s
    // of simulated time, comfortably converged.
    for (let n = 0; n < 12_000; n++) {
      for (let i = 0; i < g.tileCount; i++) {
        if (g.role[i] === Role.MEMBRANE) {
          const inI = g.inward[i]!;
          if (inI >= 0) g.set(GLU, inI, c0);
        }
      }
      diffuse(g, GLU, D, SIM_DT);
      for (let i = 0; i < g.tileCount; i++) {
        if (g.role[i] !== Role.FLUID || g.compartment[i] !== CYTOPLASM) continue;
        g.set(GLU, i, Math.max(0, g.get(GLU, i) - k * SIM_DT));
      }
    }

    // Deepest healthy tile, measured as distance inward from the membrane.
    let deepest = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = g.idx(x, y);
        if (g.role[i] !== Role.FLUID || g.compartment[i] !== CYTOPLASM) continue;
        if (g.get(GLU, i) <= 1e-3) continue;
        const depth = radius - Math.hypot(x + 0.5 - c, y + 0.5 - c);
        if (depth > deepest) deepest = depth;
      }
    }
    return deepest;
  }

  it('healthy shell thickness is independent of cell size', () => {
    const small = measureShell(20);
    const large = measureShell(34);
    // §17.3: "L does NOT depend on cell size R." Both cells are larger than L, so both
    // have a dead core, and both shells must come out the same thickness.
    expect(Math.abs(large - small)).toBeLessThan(2.0);
  });

  it('a cell smaller than L has no dead core at all', () => {
    // §17.3's flat floor: R_interior < L ⇒ exactly 0% starving. This is the "no stable
    // slightly-too-big" property that makes the cliff fair — it is preceded by a genuinely
    // flat, safe region rather than a gradual slide.
    const radius = 8;
    const size = 32;
    const g = new Grid(size, size);
    const c = size / 2;
    stampCell(g, { cx: c, cy: c, radius });

    const k = 0.063;
    for (let n = 0; n < 20_000; n++) {
      for (let i = 0; i < g.tileCount; i++) {
        if (g.role[i] === Role.MEMBRANE) {
          const inI = g.inward[i]!;
          if (inI >= 0) g.set(GLU, inI, 1.0);
        }
      }
      diffuse(g, GLU, 10, SIM_DT);
      for (let i = 0; i < g.tileCount; i++) {
        if (g.role[i] !== Role.FLUID || g.compartment[i] !== CYTOPLASM) continue;
        g.set(GLU, i, Math.max(0, g.get(GLU, i) - k * SIM_DT));
      }
    }

    let starving = 0;
    let total = 0;
    for (let i = 0; i < g.tileCount; i++) {
      if (g.role[i] !== Role.FLUID || g.compartment[i] !== CYTOPLASM) continue;
      total++;
      if (g.get(GLU, i) < 0.16) starving++;
    }
    expect(total).toBeGreaterThan(100);
    expect(starving).toBe(0);
  });
});
