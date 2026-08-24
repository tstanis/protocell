/**
 * Protein construction. SPEC.md §9.2 — the pipeline, on the real grid.
 *
 *   1. Select gene at the nucleus     (the blueprint library)
 *   2. Read the bill of materials     (blocks on a specific missing residue)
 *   3. Assemble residue by residue    (consumes typed amino acids, ~4 ATP a bond)
 *   4. Fold                            (the shape IS the function)
 *   5. Deploy                          (transporter to a face, enzyme into the soup)
 *
 * The nanobot must physically BE somewhere for each of these. It picks residues out of
 * the field at its own tile and pays ATP out of the field at its own tile, so a bot
 * standing in a depleted corner stalls exactly like a starved enzyme does. That is §4.7's
 * spatial premise arriving in the intro, before belts exist to solve it.
 */

import { ATP_PER_PEPTIDE_BOND } from './constants.js';
import { GENES, atpCost, billOfMaterials, type Gene, type GeneId } from './genes.js';
import { CYTOPLASM, type Grid } from './grid.js';
import { Inventory, RESIDUES_PER_BOND } from './inventory.js';
import { EnergyPool } from './energy.js';
import type { Nanobot } from './nanobot.js';
import { SPECIES_ID, aminoId, type AminoType, type SpeciesId } from './species.js';

const ATP = SPECIES_ID.atp;

export type BuildPhase = 'idle' | 'assembling' | 'folding' | 'carrying';

/** Seconds the fold animation occupies. §9.2 step 4 calls it "the payoff beat". */
export const FOLD_TIME = 1.3;

/**
 * Seconds per peptide bond.
 *
 * Without this, assembly ran at one residue per SIM step — 120 a second, so an entire
 * protein appeared in 0.07 s. §9.2 is explicit that the first protein is "deliberate,
 * click-each-bead" and that watching the chain extend is the point, so the bond needs a
 * duration you can actually see. At 0.45 s the eight-residue glycolysis enzyme takes 3.6 s
 * to assemble and 1.3 s to fold — about five seconds of visible work for the first build.
 */
export const BOND_TIME = 0.45;

/**
 * One bead, as an amount. Amino acid fields are continuous, so a residue is a quantity
 * rather than a count.
 *
 * 0.25 rather than 1.0, and the reason is a scale mismatch that stalled the intro. The
 * residue stock is osmotically active (§7.2), so it cannot simply be made large — at four
 * times the current pool the cell starts at stretch 0.27 against a rupture threshold of
 * 0.30, swollen before the player has done anything. That caps the cell's total lysine
 * around 26 units.
 *
 * At `RESIDUE_UNIT = 1` a single bead was therefore ~4% of the cell's entire lysine and
 * ~80% of what the bot's radius-4 gathering patch held, so every pickup emptied the local
 * neighbourhood and the next one waited on diffusion at D=8 to refill it. The bot spent
 * most of its time blocked. At 0.25 the patch holds ~5 beads, pickups are smooth, and the
 * blocking case (§9.2 step 2) still fires when a type genuinely runs out — which is what
 * it is supposed to signal.
 */
/**
 * @deprecated since §5b — residues are counted, not measured. `RESIDUES_PER_BOND` in
 * inventory.ts is the live constant. Kept only so older comments resolve.
 */
export const RESIDUE_UNIT = 1;

/**
 * The bot gathers from a neighbourhood, not from the single tile under it.
 *
 * This is forced by the scale of the fields, and getting it wrong made the whole pipeline
 * unbuildable at first: a starting stock of ~30 glycine spread across 896 cytoplasm tiles
 * is 0.033 per tile, so demanding a whole unit from one tile asked for thirty times the
 * cell's entire supply in one place. The bot would have starved standing in a full pantry.
 *
 * Physically this is also just right — an assembler pulls in what diffuses to it, it does
 * not wait for material to land on a single point. The two radii differ because the
 * species do: ATP is small and fast (D=15) so its catchment is genuinely wider than that
 * of the bulkier, slower amino acids (D=8).
 *
 * The side effect is the good kind: gathering leaves a visible hole in the residue field
 * around wherever you worked, so building in one spot repeatedly depletes it and you have
 * to move. That is §4.7's hotspots-and-cold-zones texture, arriving in the intro.
 */
export const DRAW_RADIUS_RESIDUE = 4;
export const DRAW_RADIUS_ATP = 6;

/** Total of a species within `radius` tiles of `centre`. */
function localTotal(grid: Grid, centre: number, species: SpeciesId, radius: number): number {
  const cx = centre % grid.width;
  const cy = Math.floor(centre / grid.width);
  const comp = grid.compartment[centre];
  let sum = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(grid.height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(grid.width - 1, cx + radius); x++) {
      const i = y * grid.width + x;
      if (grid.compartment[i] !== comp) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      sum += grid.get(species, i);
    }
  }
  return sum;
}

