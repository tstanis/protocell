/**
 * SPEC.md §16.1 — glycolysis and the ATP economy of §8.
 */

import { describe, expect, it } from 'vitest';
import { Compartment, S_NOM, syncTileCounts } from '../src/compartment.js';
import {
  ATP_PER_GLUCOSE,
  ATP_START,
  CELL_TILES,
  ENZYME_BIND_TIME,
  ENZYME_TURNOVER,
  LACTATE_PER_GLUCOSE,
  SIM_DT,
  UPKEEP_PER_TILE,
} from '../src/constants.js';
import { CYTOPLASM, Grid, Role } from '../src/grid.js';
import { Enzyme, payUpkeep, seedATP, stepMetabolism, totalATP } from '../src/metabolism.js';
import { SPECIES_ID } from '../src/species.js';
import { GrainStore, grainUnit } from '../src/grains.js';
import { EnergyPool } from '../src/energy.js';

const GLU = SPECIES_ID.glucose;
const LAC = SPECIES_ID.lactate;

/**
 * Since §5a glucose and lactate are GRAINS, not field. These tests seed and read them
 * accordingly: `feed` puts substrate where the enzyme can reach it, and lactate is counted
 * out of the store rather than off the grid.
 */
/**
 * TOP UP the substrate near a tile to `molecules`, rather than adding that much again.
 *
 * The distinction did not exist when glucose was a field and it is load-bearing now that
 * it is grains. "Add 5 every step" costs a field nothing — it is the same array — but it
 * ALLOCATES AN OBJECT every step once matter is discrete. Written the naive way inside a
 * 20,000-step loop it minted ~25,000 grains, each of them then linearly scanned by
 * `totalNear` on every subsequent step, and the worker died with "JavaScript heap out of
 * memory". Vitest reported that as a worker crash and still exited 0, so the whole file's
 * 12 tests silently stopped running while the suite looked green.
 *
 * Two lessons, both worth more than the fix. A test helper written against a continuum
 * does not automatically survive becoming discrete. And a crashed worker is not a skipped
 * test — check the file COUNT, not just the pass count.
 *
 * It also takes GRAINS rather than molecules, because quantisation means you cannot have
 * less than one of a thing: `GRAIN_UNIT.glucose` is 4, so asking for "1 molecule" minted
 * nothing at all and the enzyme sat starving next to an empty store. Counting in the unit
 * the simulation actually deals in makes that impossible to write by accident.
 */
function feed(grains: GrainStore, grid: Grid, tile: number, nGrains: number): void {
  const x = (tile % grid.width) + 0.5;
  const y = Math.floor(tile / grid.width) + 0.5;
  const unit = grainUnit(SPECIES_ID.glucose);
  const want = nGrains * unit;
  const have = grains.totalNear(SPECIES_ID.glucose, x, y, 3);
  if (have < want) grains.mint(SPECIES_ID.glucose, x, y, want - have);
}

function cell(tiles = 100): { grid: Grid; comp: Compartment } {
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
  // Rest volume scaled to this test cell so tileVolume is 1.0 at rest.
  comp.restVolume = comp.tileCount;
  comp.volume = comp.tileCount;
  return { grid, comp };
}

