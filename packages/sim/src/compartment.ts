/**
 * Compartments and the volume/osmosis coupling. SPEC.md §7, §4.3.
 *
 * §7.1 is the load-bearing sentence: "VOLUME IS THE DENOMINATOR OF CONCENTRATION."
 * Growing the cell dilutes everything already inside it and slows every
 * concentration-dependent reaction; shrinking concentrates and speeds them. You cannot
 * independently maximise floor space and reaction rate — one equation binds them, and
 * the player is always trading one against the other.
 *
 * ── Why volume is a scalar and not a tile count ──────────────────────────────
 * A compartment's volume is tracked as a continuous scalar, separate from how many tiles
 * it occupies. Tile volume is then `volume / tileCount`, and concentration is
 * `amount / tileVolume`.
 *
 * The alternative — volume IS tile count, so swelling adds tiles — is more physically
 * literal, but it makes every osmotic wobble a re-tiling event, and §3.6 names re-tiling
 * the single genuinely difficult seam in the whole design. Coupling the two would mean
 * the intro could not exist until division worked. Keeping them separate lets the §7
 * dynamic run at full fidelity now, and lets growth/division (§4.5) change tile count
 * later as a distinct, deliberate operation.
 */

import {
  A_REST,
  B_OSM_OVER_S_NOM,
  BLEB_TENSION_MIN,
  BLEB_VOLUME_FACTOR,
  LP,
  R0,
  RUPTURE,
  STIFF,
} from './constants.js';
import type { Grid } from './grid.js';
import { OSMOTIC_BY_ID } from './species.js';

/**
 * Nominal solute load at rest, in PARTICLES: enough for a mean concentration of 0.25
 * particles per unit volume across a rest-sized compartment. Everything osmotic is
 * measured against this.
 *
 * ── Why this is A_REST/4 and not A_REST ────────────────────────────────────
 * It used to read `= A_REST`, which looked like a law and was really a UNIT COINCIDENCE:
 * a nominal concentration of 1.0 molecule per unit volume across 1000 tiles² is 1000
 * molecules, and 1000 was also the area. §5d collapsed the parcel and the molecule into
 * one particle, so the same physical cell now counts a quarter as many things — and the
 * coincidence quietly became a 4x error.
 *
 * It was a silent one, because osmolarity is dominated by B_OSM: the cell did not break,
 * it just stopped swelling. Measured, §12.3's waste crisis never arrived — a cell that had
 * reliably ballooned toward rupture on a running enzyme sat at volume 819 against a
 * threshold of 896 and simply idled there, so Act 2 had no second half.
 *
 * Dividing both this and B_OSM by four leaves `B_OSM / S_NOM` untouched, so resting
 * volume, rupture threshold and every §7 relationship are bit-for-bit what they were. Only
 * the unit the load is COUNTED in has changed, which is the whole of §5d.
 *
 * The general lesson, and the reason this is written out: a constant defined as equal to
 * another constant is not thereby safe from a change of units. `S_NOM = A_REST` survived
 * the collapse unexamined precisely because it had no number in it to look wrong.
 */
export const S_NOM = A_REST / 4;

/**
 * §5's "baseline osmolytes": fixed intracellular proteins and ions. Not a field and not
 * transportable — a constant that DOMINATES osmolarity so that metabolites do not swing
 * volume wildly. Without it, a single glucose bolus would visibly inflate the cell, and
 * the swelling would stop reading as a waste crisis.
 */
export const B_OSM = B_OSM_OVER_S_NOM * S_NOM;

export class Compartment {
  readonly id: number;

  /** Current volume (2D area, in tiles²). The denominator of every concentration here. */
  volume: number;

  /** Rest volume — the volume this compartment's membrane was manufactured to hold. */
  restVolume: number;

  /** Baseline osmolytes. Zero for the extracellular space. */
  baselineOsmolytes: number;

  /** Number of grid tiles currently assigned to this compartment. */
  tileCount = 0;

  /** §7.3's master variable, 0..1. Drives wobble character and membrane colour. */
  tension = 0;

  /** Fractional radius stretch beyond rest. Lysis at RUPTURE (§7.4). */
  stretch = 0;

  lysed = false;

  constructor(id: number, restVolume = A_REST, baselineOsmolytes = B_OSM) {
    this.id = id;
    this.volume = restVolume;
    this.restVolume = restVolume;
    this.baselineOsmolytes = baselineOsmolytes;
  }

  /**
   * Volume of a single tile. Concentration = amount / tileVolume, so this is what makes
   * §7.1's coupling real rather than decorative: as `volume` grows with a fixed tile
   * count, every tile's concentration falls without a single amount having moved.
   */
  get tileVolume(): number {
    return this.tileCount > 0 ? this.volume / this.tileCount : 1;
  }

