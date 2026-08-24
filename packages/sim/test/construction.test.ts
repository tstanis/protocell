/**
 * §9.2 — the protein construction pipeline, driven by the nanobot.
 *
 * What these tests really protect is §1.2's premise: the player IS the ribosome, so
 * building must cost real material, real energy, and real travel. A build that succeeds
 * from anywhere for free is a menu, not a mechanic.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../src/world.js';
import { ATP_PER_PEPTIDE_BOND, SIM_DT } from '../src/constants.js';
import { GENES, atpCost, billOfMaterials } from '../src/genes.js';
import { CYTOPLASM, Role } from '../src/grid.js';
import { SPECIES_ID, aminoId, type AminoType } from '../src/species.js';

const ALL: readonly AminoType[] = ['gly', 'leu', 'lys', 'ala', 'val'];

function run(w: World, seconds: number): void {
  const steps = Math.round(seconds / SIM_DT);
  for (let n = 0; n < steps; n++) w.step();
}

/** Teleport the bot — these tests are about the pipeline, not about pathfinding. */
function put(w: World, x: number, y: number): void {
  w.bot.x = x;
  w.bot.y = y;
  w.bot.targetX = null;
  w.bot.targetY = null;
}

function toNucleus(w: World): void {
  put(w, w.nucleus.x, w.nucleus.y);
}

/**
 * Stock the field AROUND the bot, because that is how it gathers — construction.ts draws
 * a bead from a radius-4 patch and ATP from radius-6. Piling everything into the single
 * tile underfoot does not work, and should not: see DRAW_RADIUS_RESIDUE for why a
 * single-tile draw made the pipeline unbuildable at realistic field densities.
 */
function stockAround(w: World, perTileResidue = 0.5, perTileATP = 0.12): void {
  // §5c — ATP is the cell's charge, one number. There is no neighbourhood to stock, and
  // `perTileATP` becomes simply how much of it to put in.
  w.energy.add(perTileATP * w.cyto.tileCount);
  // §5b — residues are an INVENTORY. Add stock directly; there is no field to fill and no
  // position for it to be in. `perTileResidue` is reinterpreted as "plenty" vs "a little"
  // so existing call sites keep meaning what they meant.
  //
  // NOT as grains. Seeding grains here made the bot's §5b.5 auto-collect scoop them up
  // mid-test, so the inventory ROSE during a build that was supposed to be spending it —
  // the assertion "residues went down" failed with the stock 3 higher than it started.
  for (const t of ALL) w.inventory.add(t, Math.max(1, Math.round(perTileResidue * 40)));
}

/**
 * Remove one residue type from the WHOLE CELL, to force the blocking case.
 *
 * Cell-wide is the only meaningful way to starve a build since §5a.9: §9.2 draws from the
 * entire cytoplasm, so clearing a patch around the bot does nothing at all. An earlier
 * version of this helper cleared only the neighbourhood and the build sailed straight
 * through the blocking case it was supposed to be testing.
 */
function starveOf(w: World, type: AminoType): void {
  // §5b — empty the stock, AND any particles waiting at a port: §5b.5's auto-collect
  // would otherwise sweep them up on the next step and un-starve the cell, so a test that
  // thought it had removed every lysine would watch the build sail through the blocking
  // case it was written to check.
  w.inventory.take(type, w.inventory.get(type));
  const id = aminoId(type);
  for (const g of [...w.grains.grains]) if (g.species === id) w.grains.remove(g);
}

/** How many of a residue the cell owns (§5b). A count, not a quantity. */
function residueTotal(w: World, type: AminoType): number {
  return w.inventory.get(type);
}

describe('§9.2 step 1 — select gene at the nucleus', () => {
  it('refuses unless the nanobot is actually at the nucleus', () => {
    const w = new World();
    put(w, w.cx + w.radius * 0.5, w.cy - w.radius * 0.5);
    const res = w.selectGene('glycolysisEnzyme');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/nucleus/);
    expect(w.build.phase).toBe('idle');
  });

  it('hands over the blueprint when the bot has gone and got it', () => {
    const w = new World();
    toNucleus(w);
    expect(w.selectGene('glycolysisEnzyme').ok).toBe(true);
    expect(w.build.phase).toBe('assembling');
    expect(w.build.gene?.id).toBe('glycolysisEnzyme');
  });

  it('refuses a second build while one is in progress', () => {
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    expect(w.selectGene('glucoseChannel').ok).toBe(false);
  });
});

