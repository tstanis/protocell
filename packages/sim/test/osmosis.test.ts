/**
 * SPEC.md §16.1 — the volume/osmosis coupling of §7 and the death chain of §10.2.
 *
 * §10.1 is the constraint these tests exist to protect: "Solute X exceeds threshold →
 * die" is a made-up mechanic. Lactate in particular is essentially non-toxic — it is a
 * fuel. Every death here must emerge from real coupled systems, so each test asserts a
 * LINK in the chain rather than the outcome:
 *
 *   enzyme runs → lactate accumulates → osmolarity rises → water enters →
 *   volume grows → tension climbs → lyse
 */

import { describe, expect, it } from 'vitest';
import {
  B_OSM,
  Compartment,
  S_NOM,
  bleb,
  stepOsmosis,
  syncTileCounts,
  totalSolute,
} from '../src/compartment.js';
import { A_REST, BLEB_TENSION_MIN, RUPTURE, SIM_DT } from '../src/constants.js';
import { CYTOPLASM, Grid, Role } from '../src/grid.js';
import { SPECIES_ID } from '../src/species.js';

const LAC = SPECIES_ID.lactate;
const GLU = SPECIES_ID.glucose;

function cellOnly(tiles = 100): { grid: Grid; comp: Compartment } {
  const side = Math.ceil(Math.sqrt(tiles)) + 2;
  const grid = new Grid(side, side);
  let placed = 0;
  for (let i = 0; i < grid.tileCount && placed < tiles; i++) {
    grid.role[i] = Role.FLUID;
    grid.compartment[i] = CYTOPLASM;
    placed++;
  }
  const comp = new Compartment(CYTOPLASM);
  syncTileCounts(grid, [comp]);
  return { grid, comp };
}

/** Distribute an amount evenly across a compartment's tiles. */
function fill(grid: Grid, comp: Compartment, s: number, total: number): void {
  const per = total / comp.tileCount;
  for (let i = 0; i < grid.tileCount; i++) {
    if (grid.compartment[i] === comp.id) grid.set(s, i, per);
  }
}

describe('§7.2 — osmosis drives volume', () => {
  it('rests at rest volume when solute is nominal', () => {
    const { grid, comp } = cellOnly();
    fill(grid, comp, LAC, S_NOM - B_OSM);
    expect(totalSolute(grid, comp)).toBeCloseTo(S_NOM, 6);

    for (let n = 0; n < 5000; n++) stepOsmosis(grid, comp, SIM_DT);

    expect(comp.volume).toBeCloseTo(A_REST, 3);
    expect(comp.tension).toBeCloseTo(0, 6);
  });

  it('swells when solute accumulates, regardless of WHICH solute (§7.2)', () => {
    // Water moves toward higher TOTAL solute, independent of identity. So glucose and
    // lactate at the same amount must produce the same swelling — which is why the
    // crisis is osmotic rather than a hidden toxicity rule (§10.1).
    const a = cellOnly();
    const b = cellOnly();
    fill(a.grid, a.comp, LAC, S_NOM * 0.4);
    fill(b.grid, b.comp, GLU, S_NOM * 0.4);

    for (let n = 0; n < 2000; n++) {
      stepOsmosis(a.grid, a.comp, SIM_DT);
      stepOsmosis(b.grid, b.comp, SIM_DT);
    }

    expect(a.comp.volume).toBeGreaterThan(A_REST);
    expect(a.comp.volume).toBeCloseTo(b.comp.volume, 6);
  });

  it('self-regulates: more volume lowers osmolarity, so inflow slows', () => {
    // §7.2's negative feedback. Volume must approach a finite target, not run away.
    const { grid, comp } = cellOnly();
    fill(grid, comp, LAC, S_NOM * 0.25);

    for (let n = 0; n < 3000; n++) stepOsmosis(grid, comp, SIM_DT);
    const mid = comp.volume;
    for (let n = 0; n < 3000; n++) stepOsmosis(grid, comp, SIM_DT);

    expect(comp.volume).toBeCloseTo(mid, 6);
    expect(comp.lysed).toBe(false);
  });

  it('§7.3 — stiffness slows the approach (it does NOT lower the fixed point)', () => {
    // Worth being precise about, because the spec's prose and its model disagree.
    // §7.3 says the membrane "resists volume increase", which reads like an elastic
    // restoring force balancing osmotic pressure at a volume BELOW A_osm. The §7.4
    // model does not do that: `resist` divides the rate of approach, so the fixed point
    // is still exactly A_osm and stiffness only controls how fast you get there.
    //
    // This test pins the actual behaviour so nobody "fixes" it by accident. See the
    // note added to §7.3 for what changing it would cost.
    const { grid, comp } = cellOnly();
    fill(grid, comp, LAC, S_NOM * 0.6);
    const aOsm = A_REST * (totalSolute(grid, comp) / S_NOM);

    for (let n = 0; n < 200; n++) stepOsmosis(grid, comp, SIM_DT);
    const early = comp.volume;

    for (let n = 0; n < 8000; n++) stepOsmosis(grid, comp, SIM_DT);

    expect(early).toBeGreaterThan(A_REST);
    expect(early).toBeLessThan(aOsm * 0.99); // genuinely lagging early on
    expect(comp.volume).toBeCloseTo(aOsm, 3); // but it does arrive
  });
});

