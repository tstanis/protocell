/**
 * Discrete matter. SPEC.md §5a.
 *
 * The claim being defended here is that going from a continuum field to countable grains
 * changed the REPRESENTATION and not the PHYSICS. That is a strong claim and it is easy to
 * get wrong in ways that look fine for a minute — quantisation is exactly the kind of
 * change that quietly leaks or conjures matter, and §13's economy plus §17's wall are both
 * derived against the continuum numbers.
 */

import { describe, expect, it } from 'vitest';
import { GrainStore, grainUnit, isDiscrete, PARTICLE, GRAIN_DRIFT } from '../src/grains.js';
import { DIFFUSION } from '../src/constants.js';
import { SPECIES_ID, aminoId } from '../src/species.js';
import { World } from '../src/world.js';


const GLU = SPECIES_ID.glucose;
const LAC = SPECIES_ID.lactate;

describe('the grain layer (§5a)', () => {
  it('the random walk reproduces the same D the field uses', () => {
    // The load-bearing claim: a random walk is not an approximation of diffusion, it is
    // the process of which diffusion is the continuum limit. For a 2D walk, ⟨r²⟩ = 4·D·t.
    // If this drifts, every constant derived in §13 and every number in §17 silently stops
    // meaning what it says.
    const store = new GrainStore(12345);
    const N = 4000;
    for (let i = 0; i < N; i++) store.add(GLU, 0, 0);

    const dt = 1 / 120;
    const steps = 240; // 2 seconds
    for (let i = 0; i < steps; i++) store.step(dt, () => true); // unbounded: pure diffusion

    let msd = 0;
    for (const g of store.grains) msd += g.x * g.x + g.y * g.y;
    msd /= store.grains.length;

    const t = steps * dt;
    // The EFFECTIVE D — the tabulated value scaled by §5b.7's per-species drift factor.
    // The claim being protected is unchanged and is the important one: whatever D a grain
    // is given, its walk reproduces exactly that, so ⟨r²⟩ = 4·D·t still holds and §13's
    // constants still mean what they say. Only the D fed in has moved.
    const effectiveD = DIFFUSION.glucose! * GRAIN_DRIFT.glucose!;
    const expected = 4 * effectiveD * t;
    // 4000 walkers gives a few percent of sampling noise; 15% is comfortably inside that
    // while still catching a wrong factor (a missing 2 would be 100% off).
    expect(msd).toBeGreaterThan(expected * 0.85);
    expect(msd).toBeLessThan(expected * 1.15);
  });

  it('reflects off the boundary instead of piling up on it', () => {
    // Clamping to the wall manufactures a concentration spike exactly where transport
    // reads its gradient — the discrete cousin of the absorbing-sink bug §17.2 cost a
    // rebuild. Reflection keeps the interior distribution flat.
    const store = new GrainStore(99);
    const R = 10;
    const inside = (x: number, y: number): boolean => Math.hypot(x, y) < R;
    for (let i = 0; i < 2000; i++) store.add(GLU, 0, 0);
    for (let i = 0; i < 2000; i++) store.step(1 / 120, inside);

    for (const g of store.grains) expect(Math.hypot(g.x, g.y)).toBeLessThan(R);

    // A well-mixed disc puts half its area inside r = R/√2, so roughly half the grains
    // should be there. Clamping to the rim would empty the middle.
    const innerHalf = store.grains.filter((g) => Math.hypot(g.x, g.y) < R / Math.SQRT2).length;
    expect(innerHalf / store.grains.length).toBeGreaterThan(0.35);
    expect(innerHalf / store.grains.length).toBeLessThan(0.65);
  });

  it('minting carries the remainder instead of rounding it away', () => {
    // A channel delivering a third of a grain per tick must produce a grain every third
    // tick. Rounding down starves the cell; rounding up conjures matter.
    const store = new GrainStore();
    const unit = grainUnit(GLU);
    let carry = 0;
    const perTick = unit / 3;
    for (let i = 0; i < 300; i++) carry = store.mint(GLU, 0, 0, carry + perTick);

    const delivered = store.total(GLU) + carry;
    expect(delivered).toBeCloseTo(300 * perTick, 9);
    expect(store.count(GLU)).toBe(100);
  });

  it('take() splits the last grain rather than refusing it', () => {
    // A residue grain is 2.0 and a peptide bond is 0.25, so every bead is eight bonds.
    // Without splitting, seven eighths of every residue would be unreachable.
    const store = new GrainStore();
    const gly = aminoId('gly');
    store.add(gly, 0, 0);
    expect(store.total(gly)).toBe(grainUnit(aminoId('gly')));

    const got = store.take(gly, 0, 0, 5, 0.25);
    expect(got).toBeCloseTo(0.25, 9);
    expect(store.total(gly)).toBeCloseTo(grainUnit(aminoId('gly')) - 0.25, 9);
    expect(store.count(gly)).toBe(1); // split, not consumed
  });

  it('only the species the player handles are discrete', () => {
    // ATP is a charge on the cytoplasm, not an object you carry, and water and the gases
    // are nobody's inventory. Making them countable would be a category error.
    expect(isDiscrete(GLU)).toBe(true);
    expect(isDiscrete(LAC)).toBe(true);
    expect(isDiscrete(SPECIES_ID.atp)).toBe(false);
    expect(isDiscrete(SPECIES_ID.water)).toBe(false);

    // §5a.9 — the RESIDUES are deliberately not discrete, and this assertion is the record
    // of why. They were, briefly. Playtesting: "it is impossible for a player to reason
    // about where concentrations of amino acids are… finding an amino acid is an impossible
    // task, or sometimes a magical one where they are just around and you don't know why."
    // Locality is meaningless for a residue — what matters is how many the cell has — so
    // they went back to a field and §9.2 draws them cell-wide. The split is: discrete when
    // POSITION CARRIES INFORMATION (an enzyme reaches for glucose, a carrier exports from
    // the face it sits on), continuous when it does not.
    // And not discrete either — they left the spatial model entirely (§5b).
    for (const t of ['gly', 'leu', 'lys', 'ala', 'val'] as const) {
      expect(isDiscrete(aminoId(t))).toBe(false);
    }
  });
});