describe('§9.1 — the recipe is amino acids + ATP, and cost scales with length', () => {
  it('charges 4 ATP per residue, derived from the sequence rather than authored', () => {
    for (const gene of Object.values(GENES)) {
      expect(atpCost(gene)).toBe(gene.sequence.length * ATP_PER_PEPTIDE_BOND);
    }
    // §9.1's natural gating: a longer chain costs more, so complexity is priced.
    expect(atpCost(GENES.glucoseChannel)).toBeLessThan(atpCost(GENES.aminoTransporter));
    // The lactate carrier is deliberately SHORT despite being a membrane protein, because
    // the job needs two of them (see World.buildLactateCarrier). Cost per protein is not
    // the same as cost per function.
    expect(atpCost(GENES.lactateCarrier) * 2).toBeGreaterThan(atpCost(GENES.aminoTransporter));
  });

  it('the bill of materials is by TYPE, not a generic count (§5)', () => {
    const bom = billOfMaterials(GENES.glycolysisEnzyme);
    expect(bom.get('gly')).toBe(3);
    expect(bom.get('leu')).toBe(2);
    expect(bom.get('lys')).toBe(1);
    expect(bom.get('ala')).toBe(1);
    expect(bom.get('val')).toBe(1);
  });
});

describe('§9.2 step 3 — assemble residue by residue', () => {
  it('consumes typed residues and ATP from the cytoplasm as it works', () => {
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w);

    const glyBefore = residueTotal(w, 'gly');
    run(w, 3);

    expect(w.build.chain.length).toBeGreaterThan(0);
    expect(residueTotal(w, 'gly')).toBeLessThan(glyBefore);
  });

  it('takes real TIME per bond — you can watch the chain extend', () => {
    // Without BOND_TIME this ran at one residue per sim step: 120 a second, an entire
    // protein in 0.07 s. §9.2 wants the first protein to be deliberate.
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w);

    run(w, 1);
    const afterOneSecond = w.build.chain.length;
    expect(afterOneSecond).toBeGreaterThan(0);
    expect(afterOneSecond).toBeLessThan(GENES.glycolysisEnzyme.sequence.length);
  });

  it('builds the chain in SEQUENCE order, not as an unordered pile', () => {
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w);

    run(w, 2);
    const seq = GENES.glycolysisEnzyme.sequence;
    expect(w.build.chain.length).toBeGreaterThan(1);
    expect(w.build.chain).toEqual(seq.slice(0, w.build.chain.length));
  });

  it('spends 4 ATP per bond placed', () => {
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w);
    const atpBefore = w.energy.level;

    run(w, 2);
    const placed = w.build.chain.length;
    expect(placed).toBeGreaterThan(0);

    // Upkeep runs concurrently (~1.6/s), so allow it on top of the bond cost. Stocked ATP
    // is kept modest on purpose: overfilling pushes the cell past ATP_POOL_PER_TILE and
    // dissipateExcessATP sheds the surplus, which would show up here as phantom spending.
    const spent = atpBefore - w.energy.level;
    expect(spent).toBeGreaterThanOrEqual(placed * ATP_PER_PEPTIDE_BOND - 1e-6);
    expect(spent).toBeLessThan(placed * ATP_PER_PEPTIDE_BOND + 6);
  });

  it('spends from an INVENTORY, so there is nothing anywhere to hunt in (§5b)', () => {
    // This assertion has now been rewritten twice, which is the useful part of its history.
    // First it demanded a visible depleted HOLE where the bot gathered (§4.7 texture).
    // Then it demanded the opposite — a uniform draw with no hole — once residues became a
    // cell-wide pool. Now there is no field at all: a residue is a count, so the question
    // "where did it come from" has no answer and cannot be asked.
    //
    // §4.7's texture claim survives on ATP, which is still drawn from a radius, because a
    // local energy brownout is a genuinely spatial event.
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w);

    const before = residueTotal(w, 'gly');
    run(w, 3);
    expect(residueTotal(w, 'gly')).toBeLessThan(before);

    // Whole residues only — a fractional bead is not a thing anyone can count.
    expect(Number.isInteger(residueTotal(w, 'gly'))).toBe(true);
    // And nothing of it is anywhere on the grid.
    let onGrid = 0;
    for (let i = 0; i < w.grid.tileCount; i++) onGrid += w.grid.get(aminoId('gly'), i);
    expect(onGrid).toBe(0);
  });

  it('builds from anywhere in the cell — standing still at the wall is fine', () => {
    // The direct statement of what §5a.9 bought. Parked as far from the centre as the
    // membrane allows, never moving, the build still completes: supply is a stock
    // question, not a navigation one.
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w);

    for (let n = 0; n < Math.round(60 / SIM_DT) && w.build.phase !== 'carrying'; n++) {
      put(w, w.cx + w.radius - 3, w.cy);
      w.step();
    }
    expect(w.build.phase).toBe('carrying');
  });
});