describe('§8.1 — glycolysis', () => {
  it('yields 2 ATP and 2 lactate per glucose (real stoichiometry)', () => {
    const { grid, comp } = cell();
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
    const e = new Enzyme(grid.idx(3, 3));
    feed(grains, grid, e.tile, 1); // exactly ONE grain

    let cracked = 0;
    for (let n = 0; n < 2000 && cracked === 0; n++) {
      cracked += stepMetabolism(grid, comp, [e], grains, energy, SIM_DT).cracked;
    }

    // One GRAIN is GRAIN_UNIT.glucose molecules, and the enzyme binds it whole (§5a), so
    // one binding event cracks that many. The per-molecule stoichiometry below is what
    // §8.1 actually asserts and it is unchanged.
    expect(cracked).toBe(grainUnit(SPECIES_ID.glucose));
    // Not exactly 2: the tile pays one step of upkeep the instant it has ATP to pay
    // with, so the yield arrives already taxed. That is the §2.3 rent working correctly,
    // and it is exactly UPKEEP_PER_TILE * SIM_DT ≈ 1.3e-5 short.
    // §5c — ATP is the cell's CHARGE, one number, not a per-tile amount. Reading it off
    // the grid returns zero, which looks exactly like an enzyme that produced nothing.
    expect(energy.level).toBeCloseTo(
      ATP_PER_GLUCOSE * cracked - UPKEEP_PER_TILE * SIM_DT * comp.tileCount,
      6,
    );
    expect(grains.total(LAC)).toBeCloseTo(LACTATE_PER_GLUCOSE * cracked, 9);
    // And that is exactly two lactate GRAINS from one glucose grain — §8.1's C6 → 2×C3,
    // true at the level of entities and not merely of arithmetic.
    expect(grains.count(LAC)).toBe(2);
    // §13.3's correction: 2 lactate, not 1. A C6 sugar splits into two C3 units.
    expect(LACTATE_PER_GLUCOSE).toBe(2);
  });

  it('is a CATALYST — not consumed, and runs indefinitely', () => {
    const { grid, comp } = cell();
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
    const e = new Enzyme(grid.idx(3, 3));

    let cracked = 0;
    for (let n = 0; n < 20_000; n++) {
      feed(grains, grid, e.tile, 2); // keep two grains within reach
      cracked += stepMetabolism(grid, comp, [e], grains, energy, SIM_DT).cracked;
    }
    expect(cracked).toBeGreaterThan(100);
  });

  it('one active site caps throughput at 1/BIND_TIME however much substrate exists', () => {
    // §8.1: "This caps single-enzyme throughput; scaling is 'build more enzyme copies,'
    // not 'make it faster.'" Flooding the tile must NOT raise the rate.
    const { grid, comp } = cell();
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
    const e = new Enzyme(grid.idx(3, 3));

    const seconds = 20;
    const steps = Math.round(seconds / SIM_DT);
    let cracked = 0;
    for (let n = 0; n < steps; n++) {
      feed(grains, grid, e.tile, 200); // absurd excess
      cracked += stepMetabolism(grid, comp, [e], grains, energy, SIM_DT).cracked;
    }

    const rate = cracked / seconds;
    expect(rate).toBeLessThanOrEqual(ENZYME_TURNOVER + 0.05);
    expect(rate).toBeGreaterThan(ENZYME_TURNOVER * 0.9);
  });

  it('scaling comes from MORE COPIES, and scales linearly', () => {
    const run = (count: number): number => {
      const { grid, comp } = cell();
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
      const enzymes = Array.from({ length: count }, (_, k) => new Enzyme(grid.idx(2 + k, 3)));
      const steps = Math.round(10 / SIM_DT);
      let cracked = 0;
      for (let n = 0; n < steps; n++) {
        for (const e of enzymes) feed(grains, grid, e.tile, 25);
        cracked += stepMetabolism(grid, comp, enzymes, grains, energy, SIM_DT).cracked;
      }
      return cracked;
    };
    const one = run(1);
    const four = run(4);
    expect(four / one).toBeGreaterThan(3.8);
    expect(four / one).toBeLessThan(4.2);
  });
});

describe('§10.3 — the doom spiral, finally wired', () => {
  it('dilution slows the enzyme — the feedback the prototypes never connected', () => {
    // §10.3: "In the prototype, dilution is SHOWN (tint = count/A) but not yet fed back
    // into enzyme rate — wiring dilution → slower reactions is a one-line addition that
    // makes the crisis accelerate itself." This is that test.
    //
    // Same ABSOLUTE amount of glucose, different compartment volumes. The swollen cell
    // must crack fewer, purely because its contents are more dilute.
    const measure = (volumeMultiple: number): number => {
      const { grid, comp } = cell();
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
      comp.volume = comp.restVolume * volumeMultiple;
      const e = new Enzyme(grid.idx(3, 3));
      const steps = Math.round(20 / SIM_DT);
      let cracked = 0;
      for (let n = 0; n < steps; n++) {
        feed(grains, grid, e.tile, 1); // one grain: scarce, so binding is rate-limiting
        cracked += stepMetabolism(grid, comp, [e], grains, energy, SIM_DT).cracked;
      }
      return cracked;
    };

    const normal = measure(1);
    const swollen = measure(3);

    expect(normal).toBeGreaterThan(0);
    expect(swollen).toBeLessThan(normal);
    // Roughly inverse in the binding-limited regime: 3x the volume, ~1/3 the rate.
    expect(swollen).toBeGreaterThan(normal / 5);
  });

  it('a saturated enzyme is unaffected by dilution — the spiral needs scarcity first', () => {
    // Worth pinning: the feedback only bites once substrate is limiting. A well-fed cell
    // can swell somewhat without losing throughput, which is what makes the spiral a
    // TRAP rather than a constant tax — you feel fine right up until you do not.
    const measure = (volumeMultiple: number): number => {
      const { grid, comp } = cell();
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
      comp.volume = comp.restVolume * volumeMultiple;
      const e = new Enzyme(grid.idx(3, 3));
      const steps = Math.round(10 / SIM_DT);
      let cracked = 0;
      for (let n = 0; n < steps; n++) {
        feed(grains, grid, e.tile, 125);
        cracked += stepMetabolism(grid, comp, [e], grains, energy, SIM_DT).cracked;
      }
      return cracked;
    };
    expect(measure(2)).toBe(measure(1));
  });
});

