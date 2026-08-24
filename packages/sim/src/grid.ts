/**
 * The truth layer. SPEC.md §3.1.
 *
 * A 2D lattice of tiles. Each tile holds one float per chemical species. There are NO
 * particles here — particles are purely a render-layer artifact spawned from these
 * fields (§2.1), and they live in a different process entirely (§3.7).
 *
 * Storage is one flat Float32Array indexed `s*tileCount + y*width + x`, species-major so
 * a single species' plane is contiguous. Every operation in ops/ is a local stencil over
 * one plane, which is what makes a grid cheap and a particle soup expensive (§3.1).
 */

import { SPECIES_COUNT, type SpeciesId } from './species.js';

/** §4.1 / §4.2. A tile is one of exactly three things. */
export const Role = {
  /** Not part of any compartment. Reflecting no-flux boundary (§17.2). */
  VOID: 0,
  /** A one-tile-thick wall. A GATE, not a tank: holds no solute pool (§4.2). */
  MEMBRANE: 1,
  /** Interior of some compartment: cytoplasm, extracellular space, nucleoplasm, blood. */
  FLUID: 2,
} as const;

export type RoleValue = (typeof Role)[keyof typeof Role];

/**
 * Compartment ids. §4.3: "The compartment model is recursive: extracellular space
 * *contains* the cell, cytoplasm *contains* the nucleus, organelles have their own
 * walls." So a tile's compartment is data, not a hardcoded enum — this is what lets the
 * same code carry a nucleus, an organelle, and eventually a bloodstream (§6.8) without
 * a new primitive each time.
 *
 * FLUID tiles diffuse freely with same-compartment neighbours. Different compartments
 * exchange ONLY through membrane tiles (§4.2), which is what makes gradients possible.
 */
export const NO_COMPARTMENT = -1;
export const EXTRACELLULAR = 0;
export const CYTOPLASM = 1;

export class Grid {
  readonly width: number;
  readonly height: number;
  readonly tileCount: number;

  /**
   * Amounts, species-major: `s*tileCount + y*width + x`.
   *
   * Float64, deliberately. Float32 storage costs half the memory and matches the wire
   * format, but it caps mass conservation at ~2e-6 relative drift over 10k steps — the
   * read-modify-write rounds every tile every step, and it compounds. That is invisible
   * in a demo and corrosive in a simulation that is supposed to run for hours and whose
   * first principle is "numbers are truth" (§2.1).
   *
   * So: the truth layer is exact to the practical limit, and the COSTUME is what gets
   * quantized — the wire converts to Float32 at serialization (§15.3), where lossiness is
   * both harmless and free. Conserving to 1e-13 costs 8 bytes a tile; it is worth it.
   */
  readonly amount: Float64Array;

  /** Scratch plane for double-buffered stencils. Length of ONE species plane. */
  readonly scratch: Float64Array;

  readonly role: Int8Array;

  /** Which compartment each tile belongs to. NO_COMPARTMENT for VOID and MEMBRANE. */
  readonly compartment: Int32Array;

  /**
   * For membrane tiles, the tile index on the INNER side — the normal, so a pump knows
   * which way is "out" (§4.2). -1 for non-membrane tiles.
   *
   * Corner tiles with cytoplasm on two sides are the fiddly case §4.2 flags; see
   * membrane.ts for how they are resolved.
   */
  readonly inward: Int32Array;

  /** For membrane tiles, the tile index on the OUTER side. -1 otherwise. */
  readonly outward: Int32Array;

  /**
   * Transport area of a membrane tile, in edges. A flat stretch of wall faces outward on
   * one edge; a corner tile faces outward on two, so it exchanges twice as fast.
   *
   * This is §4.2's "only fiddly case ... corner tiles with cytoplasm on two sides",
   * which is exactly the geometry that gets stressed during growth and division. Flux is
   * area-weighted by this value while mass still moves between the primary inner/outer
   * pair, so total exchange is right and only the position within the tile is smeared.
   */
  readonly edgeArea: Float32Array;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3) {
      throw new RangeError(`grid must be at least 3x3 integers, got ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.tileCount = width * height;
    this.amount = new Float64Array(SPECIES_COUNT * this.tileCount);
    this.scratch = new Float64Array(this.tileCount);
    this.role = new Int8Array(this.tileCount);
    this.compartment = new Int32Array(this.tileCount).fill(NO_COMPARTMENT);
    this.inward = new Int32Array(this.tileCount).fill(-1);
    this.outward = new Int32Array(this.tileCount).fill(-1);
    this.edgeArea = new Float32Array(this.tileCount);
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  planeStart(s: SpeciesId): number {
    return s * this.tileCount;
  }

  /** A writable VIEW of one species' plane — writes go straight into `amount`. */
  plane(s: SpeciesId): Float64Array {
    const start = this.planeStart(s);
    return this.amount.subarray(start, start + this.tileCount);
  }

  get(s: SpeciesId, i: number): number {
    return this.amount[s * this.tileCount + i]!;
  }

  set(s: SpeciesId, i: number, v: number): void {
    this.amount[s * this.tileCount + i] = v;
  }

  add(s: SpeciesId, i: number, dv: number): void {
    this.amount[s * this.tileCount + i]! += dv;
  }

  /**
   * Total amount of a species across every tile.
   *
   * Kahan-compensated, because the conservation test (§16.1) asserts a tighter bound
   * than a naive left-to-right sum over ~10^4 tiles can measure. Without compensation
   * the SUMMATION error would dominate and the test would be checking the accumulator
   * rather than the simulation.
   */
  total(s: SpeciesId): number {
    const plane = this.plane(s);
    let sum = 0;
    let c = 0;
    for (let i = 0; i < plane.length; i++) {
      const y = plane[i]! - c;
      const t = sum + y;
      c = t - sum - y;
      sum = t;
    }
    return sum;
  }

  /** Total across one compartment only. */
  totalIn(s: SpeciesId, comp: number): number {
    const plane = this.plane(s);
    let sum = 0;
    let c = 0;
    for (let i = 0; i < plane.length; i++) {
      if (this.compartment[i] !== comp) continue;
      const y = plane[i]! - c;
      const t = sum + y;
      c = t - sum - y;
      sum = t;
    }
    return sum;
  }

  countTiles(comp: number): number {
    let n = 0;
    for (let i = 0; i < this.tileCount; i++) if (this.compartment[i] === comp) n++;
    return n;
  }

  countRole(role: RoleValue): number {
    let n = 0;
    for (let i = 0; i < this.tileCount; i++) if (this.role[i] === role) n++;
    return n;
  }
}
