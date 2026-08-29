/**
 * §15.8 — a saved cell resumes as the same cell.
 *
 * ── The only assertion that is worth anything here ──────────────────────────
 * "The numbers look right after loading" is not a test. A snapshot that forgets one
 * accumulator produces a cell that is correct for one step and wrong forever after, and
 * every visible quantity — ATP, volume, tension, grain count — will look entirely
 * plausible the whole way down.
 *
 * So the test is DIVERGENCE: run a world, save it, restore into a fresh one, then step
 * both for thousands of ticks and demand they stay identical. A forgotten field shows up
 * as drift, and drift is unmissable.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../src/world.js';
import { SNAPSHOT_VERSION } from '../src/snapshot.js';
import { AMINO_TYPES, SPECIES_ID } from '../src/species.js';

/** Every number a divergence would show up in, flattened for comparison. */
function fingerprint(w: World): string {
  const parts: (string | number)[] = [
    w.tick,
    w.atp.toFixed(9),
    w.cyto.volume.toFixed(9),
    w.cyto.tension.toFixed(9),
    w.grains.grains.length,
    w.transporters.size,
    w.enzymes.length,
    w.ribosomes.length,
    w.flagella.length,
    w.vacancies.length,
    w.bot.x.toFixed(9),
    w.bot.y.toFixed(9),
    w.motility.x.toFixed(9),
    w.motility.y.toFixed(9),
    w.build.phase,
    w.build.chain.length,
  ];
  for (const t of AMINO_TYPES) parts.push(w.inventory.get(t));
  // Grain positions are the sharpest divergence detector: they are driven by the PRNG,
  // so a dropped seed shows up here on the very first step and nowhere else.
  for (const g of w.grains.grains) {
    parts.push(g.id, g.species, g.x.toFixed(9), g.y.toFixed(9), g.amount.toFixed(9));
  }
  for (const p of w.patches.patches) parts.push(p.richness.toFixed(9));
  return parts.join('|');
}

/** A world that has actually been played, not a fresh one. */
function played(seconds: number): World {
  const w = new World();
  w.buildGlucoseChannel();
  w.buildEnzyme();
  w.buildLactateCarrier(2);
  w.buildAminoTransporter();
  for (let i = 0; i < 120 * seconds; i++) w.step();
  return w;
}

