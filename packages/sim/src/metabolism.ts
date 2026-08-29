/**
 * Glycolysis and the ATP economy. SPEC.md §8.
 *
 * Two decisions here matter more than the arithmetic:
 *
 * 1. **ATP is a FIELD, not a scalar.** It is produced at enzymes and consumed at pumps,
 *    both of which have positions, so a global counter would quietly erase §4.7's entire
 *    premise — that a consumer far from a producer starves unless you move the organelle
 *    closer or run a highway to it. Real cells cluster mitochondria at high-demand sites
 *    for exactly this reason, and that only becomes a decision if ATP has to get there.
 *
 * 2. **Binding rate depends on local CONCENTRATION, not amount.** That single choice
 *    closes §10.3's doom spiral for free: swelling raises tile volume, which lowers
 *    concentration, which slows every enzyme — so reaction rates sag exactly when
 *    throughput is most needed. §10.3 calls this "a one-line addition" that the
 *    prototypes never wired. It is wired here, and it is the `/ tileVolume` below.
 */

import {
  ATP_PER_GLUCOSE,
  ATP_POOL_PER_TILE,
  ENZYME_BIND_TIME,
  LACTATE_PER_GLUCOSE,
  UPKEEP_PER_TILE,
} from './constants.js';
import type { Compartment } from './compartment.js';
import type { Grid } from './grid.js';
import { SPECIES_ID } from './species.js';
import { GrainStore } from './grains.js';
import { EnergyPool } from './energy.js';
import { efficiency, type Perishable } from './denature.js';

/**
 * How far an enzyme reaches for substrate, in tiles (§5a).
 *
 * A tile-local read stopped working when glucose became countable: ~16 grains over 896
 * interior tiles means the enzyme's own tile is empty essentially always, so a
 * point-sampled enzyme would never bind anything and the cell would starve holding a full
 * larder. Three tiles is a diffusion-limited encounter radius — the enzyme catches what
 * drifts past it, which is what an enzyme actually does.
 */
export const ENZYME_REACH = 3;

const GLU = SPECIES_ID.glucose;
const ATP = SPECIES_ID.atp;
const LAC = SPECIES_ID.lactate;

/**
 * Substrate encounter rate at unit concentration.
 *
 * 80, RE-EXPRESSED PER PARTICLE by §5d along with everything else on this path. `near`
 * comes from `totalNear`, which sums particle amounts — so when a parcel stopped being
 * four molecules and became one particle, the same physical amount of glucose started
 * reading as a quarter of the concentration and binding silently slowed fourfold. A rate
 * constant with units of 1/(concentration x time) cannot survive a change of concentration
 * unit unchanged; this is that change, and it exactly cancels.
 *
 * Half-saturation (Km, where binding is as slow as processing) is 0.893/80 = 0.011
 * particles per unit volume, against a nominal cytoplasmic 0.25 — so a healthy cell runs
 * at ~96% of its ceiling and a starved or diluted one falls off it proportionally. Those
 * are the same two numbers as before in the old unit; only the scale moved.
 */
export const K_ON = 80;

/**
 * A glycolysis enzyme. §8.1: ONE ACTIVE SITE — it binds one glucose, processes it over a
 * bind time, releases products, resets. That caps single-copy throughput, so scaling is
 * "build more enzyme copies", never "make it faster".
 *
 * A catalyst, so it is NOT consumed by the reaction: pay the one-time build cost, produce
 * indefinitely. §6.6's distinction is worth keeping in view — an enzyme speeds up a
 * reaction that already wants to happen and spends no ATP, where a pump forces an
 * unfavourable move and burns ATP. Same build pipeline, opposite thermodynamic roles.
 */
export class Enzyme implements Perishable {
  /** §9.4 — enzymes denature like anything else the cell folds. */
  integrity = 1;

  /** Tile index. Position is the whole point — see §4.7. */
  readonly tile: number;
  occupied = false;
  /** Seconds the current substrate has been held. */
  private processT = 0;
  /** Progress toward the next binding event, in [0, 1). */
  private bindP = 0;
  /** Molecules currently held from the bound grain (§5a). */
  private held = 0;
  /** Lactate owed but not yet worth a whole grain. Never rounded away — see mint(). */
  private lactateCarry = 0;

  constructor(tile: number) {
    this.tile = tile;
  }

  /**
   * §15.8 — the enzyme's whole state, including the half-finished catalysis.
   *
   * `processT`, `bindP` and `held` are private and are exactly the fields a naive save
   * would miss: an enzyme restored without them resumes with an empty active site, so a
   * glucose particle it had already swallowed is silently destroyed and the cell's
   * throughput dips for one bind-time after every restart.
   */
  snapshot(): [number, boolean, number, number, number, number, number] {
    return [this.tile, this.occupied, this.processT, this.bindP, this.held, this.lactateCarry, this.integrity];
  }