/** Draw `want` of a species from the neighbourhood, proportionally. Returns what was taken. */
/**
 * Total of a species across the whole cytoplasm (§5a.9).
 *
 * Residues are drawn cell-wide rather than locally, so this is the availability test that
 * matters for §9.2. Deliberately NOT position-dependent: a player cannot reason about
 * where a residue is, and making a build depend on that produced a mechanic that was
 * either an impossible search or an inexplicable gift.
 */
function cellTotal(grid: Grid, species: SpeciesId): number {
  return grid.totalIn(species, CYTOPLASM);
}

/** Take `want` from the cytoplasm, proportionally across every tile that holds any. */
function takeFromCell(grid: Grid, species: SpeciesId, want: number): number {
  const have = cellTotal(grid, species);
  if (have <= 0) return 0;
  const take = Math.min(want, have);
  // Proportional, so a well-mixed pool stays well mixed and no tile is driven negative.
  const f = take / have;
  for (let i = 0; i < grid.tileCount; i++) {
    if (grid.compartment[i] !== CYTOPLASM) continue;
    const a = grid.get(species, i);
    if (a > 0) grid.add(species, i, -a * f);
  }
  return take;
}

/** Return an unspent residue to the cytoplasm, at the bot rather than nowhere. */
function giveToCell(grid: Grid, species: SpeciesId, amount: number, tile: number): void {
  if (amount <= 0) return;
  if (grid.compartment[tile] === CYTOPLASM) grid.add(species, tile, amount);
}

function gather(
  grid: Grid,
  centre: number,
  species: SpeciesId,
  want: number,
  radius: number,
): number {
  const available = localTotal(grid, centre, species, radius);
  if (available < want) return 0;

  const frac = want / available;
  const cx = centre % grid.width;
  const cy = Math.floor(centre / grid.width);
  const comp = grid.compartment[centre];
  let taken = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(grid.height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(grid.width - 1, cx + radius); x++) {
      const i = y * grid.width + x;
      if (grid.compartment[i] !== comp) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      const take = grid.get(species, i) * frac;
      grid.add(species, i, -take);
      taken += take;
    }
  }
  return taken;
}

export interface BuildState {
  phase: BuildPhase;
  gene: Gene | null;
  /** Residues placed so far — the chain, in order. */
  chain: AminoType[];
  /** Fold progress in [0,1]. */
  fold: number;
  /** Seconds accumulated toward the current peptide bond. */
  bondT: number;
  /**
   * Why assembly is not progressing right now, or null if it is. This is the readable
   * half of §9.2 step 2's blocking case: the player must be able to see WHICH bead the
   * build is waiting on, otherwise a stalled build is indistinguishable from a bug.
   */
  blockedOn: { residue: AminoType; reason: 'residue' | 'atp' } | null;
  /**
   * Which amino acid this product will carry, for a type-selectable gene (§5, §6.7).
   * Null when the gene's species is fixed. Captured at blueprint time, not deploy time,
   * so the choice is part of what you built rather than an afterthought at the wall.
   */
  residue: AminoType | null;
}

export function emptyBuild(): BuildState {
  return { phase: 'idle', gene: null, chain: [], fold: 0, bondT: 0, blockedOn: null, residue: null };
}

/** The next residue the sequence calls for, or null when the chain is complete. */
export function nextResidue(b: BuildState): AminoType | null {
  if (!b.gene) return null;
  return b.gene.sequence[b.chain.length] ?? null;
}

export interface StartResult {
  ok: boolean;
  /** Populated when the pool cannot cover the sequence — §9.2 step 2's up-front check. */
  shortfall?: Map<AminoType, number>;
}

/**
 * §9.2 step 1–2. Choosing the gene is choosing the recipe; the panel then checks the
 * cytoplasm pool against the bill of materials.
 *
 * A shortfall does NOT prevent starting. The spec is specific that the build "blocks on
 * that specific bead until it's imported or synthesized" — so a partially-buildable
 * protein is a legitimate state, and the half-finished chain sitting there waiting on one
 * Lys is the mechanic. Refusing up front would turn a supply-chain problem into a menu
 * error message.
 */
export function startBuild(
  b: BuildState,
  geneId: GeneId,
  poolTotals: ReadonlyMap<AminoType, number>,
  /** For a type-selectable product (§5), which amino acid it will carry. */
  residue?: AminoType,
): StartResult {
  if (b.phase !== 'idle') return { ok: false };
  const gene = GENES[geneId];
  b.residue = gene.selectableResidue ? (residue ?? 'gly') : null;
  b.phase = 'assembling';
  b.gene = gene;
  b.chain = [];
  b.fold = 0;
  b.bondT = 0;
  b.blockedOn = null;

  const shortfall = new Map<AminoType, number>();
  for (const [type, need] of billOfMaterials(gene)) {
    const have = poolTotals.get(type) ?? 0;
    if (have < need) shortfall.set(type, need - have);
  }
  return shortfall.size > 0 ? { ok: true, shortfall } : { ok: true };
}

