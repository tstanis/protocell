/**
 * §9.5 — pre-emptive repair, and §9.5b — the stranding it cannot prevent.
 *
 * Playtested: "the ribosome should pre-emptively repair proteins when they are close to
 * denaturing, rather than waiting for the end." Waiting for failure means every protein
 * spends a window dead, so a fully-covered cell still runs with holes in it.
 *
 * The second half is the failure that motivated §9.5b: the last flagellum denatured on a
 * membrane tile outside every ribosome's reach, and the cell could then neither swim to a
 * deposit nor fold a replacement from an empty larder. Silent and permanent — the only
 * symptom was that the steering buttons had greyed out.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../src/world.js';
import { SIM_DT } from '../src/constants.js';
import { Ribosome } from '../src/ribosome.js';
import { REPAIR_AT, worn } from '../src/denature.js';
import { gateTiles } from '../src/membrane.js';
import { AMINO_TYPES } from '../src/species.js';

/** East-most gate tile — as far from the centre as the ring gets. */
function eastGate(w: World): number {
  const gates = [...gateTiles(w.grid)];
  return gates.reduce((best, t) => {
    const score = (i: number) => (i % w.grid.width) - w.cx - Math.abs(Math.floor(i / w.grid.width) - w.cy);
    return score(t) > score(best) ? t : best;
  }, gates[0]!);
}

function ringOfRibosomes(w: World): void {
  for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
    const x = Math.round(w.cx + Math.cos(a) * 9);
    const y = Math.round(w.cy + Math.sin(a) * 9);
    w.ribosomes.push(new Ribosome(w.grid.idx(x, y)));
  }
}

/** Run, keeping ATP and residues non-limiting so the REPAIR POLICY is what is measured. */
function runSupplied(w: World, seconds: number, onStep?: () => void): void {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    w.energy.add(1000);
    for (const t of AMINO_TYPES) if (w.inventory.get(t) < 40) w.inventory.add(t, 40);
    w.step();
    onStep?.();
  }
}

/**
 * Age everything to just above the repair threshold.
 *
 * The alternative — running until natural decay brings something down — costs 90 s of
 * wall clock per test and makes the assertion depend on `frailtyOf`'s hash landing
 * conveniently. Starting the clock where the mechanic actually begins tests the same
 * behaviour, deterministically, in a fraction of the time.
 */
function wearEverything(w: World, to = REPAIR_AT + 0.02): void {
  for (const t of w.transporters.values()) t.integrity = to;
  for (const e of w.enzymes) e.integrity = to;
  for (const f of w.flagella) f.integrity = to;
}

describe('§9.5 — a protein is replaced when it starts to falter, not when it dies', () => {
  it('a covered cell never actually loses a protein', () => {
    const w = new World();
    w.buildGlucoseChannel();
    w.buildEnzyme();
    w.addFlagellum(eastGate(w));
    ringOfRibosomes(w);
    wearEverything(w);

    let died = 0;
    let noFlagellum = 0;
    for (let i = 0; i < Math.round(200 / SIM_DT); i++) {
      w.energy.add(1000);
      for (const t of AMINO_TYPES) if (w.inventory.get(t) < 40) w.inventory.add(t, 40);
      died += w.step().proteinsFailed;
      if (w.flagella.length === 0) noFlagellum += SIM_DT;
    }

    expect(died).toBe(0);
    expect(noFlagellum).toBe(0);
    expect(w.vacancies.length).toBe(0);
  });

  it('machinery never runs degraded — integrity stays around the faltering point', () => {
    // The whole reason REPAIR_AT is `efficiency`'s taper point rather than a new number:
    // a covered protein is renewed as it begins to falter, so it never spends real time
    // below full rate. A small dip is expected, because folding the replacement is not
    // instant — that is the honest cost, not a tuning failure.
    const w = new World();
    w.buildGlucoseChannel();
    w.addFlagellum(eastGate(w));
    ringOfRibosomes(w);
    wearEverything(w);

    let floor = 1;
    runSupplied(w, 150, () => {
      for (const f of w.flagella) floor = Math.min(floor, f.integrity);
    });
    expect(floor).toBeLessThan(REPAIR_AT); // it really did get worn, so this is a live test
    expect(floor).toBeGreaterThan(REPAIR_AT - 0.15);
  });

  it('a renewal restores the protein rather than installing a second copy', () => {
    const w = new World();
    const tile = eastGate(w);
    w.addFlagellum(tile);
    ringOfRibosomes(w);
    w.flagella[0]!.integrity = REPAIR_AT - 0.01;
    expect(worn(w.flagella[0]!)).toBe(true);

    runSupplied(w, 30);
    expect(w.flagella.length).toBe(1); // not two
    expect(w.flagella[0]!.tile).toBe(tile);
    expect(w.flagella[0]!.integrity).toBeGreaterThan(REPAIR_AT);
  });

  it('dead beats tired — a vacancy outranks a renewal', () => {
    const w = new World();
    w.buildEnzyme();
    ringOfRibosomes(w);
    // One worn transporter in reach, and one outright hole.
    const tile = eastGate(w);
    w.buildGlucoseChannel();
    for (const t of w.transporters.values()) t.integrity = REPAIR_AT - 0.01;
    w.vacancies.push({ tile, gene: 'flagellum' });

    runSupplied(w, 1);
    const jobs = w.ribosomes.map((r) => r.job).filter(Boolean);
    expect(jobs.some((j) => j!.source === 'repair')).toBe(true);
  });
});

describe('§9.5b — the cell must be told when it cannot recover', () => {
  it('a central ribosome does not cover the membrane, and that is now reportable', () => {
    const w = new World();
    const tile = eastGate(w);
    w.ribosomes.push(new Ribosome(w.grid.idx(Math.round(w.cx), Math.round(w.cy))));
    // §9.5's siting decision, stated as a fact the client can read.
    expect(w.coveredByRibosome(tile)).toBe(false);
    ringOfRibosomes(w);
    expect(w.coveredByRibosome(tile)).toBe(true);
  });

  it('stranded is FALSE while the player can still fold a flagellum by hand', () => {
    const w = new World();
    // No flagellum at all, but a full larder and a full battery.
    expect(w.flagella.length).toBe(0);
    expect(w.stranded()).toBe(false);
  });

  it('stranded is TRUE only when nothing can produce one', () => {
    const w = new World();
    for (const t of AMINO_TYPES) w.inventory.take(t, w.inventory.get(t));
    expect(w.stranded()).toBe(true);

    // A ribosome that covers the vacancy is a recovery path, so it is not a stranding.
    const tile = eastGate(w);
    w.vacancies.push({ tile, gene: 'flagellum' });
    ringOfRibosomes(w);
    expect(w.stranded()).toBe(false);
  });

  it('and a flagellum in the water is never a stranding, however worn', () => {
    const w = new World();
    for (const t of AMINO_TYPES) w.inventory.take(t, w.inventory.get(t));
    w.addFlagellum(eastGate(w));
    w.flagella[0]!.integrity = 0.01;
    expect(w.stranded()).toBe(false);
  });
});