describe('grains in the whole simulation', () => {
  it('one glucose grain is exactly two lactate grains (§8.1 C6 → 2×C3)', () => {
    // §11.3e gave glucose a hexagon and lactate a triangle because one is a hexose and the
    // other a triose. At these grain units that stops being a visual pun and becomes
    // literally true: LACTATE_PER_GLUCOSE = 2, so 4 glucose molecules make 8 lactate,
    // which is two lactate grains. The player watches one hexagon become two triangles.
    // §5d — one particle is one thing, for every species. There is no per-species parcel
    // size any more, which is what makes "one glucose becomes two lactate" a statement
    // about the things on screen rather than about an invisible conversion.
    expect(PARTICLE).toBe(1);
    expect(grainUnit(GLU)).toBe(grainUnit(LAC));
    const w = new World();
    w.buildGlucoseChannel();
    w.buildEnzyme();
    for (let i = 0; i < 120 * 60; i++) w.step();
    expect(w.grains.count(LAC)).toBeGreaterThan(0);
  });

  it('the cell starts with a countable stock, not a wash', () => {
    // The complaint that produced §5a: ~1,400 dots of which 436 were residues at a
    // concentration measuring 0.0389 against a max of 0.0392 — perfectly flat, and
    // therefore saying nothing at all. The whole point is that this number is small.
    // Now counted after the cell has actually imported something, because the starting
    // stock is residues (a field, §5a.9) and glucose only arrives through a channel.
    const w = new World();
    w.buildGlucoseChannel();
    for (let i = 0; i < 120 * 30; i++) w.step();
    expect(w.grains.grains.length).toBeGreaterThan(3);
    expect(w.grains.grains.length).toBeLessThan(140);
  });

  it('discrete species have NO interior field — there is one representation, not two', () => {
    // A parallel field would be a second copy of the truth, and the two would drift. This
    // is why `interiorAmount` exists: reading the grid for a discrete species is a silent
    // zero, which looks exactly like an empty cell.
    const w = new World();
    w.buildGlucoseChannel();
    for (let i = 0; i < 600; i++) w.step();
    // Glucose is discrete: its interior field is empty and the grains are the truth.
    expect(w.grid.totalIn(GLU, 1)).toBe(0);
    expect(w.interiorAmount(GLU)).toBe(w.grains.total(GLU));
    // Residues are NEITHER since §5b: not grains, and not a field. They are a count, and
    // the grid holds nothing of them anywhere — which is what makes them impossible to
    // render illegibly, because there is no density to get wrong.
    expect(w.grains.count(aminoId('gly'))).toBe(0);
    expect(w.grid.totalIn(aminoId('gly'), 1)).toBe(0);
    expect(w.inventory.get('gly')).toBeGreaterThan(0);
  });

  it('grains are osmotically active — quantising matter must not deflate the cell', () => {
    // §7.2 makes volume a function of TOTAL solute regardless of identity. A molecule that
    // stopped being counted when it became a grain would stop pushing water, and the cell
    // would silently fail to swell — removing §12's whole lactate crisis.
    const w = new World();
    w.buildGlucoseChannel();
    for (let i = 0; i < 120 * 30; i++) w.step();
    const breakdown = w.osmoticBreakdown();
    const glu = breakdown.find((b) => b.name === 'glucose');
    expect(glu).toBeDefined();
    expect(glu!.amount).toBeCloseTo(w.grains.total(GLU), 9);
    expect(glu!.amount).toBeGreaterThan(0);
  });

  it('a grain can be picked up and is carried, not copied', () => {
    // The satchel survives §5a.9 but is no longer on the critical path: construction
    // spends the cell's residue pool, not the bot's pockets. Picking a glucose grain up is
    // still meaningful — you can move fuel to an enzyme that is starving — it is simply
    // not something the game requires you to do to build anything.
    const w = new World();
    w.buildGlucoseChannel();
    for (let i = 0; i < 120 * 30; i++) w.step();
    const g = w.grains.grains.find((q) => q.species === GLU);
    expect(g).toBeDefined();
    w.bot.x = g!.x;
    w.bot.y = g!.y;
    expect(w.pickUp(g!.id).ok).toBe(true);
    expect(w.bot.held(GLU)).toBeCloseTo(g!.amount, 9);
    expect(w.grains.grains.some((q) => q.id === g!.id)).toBe(false);
  });

  it('refuses a pickup out of reach', () => {
    const w = new World();
    w.buildGlucoseChannel();
    for (let i = 0; i < 120 * 30; i++) w.step();
    const g = w.grains.grains[0]!;
    w.bot.x = g.x + 20;
    w.bot.y = g.y + 20;
    const r = w.pickUp(g.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/far/);
  });

  it('the amino transporter carries the residue the PLAYER chose (§5, §6.7)', () => {
    // The gene was hard-coded to glycine, so every amino transporter ever built was a
    // glycine channel — "rare types gate rare proteins" was a rule the game stated and
    // then gave you no way to act on. A cell starved of lysine could not build a lysine
    // importer, which is precisely the situation the rule exists to create.
    const w = new World();
    w.bot.x = w.nucleus.x;
    w.bot.y = w.nucleus.y;
    for (let i = 0; i < 240; i++) w.step();
    expect(w.selectGene('aminoTransporter', 'lys').ok).toBe(true);
    expect(w.build.residue).toBe('lys');

    for (let i = 0; i < 120 * 300 && w.build.phase !== 'carrying'; i++) w.step();
    expect(w.build.phase).toBe('carrying');

    let tile = -1;
    for (let i = 0; i < w.grid.tileCount; i++) {
      if (w.grid.role[i] === 1 && (w.grid.inward[i] ?? -1) >= 0) { tile = i; break; }
    }
    w.bot.x = (tile % w.grid.width) + 0.5;
    w.bot.y = Math.floor(tile / w.grid.width) + 0.5;
    expect(w.deploy(tile).ok).toBe(true);
    expect(w.transporters.get(tile)?.species).toBe(aminoId('lys'));
    expect(w.transporters.get(tile)?.species).not.toBe(aminoId('gly'));
  });

  it('§12 still runs: ATP falls, then a channel, then enzymes turn it around', () => {
    // The regression that matters most. Two prior changes to effective membrane area
    // silently re-tuned the economy and lysed the cell on an arc it had always survived
    // (§10A.5); a change of representation is a far bigger lever than either of those.
    const w = new World();
    const start = w.atp;
    for (let i = 0; i < 120 * 20; i++) w.step();
    const bare = w.atp;
    expect(bare).toBeLessThan(start); // the death clock still ticks

    w.buildGlucoseChannel();
    for (let i = 0; i < 120 * 30; i++) w.step();
    expect(w.atp).toBeLessThan(bare); // raw glucose is not energy
    expect(w.grains.count(GLU)).toBeGreaterThan(0); // but it IS arriving, countably

    w.buildEnzyme();
    w.buildEnzyme();
    w.buildEnzyme();
    for (let i = 0; i < 120 * 40; i++) w.step();
    const fed = w.atp;
    expect(fed).toBeGreaterThan(bare); // the curve turns around
    const swollen = w.cyto.tension;
    expect(w.grains.count(LAC)).toBeGreaterThan(5); // waste piles up, visibly

    w.buildLactateCarrier();
    for (let i = 0; i < 120 * 60; i++) w.step();
    expect(w.cyto.tension).toBeLessThan(swollen); // and the carrier relieves it
    expect(w.cyto.lysed).toBe(false);
  });
});