describe('§9.2 step 2 — THE BLOCKING CASE (§16.2 calls this the richest unbuilt mechanic)', () => {
  it('stalls on the specific missing residue, and names it', () => {
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w);
    starveOf(w, 'lys'); // everything present except lysine, the 4th residue

    run(w, 5);

    expect(w.build.phase).toBe('assembling');
    expect(w.build.chain.length).toBe(3); // Leu-Gly-Gly, then it hits Lys and stops
    expect(w.build.blockedOn).toEqual({ residue: 'lys', reason: 'residue' });
  });

  it('resumes the instant the missing residue arrives — nothing already placed is lost', () => {
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w);
    starveOf(w, 'lys');
    run(w, 4);
    expect(w.build.blockedOn?.residue).toBe('lys');
    const stalledAt = w.build.chain.length;

    // The supply line comes through — as stock, which is the only form it has (§5b).
    w.inventory.add('lys', 8);
    run(w, 5);

    expect(w.build.blockedOn).toBeNull();
    expect(w.build.chain.length).toBeGreaterThan(stalledAt);
    expect(w.build.chain.slice(0, stalledAt)).toEqual(
      GENES.glycolysisEnzyme.sequence.slice(0, stalledAt),
    );
  });

  it('stalls on ATP too, mid-chain, and says so', () => {
    // §9.2 step 3: "low ATP visibly stalls assembly mid-chain."
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w);
    for (let i = 0; i < w.grid.tileCount; i++) {
      void i;
    }
    // Just enough for one bond, in reach of the bot.
    // Drain the pool to just over one bond's worth: enough to place one residue and then
    // stall, which is what §9.2 step 3's "low ATP visibly stalls assembly mid-chain" means
    // now that energy is a single charge rather than a field with thin patches in it.
    w.energy.draw(w.energy.level);
    w.energy.add(ATP_PER_PEPTIDE_BOND + 0.5);

    run(w, 4);

    expect(w.build.chain.length).toBeLessThan(GENES.glycolysisEnzyme.sequence.length);
    expect(w.build.blockedOn?.reason).toBe('atp');
  });

  it('reports a shortfall up front but still lets the build start', () => {
    // The half-finished chain waiting on one residue IS the mechanic; refusing up front
    // would turn a supply-chain problem into a menu error.
    const w = new World();
    starveOf(w, 'lys');
    toNucleus(w);
    const res = w.selectGene('lactateCarrier');
    expect(res.ok).toBe(true);
    expect(res.shortfall?.get('lys')).toBeGreaterThan(0);
    expect(w.build.phase).toBe('assembling');
  });
});

describe('§9.2 step 4 — fold', () => {
  it('folds once the chain is complete, then hands the protein to the bot to carry', () => {
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w, 1.0, 0.12);

    run(w, 14);

    expect(w.build.phase).toBe('carrying');
    expect(w.build.fold).toBe(1);
    expect(w.bot.carrying).toEqual([...GENES.glycolysisEnzyme.sequence]);
  });
});

