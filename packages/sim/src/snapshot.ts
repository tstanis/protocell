/**
 * Saving a cell. SPEC.md §15.8.
 *
 * ── Why this exists at all, when §3.7 said it would not have to ─────────────
 * §3.7 records that a seeded PRNG plus a command log gives "exact replay for free, since
 * every player input already arrives as a discrete message". That is true, and it is true
 * for the wrong problem. Replay is O(playtime): restoring a cell someone played for two
 * hours means simulating two hours, and a live cell costs 5.5% of a core (§15.6), so
 * that is **six and a half minutes of CPU to open a save**. Fine for reproducing a bug
 * offline; useless as a load screen, and ruinous on a server doing it for many players.
 *
 * So a save is a SNAPSHOT: the state itself, not the instructions for reaching it.
 *
 * ── What is NOT here, and why that is safe ──────────────────────────────────
 * Geometry is omitted entirely — grid dimensions, the compartment and role maps, inward
 * and outward neighbours, edge areas, tile counts, the nucleus, the cell's centre and
 * radius, and the position/radius/peak of every patch. All of it is a pure function of
 * construction, identical in every `new World()`, and none of it changes during play.
 * Storing it would be storing the program.
 *
 * What patches DO carry is `richness`, because that is the part play moves.
 *
 * ── Raw arrays, deliberately ────────────────────────────────────────────────
 * The field planes come out as `Float64Array` rather than base64 or JSON numbers. This
 * package has `types: []` — no Node, so no `Buffer` — and more importantly encoding is a
 * storage concern: a database, a file and a socket all want different bytes, and the
 * simulation should not have an opinion. `packages/sim` produces the state; whoever
 * stores it decides how.
 *
 * Only planes with a non-zero entry are emitted. Measured on a cell 90 s into real play,
 * **2 of 13 species planes are live** — glucose and lactate — because §5c made ATP a pool
 * and §5b made residues an inventory, so those planes are structurally empty. That takes
 * a snapshot's bulk from 958 KB to 144 KB without any compression or loss.
 */

import type { AminoType, SpeciesId } from './species.js';
import type { GeneId } from './genes.js';
import type { TransporterKind } from './transport.js';
import type { Grain } from './grains.js';
import type { AminoType as Amino } from './species.js';

/** Bumped when the shape changes incompatibly, so a stale save is refused, not misread. */
export const SNAPSHOT_VERSION = 1;

export interface PlaneSnapshot {
  species: SpeciesId;
  data: Float64Array;
}

export interface TransporterSnapshot {
  tile: number;
  kind: TransporterKind;
  species: SpeciesId;
  p: number;
  integrity: number;
  closed?: boolean;
  vmax?: number;
  rate?: number;
  direction?: 1 | -1;
  atpPerUnit?: number;
  lastFlux?: number;
}

export interface WorldSnapshot {
  v: number;
  tick: number;

  /** Only species whose plane holds something. See the note above. */
  planes: PlaneSnapshot[];

  cyto: { volume: number; tension: number; stretch: number; lysed: boolean };
  extra: { volume: number; tension: number; stretch: number; lysed: boolean };

  /** The charge, in ATP. Capacity is derived from geometry. */
  energy: number;
  inventory: Partial<Record<AminoType, number>>;

  grains: { seed: number; nextId: number; items: Grain[] };

  transporters: TransporterSnapshot[];
  /** Enzyme tuples, including the half-finished catalysis — see `Enzyme.snapshot`. */
  enzymes: Array<[number, boolean, number, number, number, number, number]>;
  ribosomes: Array<{ tile: number; integrity: number; job: unknown }>;
  flagella: Array<{ tile: number; dx: number; dy: number; firing: boolean; integrity: number }>;

  vacancies: unknown[];
  orders: GeneId[];
  pendingProteins: GeneId[];

  bot: {
    x: number;
    y: number;
    targetX: number | null;
    targetY: number | null;
    carrying: Amino[] | null;
    /** Grains in the satchel. NOT in the grain store — `pickUp` removes them from it. */
    inventory: Grain[];
  };

  build: unknown;
  motility: unknown;

  /** Richness only; everything else about a patch is constructed. */
  patchRichness: number[];

  /**
   * The fractional remainders every rate carries between steps.
   *
   * Individually tiny and collectively the difference between a save that resumes and one
   * that drifts: `importCarry` is the sub-particle fraction a port has accrued, and
   * dropping it makes every restart quietly round the cell's imports down.
   */
  carry: {
    importCarry: Array<[SpeciesId, number]>;
    exportCarry: Array<[number, number]>;
    exportRate: Array<[number, number]>;
    autoSeekT: number;
  };
}
