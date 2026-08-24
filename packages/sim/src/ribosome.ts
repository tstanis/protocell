/**
 * The ribosome. SPEC.md §9.5, roadmap item 1.
 *
 * ── What it is, and what it deliberately is not ──────────────────────────────
 * Not a build menu. A menu would retire §9.2's bead-walking and leave the player choosing
 * from a list, which is a worse version of the thing it replaced — the tedium would be
 * gone and so would the decision.
 *
 * A ribosome **senses its own neighbourhood and decides what to make**. It has a position
 * and a radius, it sees what is failing near it, and it fixes that; it also serves the
 * standing orders the player has placed. So the interesting question stops being "what do
 * I build next" and becomes **"where do I put the thing that keeps this part of the cell
 * alive"** — which is §6.7's placement decision and §4.7's spatial logistics, applied to
 * maintenance rather than to transport.
 *
 * That is also why it pairs with §9.4's denaturation. A ribosome over a finite build-out
 * is a shortcut. A ribosome over a cell that is continuously losing machinery is
 * infrastructure, and where you site it determines what survives.
 *
 * ── Two sources of work, and why they are placed differently ─────────────────
 *   REPAIR   A protein that denatured leaves a VACANCY: a tile, and what used to be in it.
 *            The ribosome knows exactly where that goes, so it rebuilds it in place. No
 *            decision is being taken from the player — they already made it when they sited
 *            the original.
 *   ORDERS   A protein the player has asked for has no home yet, so it is folded and left
 *            for them to carry and seat. The placement decision stays theirs.
 */

import type { SpeciesId } from './species.js';
import type { AminoType } from './species.js';
import type { TransporterKind } from './transport.js';
import type { Perishable } from './denature.js';
import type { GeneId } from './construction.js';

/**
 * How far a ribosome senses and reaches, in tiles.
 *
 * SIZED AGAINST THE ACTUAL GEOMETRY, which the first guess of 14 was not.
 *
 * §4.1's cell has membrane tiles out to 18.4 from the centre, so at 14 a ribosome sited
 * centrally covered the interior and none of the membrane — and, worse, ribosomes spread
 * around the ring to cover it sat 13.9 apart against a reach of 14, so the network that
 * keeps ITSELF alive was one rounding error from breaking. Measured, it did: every trial
 * lost all its ribosomes and then everything else, from a cell that had been stable for
 * six minutes.
 *
 * At 16 the arithmetic closes. Three ribosomes at ~9 tiles from the centre sit 15.6 apart
 * (inside reach, so they maintain each other) and each covers ±64° of the membrane ring,
 * which is 382° between them — full coverage with a little to spare.
 *
 * One is still not enough: a central ribosome reaches 16 against a membrane at 18.4, so it
 * cannot maintain the transporters. That is the property worth keeping — siting has to be
 * a decision, and a second ribosome has to be a real one.
 */
export const RIBOSOME_REACH = 16;

/**
 * Seconds per peptide bond. §9.2's hand-assembly is BOND_TIME = 0.45.
 *
 * Three times faster, which is the whole reward: the machine is quicker than you are. It
 * is not instant, because watching a protein come together is §9.2's payoff beat and a
 * ribosome that blinks things into existence throws that away — and because a visible
 * build time is what makes a queue legible when several things need fixing at once.
 */
export const RIBOSOME_BOND_TIME = 0.15;

/**
 * How long a ribosome waits on a missing residue before releasing the job, in seconds.
 *
 * A claimed job holds its vacancy and blocks that ribosome from doing anything else, so a
 * stall has to be temporary. Ten seconds is long enough that a supply line delivering
 * every few seconds is not thrashed, and short enough that one unobtainable residue cannot
 * park a ribosome indefinitely while the rest of the cell rots.
 */
export const JOB_PATIENCE = 10;

/** What used to be at a tile, so a ribosome can put it back. */
export interface Vacancy {
  tile: number;
  gene: GeneId;
  /** For a transporter — what it carried and which tier it was. */
  species?: SpeciesId | undefined;
  transporter?: TransporterKind | undefined;
  /** Residue a type-selectable product was carrying (§5, §5a.10). */
  residue?: AminoType | null | undefined;
}

/**
 * `repair` puts back something that has already failed; `renew` replaces something that is
 * still working but has fallen to REPAIR_AT; `order` is a standing request from the player.
 *
 * The distinction between the first two is only in what happens at the END of the job — a
 * renewal restores the protein that is still sitting there, a repair installs a new one
 * into an empty tile — but keeping them apart is what lets triage prefer a dead protein
 * over a tired one, which is the correct urgency ordering.
 */
export type JobSource = 'repair' | 'renew' | 'order';

export interface RibosomeJob {
  gene: GeneId;
  source: JobSource;
  /** Where it goes, for a repair. Null for an order — the player sites those. */
  tile: number | null;
  species?: SpeciesId | undefined;
  transporter?: TransporterKind | undefined;
  residue?: AminoType | null | undefined;
  /** Bonds placed so far, against the gene's sequence length. */
  placed: number;
  /** Seconds accumulated toward the next bond. */
  bondT: number;
  /** Which residue it is waiting on, if it is stalled. */
  blockedOn: AminoType | null;
  /** Seconds spent waiting on a missing residue. See JOB_PATIENCE. */
  starved: number;
}

export class Ribosome implements Perishable {
  readonly tile: number;
  /** §9.4 — a ribosome is a protein too, and denatures like the rest. */
  integrity = 1;
  job: RibosomeJob | null = null;

  constructor(tile: number) {
    this.tile = tile;
  }
}

/** Is `tile` within a ribosome's reach? Both are grid indices. */
export function inReach(gridWidth: number, ribosomeTile: number, tile: number): boolean {
  const ax = ribosomeTile % gridWidth;
  const ay = Math.floor(ribosomeTile / gridWidth);
  const bx = tile % gridWidth;
  const by = Math.floor(tile / gridWidth);
  return Math.hypot(ax - bx, ay - by) <= RIBOSOME_REACH;
}