describe('§9.2 step 5 — deploy, and where enzyme and transporter split', () => {
  function buildTo(w: World, gene: Parameters<World['selectGene']>[0]): void {
    toNucleus(w);
    w.selectGene(gene);
    stockAround(w, 1.5, 0.12);
    run(w, 16);
    expect(w.build.phase).toBe('carrying');
  }

  it('an enzyme is released into the cytoplasm wherever the bot is standing', () => {
    const w = new World();
    buildTo(w, 'glycolysisEnzyme');
    const where = w.bot.tile(w.grid);

    expect(w.deploy().ok).toBe(true);
    expect(w.enzymes).toHaveLength(1);
    expect(w.enzymes[0]!.tile).toBe(where);
    expect(w.build.phase).toBe('idle');
    expect(w.bot.carrying).toBeNull();
  });

  it('a transporter must go into the MEMBRANE, not the cytoplasm', () => {
    const w = new World();
    buildTo(w, 'glucoseChannel');
    const res = w.deploy(w.bot.tile(w.grid));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/membrane/);
    expect(w.build.phase).toBe('carrying'); // still held, not lost
  });

  it('and the bot has to walk it there — §6.7 placement is a real decision', () => {
    const w = new World();
    buildTo(w, 'glucoseChannel');

    let far = -1;
    let bestD = -1;
    for (let i = 0; i < w.grid.tileCount; i++) {
      if (w.grid.role[i] !== Role.MEMBRANE || w.grid.inward[i]! < 0) continue;
      const x = (i % w.grid.width) + 0.5;
      const y = Math.floor(i / w.grid.width) + 0.5;
      const d = Math.hypot(x - w.bot.x, y - w.bot.y);
      if (d > bestD) {
        bestD = d;
        far = i;
      }
    }

    expect(w.deploy(far).ok).toBe(false); // too far to seat it

    put(w, (far % w.grid.width) + 0.5, Math.floor(far / w.grid.width) + 0.5);
    expect(w.deploy(far).ok).toBe(true);
    expect(w.transporters.has(far)).toBe(true);
    expect(w.transporters.get(far)!.kind).toBe('channel');
  });

  it('the seated transporter immediately starts moving its species', () => {
    // §9.2 step 5: "the instant it seats, that tile's permeability for its species jumps
    // and transport begins."
    const w = new World();
    buildTo(w, 'glucoseChannel');

    // A membrane tile on the glucose side, so the gradient favours import.
    let best = -1;
    let bestD = Infinity;
    const tx = w.cx - w.radius;
    for (let i = 0; i < w.grid.tileCount; i++) {
      if (w.grid.role[i] !== Role.MEMBRANE || w.grid.inward[i]! < 0) continue;
      const x = (i % w.grid.width) + 0.5;
      const y = Math.floor(i / w.grid.width) + 0.5;
      const d = Math.hypot(x - tx, y - w.cy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    put(w, (best % w.grid.width) + 0.5, Math.floor(best / w.grid.width) + 0.5);
    expect(w.deploy(best).ok).toBe(true);

    // §5a — imported glucose arrives as GRAINS, so it is counted out of the store. Reading
    // the grid here would report a flat zero forever: discrete species have no interior
    // field at all, which is precisely the confusion `interiorAmount` exists to prevent.
    const before = w.interiorAmount(SPECIES_ID.glucose);
    run(w, 25);
    expect(w.interiorAmount(SPECIES_ID.glucose)).toBeGreaterThan(before);
    expect(w.grains.count(SPECIES_ID.glucose)).toBeGreaterThan(0);
  });
});

describe('the nanobot as avatar (§1.2)', () => {
  it('walks toward a target and stops on arrival', () => {
    const w = new World();
    const tx = w.cx + 4;
    const ty = w.cy + 4;
    w.bot.moveTo(tx, ty);
    expect(w.bot.moving).toBe(true);

    run(w, 6);

    expect(Math.hypot(w.bot.x - tx, w.bot.y - ty)).toBeLessThan(1);
    expect(w.bot.moving).toBe(false);
  });

  it('cannot walk out through its own membrane', () => {
    const w = new World();
    w.bot.moveTo(w.cx + 200, w.cy); // far outside
    run(w, 20);
    expect(w.grid.compartment[w.bot.tile(w.grid)]).toBe(CYTOPLASM);
  });

  it('cancelling a build refunds nothing — half a protein is not half useful', () => {
    const w = new World();
    toNucleus(w);
    w.selectGene('glycolysisEnzyme');
    stockAround(w);
    run(w, 2);

    const glyAfterSomeWork = residueTotal(w, 'gly');
    expect(w.build.chain.length).toBeGreaterThan(0);

    w.cancelBuild();

    expect(w.build.phase).toBe('idle');
    expect(w.build.chain).toHaveLength(0);
    expect(residueTotal(w, 'gly')).toBeCloseTo(glyAfterSomeWork, 6);
  });
});