export function cancelBuild(b: BuildState): void {
  // Spent residues and ATP are NOT refunded. §9.2 step 4 flags misfolding as wasting both,
  // and the same logic applies to abandoning a chain — half a protein is not half useful.
  b.phase = 'idle';
  b.gene = null;
  b.chain = [];
  b.fold = 0;
  b.bondT = 0;
  b.blockedOn = null;
}

export interface AssembleEvent {
  placed?: AminoType;
  folded?: boolean;
}

/**
 * §9.2 step 3. "The nanobot pulls a matching amino-acid dot from the pool (consumed),
 * spends ~4 ATP (the counter ticks down in lockstep; low ATP visibly stalls assembly
 * mid-chain), and extends the chain by one bead."
 *
 * Both inputs come from the bot's OWN TILE, which is what makes the player drive it to
 * where the material actually is.
 */
export function stepConstruction(
  b: BuildState,
  bot: Nanobot,
  grid: Grid,
  /** §5b — the residue stock. Counts, not a field; there is nowhere else to look. */
  inv: Inventory,
  /** §5c — the cell's charge, which every peptide bond is paid from. */
  energy: EnergyPool,
  dt: number,
): AssembleEvent {
  if (b.phase === 'folding') {
    b.fold = Math.min(1, b.fold + dt / FOLD_TIME);
    if (b.fold >= 1) {
      b.phase = 'carrying';
      bot.carrying = b.chain.slice();
      return { folded: true };
    }
    return {};
  }

  if (b.phase !== 'assembling' || !b.gene) return {};

  const want = nextResidue(b);
  if (want === null) {
    // Chain complete — §9.2 step 4. The linear chain collapses into a compact shape with
    // a pocket that is the negative mold of the substrate. The shape IS the function.
    b.phase = 'folding';
    b.fold = 0;
    b.bondT = 0;
    b.blockedOn = null;
    return {};
  }

  const tile = bot.tile(grid);
  const sid = aminoId(want);

  // Check availability BEFORE spending bond time, so a blocked build reads as blocked
  // immediately rather than after a wasted 0.45 s.
  // §5a.9 — residues come from the WHOLE CELL, not from a radius around the bot and not
  // from a satchel.
  //
  // Both of the previous answers failed, in opposite directions. Drawing from radius 4
  // made the supply chain ambient and invisible. Requiring a pickup made it visible and
  // impossible: five species of small drifting bead cannot be told apart or predicted in a
  // crowded cytoplasm, so fetching a specific lysine was either a hopeless search or —
  // worse — occasionally magical, with beads simply being to hand for reasons the player
  // could not see.
  //
  // What is actually true about a residue is HOW MANY THE CELL HAS. Position carries no
  // information a player can act on, because at D = 8 the interior equilibrates in about
  // ten seconds against an arc measured in minutes: the cytoplasm really is well mixed on
  // the timescale that matters. So the cell is the unit, §9.2's blocking case becomes
  // "you are out of lysine — import more", and the fix is a supply decision rather than a
  // scavenger hunt.
  if (inv.get(want) < RESIDUES_PER_BOND) {
    // THE blocking case (§9.2 step 2, §16.2). The rare amino acid gates the protein.
    b.blockedOn = { residue: want, reason: 'residue' };
    return {};
  }
  if (energy.level < ATP_PER_PEPTIDE_BOND) {
    // §9.2 step 3: "low ATP visibly stalls assembly mid-chain."
    b.blockedOn = { residue: want, reason: 'atp' };
    return {};
  }

  b.blockedOn = null;
  b.bondT += dt;
  if (b.bondT < BOND_TIME) return {};
  b.bondT = 0;

  // Re-check at the moment of commitment: the field moved during the bond.
  const gotResidue = inv.take(want, RESIDUES_PER_BOND);
  if (gotResidue <= 0) {
    b.blockedOn = { residue: want, reason: 'residue' };
    return {};
  }
  // ATP is still a field — it is not something the player carries, it is the charge on the
  // cytoplasm — so this half is unchanged (§5a keeps continuum species continuous).
  // §5c — from the cell's charge. ATP is a pool level, so there is no neighbourhood to
  // draw it from and no flat patch of cytoplasm to be caught standing in.
  const gotATP = energy.draw(ATP_PER_PEPTIDE_BOND);
  if (gotATP <= 0) {
    // Put the residue back rather than eating it for nothing — it was never bonded.
    inv.add(want, gotResidue);
    b.blockedOn = { residue: want, reason: 'atp' };
    return {};
  }

  b.chain.push(want);
  return { placed: want };
}

export { GENES, atpCost, billOfMaterials, type Gene, type GeneId };
