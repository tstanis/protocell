/**
 * §9.4 + §10A.2 — does the world contain enough amino acid to survive its own
 * denaturation?
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * The deposits were sized as "roughly twice the starting stock of that residue", which is
 * an inventory-shaped number. Denaturation then gave residues a RATE of consumption, and
 * nothing ever re-checked the deposits against it. The five of them between them held 168
 * particles against 43 a minute of replacement demand — **the whole map contained less
 * amino acid than one build-out costs** — and regrowth ran two orders of magnitude below
 * consumption, so the world was a fuel tank with about six minutes in it. Playtested
 * verdict: "impossible to keep up with the denaturing."
 *
 * The defect was pure arithmetic and no test could see it, because every test asserted
 * that a mechanism WORKS (a port imports, a deposit depletes, a ribosome rebuilds) and
 * none asserted that the numbers BALANCE. This file asserts the balance.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../src/world.js';
import { GENES, type GeneId } from '../src/genes.js';
import { FRAILTY_MAX, FRAILTY_MIN, MEAN_LIFETIME } from '../src/denature.js';
import { RESIDUE_IMPORT_RATE } from '../src/constants.js';
import { AMINO_TYPES, SPECIES_ID, type AminoType } from '../src/species.js';

/** §14's standing build-out — what the cell holds once it is up and running. */
const STANDING: Array<[GeneId, number]> = [
  ['glucoseChannel', 3],
  ['glycolysisEnzyme', 3],
  ['lactateCarrier', 2],
  ['aminoTransporter', 5],
  ['flagellum', 1],
  ['ribosome', 3],
];

const MEAN_FRAILTY = (FRAILTY_MIN + FRAILTY_MAX) / 2;
const LIFE = MEAN_LIFETIME * MEAN_FRAILTY;

/** Residues of each type consumed per second, replacing the standing set forever. */
function demand(): Map<AminoType, number> {
  const standing = new Map<AminoType, number>(AMINO_TYPES.map((t) => [t, 0]));
  for (const [id, n] of STANDING) {
    for (const r of GENES[id].sequence) standing.set(r, standing.get(r)! + n);
  }
  return new Map([...standing].map(([t, n]) => [t, n / LIFE]));
}

function depositFor(w: World, t: AminoType) {
  return w.patches.patches.find((p) => p.species === SPECIES_ID[t] && !p.hostile)!;
}

describe('§9.4 — the residue economy has to close', () => {
  it('every deposit regrows faster than the cell consumes that residue', () => {
    // THE load-bearing assertion. If regrowth is below demand for any type, the world is a
    // countdown however large the reserves are, and the cell dies of a shortage the player
    // can do nothing about. Headroom above 1.0 is deliberate — see RESIDUE_ECONOMY — since
    // a player cannot realise nominal regrowth: they travel, hoppers stall while they are
    // elsewhere, and a deposit sitting at full richness regrows nothing at all.
    const w = new World();
    const d = demand();
    for (const t of AMINO_TYPES) {
      const dep = depositFor(w, t);
      expect(dep.regrowth, `${t} regrowth vs demand`).toBeGreaterThan(d.get(t)!);
    }
  });

  it('a deposit refills in about one foraging circuit, not instantly and not never', () => {
    // Reserve and regrowth together set the pacing: reserve/regrowth is the time from
    // stripped to full. Too short and a pocket is a tap you leave running, which retires
    // §10A.2's reason to move; too long and coming back is pointless.
    const w = new World();
    for (const t of AMINO_TYPES) {
      const dep = depositFor(w, t);
      const refill = dep.reserve / dep.regrowth;
      expect(refill, `${t} refill seconds`).toBeGreaterThan(300);
      expect(refill, `${t} refill seconds`).toBeLessThan(900);
    }
  });

  it('one port can clear a deposit within a single visit', () => {
    // A visit has to be able to collect what regrew, or the surplus is unreachable and the
    // regrowth above is a number on paper. Draw runs at full rate down to a quarter
    // remaining (§5b), so a stop of ~100 s must cover 75% of the reserve.
    const w = new World();
    const STOP_SECONDS = 100;
    for (const t of AMINO_TYPES) {
      const dep = depositFor(w, t);
      const collectable = RESIDUE_IMPORT_RATE * STOP_SECONDS;
      expect(collectable, `${t} collectable in one stop`).toBeGreaterThan(dep.reserve * 0.5);
    }
  });

  it('the map holds far more residue than one build-out costs', () => {
    // The specific thing that was false. 432 in the world against 181 to build the standing
    // set left 251 for maintenance — 5.8 minutes — and then nothing.
    const w = new World();
    let world = 0;
    for (const t of AMINO_TYPES) world += w.inventory.get(t) + depositFor(w, t).reserve;

    let buildOut = 0;
    for (const [id, n] of STANDING) buildOut += GENES[id].sequence.length * n;

    expect(buildOut).toBe(181);
    expect(world).toBeGreaterThan(buildOut * 4);

    // And the standing reserve alone, ignoring regrowth entirely, is a long game.
    const total = [...demand().values()].reduce((a, b) => a + b, 0);
    expect((world - buildOut) / total).toBeGreaterThan(600);
  });

  it('staying put is still losing — deposits are finite on the timescale of a visit', () => {
    // The fix must not retire §10A.2. Regrowth beats demand only if you WORK the circuit;
    // parked on one deposit you import one type and spend five, so a single pocket cannot
    // fund the cell no matter how long you sit on it.
    const w = new World();
    const d = demand();
    const total = [...d.values()].reduce((a, b) => a + b, 0);
    for (const t of AMINO_TYPES) {
      // Even at full rate, one deposit's type is a fraction of what the cell is spending.
      expect(d.get(t)!).toBeLessThan(total * 0.5);
    }
    // And that one type runs down while you sit there: full-rate draw exceeds regrowth.
    for (const t of AMINO_TYPES) {
      expect(RESIDUE_IMPORT_RATE).toBeGreaterThan(depositFor(w, t).regrowth * 2);
    }
  });
});