  static restore(s: [number, boolean, number, number, number, number, number]): Enzyme {
    const e = new Enzyme(s[0]);
    e.occupied = s[1];
    e.processT = s[2];
    e.bindP = s[3];
    e.held = s[4];
    e.lactateCarry = s[5];
    e.integrity = s[6];
    return e;
  }

  reset(): void {
    this.occupied = false;
    this.processT = 0;
    this.bindP = 0;
    this.held = 0;
  }

  /**
   * Advance one step. Returns the number of glucose particles cracked (0 or 1).
   *
   * `tileVolume` is what makes dilution bite: the enzyme sees `amount / tileVolume`, so a
   * swollen cell feeds its own enzymes more slowly without a single molecule moving.
   */
  /**
   * Advance one step. Returns the number of glucose PARTICLES cracked this step (0 or 1).
   *
   * Since §5a the enzyme binds a whole particle rather than a trickle of concentration, so
   * the event is something you can watch: a hexagon vanishes into the enzyme and two
   * triangles come out. §8.1's `LACTATE_PER_GLUCOSE = 2` is the C6 → 2xC3 split, and since
   * §5d made the particle the unit that split is literally what is drawn — one hexagon in,
   * two triangles out, no conversion anywhere.
   *
   * `tileVolume` is what makes dilution bite: the encounter rate uses concentration, so a
   * swollen cell feeds its own enzymes more slowly without a single molecule moving.
   */
  step(grains: GrainStore, grid: Grid, energy: EnergyPool, dt: number, tileVolume: number): number {
    const x = (this.tile % grid.width) + 0.5;
    const y = Math.floor(this.tile / grid.width) + 0.5;

    if (this.occupied) {
      this.processT += dt;
      // §5d — ONE particle, one bind time. This used to be `ENZYME_BIND_TIME * this.held`
      // because a parcel held four molecules and was processed for four bind-times; with
      // one unit there is nothing left to multiply by, and leaving the multiply in place
      // is what made the collapse a 4x speed-up instead of a no-op.
      if (this.processT < ENZYME_BIND_TIME) return 0;

      const particles = this.held;
      this.occupied = false;
      this.processT = 0;
      this.held = 0;
      // §5c — into the cell's charge, not into this tile. ATP is a pool level, not a
      // substance with a location.
      energy.add(ATP_PER_GLUCOSE * particles);
      // Lactate comes back as grains, at the site, so waste appears where it is made.
      this.lactateCarry = grains.mint(
        LAC,
        x,
        y,
        this.lactateCarry + LACTATE_PER_GLUCOSE * particles,
      );
      return particles;
    }

    // Encounter rate scales with local concentration; the single site is the ceiling.
    const near = grains.totalNear(GLU, x, y, ENZYME_REACH);
    if (near <= 0) return 0;
    const area = Math.PI * ENZYME_REACH * ENZYME_REACH;
    // §9.4 — a denaturing enzyme binds more slowly before it stops entirely.
    this.bindP += K_ON * (near / (area * tileVolume)) * efficiency(this) * dt;
    if (this.bindP < 1) return 0;

    const g = grains.nearest(GLU, x, y, ENZYME_REACH);
    if (!g) return 0;
    this.bindP = 0;
    this.held = g.amount;
    grains.remove(g);
    this.occupied = true;
    return 0;
  }
}

export interface MetabolismResult {
  /** Glucose particles cracked this step, across all enzymes. */
  cracked: number;
  /** ATP consumed by baseline upkeep this step. */
  upkeepPaid: number;
  /** Tiles that could not pay their upkeep — local brownout (§2.3). */
  brownedOut: number;
  /** ATP shed as heat because the adenine pool was full. */
  dissipated: number;
}

/**
 * Baseline upkeep: the rent from §2.3, charged per tile.
 *
 * "Being alive is the ongoing act of spending ATP to hold gradients away from
 * equilibrium... mitochondria don't just power construction, they pay rent on staying
 * un-equilibrated, every tick, forever."
 *
 * Charged per tile rather than as a flat total (§13.2) because a flat drain cannot
 * produce the SA:V wall — if rent does not grow with the cell, growing is never punished
 * and §17's forcing function evaporates. A tile that cannot pay browns out locally, which
 * is how the failure arrives spatially rather than as a global game-over flag.
 */
