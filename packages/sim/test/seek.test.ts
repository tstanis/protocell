/**
 * §10A.9 — auto-seek: sort the counts, go to the lowest.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../src/world.js';
import { SIM_DT } from '../src/constants.js';
import { SWITCH_MARGIN, chooseTarget, type Stock } from '../src/scarcity.js';
import { SPECIES_ID, aminoId } from '../src/species.js';

const row = (species: number, count: number): Stock => ({ species, name: String(species), count });

describe('§10A.9 — the seeker goes to the lowest stock', () => {
  it('the table is every stock the player can see, sorted lowest first', () => {
    const w = new World();
    const table = w.scarcity();
    expect(table.length).toBe(6); // glucose + five residues
    for (let i = 1; i < table.length; i++) {
      expect(table[i]!.count).toBeGreaterThanOrEqual(table[i - 1]!.count);
    }
    // And the counts are the ones on the HUD, not derived from anything.
    const gly = table.find((t) => t.species === aminoId('gly'))!;
    expect(gly.count).toBe(w.inventory.get('gly'));
    const glu = table.find((t) => t.species === SPECIES_ID.glucose)!;
    expect(glu.count).toBe(w.grains.count(SPECIES_ID.glucose));
  });

  it('picks the minimum when it has no current errand', () => {
    expect(chooseTarget([row(1, 40), row(2, 12), row(3, 90)], null)).toBe(2);
  });

  it('finishes the errand it is on rather than chasing every crossover', () => {
    // THE failure this margin exists for: two stocks a particle apart swap places as they
    // drain, and a seeker without hysteresis turns around every time they cross and
    // travels nowhere.
    expect(chooseTarget([row(1, 39), row(2, 40)], 2)).toBe(2);
    expect(chooseTarget([row(1, 40 - SWITCH_MARGIN - 1), row(2, 40)], 2)).toBe(1);
  });

  it('holds a target that is still the lowest', () => {
    expect(chooseTarget([row(1, 10), row(2, 80)], 1)).toBe(1);
  });

  it('drives chemotaxis, and picking a species by hand takes the wheel back', () => {
    const w = new World();
    w.setAutoSeek(true);
    expect(w.motility.autoSeek).toBe(true);
    expect(w.motility.chemotaxis).not.toBeNull();

    w.setChemotaxis(aminoId('lys'));
    expect(w.motility.autoSeek).toBe(false);
    expect(w.motility.chemotaxis).toBe(aminoId('lys'));
  });

  it('re-targets as the counts move', () => {
    const w = new World();
    // Interior glucose starts at ZERO — nothing has been imported yet — so it is the
    // lowest stock on a fresh cell and the seeker correctly wants sugar. Seed some so the
    // residue comparison is the thing under test.
    for (let i = 0; i < 300; i++) w.grains.add(SPECIES_ID.glucose, w.cx, w.cy, 1);
    for (const t of ['gly', 'leu', 'ala', 'val'] as const) w.inventory.add(t, 200);
    w.inventory.take('lys', w.inventory.get('lys'));
    w.setAutoSeek(true);
    expect(w.motility.chemotaxis).toBe(aminoId('lys'));

    // Now flood lysine and starve alanine; the seeker should follow.
    w.inventory.add('lys', 500);
    w.inventory.take('ala', w.inventory.get('ala'));
    for (let i = 0; i < Math.round(1 / SIM_DT); i++) w.step();
    expect(w.motility.chemotaxis).toBe(aminoId('ala'));
  });

  it('a fresh cell wants glucose, because it has none inside it yet', () => {
    // Worth pinning: interior glucose is a PIPELINE, not a stockpile — it is whatever is
    // in transit between the membrane and the enzymes, capped by INTERIOR_SATURATION. It
    // is therefore usually the smallest number on the table, and the seeker will pick it
    // often. That is what sorting counts means; it is a balance question, not a bug.
    const w = new World();
    expect(w.grains.count(SPECIES_ID.glucose)).toBe(0);
    expect(w.scarcity()[0]!.species).toBe(SPECIES_ID.glucose);
  });
});