describe('§8.2 / §13.2 — upkeep is the death clock, and it SCALES', () => {
  it('drains exactly 1.8 ATP/s at §4.1 cell size — the playtested value', () => {
    // The whole point of the per-tile anchor (§13.2): intro pacing is preserved bit for
    // bit while the constant acquires a size dependence the flat version could not have.
    const { grid, comp } = cell(CELL_TILES);
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
    seedATP(grid, comp, 10_000);

    const steps = Math.round(1 / SIM_DT);
    let paid = 0;
    for (let n = 0; n < steps; n++) paid += payUpkeep(grid, comp, SIM_DT).paid;

    expect(paid).toBeCloseTo(1.8, 6);
  });

  it('a bigger cell pays proportionally more — without this §17 cannot exist', () => {
    const drain = (tiles: number): number => {
      const { grid, comp } = cell(tiles);
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
      seedATP(grid, comp, 1e6);
      const steps = Math.round(1 / SIM_DT);
      let paid = 0;
      for (let n = 0; n < steps; n++) paid += payUpkeep(grid, comp, SIM_DT).paid;
      return paid;
    };

    const small = drain(200);
    const big = drain(800);
    expect(big / small).toBeCloseTo(4, 4);
    expect(UPKEEP_PER_TILE).toBeGreaterThan(0);
  });

  it('browns out locally when ATP runs dry, rather than flipping a global flag', () => {
    // §2.3: "When the power grid browns out, pumps stop, gradients slump, and the
    // organism dies the way real cells die." Making that spatial is what lets a cell be
    // partly in trouble — which is the whole of §17's dead-core failure mode.
    const { grid, comp } = cell(100);
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
    seedATP(grid, comp, 0);
    const res = payUpkeep(grid, comp, SIM_DT);
    expect(res.brownedOut).toBe(comp.tileCount);
    expect(res.paid).toBe(0);
  });

  it('the intro reserve covers the bootstrap: two proteins plus the wait', () => {
    const { grid, comp } = cell(CELL_TILES);
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
    seedATP(grid, comp, ATP_START);

    let seconds = 0;
    while (totalATP(grid, comp) > 0.01 && seconds < 120) {
      for (let n = 0; n < Math.round(1 / SIM_DT); n++) payUpkeep(grid, comp, SIM_DT);
      seconds++;
    }
    // 140 / 1.8 = 78 s of idle grace — but idling is not what the reserve is FOR. It has
    // to fund the glucose channel (24 ATP) and the glycolysis enzyme (32 ATP) plus the
    // ~30 s of walking and assembling between them, because nothing produces ATP until
    // both exist. See the note on ATP_START.
    const bootstrapATP = 24 + 32;
    const bootstrapSeconds = 30;
    // The reserve must clear the bootstrap with real margin, because local gathering and
    // travel time both cost more than the arithmetic sum suggests — see ATP_START.
    expect(ATP_START).toBeGreaterThan((bootstrapATP + bootstrapSeconds * 1.8) * 1.8);
    // 220 / 1.8 ≈ 122 s of idle grace. Generous on paper; most of it goes on the two
    // proteins that have to exist before anything produces ATP at all.
    expect(seconds).toBeGreaterThan(100);
    expect(seconds).toBeLessThan(140);
  });
});

describe('the intro economy closes (§13.3)', () => {
  it('one fed enzyme comfortably outpaces upkeep at intro size', () => {
    // 7.14 ATP/s produced against 1.8 ATP/s upkeep — real headroom, and a real ceiling.
    // This is Act 2's emotional beat: the counter turns around and climbs.
    const { grid, comp } = cell(CELL_TILES);
    const grains = new GrainStore();
    const energy = new EnergyPool(0, comp.tileCount);
    const e = new Enzyme(grid.idx(5, 5));
    energy.add(ATP_START);

    const before = energy.level;
    const steps = Math.round(10 / SIM_DT);
    for (let n = 0; n < steps; n++) {
      feed(grains, grid, e.tile, 12);
      stepMetabolism(grid, comp, [e], grains, energy, SIM_DT);
    }
    const after = energy.level;

    expect(after).toBeGreaterThan(before);
    const netPerSecond = (after - before) / 10;
    expect(netPerSecond).toBeGreaterThan(4); // ~7.14 produced − 1.8 upkeep
    expect(netPerSecond).toBeLessThan(6);
  });

  it('lactate from a running enzyme is enough to matter osmotically', () => {
    // Act 2's crisis has to arrive on its own. At 0.893 cracks/s x 2 lactate, a single
    // enzyme produces ~1.79 lactate PARTICLES/s; S_NOM is the nominal total solute load,
    // also in particles, so this sanity-checks that the waste is on a scale that can
    // actually move volume.
    //
    // These were 7.14 and 0.28 — the same physical rates written in the molecule unit §5d
    // retired. Both halves of the comparison had to move together, and the value of the
    // check is that it FAILED when only one of them did: the collapse left ENZYME_BIND_TIME
    // per-molecule while everything around it became per-particle, which ran the enzyme
    // four times too fast.
    const perSecond = ENZYME_TURNOVER * LACTATE_PER_GLUCOSE;
    expect(perSecond).toBeCloseTo(1.79, 1);
    const secondsToHalfNominal = S_NOM / 2 / perSecond;
    expect(secondsToHalfNominal).toBeLessThan(120);
    expect(ENZYME_BIND_TIME).toBe(1.12);
  });
});