  get radius(): number {
    return Math.sqrt(this.volume / Math.PI);
  }
}

/**
 * Total osmotically active solute in a compartment, including the fixed baseline.
 *
 * `extra` is the quantity held OUTSIDE the field — since §5a, glucose, lactate and the
 * residues live inside the cell as discrete grains and contribute nothing to the grid
 * plane. Osmosis does not care which representation a molecule happens to have; §7.2 makes
 * volume a function of total solute regardless of identity, and a molecule that stopped
 * being counted here would stop pushing water, which is how a cell silently deflates.
 */
export function totalSolute(grid: Grid, comp: Compartment, extra = 0): number {
  let sum = comp.baselineOsmolytes + extra;
  for (let s = 0; s < OSMOTIC_BY_ID.length; s++) {
    if (!OSMOTIC_BY_ID[s]) continue;
    sum += grid.totalIn(s, comp.id);
  }
  return sum;
}

export interface OsmosisResult {
  lysed: boolean;
}

/**
 * One osmosis step. SPEC.md §7.4 — the exact model `full_cell.html` runs, re-expressed
 * in grid units.
 *
 *     A_osm  = A_REST * solute / S_NOM      // volume at which inside osmolarity matches out
 *     resist = 1 + STIFF * max(0, A/A_REST - 1)
 *     A     += (A_osm - A) * min(1, LP*dt) / resist
 *
 * §7.2: water moves toward higher TOTAL solute, independent of which solute — so
 * accumulating any trapped waste raises osmolarity, water floods in, volume rises, and
 * every concentration falls at once. There is negative feedback (more volume → lower
 * osmolarity → less inflow) so it self-regulates, but matching requires volume to grow
 * in proportion to accumulated solute. Unremoved solute therefore means relentless
 * swelling, which is §10.2's entire death chain.
 *
 * §7.3: real bilayers stretch ~2–3% before rupture and cells enlarge by MANUFACTURING
 * membrane, not stretching it — hence `resist`, which stiffens sharply past rest.
 */
export function stepOsmosis(
  grid: Grid,
  comp: Compartment,
  dt: number,
  /** Osmotically active quantity held as grains rather than in the field (§5a). */
  grainSolute = 0,
): OsmosisResult {
  if (comp.lysed) return { lysed: true };

  const solute = totalSolute(grid, comp, grainSolute);
  const aOsm = comp.restVolume * (solute / S_NOM);

  const resist = 1 + STIFF * Math.max(0, comp.volume / comp.restVolume - 1);
  comp.volume += ((aOsm - comp.volume) * Math.min(1, LP * dt)) / resist;

  const r0 = Math.sqrt(comp.restVolume / Math.PI);
  comp.stretch = comp.radius / r0 - 1;
  comp.tension = Math.min(1, Math.max(0, comp.stretch / RUPTURE));

  if (comp.stretch >= RUPTURE) {
    comp.lysed = true;
    return { lysed: true };
  }
  return { lysed: false };
}

/**
 * §10.4 — the emergency escape. Under critical tension a cell pinches off a vesicle,
 * shedding volume AND solute to survive instead of rupturing.
 *
 * The point is that a red-line threshold is binary and unfair, so the swell gives a
 * visible, gradual, survivable warning with agency at every stage: swell → strain →
 * (clear the waste, or bleb, or lyse if ignored). It costs real material — that is the
 * price of the reprieve, not a free undo.
 *
 * Returns false if tension has not reached the threshold, so the UI can gate the button
 * on exactly the same predicate the simulation uses.
 */
export function bleb(
  grid: Grid,
  comp: Compartment,
  species: readonly number[],
  shedFraction: number,
): boolean {
  if (comp.lysed || comp.tension < BLEB_TENSION_MIN) return false;

  for (const s of species) {
    for (let i = 0; i < grid.tileCount; i++) {
      if (grid.compartment[i] !== comp.id) continue;
      grid.set(s, i, grid.get(s, i) * (1 - shedFraction));
    }
  }
  comp.volume *= BLEB_VOLUME_FACTOR;
  return true;
}

/** Recount tiles per compartment. Call after any geometry change (§4.5). */
export function syncTileCounts(grid: Grid, comps: readonly Compartment[]): void {
  for (const c of comps) c.tileCount = 0;
  const byId = new Map(comps.map((c) => [c.id, c]));
  for (let i = 0; i < grid.tileCount; i++) {
    const c = byId.get(grid.compartment[i]!);
    if (c) c.tileCount++;
  }
}

export { R0, A_REST };
