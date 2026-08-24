/**
 * Managed species. SPEC.md §5.
 *
 * §11.3 budgets ~6–8 glanceable visual signatures; everything beyond that is a
 * number-on-hover or a tint when relevant. That budget constrains the RENDERER, not
 * this list — the sim can carry as many species as the biology needs.
 */

import { DIFFUSION } from './constants.js';

/**
 * §5: "Amino acids are TYPED, not generic. A protein is a specific *sequence* drawn from
 * ~20 types, so recipes are bills of materials of specific types. Rare types gate rare
 * proteins."
 *
 * Five types for now, matching `enzyme_build.html`'s palette. That is enough for the
 * mechanic §16.2 calls the richest unbuilt one — a build BLOCKING on one specific missing
 * bead — which a single generic `amino` pool cannot express at all. The remaining fifteen
 * are a data change, not a code change.
 */
export const AMINO_TYPES = ['gly', 'leu', 'lys', 'ala', 'val'] as const;
export type AminoType = (typeof AMINO_TYPES)[number];

export const SPECIES = [
  'glucose',
  'atp',
  'lactate',
  'o2',
  'co2',
  'na',
  'k',
  'water',
  ...AMINO_TYPES,
] as const;

export type SpeciesName = (typeof SPECIES)[number];

/**
 * Numeric ids, which go on the wire (§15.3). Stable WITHIN a protocol version; the
 * generic `amino` slot was replaced by the five typed ones above and PROTOCOL_VERSION
 * bumped to 2 rather than leaving a dead id behind. Renumbering is a breaking change and
 * must always carry a version bump.
 */
export type SpeciesId = number;

export const SPECIES_ID: Readonly<Record<SpeciesName, SpeciesId>> = Object.freeze(
  Object.fromEntries(SPECIES.map((n, i) => [n, i])) as Record<SpeciesName, SpeciesId>,
);

export const SPECIES_COUNT = SPECIES.length;

export function speciesName(id: SpeciesId): SpeciesName {
  const n = SPECIES[id];
  if (n === undefined) throw new RangeError(`unknown species id ${id}`);
  return n;
}

/** Species ids of the amino acids, in AMINO_TYPES order. */
export const AMINO_IDS: readonly SpeciesId[] = AMINO_TYPES.map((t) => SPECIES.indexOf(t));

export function aminoId(t: AminoType): SpeciesId {
  return SPECIES.indexOf(t);
}

export function isAmino(id: SpeciesId): boolean {
  return AMINO_IDS.includes(id);
}

/**
 * Diffusion coefficient per species, indexed by id. Pulled from §13.5's table; water
 * moves by osmosis (§7.2) rather than ordinary diffusion but still has a coefficient
 * for the residual case.
 */
export const D_BY_ID: Readonly<Float64Array> = Float64Array.from(
  SPECIES.map((n) => DIFFUSION[n] ?? 1),
);

/**
 * Whether a species contributes to osmolarity (§7.2).
 *
 * Water is excluded by definition — it is the solvent, and including it would make the
 * osmotic balance circular.
 *
 * §5's "baseline osmolytes" (fixed intracellular proteins and ions) are NOT a field.
 * They are a constant that dominates osmolarity so metabolites do not swing volume
 * wildly, and they live in the compartment, not the grid.
 *
 * ATP is excluded too, and that one is not obvious. §7.4's prototype counts its ATP pool
 * as solute, which is fine while that pool is small and bounded. On a real field it is
 * neither: with nothing yet to spend ATP on, a running enzyme drove the pool from 106 to
 * 302 in two minutes, and the resulting osmotic load — not the lactate — became the thing
 * inflating the cell. That is backwards; §12.3's crisis is supposed to be a WASTE crisis.
 *
 * The biology agrees. Adenine nucleotides are conserved: ATP is not created and
 * destroyed, it cycles ATP ⇌ ADP + Pi, so the particle count barely moves however hard
 * the cell is respiring. A conserved total is a constant, and a constant belongs in
 * B_OSM, not in a field that can run away.
 *
 * That conservation also implies a production ceiling — no free ADP means no more ATP —
 * which is modelled as ATP_POOL_PER_TILE.
 */
export const OSMOTIC_BY_ID: Readonly<Uint8Array> = Uint8Array.from(
  SPECIES.map((n) => (n === 'water' || n === 'atp' ? 0 : 1)),
);


/** The AminoType for a species id, or null if it is not an amino acid. */
export function aminoTypeOf(id: SpeciesId): AminoType | null {
  const i = AMINO_IDS.indexOf(id);
  return i >= 0 ? AMINO_TYPES[i]! : null;
}