describe('§15.8 — snapshot round-trip', () => {
  it('a restored world is indistinguishable from the original at rest', () => {
    const a = played(20);
    const b = new World();
    b.restore(a.snapshot());
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('and STAYS indistinguishable for thousands of steps — the real test', () => {
    const a = played(20);
    const b = new World();
    b.restore(a.snapshot());

    // 30 s of divergence pressure. Diffusion, the random walk, denaturation, import
    // accumulators and the osmotic loop all run; any dropped field compounds.
    for (let i = 0; i < 120 * 30; i++) {
      a.step();
      b.step();
    }
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('carries the PRNG, so the random walk continues rather than restarting', () => {
    const a = played(10);
    const snap = a.snapshot();
    const b = new World();
    b.restore(snap);
    // One step is enough: every grain moves by a draw from the generator.
    a.step();
    b.step();
    expect(fingerprint(b)).toBe(fingerprint(a));

    // And a world restored from a snapshot whose seed was clobbered diverges, which is
    // what makes the assertion above meaningful rather than vacuous.
    const c = new World();
    const tampered = a.snapshot();
    tampered.grains = { ...tampered.grains, seed: (tampered.grains.seed ^ 0xffff) >>> 0 };
    c.restore(tampered);
    c.step();
    expect(fingerprint(c)).not.toBe(fingerprint(a));
  });

  it('carries mid-flight state: a half-assembled protein and a loaded enzyme', () => {
    const w = new World();
    w.buildGlucoseChannel();
    w.buildEnzyme();
    // Walk to the nucleus and start a build, so `build` is mid-chain when we save.
    w.bot.moveTo(w.nucleus.x, w.nucleus.y);
    for (let i = 0; i < 120 * 12; i++) w.step();
    w.selectGene('glycolysisEnzyme');
    for (let i = 0; i < 120 * 2; i++) w.step();

    const snap = w.snapshot();
    expect(snap.build).toBeTruthy();

    const b = new World();
    b.restore(snap);
    expect(b.build.phase).toBe(w.build.phase);
    expect(b.build.chain).toEqual(w.build.chain);
    expect(b.build.gene?.id).toBe(w.build.gene?.id);

    for (let i = 0; i < 120 * 10; i++) {
      w.step();
      b.step();
    }
    expect(fingerprint(b)).toBe(fingerprint(w));
  });

  it('carries an enzyme mid-catalysis, substrate already swallowed', () => {
    // Found by mutation-testing the suite: zeroing the enzyme's private processT/bindP/
    // held did NOT fail the divergence test, because at the moment that test happens to
    // save, every active site is empty. A snapshot taken a fraction of a second later
    // would have silently destroyed a bound glucose particle on every restore.
    //
    // The lesson is the one §16.1a already paid for twice: a test that passes is not
    // evidence until you have seen it fail for the right reason.
    const w = new World();
    w.buildGlucoseChannel();
    w.buildEnzyme();
    let guard = 0;
    while (!w.enzymes[0]!.occupied && guard++ < 120 * 600) w.step();
    expect(w.enzymes[0]!.occupied).toBe(true); // the case actually under test

    const b = new World();
    b.restore(w.snapshot());
    expect(b.enzymes[0]!.occupied).toBe(true);

    // The bound particle must be released as ATP on schedule in BOTH, not dropped in one.
    for (let i = 0; i < 120 * 20; i++) {
      w.step();
      b.step();
    }
    expect(fingerprint(b)).toBe(fingerprint(w));
    expect(b.atp).toBeCloseTo(w.atp, 9);
  });

  it('carries the satchel, whose grains are NOT in the grain store', () => {
    const w = played(15);
    const g = w.grains.grains.find((q) => q.species === SPECIES_ID.glucose);
    if (g) {
      w.bot.x = g.x;
      w.bot.y = g.y;
      w.pickUp(g.id);
    }
    const carried = w.bot.inventory.length;
    const b = new World();
    b.restore(w.snapshot());
    expect(b.bot.inventory.length).toBe(carried);
    expect(fingerprint(b)).toBe(fingerprint(w));
  });

  it('restoring into a world that was already played leaves no residue of it', () => {
    // The failure this guards: `restore` that only writes the planes present in the
    // snapshot leaves whatever was in the others, so a reused World inherits a ghost.
    const fresh = played(5);
    const dirty = played(40);
    dirty.buildLactateCarrier(3);
    dirty.inventory.add('lys', 500);

    dirty.restore(fresh.snapshot());
    expect(fingerprint(dirty)).toBe(fingerprint(fresh));
  });

  it('refuses a snapshot from a different format version rather than half-loading it', () => {
    const w = played(5);
    const snap = w.snapshot();
    snap.v = SNAPSHOT_VERSION + 1;
    expect(() => new World().restore(snap)).toThrow(/snapshot version/);
  });

  it('omits geometry and empty planes — a save is state, not the program', () => {
    const snap = played(60).snapshot();
    // §5c made ATP a pool and §5b made residues an inventory, so those planes are
    // structurally empty and never reach the wire.
    const ids = snap.planes.map((p) => p.species);
    expect(ids).toContain(SPECIES_ID.glucose);
    expect(ids).not.toContain(SPECIES_ID.atp);
    for (const t of AMINO_TYPES) expect(ids).not.toContain(SPECIES_ID[t]);
    // 2 live planes out of 13 is the measured figure the snapshot doc quotes.
    expect(snap.planes.length).toBeLessThanOrEqual(3);
  });
});
