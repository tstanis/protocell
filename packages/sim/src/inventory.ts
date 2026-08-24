/**
 * The cell's stock of building materials. SPEC.md §5b.
 *
 * ── Why this is not a field ──────────────────────────────────────────────────
 * Amino acids were modelled as concentration fields, then as discrete drifting grains,
 * then as a well-mixed field drawn cell-wide. Every version failed the same test, and the
 * playtest note that finally named it was: *"still incredibly broken. nothing is visible…
 * random amino acids now show up for building… probably we just need to not use real
 * chemistry and instead make this more of a particle thing."*
 *
 * The tell was in how each fix got made. Answering "can the player see their glycine?"
 * required computing that 6 units spread over 896 tiles is a concentration of 0.0067,
 * which at a dot-scale of 0.25 with a dither yields 23 dots — and then checking that the
 * answer survives a change of zoom (it did not: dot count scaled with the number of frame
 * cells, so pulling the camera out made residues vanish super-linearly).
 *
 * **If "how many do I have" requires arithmetic, the model is wrong.** Concentration is
 * the right primitive for something whose GRADIENT does work — glucose crossing a cell,
 * lactate backing up behind a carrier. It is the wrong primitive for an inventory.
 *
 * So a residue is an integer you own. There is no volume, no diffusion, no per-species
 * scale constant, and nothing that changes when the camera moves. `lys: 14` means you can
 * place fourteen more lysines. That is the whole model, and it cannot become illegible.
 *
 * ── What this deliberately gives up ──────────────────────────────────────────
 * Residues no longer diffuse, no longer have a position, and no longer contribute to
 * osmotic pressure. The first two are the point. The third is a real loss and is recorded
 * rather than hidden: §7.2 makes volume a function of total solute, and building material
 * dissolved in cytoplasm genuinely pushes water. It was a small term next to lactate, and
 * §12's crisis is a lactate crisis, so the trade is worth making — but it is a trade.
 */

import { AMINO_TYPES, type AminoType } from './species.js';

/**
 * One residue is one peptide bond.
 *
 * The most useful unit the quantity could take: the count on screen is exactly the number
 * of residues you are still able to place. The previous `RESIDUE_UNIT = 0.25` meant a
 * stock of "6" was really 24 bonds, and every player-facing number needed dividing before
 * it meant anything.
 */
export const RESIDUES_PER_BOND = 1;

export class Inventory {
  private readonly counts = new Map<AminoType, number>();

  constructor(start?: Partial<Record<AminoType, number>>) {
    for (const t of AMINO_TYPES) this.counts.set(t, Math.max(0, Math.floor(start?.[t] ?? 0)));
  }

  get(type: AminoType): number {
    return this.counts.get(type) ?? 0;
  }

  /** Whole units only — a fractional residue is not a thing, which is half the point. */
  add(type: AminoType, n: number): void {
    if (n <= 0) return;
    this.counts.set(type, this.get(type) + Math.floor(n));
  }

  /** Take `n` if all of it is available; otherwise take nothing. Returns what was taken. */
  take(type: AminoType, n = 1): number {
    const have = this.get(type);
    if (have < n) return 0;
    this.counts.set(type, have - n);
    return n;
  }

  /** Can the whole bill be paid right now? Returns the first type that is short, or null. */
  shortfallFor(bill: ReadonlyMap<AminoType, number>): AminoType | null {
    for (const [t, n] of bill) if (this.get(t) < n) return t;
    return null;
  }

  /** Every type that is short of `bill`, and by how much — for the build panel. */
  shortfalls(bill: ReadonlyMap<AminoType, number>): Map<AminoType, number> {
    const out = new Map<AminoType, number>();
    for (const [t, n] of bill) {
      const missing = n - this.get(t);
      if (missing > 0) out.set(t, missing);
    }
    return out;
  }

  snapshot(): Map<AminoType, number> {
    return new Map(this.counts);
  }

  total(): number {
    let sum = 0;
    for (const n of this.counts.values()) sum += n;
    return sum;
  }
}