describe('§7.1 — volume is the denominator of concentration', () => {
  it('swelling dilutes without any amount moving — the doom-spiral seed (§10.3)', () => {
    const { grid, comp } = cellOnly();
    fill(grid, comp, LAC, S_NOM * 0.5);
    const amountBefore = grid.totalIn(LAC, CYTOPLASM);
    const concBefore = amountBefore / comp.volume;

    for (let n = 0; n < 3000; n++) stepOsmosis(grid, comp, SIM_DT);

    const amountAfter = grid.totalIn(LAC, CYTOPLASM);
    const concAfter = amountAfter / comp.volume;

    expect(amountAfter).toBeCloseTo(amountBefore, 9); // nothing moved
    expect(concAfter).toBeLessThan(concBefore); // yet it is more dilute
    expect(comp.tileVolume).toBeGreaterThan(A_REST / comp.tileCount);
  });
});

describe('§10.2 — osmotic lysis, the primary death', () => {
  it('bursts only when stretch reaches RUPTURE, not at a solute threshold', () => {
    const { grid, comp } = cellOnly();
    // Enough trapped solute to drive stretch past the rupture strain.
    fill(grid, comp, LAC, S_NOM * 2.5);

    let lysedAtStretch = -1;
    for (let n = 0; n < 20_000; n++) {
      const before = comp.stretch;
      const r = stepOsmosis(grid, comp, SIM_DT);
      if (r.lysed) {
        lysedAtStretch = Math.max(before, comp.stretch);
        break;
      }
    }

    expect(comp.lysed).toBe(true);
    expect(lysedAtStretch).toBeGreaterThanOrEqual(RUPTURE);
  });

  it('a cell that clears its waste deflates back to safety (§7.5)', () => {
    // This is the intro's Act 2 payoff: the exporter is structural life support, not
    // cosmetic cleanup, and the deflation is what shows it.
    const { grid, comp } = cellOnly();
    fill(grid, comp, LAC, S_NOM * 0.6);
    for (let n = 0; n < 3000; n++) stepOsmosis(grid, comp, SIM_DT);

    const swollen = comp.volume;
    expect(swollen).toBeGreaterThan(A_REST);
    expect(comp.tension).toBeGreaterThan(0);

    fill(grid, comp, LAC, 0); // the carrier does its job
    for (let n = 0; n < 5000; n++) stepOsmosis(grid, comp, SIM_DT);

    expect(comp.volume).toBeLessThan(swollen);
    expect(comp.volume).toBeCloseTo(A_REST * (B_OSM / S_NOM), 2);
    expect(comp.lysed).toBe(false);
  });

  it('tension rises monotonically with volume, so the warning is readable', () => {
    // §17.6's fairness principle, applied to the intro: the gauge must move smoothly and
    // predictably even though the consequence is sudden.
    const { grid, comp } = cellOnly();
    fill(grid, comp, LAC, S_NOM * 0.6); // stretch 0.203 — strained, survivable
    let prev = -1;
    for (let n = 0; n < 4000; n++) {
      stepOsmosis(grid, comp, SIM_DT);
      expect(comp.tension).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = comp.tension;
    }
    expect(comp.lysed).toBe(false); // the gauge must be readable BEFORE the cliff
    expect(comp.tension).toBeGreaterThan(0.5);
    expect(comp.tension).toBeLessThan(1);
  });
});

describe('§10.4 — blebbing, the survivable third act', () => {
  it('refuses below the tension threshold, so the UI can gate on the same predicate', () => {
    const { grid, comp } = cellOnly();
    expect(comp.tension).toBeLessThan(BLEB_TENSION_MIN);
    expect(bleb(grid, comp, [LAC], 0.55)).toBe(false);
  });

  it('sheds volume AND solute, buying survival at the cost of material', () => {
    const { grid, comp } = cellOnly();
    // 0.64 puts stretch at 0.219 — tension 0.73, comfortably past the bleb threshold and
    // comfortably short of RUPTURE at 0.30. That narrow band IS the third act: strained
    // enough to demand a decision, not yet dead.
    fill(grid, comp, LAC, S_NOM * 0.64);
    for (let n = 0; n < 4000; n++) stepOsmosis(grid, comp, SIM_DT);
    expect(comp.lysed).toBe(false);
    expect(comp.tension).toBeGreaterThanOrEqual(BLEB_TENSION_MIN);

    const volBefore = comp.volume;
    const lacBefore = grid.totalIn(LAC, CYTOPLASM);

    expect(bleb(grid, comp, [LAC], 0.55)).toBe(true);

    expect(comp.volume).toBeLessThan(volBefore);
    expect(grid.totalIn(LAC, CYTOPLASM)).toBeCloseTo(lacBefore * 0.45, 6);

    // And the reprieve must be real: tension actually falls.
    stepOsmosis(grid, comp, SIM_DT);
    expect(comp.tension).toBeLessThan(1);
  });
});