describe('the catchability rule, and why it stopped being load-bearing (§5a.8 → §5a.9)', () => {
  it('records the rule: what you must walk to cannot outrun you', () => {
    // Kept as a statement of the principle even though nothing currently depends on it.
    //
    // The rule was discovered the hard way. When residues were grains, they drifted at the
    // tabulated D of 8 — netting 5.7 tiles/s against BOT_SPEED 9, on a jitter path of
    // ~44 tiles/s — and playtesting said "they move around so quickly you can't go get
    // them." Slowing them fixed catchability and did NOT fix findability, which is what
    // actually killed the mechanic (§5a.9). The deeper lesson is that a legibility problem
    // will not yield to a tuning fix if the representation itself is wrong.
    //
    // Glucose and lactate are the only grains now and neither must be collected to play,
    // so both keep their true D — which matters, because glucose's traverse from membrane
    // to enzyme IS §17's penetration depth.
    // Metabolites still drift; residues do not. The absolute values moved in §5b.7 —
    // glucose was netting 6.3 tiles/s and its jitter path ~44 tiles/s, which read as a
    // swarm of gnats rather than as matter — but the ORDERING is what this asserts, and
    // it is the part that carries meaning: what machinery handles moves, what sits in a
    // hopper waiting for you does not.
    expect(GRAIN_DRIFT.glucose).toBeGreaterThan(0);
    expect(GRAIN_DRIFT.lactate).toBeGreaterThan(GRAIN_DRIFT.glucose!);
    for (const t of ['gly', 'leu', 'lys', 'ala', 'val'] as const) {
      expect(GRAIN_DRIFT[t]).toBe(0);
    }
  });

  it('the bot can walk to a glucose grain and collect it', () => {
    // Optional, not required: moving fuel to a starving enzyme is a real thing you may do,
    // but no build depends on it. That distinction is the whole of §5a.9.
    const w = new World();
    w.buildGlucoseChannel();
    for (let i = 0; i < 120 * 30; i++) w.step();
    const target = w.grains.grains.find((g) => g.species === GLU);
    expect(target).toBeDefined();

    let collected = false;
    for (let i = 0; i < 120 * 20 && !collected; i++) {
      w.bot.targetX = target!.x;
      w.bot.targetY = target!.y;
      w.step();
      if (Math.hypot(target!.x - w.bot.x, target!.y - w.bot.y) <= 3) {
        collected = w.pickUp(target!.id).ok;
      }
    }
    expect(collected).toBe(true);
  });

  it('NO build requires collecting anything — the supply question is a stock question', () => {
    // The direct regression test for the playtest that produced §5a.9: a player who never
    // picks anything up must still be able to build. Parked at the wall, satchel empty.
    const w = new World();
    w.bot.x = w.nucleus.x;
    w.bot.y = w.nucleus.y;
    for (let i = 0; i < 240; i++) w.step();
    expect(w.selectGene('glycolysisEnzyme').ok).toBe(true);

    for (let i = 0; i < 120 * 120 && w.build.phase !== 'carrying'; i++) {
      w.bot.x = w.cx + w.radius - 3;
      w.bot.y = w.cy;
      w.step();
    }
    expect(w.build.phase).toBe('carrying');
    expect(w.bot.inventory.length).toBe(0);
  });
});