export function payUpkeep(
  grid: Grid,
  comp: Compartment,
  dt: number,
  /**
   * Extra tiles this compartment is responsible for but which hold no ATP of their own —
   * in practice its membrane ring. §13.2 anchors UPKEEP_PER_TILE against CELL_TILES,
   * which is interior PLUS membrane, and the membrane is where much of a real cell's
   * energy actually goes (the Na⁺/K⁺ pump alone is a large share of a neuron's budget).
   * But §4.2 says a membrane tile holds no pool, so it cannot pay directly — its share is
   * billed to the cytoplasm that maintains it.
   */
  dependentTiles = 0,
): { paid: number; brownedOut: number } {
  const payers = comp.tileCount || 1;
  const due = (UPKEEP_PER_TILE * dt * (payers + dependentTiles)) / payers;
  let paid = 0;
  let brownedOut = 0;

  for (let i = 0; i < grid.tileCount; i++) {
    if (grid.compartment[i] !== comp.id) continue;
    const have = grid.get(ATP, i);
    if (have >= due) {
      grid.set(ATP, i, have - due);
      paid += due;
    } else {
      grid.set(ATP, i, 0);
      paid += have;
      brownedOut++;
    }
  }
  return { paid, brownedOut };
}

/**
 * Discard ATP above the adenine pool ceiling. Returns how much was dissipated.
 *
 * ── Why dissipation rather than stalling the enzyme ──────────────────────────
 * Respiratory control is real: a fully charged pool leaves no free ADP, and glycolysis
 * genuinely does slow down. The first implementation here modelled that literally, by
 * refusing to bind substrate when the tile's ATP was full. It produced a much worse bug.
 *
 * With the enzyme stalled, imported glucose stops being consumed, so free internal
 * glucose climbs toward the external concentration — and glucose is osmotically active.
 * Worse, its equilibrium AMOUNT scales with volume, so the usual §7.2 negative feedback
 * (more volume → lower osmolarity → less inflow) inverts into a positive one: more volume
 * admits more glucose, which demands more volume. The cell inflates without a fixed point
 * and lyses. That is hyperglycemia (§10.6) arriving uninvited in the middle of Act 2.
 *
 * §8.1 already specifies the way out, and it is the real biology: "glycolysis' first step
 * traps glucose the instant it enters, holding internal free-glucose near zero, so the
 * import gradient never reverses and the free channel keeps flowing." Hexokinase
 * phosphorylates on entry. So the enzyme must NOT stall, and surplus energy leaves as
 * heat instead — which cells genuinely do (futile cycling, thermogenesis).
 *
 * Worth revisiting once the ribosome exists and ATP has somewhere to go: at that point
 * respiratory control becomes safe to model properly, and a glucose channel left wide open
 * with nothing consuming becomes a legitimate way to kill yourself.
 */
export function dissipateExcessATP(grid: Grid, comp: Compartment): number {
  // The ceiling is on the COMPARTMENT TOTAL, not on any single tile, and the difference
  // is not cosmetic. An enzyme deposits its whole 2 ATP into one tile; a per-tile clamp
  // sees that transient spike and destroys ~87% of it before diffusion can spread it,
  // which silently cut glycolysis' effective yield from 2 ATP to about 0.25 and left the
  // cell starving with a working enzyme. Measured that exact failure before fixing it.
  //
  // Scaling the whole compartment proportionally enforces the pool size while preserving
  // the spatial distribution — which matters, because ATP being a FIELD is the entire
  // point (§4.7).
  const cap = ATP_POOL_PER_TILE * comp.tileCount;
  const total = grid.totalIn(ATP, comp.id);
  if (total <= cap || total <= 0) return 0;

  const scale = cap / total;
  for (let i = 0; i < grid.tileCount; i++) {
    if (grid.compartment[i] !== comp.id) continue;
    grid.set(ATP, i, grid.get(ATP, i) * scale);
  }
  return total - cap;
}

export function stepMetabolism(
  grid: Grid,
  comp: Compartment,
  enzymes: readonly Enzyme[],
  grains: GrainStore,
  energy: EnergyPool,
  dt: number,
  dependentTiles = 0,
): MetabolismResult {
  const tv = comp.tileVolume;
  energy.beginStep();
  let cracked = 0;
  for (const e of enzymes) cracked += e.step(grains, grid, energy, dt, tv);

  const paid = energy.payUpkeep(dt, comp.tileCount + dependentTiles);
  return {
    cracked,
    upkeepPaid: paid,
    brownedOut: energy.brownedOut ? 1 : 0,
    dissipated: energy.lastDissipated,
  };
}

/** Total ATP in a compartment — the HUD number, derived from the field, never stored. */
export function totalATP(grid: Grid, comp: Compartment): number {
  return grid.totalIn(ATP, comp.id);
}

/**
 * Seed a compartment's starting ATP reserve, spread evenly (§13.2's ATP_START).
 */
export function seedATP(grid: Grid, comp: Compartment, total: number): void {
  const per = total / Math.max(1, comp.tileCount);
  for (let i = 0; i < grid.tileCount; i++) {
    if (grid.compartment[i] === comp.id) grid.set(ATP, i, per);
  }
}
