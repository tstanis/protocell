/**
 * The nanobot. SPEC.md §1.2, §9.2.
 *
 * The player's avatar, and the reason the game's premise works: "The nanobot is a
 * general-purpose molecular assembler — which is WHAT A RIBOSOME IS. At the start, the
 * player literally IS the ribosome: they hand-assemble proteins because the nanobot is
 * the only assembler in the cell."
 *
 * So this is not a cursor with a sprite. It has a position, it has to physically be
 * somewhere to do anything, and the long arc of the game is building biological machines
 * that replace each of its functions until it is obsolete (§12.4 retires its hand-labour
 * first). "Hand-mine before you build the drill."
 *
 * It holds no simulation state of its own beyond position and what it is carrying — every
 * amino acid it consumes and every ATP it spends comes out of the field at its own tile,
 * which is what makes WHERE it is matter (§4.7's spatial premise, previewed).
 */

import type { Grid } from './grid.js';
import type { AminoType } from './species.js';
import type { Grain } from './grains.js';

/** Tiles per second. Slow enough that distance is felt, fast enough not to be tedious. */
export const BOT_SPEED = 9;

/** How close counts as "arrived", in tiles. */
export const BOT_REACH = 0.6;

export class Nanobot {
  /** Continuous position in tile coordinates — not snapped to the lattice. */
  x: number;
  y: number;

  /** Destination, or null when idle. Set by the player (§9.2 is hand-driven). */
  targetX: number | null = null;
  targetY: number | null = null;

  /**
   * A folded protein being carried to its deployment site (§9.2 step 5). A transporter
   * must be walked to a membrane tile and seated on the correct face; an enzyme is simply
   * released into the cytoplasm. Infrastructure bolted to a wall versus a free agent in
   * the soup — a real, internalised distinction.
   */
  carrying: AminoType[] | null = null;

  /**
   * §5a — the beads the bot is holding, and the whole of the new logistics decision.
   *
   * Construction draws residues from HERE and nowhere else. Before grains, a bond simply
   * siphoned a quarter-unit out of the field within radius 4, which meant the player never
   * touched their own supply chain: matter was ambient. Now a bead has to be picked up
   * before it can be bonded, so "which residues am I carrying" is a real choice with a
   * real cost — and §9.2's blocking case stops being a message and becomes a trip.
   *
   * Deliberately small. A big satchel turns the decision back into ambience; eight is
   * enough for a short protein and not enough for a long one without planning.
   */
  readonly inventory: Grain[] = [];
  static readonly CAPACITY = 8;

  get full(): boolean {
    return this.inventory.length >= Nanobot.CAPACITY;
  }

  /** How much of a residue type the bot is carrying, in field units. */
  held(species: number): number {
    let sum = 0;
    for (const g of this.inventory) if (g.species === species) sum += g.amount;
    return sum;
  }

  /**
   * Consume `want` units of a species from the satchel, splitting the last bead.
   *
   * Splitting matters: a grain is 1.0 and RESIDUE_UNIT is 0.25, so every bead is four
   * bonds. Without splitting, three quarters of every residue the player carried would be
   * unusable.
   */
  takeHeld(species: number, want: number): number {
    let got = 0;
    for (let i = this.inventory.length - 1; i >= 0 && got < want - 1e-12; i--) {
      const g = this.inventory[i]!;
      if (g.species !== species) continue;
      const need = want - got;
      if (g.amount <= need + 1e-12) {
        got += g.amount;
        this.inventory.splice(i, 1);
      } else {
        g.amount -= need;
        got += need;
      }
    }
    return got;
  }

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  moveTo(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
  }

  get moving(): boolean {
    return this.targetX !== null && this.targetY !== null && !this.arrived();
  }

  arrived(): boolean {
    if (this.targetX === null || this.targetY === null) return true;
    return Math.hypot(this.targetX - this.x, this.targetY - this.y) <= BOT_REACH;
  }

  /** Index of the tile the bot is currently standing on. */
  tile(grid: Grid): number {
    const tx = Math.max(0, Math.min(grid.width - 1, Math.floor(this.x)));
    const ty = Math.max(0, Math.min(grid.height - 1, Math.floor(this.y)));
    return grid.idx(tx, ty);
  }

  /**
   * Advance toward the target. Deliberately NOT charged ATP.
   *
   * §10A.1 makes swimming expensive because whole-cell motility competes with
   * construction for the energy budget, and that tension is the point of the exploration
   * axis. Moving the assembler around inside its own cytoplasm is a different thing: it
   * is the player's hand, and metering it would tax deliberation rather than distance.
   * The costs that matter here are the ones §9.1 names — amino acids and 4 ATP a bond.
   */
  step(dt: number): void {
    if (this.targetX === null || this.targetY === null) return;
    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    const d = Math.hypot(dx, dy);
    if (d <= BOT_REACH) {
      this.targetX = null;
      this.targetY = null;
      return;
    }
    const s = Math.min(d, BOT_SPEED * dt);
    this.x += (dx / d) * s;
    this.y += (dy / d) * s;
  }

  /** Clamp into a compartment so the bot cannot wander through its own membrane. */
  confineTo(grid: Grid, compartment: number, cx: number, cy: number): void {
    const i = this.tile(grid);
    if (grid.compartment[i] === compartment) return;
    // Walk back toward the centre until we are inside again. Cheap, and correct for the
    // convex blob the intro uses; a concave cell would want a proper containment test.
    const dx = cx - this.x;
    const dy = cy - this.y;
    const d = Math.hypot(dx, dy) || 1;
    this.x += (dx / d) * 0.5;
    this.y += (dy / d) * 0.5;
    this.targetX = null;
    this.targetY = null;
  }
}
