/**
 * The cell's charge. SPEC.md §5c.
 *
 * ── Why ATP stopped being a field ────────────────────────────────────────────
 * ATP was a per-tile concentration, which bought two things: §2.3's local brownouts (a
 * corner of the cell that cannot pay its rent) and §4.7's texture (building somewhere
 * flat stalls you). Both are real ideas. Neither survived contact with the rest of the
 * model once everything else the player handles became countable.
 *
 * What it cost instead was legibility, in the same way §5b's residues did: "how much
 * energy do I have here" was a question with a different answer everywhere, none of which
 * the HUD could show. And the machinery around it was almost all correction — a per-tile
 * dissipation cap that destroyed 87% of glycolysis' yield before diffusion could spread a
 * spike, a proportional rescale to enforce a pool ceiling without flattening the field, an
 * upkeep loop that walked every tile to bill a rent that is the same everywhere.
 *
 * ATP is one number now: **the charge on the cell**. It is not matter you can point at —
 * it is the adenine pool's state, and a pool has a level, not a shape.
 *
 * ── What is deliberately given up ────────────────────────────────────────────
 * Local brownouts, and with them §4.7's "where you build matters, because ATP is thin
 * over there". Position still matters for everything made of MATTER — an enzyme still has
 * to be where glucose reaches it, a carrier still has to be where waste reaches it, a
 * transporter still has to face its deposit — so §4.7's principle keeps a body; it just
 * no longer applies to energy. That is a real loss and it is recorded rather than hidden.
 */

import { ATP_POOL_PER_TILE, UPKEEP_PER_TILE } from './constants.js';

export class EnergyPool {
  /** Current charge, in the same ATP units §13 derives everything else in. */
  private charge = 0;
  /** Tiles the pool is sized against — interior plus the membrane it maintains. */
  private capacityTiles = 1;

  /**
   * ATP shed as heat this step because the pool was already full.
   *
   * Surfaced because a cell at its ceiling looks EXACTLY like a cell that has stalled —
   * the number stops moving either way — and the two call for opposite responses (§8.2a).
   */
  lastDissipated = 0;

  /** True when upkeep could not be paid in full: the cell is running on empty (§2.3). */
  brownedOut = false;

  constructor(startingCharge: number, capacityTiles: number) {
    this.capacityTiles = Math.max(1, capacityTiles);
    this.charge = Math.min(startingCharge, this.capacity);
  }

  /** The adenine pool ceiling. Conserved nucleotides, so a charged cell pins here. */
  get capacity(): number {
    return ATP_POOL_PER_TILE * this.capacityTiles;
  }

  get level(): number {
    return this.charge;
  }

  /** Resize with the cell — the pool scales with the body that holds it. */
  setCapacityTiles(n: number): void {
    this.capacityTiles = Math.max(1, n);
    if (this.charge > this.capacity) this.charge = this.capacity;
  }

  /**
   * Add ATP, shedding whatever will not fit.
   *
   * The ceiling is on the TOTAL and always was; a per-tile cap saw an enzyme's 2-ATP
   * deposit as a spike and destroyed most of it, cutting glycolysis' effective yield to
   * about 0.25 ATP per glucose. With one number there is no spike to mistake.
   */
  add(amount: number): void {
    if (amount <= 0) return;
    const room = this.capacity - this.charge;
    if (amount <= room) {
      this.charge += amount;
      return;
    }
    this.charge = this.capacity;
    this.lastDissipated += amount - Math.max(0, room);
  }

  /** Take up to `want`, returning what was actually available. */
  draw(want: number): number {
    if (want <= 0) return 0;
    const got = Math.min(want, this.charge);
    this.charge -= got;
    return got;
  }

  /**
   * §13.2's rent: `UPKEEP_PER_TILE` per tile per second, for interior AND membrane.
   *
   * §4.2 says a membrane tile holds no pool, so it cannot pay directly — its share is
   * billed to the cytoplasm that maintains it, which is why this takes a total tile count
   * rather than only the payers.
   */
  payUpkeep(dt: number, tiles: number): number {
    const due = UPKEEP_PER_TILE * tiles * dt;
    const paid = this.draw(due);
    this.brownedOut = paid < due - 1e-12;
    return paid;
  }

  /** Call once per step, after production, before reporting. */
  beginStep(): void {
    this.lastDissipated = 0;
  }
}
