/**
 * The blueprint library. SPEC.md §9.2 step 1–2.
 *
 * "Select gene at the nucleus (the blueprint library). Choosing the gene = choosing the
 * recipe. In the intro, transcription is collapsed — the nucleus hands over the blueprint
 * directly."
 *
 * A blueprint is a specific SEQUENCE of typed amino acids, not a count, because §5 is
 * emphatic that amino acids are typed: "recipes are bills of materials of specific types.
 * Rare types gate rare proteins." The sequence is what makes §9.2's blocking case
 * possible — a build stalls on one specific missing bead, not on a generic shortfall —
 * and §16.2 calls that the richest mechanic the prototypes never built.
 *
 * ATP cost is derived, never authored: §9.1 puts peptide-bond formation at ~4
 * ATP-equivalents per residue, so cost scales with chain length and big proteins are
 * naturally gated behind a larger energy economy.
 */

import { ATP_PER_PEPTIDE_BOND } from './constants.js';
import { SPECIES_ID, type AminoType, type SpeciesId } from './species.js';

export type GeneId =
  | 'glycolysisEnzyme'
  | 'glucoseChannel'
  | 'aminoTransporter'
  | 'ribosome'
  | 'lactateCarrier'
  | 'flagellum';

/** What the folded protein becomes on deployment (§9.2 step 5). */
export type Product =
  | { kind: 'enzyme' }
  | { kind: 'transporter'; transporter: 'channel' | 'carrier' | 'pump'; species: SpeciesId }
  | { kind: 'ribosome' }
  /** §10A.1 — a flagellum. Seated in the membrane like a transporter, but it pushes. */
  | { kind: 'flagellum' };

export interface Gene {
  id: GeneId;
  name: string;
  /**
   * True when the player chooses WHICH amino acid the product carries (§5, §6.7).
   * `Product.species` is then only a default that `selectGene` overrides.
   */
  selectableResidue?: boolean;
  /** The residue sequence. Length drives ATP cost; composition drives what can block. */
  sequence: readonly AminoType[];
  product: Product;
  /** One line of player-facing explanation, shown alongside the bill of materials. */
  blurb: string;
}

/**
 * §9.2 step 5 is where enzyme and transporter split, and the sequences reflect it:
 * membrane proteins are longer and lean on the rarer residues, so they cost more ATP and
 * are the ones that block first when the pool runs thin. That is not decoration — it is
 * what makes the amino-acid supply line something you have to actually manage.
 */
export const GENES: Readonly<Record<GeneId, Gene>> = {
  // The intro's first build, and deliberately the cheapest: 8 residues, 32 ATP of a
  // 55 ATP reserve. Matches `enzyme_build.html`'s sequence exactly.
  glycolysisEnzyme: {
    id: 'glycolysisEnzyme',
    name: 'Glycolysis enzyme',
    sequence: ['leu', 'gly', 'gly', 'lys', 'ala', 'gly', 'leu', 'val'],
    product: { kind: 'enzyme' },
    blurb: 'Cracks glucose into 2 ATP and 2 lactate. A catalyst — build it once, it runs forever.',
  },

  // Act 1's build, and the shortest membrane protein for a reason: it has to be
  // affordable from the starting reserve alone, before a single ATP has been produced.
  // §9.1's "small proteins are cheap" is what makes a bootstrap possible at all.
  glucoseChannel: {
    id: 'glucoseChannel',
    name: 'Glucose channel',
    sequence: ['gly', 'leu', 'val', 'gly', 'ala', 'leu'],
    product: { kind: 'transporter', transporter: 'channel', species: SPECIES_ID.glucose },
    blurb: 'An open pore. Glucose flows in down its gradient, for free — a channel, not a pump.',
  },

  aminoTransporter: {
    id: 'aminoTransporter',
    name: 'Amino-acid transporter',
    sequence: ['lys', 'gly', 'ala', 'lys', 'val', 'gly', 'leu', 'lys', 'ala'],
    product: { kind: 'transporter', transporter: 'channel', species: SPECIES_ID.gly },
    /**
     * WHICH residue this carries is the player's choice (§5, §6.7). The species above is
     * only the default; `selectGene` overrides it. Before this existed the gene was fixed
     * to glycine, so "rare types gate rare proteins" was a claim the game never let you
     * act on — you could be starved of lysine with no way to build a lysine importer.
     */
    selectableResidue: true,
    blurb: 'Imports ONE amino acid — choose which. The material every future protein is made of.',
  },

  /**
   * Lys-heavy on purpose: lysine is the scarcest residue in the starting pool, so this is
   * the build most likely to block — and it is the one you need most urgently, which is
   * when the supply line should be felt rather than explained.
   *
   * Short (7 residues, 28 ATP) because YOU NEED TWO OF THEM. Measured: one carrier cannot
   * keep up with one enzyme, and moving it next to the enzyme does not save it
   * (191 → 181 lactate, still rising); two clear the backlog outright (132 → 112) and
   * three drain it fast (132 → 47). See §16.3 for why import and export are asymmetric.
   */
  lactateCarrier: {
    id: 'lactateCarrier',
    name: 'Lactate carrier',
    sequence: ['lys', 'leu', 'gly', 'lys', 'ala', 'val', 'lys'],
    product: { kind: 'transporter', transporter: 'carrier', species: SPECIES_ID.lactate },
    blurb: 'Exports waste down its gradient. You will need more than one — export is slower than import.',
  },

  /**
   * §10A.1 — the flagellum. The longest and most expensive protein in the intro set, at
   * 14 residues and 56 ATP, and deliberately so: motility is a capital investment made
   * against a running cost. Real flagella are enormous multi-protein assemblies; this is
   * the cheapest honest gesture at that.
   *
   * Note it does not need lysine. The scarce residue gates the things you need to SURVIVE
   * (§9.2's blocking case, on the carrier); making it also gate the thing you need to go
   * find more lysine would be a deadlock rather than a dilemma.
   */
  /**
   * §9.5 — the machine that retires hand-assembly. Deliberately the largest thing in the
   * list: 22 residues and 88 ATP, which at §9.2's pace is a real commitment and is meant
   * to be the last protein a player folds bead by bead. Lys-heavy, so §12.3's squeeze is
   * what stands between you and automation.
   */
  ribosome: {
    id: 'ribosome',
    name: 'Ribosome',
    sequence: [
      'lys', 'gly', 'leu', 'ala', 'lys', 'val', 'gly', 'leu',
      'lys', 'ala', 'gly', 'val', 'leu', 'lys', 'gly', 'ala',
      'val', 'leu', 'gly', 'lys', 'ala', 'gly',
    ],
    product: { kind: 'ribosome' },
    blurb: 'Senses what is failing around it and rebuilds it. Where you site it decides what survives.',
  },

  flagellum: {
    id: 'flagellum',
    name: 'Flagellum',
    sequence: [
      'gly', 'ala', 'val', 'leu', 'gly', 'ala', 'leu',
      'val', 'gly', 'leu', 'ala', 'val', 'gly', 'leu',
    ],
    product: { kind: 'flagellum' },
    blurb: 'A motor. Costs ATP every second it runs — swimming competes with building (§10A.1).',
  },
};

export function atpCost(gene: Gene): number {
  return gene.sequence.length * ATP_PER_PEPTIDE_BOND;
}

/** Bill of materials: how many of each residue type the sequence needs. */
export function billOfMaterials(gene: Gene): Map<AminoType, number> {
  const bom = new Map<AminoType, number>();
  for (const t of gene.sequence) bom.set(t, (bom.get(t) ?? 0) + 1);
  return bom;
}
