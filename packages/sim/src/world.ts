/**
 * The composed simulation. SPEC.md §12 — the intro scenario, on the real grid.
 *
 * This is what the server owns and ticks. It is still pure: no I/O, no network, no
 * clock-reading. `step()` takes no arguments at all, so nothing inside can accidentally
 * scale itself by a frame delta (§3.7).
 */

import {
  ATP_START,
  DIFFUSION,
  P_CHANNEL_GLUCOSE,
  ATP_POOL_PER_TILE,
  ATP_PER_PEPTIDE_BOND,
  R0,
  SIM_DT,
  TRANSPORTER_FACE_TILES,
  VMAX_CARRIER_LACTATE,
  RESIDUE_IMPORT_RATE,
  GLUCOSE_IMPORT_RATE,
  EXPORT_REACH,
  EXPORT_WINDOW,
  HOPPER_CAPACITY,
  AUTO_SEEK_INTERVAL,
  INTERIOR_SATURATION,
  HOPPER_SPREAD,
  SETTLE_RADIUS,
  SETTLE_SPEED,
  HOSTILE_WEIGHT,
  health as healthOf,
} from './constants.js';
import { Compartment, bleb, stepOsmosis, syncTileCounts } from './compartment.js';
import { CYTOPLASM, EXTRACELLULAR, Grid, Role } from './grid.js';
import { Enzyme, seedATP, stepMetabolism, totalATP } from './metabolism.js';
import { faceTiles, gateTiles, isGateTile, stampCell } from './membrane.js';
import { diffuse } from './ops/diffuse.js';
import {
  AMINO_IDS,
  OSMOTIC_BY_ID,
  AMINO_TYPES,
  SPECIES,
  SPECIES_ID,
  aminoId,
  aminoTypeOf,
  speciesName,
  type AminoType,
  type SpeciesId,
} from './species.js';
import {
  applyGrainTransport,
  applyTransport,
  carrier,
  channel,
  pump,
  type GrainSide,
  type Transporter,
  type TransporterKind,
} from './transport.js';
import { Nanobot } from './nanobot.js';
import {
  RESIDUE_UNIT,
  emptyBuild,
  startBuild,
  stepConstruction,
  cancelBuild,
  type BuildState,
  type GeneId,
} from './construction.js';
import { GENES, atpCost, billOfMaterials } from './genes.js';
import {
  FLAGELLUM_SPEED,
  emptyMotility,
  senseGradient,
  stepMotility,
  type Flagellum,
  type MotilityState,
} from './motility.js';
import { PatchField, type Patch } from './world-patches.js';
import { GrainStore, PARTICLE, isDiscrete } from './grains.js';
import { Inventory } from './inventory.js';
import { decay, efficiency, frailtyOf, stressLevel, worn, type Perishable } from './denature.js';
import {
  JOB_PATIENCE,
  RIBOSOME_BOND_TIME,
  Ribosome,
  inReach,
  type RibosomeJob,
  type Vacancy,
} from './ribosome.js';
import { EnergyPool } from './energy.js';
import { chooseTarget, type Stock } from './scarcity.js';
import {
  SNAPSHOT_VERSION,
  type PlaneSnapshot,
  type TransporterSnapshot,
  type WorldSnapshot,
} from './snapshot.js';

/**
 * Radius, in tiles, over which a membrane patch senses the interior concentration (§5a).
 *
 * Point-sampling one tile is meaningless once matter is discrete: ~16 glucose grains over
 * 896 interior tiles means the specific tile behind any membrane patch is empty almost
 * always, so a point sample reads zero, infers an enormous gradient, and imports without
 * limit. Five tiles averages over ~80 interior tiles — stable at intro scale, and still
 * local enough to resolve a genuine gradient in a large cell, which is where §17's
 * penetration-depth wall lives.
 */
const SENSE_RADIUS = 5;

/** How far the nanobot can reach to pick a grain up, in tiles (§5a). */
export const PICKUP_REACH = 3;

/**
 * How far the nanobot sweeps up WAITING RESIDUES, in tiles (§5b.5).
 *
 * Wider than PICKUP_REACH on purpose. A settled hopper spreads to a cluster radius of
 * about 3 tiles and its farthest member sits ~6.5 tiles from the port, so a 3-tile reach
 * meant walking to your own importer collected part of the pile and left the rest — you
 * had to shuffle around it. Standing in a pile should sweep the pile.
 */
export const COLLECT_REACH = 7;

/**
 * How many proteins may be queued at once (§9.6).
 *
 * A bound rather than a feature: an unbounded queue lets a player park a hundred orders
 * and walk away, which turns the ribosome from a thing you direct into a thing you fill
 * once. Eight is more than the standing build-out has distinct proteins, so it never
 * blocks a real plan.
 */
export const MAX_ORDERS = 8;

/** A queued or finished order. The residue is null for genes that do not select one. */
export interface Order {
  gene: GeneId;
  residue: AminoType | null;
}

const GLU = SPECIES_ID.glucose;
const LAC = SPECIES_ID.lactate;

/** Face angles. §12.1: glucose zone on one face, amino on another, waste out a third. */
export const FACE = {
  glucose: Math.PI, // left
  amino: 0, // right
  lactate: Math.PI / 2, // bottom
} as const;

export interface WorldOptions {
  width?: number;
  height?: number;
  radius?: number;
}

export interface StepStats {
  cracked: number;
  brownedOut: number;
  atpSpentOnPumps: number;
  lysedThisStep: boolean;
  /**
   * ATP shed as heat because the adenine pool was already full.
   *
   * Surfaced because a cell at its ceiling looks EXACTLY like a cell that has stalled —
   * the HUD number stops moving either way — and the two call for opposite responses.
   * This is the number that distinguishes them.
   */
  dissipated: number;
  /** §10A.1 — ATP spent on thrust this step, from the same field construction draws on. */
  atpSpentSwimming: number;
  /** Flagella wanted to fire but the cell could not pay. */
  swimStalled: boolean;
  /** §9.4 — folded proteins that denatured past use this step. */
  proteinsFailed: number;
  /** A residue added to the chain this step (§9.2 step 3), for the click-clack feedback. */
  placed: AminoType | null;
  /** The chain finished folding this step (§9.2 step 4) — "the payoff beat". */
  folded: boolean;
}

export class World {
  readonly grid: Grid;
  readonly cyto: Compartment;
  readonly extra: Compartment;
  readonly enzymes: Enzyme[] = [];
  readonly transporters = new Map<number, Transporter>();

  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  /** The ring. Holds no ATP (§4.2) but its upkeep is billed to the cytoplasm (§13.2). */
  readonly membraneTiles: number;

  /** Species actually simulated. Kept small until the biology needs more. */
  /**
   * Species actually simulated as MATTER IN SPACE.
   *
   * The residues are gone from this list since §5b — they are an integer inventory, not a
   * field, so there is nothing here for them to be. Anything that wants a residue count
   * asks `inventory`, and there is exactly one place to ask.
   */
  readonly active: SpeciesId[] = [GLU, LAC];

  /** §5a — the two representations. Every active species is in exactly one. */
  readonly discrete: SpeciesId[] = this.active.filter((s) => isDiscrete(s));
  readonly continuum: SpeciesId[] = this.active.filter((s) => !isDiscrete(s));

  /** §1.2 — the player's avatar, and the only assembler in the cell until a ribosome. */
  readonly bot: Nanobot;

  /** §9.2 — the in-progress protein, if any. */
  readonly build: BuildState = emptyBuild();

  /**
   * §12.1 — the nucleus, "clickable blueprint library, with the ribosome visible but
   * locked = signposted goal". The bot must be here to select a gene.
   */
  readonly nucleus: { x: number; y: number; r: number };

  /**
   * The extracellular field the medium relaxes back toward — see `bathRate`.
   *
   * Recomputed from the patch field whenever the cell has swum far enough to be looking
   * at different terrain. Caching matters: evaluating every patch at every extracellular
   * tile is ~8k tiles × species × patches, and at 120 Hz that is real work for a value
   * that only changes when the cell moves.
   */
  private readonly bathBaseline = new Map<SpeciesId, Float64Array>();
  private baselineBuiltAt = { x: Number.NaN, y: Number.NaN };

  /** §10A.2 — the terrain, in world coordinates. */
  readonly patches: PatchField;

  /**
   * Residues imported but not yet worth a whole one. §5b counts in whole residues, so a
   * transporter delivering 0.3 of one per second has to bank the remainder rather than
   * round it away (which starves you) or up (which conjures matter).
   */
  private readonly importCarry = new Map<SpeciesId, number>();
  /** Per-carrier export budget awaiting a whole grain (§5b.8). */
  private readonly exportCarry = new Map<number, number>();
  /** Leaky integral of units exported, for a readable rate. See stepLactateExport. */
  private readonly exportRate = new Map<number, number>();

  /**
   * §5b — the building-material stock, as plain counts. One residue is one peptide bond.
   *
   * TRIPLED after playtesting: "it is impossible to get everything built with the current
   * inventory." The original numbers were sized against §12's scripted arc — four intro
   * proteins plus a second carrier plus a flagellum — which is not what a player actually
   * builds. A realistic build-out is closer to three enzymes, three glucose channels (§13.4
   * feeds one enzyme per face), two lactate carriers, an amino transporter for each of the
   * five types, and a flagellum:
   *
   *     gly 31   leu 23   lys 24   ala 21   val 16
   *
   * against a starting lysine of fourteen — and lysine's deposit is the farthest one on the
   * map. So the squeeze arrived before the player had the means to answer it, which is the
   * wrong order: §12.3 wants scarcity to teach the supply line, not to preempt it.
   *
   * Sizing a stock against the DESIGNED path rather than the PLAYED one is the recurring
   * error here — it is the same mistake as §5b's stale comment, one revision later.
   */
  readonly inventory = new Inventory({ gly: 72, leu: 60, lys: 42, ala: 48, val: 42 });

  /**
   * §5c — the cell's charge, as one number rather than a field.
   *
   * Sized against interior + membrane, because §4.2's membrane holds no pool of its own
   * but its upkeep is billed here (§13.2).
   */
  readonly energy: EnergyPool;

  /** §9.5 — the machines that keep the cell repaired. Sited by the player. */
  readonly ribosomes: Ribosome[] = [];

  /**
   * Holes left by denatured proteins (§9.4), waiting for a ribosome in range.
   *
   * A vacancy remembers WHAT was there, not just that something was: a repair puts back
   * the lysine transporter you sited, not a generic protein. The player's placement
   * decision outlives the protein that expressed it.
   */
  readonly vacancies: Vacancy[] = [];

  /** §9.5 — what the player has asked for, over and above repairs. */
  readonly orders: Order[] = [];

  /** Folded proteins a ribosome has finished on an ORDER, waiting for the player to site. */
  readonly pendingProteins: Order[] = [];

  /**
   * §5a — the countable matter inside the cell.
   *
   * Grains are TRUTH for glucose, lactate and the five residues; those species have no
   * interior field at all, so there is no second representation to fall out of sync with.
   * The extracellular side stays a continuum, because §2.5 already models the medium as a
   * boundary condition rather than as state.
   */
  readonly grains = new GrainStore();

  /**
   * Fractional imports awaiting a whole grain, keyed by tile × species.
   *
   * A channel delivering 0.3 of a grain's worth per tick must mint one grain every fourth
   * tick — not zero forever (which starves the cell) and not one per tick (which conjures
   * matter). This is where conservation lives now that quantity is quantised.
   */
  private readonly importRemainder = new Map<number, number>();

  /** Interior tiles within SENSE_RADIUS of each membrane tile's inner neighbour. */
  private readonly senseArea = new Map<number, number>();

  /** §10A — where the cell is, how fast, and what it is steering toward. */
  readonly motility: MotilityState = emptyMotility();

  /** §10A.1 — flagella, seated in membrane tiles like any other membrane protein. */
  readonly flagella: Flagellum[] = [];

  /** Imports this step, per species, so patches can be drawn down by what was eaten. */
  private readonly importedThisStep = new Map<SpeciesId, number>();

  private autoSeekT = 0;

  /**
   * How fast the extracellular medium is refreshed, per second. §2.5: "Every 'sealed box'
   * in a single-cell scene only looks sealed because what is on the other side hasn't
   * been drawn yet."
   *
   * WHY THIS EXISTS, and why it is `Infinity` by default. Measured on this grid: one
   * enzyme produces 7.14 lactate/s, but a 13-tile carrier face exported only 2.8/s,
   * because exported lactate piles up in a boundary layer immediately outside the face
   * and flattens its own gradient. Per-tile the numbers were stark — inside 0.044,
   * outside 0.041, so the gradient actually driving transport was 0.003 while the
   * bulk-to-bulk gradient was 0.145. That is `lactate_export.html`'s stall reproduced
   * exactly, and §6.8 draws the right conclusion: the fix is not a stronger carrier, it
   * is keeping the far side clear.
   *
   * It cannot be fixed by widening the medium either, because this game is 2D (§15.1).
   * Steady-state 2D diffusion from a point source falls off as ln(r), so the far-field
   * concentration never really converges — `Q/(2πD)·ln(R_far/R)` still leaves ~0.09 at
   * the membrane. In 3D the same integral converges to `Q/(4πDR)` and the problem largely
   * evaporates. A 2D cell in still water genuinely cannot shed waste.
   *
   * So the medium is modelled as a BOUNDARY CONDITION rather than as state: effectively
   * infinite and well stirred, which is what a real cell in open water has. It also keeps
   * §12.1's food zones from being eaten hollow.
   *
   * The moment that assumption stops holding is precisely the multicellular transition.
   * Pack cells together and each one's neighbourhood IS bounded, its neighbours' exhaust
   * has nowhere to go, and circulation becomes mandatory (§6.8, §17.7). **Set this to 0
   * to get the stall back deliberately** — it is the same knob, and it is the argument
   * for a bloodstream made mechanical. A finite value in between models a sluggish or
   * crowded medium.
   */
  bathRate = Infinity;

  tick = 0;

  constructor(opts: WorldOptions = {}) {
    const width = opts.width ?? 96;
    const height = opts.height ?? 96;
    this.radius = opts.radius ?? R0;
    this.cx = width / 2;
    this.cy = height / 2;

    this.grid = new Grid(width, height);
    stampCell(this.grid, { cx: this.cx, cy: this.cy, radius: this.radius });
    this.membraneTiles = this.grid.countRole(Role.MEMBRANE);

    this.cyto = new Compartment(CYTOPLASM);
    // The extracellular space has no baseline osmolytes and does not swell — it is the
    // reference the cell is measured against. §2.5 notes it only LOOKS sealed because
    // what is on the other side has not been drawn yet; circulation (§6.8) is what will
    // eventually dissolve it.
    this.extra = new Compartment(EXTRACELLULAR, 1, 0);
    syncTileCounts(this.grid, [this.cyto, this.extra]);
    this.cyto.restVolume = this.cyto.tileCount;
    this.cyto.volume = this.cyto.tileCount;
    this.extra.restVolume = this.extra.tileCount;
    this.extra.volume = this.extra.tileCount;

    this.nucleus = { x: this.cx - this.radius * 0.35, y: this.cy + this.radius * 0.35, r: 4 };
    this.bot = new Nanobot(this.cx + this.radius * 0.3, this.cy - this.radius * 0.3);

    // §10A.2 — the terrain. The cell starts at the centre of its own window, and the
    // intro pockets are placed around that origin so §12 is unchanged by motility
    // existing: a player who never builds a flagellum sees exactly the cell they used to.
    this.motility.x = this.cx;
    this.motility.y = this.cy;
    this.patches = PatchField.intro(this.cx, this.cy);

    this.energy = new EnergyPool(ATP_START, this.cyto.tileCount + this.membraneTiles);

    // The medium is now a window onto the patch field rather than a fixed snapshot.
    //
    // Copy it into the EXTRACELLULAR tiles only. Blitting the whole plane also overwrites
    // the cytoplasm — where the baseline is zero — which silently erased the starting ATP
    // and the entire starting residue stock seeded two lines above, and presented as every
    // build stalling on ATP from the very first bond.
    this.rebuildBaseline();
    for (const s of this.active) {
      const base = this.bathBaseline.get(s);
      if (!base) continue;
      const plane = this.grid.plane(s);
      for (let i = 0; i < plane.length; i++) {
        if (this.grid.compartment[i] === EXTRACELLULAR) plane[i] = base[i]!;
      }
    }
  }

  /**
   * §12.1's unstated prerequisite: a small starting stock of typed amino acids.
   *
   * There is a chicken-and-egg the spec never quite addresses. Every protein costs amino
   * acids (§9.1), and the amino-acid transporter is itself a protein — so with an empty
   * cytoplasm the player can build nothing at all and the intro cannot start.
   * `enzyme_build.html` solved it the same way, shipping a starting pool.
   *
   * Sized deliberately tight: enough for the glycolysis enzyme and roughly one membrane
   * protein, not three. Lys is the scarcest, and the lactate carrier needs four of them —
   * so the player who builds the carrier before the transporter will run the pool dry and
   * meet §9.2's blocking case as a consequence of their own ordering, which is the lesson
   * arriving on its own rather than being announced.
   */

  /**
   * A deterministic scatter of points inside the cell.
   *
   * Deterministic because §3.7 makes the whole run replayable from a seed, and a starting
   * stock that differed per run would break that. A sunflower/golden-angle spiral rather
   * than rejection sampling: it is uniform by construction, needs no retries, and does not
   * clump the way independent uniform draws do — which matters when there are only a few
   * dozen grains and a clump reads as a meaningful concentration.
   */
  private randomInterior(k: number, n: number): { x: number; y: number } {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const r = (this.radius - 1.5) * Math.sqrt((k + 0.5) / n);
    const a = k * golden;
    return { x: this.cx + r * Math.cos(a), y: this.cy + r * Math.sin(a) };
  }

  /**
   * How much of a species is inside the cell, whichever representation carries it.
   *
   * The single accessor exists so that no caller has to remember which species are grains.
   * Getting that wrong is silent in the worst way: a discrete species read off the grid
   * returns 0 because its interior field is genuinely empty, and the cell then appears to
   * contain no glucose at all while sixteen grains of it drift around inside.
   */
  interiorAmount(s: SpeciesId): number {
    return isDiscrete(s) ? this.grains.total(s) : this.grid.totalIn(s, CYTOPLASM);
  }

  /** Osmotically active quantity held as grains — §7.2 counts molecules, not fields. */
  private grainOsmolytes(): number {
    let sum = 0;
    for (const s of this.discrete) if (OSMOTIC_BY_ID[s]) sum += this.grains.total(s);
    return sum;
  }

  /** Total of each residue type inside the cell — the §9.2 step 2 pool check. */
  /** The residue stock — counts, not concentrations (§5b). */
  residuePool(): Map<AminoType, number> {
    return this.inventory.snapshot();
  }

  /**
   * §5a — pick up a grain. The bot must be able to reach it.
   *
   * Reach rather than exact position because a grain is a drifting object and the bot is a
   * drifting object; demanding they coincide would make collection a coordination puzzle
   * against Brownian motion, which is frustration rather than difficulty.
   */
  pickUp(grainId: number): { ok: boolean; reason?: string } {
    if (this.bot.full) return { ok: false, reason: 'the satchel is full' };
    const g = this.grains.grains.find((q) => q.id === grainId);
    if (!g) return { ok: false, reason: 'that grain is gone' };
    if (g.held) return { ok: false, reason: 'already carried' };
    if (Math.hypot(g.x - this.bot.x, g.y - this.bot.y) > PICKUP_REACH) {
      return { ok: false, reason: 'too far away — walk the nanobot over first' };
    }
    this.grains.remove(g);
    g.held = true;
    this.bot.inventory.push(g);
    return { ok: true };
  }

  /** Put a carried grain back into the cytoplasm where the bot is standing. */
  dropGrain(grainId: number): { ok: boolean; reason?: string } {
    const i = this.bot.inventory.findIndex((q) => q.id === grainId);
    if (i < 0) return { ok: false, reason: 'not carrying that' };
    const g = this.bot.inventory.splice(i, 1)[0]!;
    g.held = false;
    g.x = this.bot.x;
    g.y = this.bot.y;
    this.grains.grains.push(g);
    return { ok: true };
  }

  /** Pick up nearby beads the in-progress build still calls for. See step(). */
  private autoCollect(): void {
    const gene = this.build.gene;
    if (!gene || this.build.phase !== 'assembling') return;
    const needed = new Set<SpeciesId>();
    for (let i = this.build.chain.length; i < gene.sequence.length; i++) {
      needed.add(aminoId(gene.sequence[i]!));
    }
    for (const s of needed) {
      if (this.bot.full) return;
      // Only reach for a type the satchel is actually short of, so one bead type cannot
      // crowd out the others when the build needs several.
      if (this.bot.held(s) >= RESIDUE_UNIT) continue;
      const g = this.grains.nearest(s, this.bot.x, this.bot.y, PICKUP_REACH);
      if (g) this.pickUp(g.id);
    }
  }

  /**
   * §9.4 — age every folded protein, and retire the ones that give out.
   *
   * Driven by stress rather than by a flat clock, so this is a readout of how the cell is
   * doing rather than a maintenance tax: a comfortable cell replaces a protein every
   * minute or so, a cell held at rupture tension loses them six times faster. That gives
   * §10.3's doom spiral a second, visible body — swelling strains the carriers, and losing
   * carriers makes the swelling worse.
   */
  private stepDenaturation(dt: number): number {
    const stress = stressLevel(this.cyto.tension, this.energy.brownedOut);
    let failed = 0;

    for (const [tile, t] of [...this.transporters]) {
      if (decay(t, dt, stress, frailtyOf(tile))) {
        failed++;
        // A denatured protein is not a gated one — it is gone, and its tile is free for
        // whatever you fold next. §6.7's real estate comes back.
        this.transporters.delete(tile);
        this.vacancies.push({
          tile,
          gene: this.geneFor(t.species),
          species: t.species,
          transporter: t.kind,
          residue: aminoTypeOf(t.species),
        });
      }
    }
    for (let i = this.enzymes.length - 1; i >= 0; i--) {
      if (decay(this.enzymes[i]!, dt, stress, frailtyOf(this.enzymes[i]!.tile + 7919))) {
        failed++;
        this.vacancies.push({ tile: this.enzymes[i]!.tile, gene: 'glycolysisEnzyme' });
        this.enzymes.splice(i, 1);
      }
    }
    // RIBOSOMES DO NOT DENATURE. §9.5a.
    //
    // They are the only thing that can replace a ribosome, so mortality gave the network no
    // floor: any run of bad luck that took them all out was unrecoverable, and over a long
    // enough game that run always comes. Measured, every configuration reached zero
    // ribosomes and then zero of everything else — and raising protein lifetime from 7 to
    // 30 minutes did not change it, which is what marks the problem as structural rather
    // than as tuning. Bisecting confirmed the economy itself was fine: with decay disabled
    // the same cell held 11 proteins and ATP 494 at fifteen minutes.
    //
    // So automation, once earned, stays earned. It costs the symmetry of "everything the
    // cell folds can be lost", which is a real loss and is recorded rather than hidden; the
    // alternatives were to let a ribosome repair its own integrity, or to leave it mortal
    // and make hand-folding the floor. Worth revisiting once growth and division give the
    // cell a reason to build ribosomes it might then lose.
    for (let i = this.flagella.length - 1; i >= 0; i--) {
      if (decay(this.flagella[i]!, dt, stress, frailtyOf(this.flagella[i]!.tile + 104729))) {
        failed++;
        this.vacancies.push({ tile: this.flagella[i]!.tile, gene: 'flagellum' });
        this.flagella.splice(i, 1);
      }
    }
    return failed;
  }

  /**
   * §5b.8 — lactate export, as the mirror image of an import port.
   *
   * A carrier used to move lactate by concentration flux, which left it the last thing on
   * the membrane still running on a mechanism nothing else used — and an invisible one, so
   * "is my carrier working" was unanswerable by looking. It is now an EXTRACTOR: it
   * consumes lactate grains within reach and sends them out.
   *
   * The one thing worth preserving from the flux model is §6.4's saturation, and it comes
   * across intact: a carrier binds its cargo, so it has a hard Vmax and cannot be made to
   * go faster by piling more lactate against it. That is still the reason you need two of
   * them (§12.3), and it is now visible as a queue of grains the carrier cannot keep up
   * with rather than as a number that stops climbing.
   */
  private stepLactateExport(dt: number): void {
    let exported = 0;
    for (const [tile, tr] of this.transporters) {
      if (tr.species !== LAC || tr.closed === true) continue;
      const x = (tile % this.grid.width) + 0.5;
      const y = Math.floor(tile / this.grid.width) + 0.5;

      const carry = (this.exportCarry.get(tile) ?? 0) + VMAX_CARRIER_LACTATE * efficiency(tr) * dt;
      // Whole particles only; the remainder banks so a slow carrier still exports eventually.
      const unit = PARTICLE;
      let budget = carry;
      let moved = 0;
      while (budget >= unit) {
        const g = this.grains.nearest(LAC, x, y, EXPORT_REACH);
        if (!g) break;
        this.grains.remove(g);
        // Out into the medium, which §2.5 models as an effectively infinite sink.
        budget -= unit;
        moved += g.amount;
      }
      this.exportCarry.set(tile, budget);
      // A LEAKY INTEGRATOR, not an exponential average of the instantaneous rate.
      //
      // Export is bursty by construction: the budget accrues for ~34 steps and then a
      // whole 4-unit grain leaves at once, which is 480 units/s for one tick and zero for
      // the rest. Smoothing that reads back as a number swinging between 0.04 and 9.12 —
      // worse than useless, because it looks like the carrier is malfunctioning. Summing
      // what actually left over a two-second window and dividing gives the rate a player
      // means when they ask how fast it is going.
      const acc = (this.exportRate.get(tile) ?? 0) + moved - (this.exportRate.get(tile) ?? 0) * (dt / EXPORT_WINDOW);
      this.exportRate.set(tile, acc);
      tr.lastFlux = acc / EXPORT_WINDOW;
      exported += moved;
    }
  }

  /**
   * §5b — residue transporters, which no longer move a field because there is no field.
   *
   * A transporter for a residue is an INSERTER: while the cell is within reach of that
   * residue's deposit it pulls whole residues across at a rate, and the deposit counts
   * down. No concentration, no gradient, no equilibrium — those were the right tools for
   * a metabolite and the wrong ones for a bill of materials.
   *
   * Rate scales with how strongly that deposit reaches the cell and with what is left in
   * it, so BOTH position and depletion still matter: parking on the deposit is much better
   * than skirting it, and a stripped deposit stops paying. That keeps §6.7's placement
   * decision and §10A.2's reason-to-move intact without any chemistry.
   */
  private stepResidueImport(dt: number): void {
    // §5b.6 — GLUCOSE USES THE SAME PORT MODEL. A transporter in range of its deposit
    // mints particles at its own tile; that is now the only way anything gets in.
    //
    // Glucose used to arrive by concentration flux across the membrane, which meant the
    // import you had built was an invisible arithmetic relationship between two numbers
    // neither of which was on screen. One mechanism for everything the player imports is
    // both simpler to reason about and simpler to explain.
    //
    // It also makes §17 legible rather than merely modelled. Glucose particles still
    // random-walk once inside (their D is untouched), so "how far does a glucose get from
    // the wall before an enzyme eats it" IS the penetration depth §17's SA:V wall is built
    // from — except now it is a thing you watch instead of a gradient you infer.
    for (const t of [...AMINO_TYPES, 'glucose'] as const) {
      const id = t === 'glucose' ? SPECIES_ID.glucose : aminoId(t);
      const isResidue = t !== 'glucose';
      // §9.4 — a worn port draws less. `efficiency` holds at 1 for most of a protein's
      // life and tapers only near the end, so machinery works properly and then visibly
      // falters, rather than everything being permanently half-broken.
      let ports = 0;
      for (const tr of this.transporters.values()) {
        if (tr.species === id && tr.closed !== true) ports += efficiency(tr);
      }
      if (ports <= 0) continue;

      // THE BEST deposit of this species, not the first one in the array.
      //
      // `.find()` meant only ever the home patch. Glucose has three deposits; a player who
      // swam to the richer one 95 tiles out and parked on top of it got nothing at all,
      // because range was still being measured to a patch on the other side of the map —
      // and the channel reported "at equilibrium", which is not even the right vocabulary
      // for a port. Any species with more than one deposit had exactly one that worked.
      const dep = this.bestDepositFor(id);
      if (!dep || dep.richness <= 0) continue;

      // Distance from the MEMBRANE, not from the cell's centre — the transporter is a
      // protein sitting in the wall, so what matters is how far the wall is from the
      // deposit. Measuring from the centre made a deposit that visibly touched the cell
      // read as 18 tiles further away than it looked.
      const gap = Math.max(0, Math.hypot(dep.x - this.motility.x, dep.y - this.motility.y) - this.radius);

      // Full rate inside the deposit's core, tapering to nothing at its harvest radius.
      // A hard range with a visible ring, rather than a gaussian tail nobody can see: the
      // old test was `exp(-d^2/2s^2) > 0.02`, which meant a channel aimed at a deposit
      // 39 tiles away did NOTHING, with no way to find that out.
      let reach: number;
      if (gap <= dep.radius) reach = 1;
      else if (gap >= dep.harvestRadius) reach = 0;
      else reach = 1 - (gap - dep.radius) / (dep.harvestRadius - dep.radius);
      if (reach <= 0) {
        for (const tr of this.transporters.values()) if (tr.species === id) tr.lastFlux = 0;
        continue;
      }

      // Glucose feeds enzymes rather than a build queue, so it comes in faster — matched
      // to ENZYME_TURNOVER so a couple of ports can keep an enzyme busy.
      const rate = isResidue ? RESIDUE_IMPORT_RATE : GLUCOSE_IMPORT_RATE;

      // A RESIDUE DEPOSIT RUNS AT FULL RATE UNTIL IT IS NEARLY OUT, then visibly falters.
      //
      // Scaling the rate by richness directly — which is what glucose still does, and what
      // both did — makes draw-down exponential: dN/dt = -R.N/reserve, so a deposit
      // asymptotes toward empty and can never be stripped. The practical effect is a hard
      // ceiling on what one visit can ever yield, no matter how long you stay: a 2-minute
      // stop on a full deposit collected 46% of it and the last quarter was unreachable.
      // That is the wrong shape for something §5b deliberately models as an ORE PATCH
      // rather than as a gradient — an inserter does not slow down because the chest is
      // half empty.
      //
      // Same taper as `efficiency` uses for a worn protein (§9.4), and for the same
      // reason: full rate for most of its life, then a visible falter, rather than
      // everything being permanently a bit degraded. A deposit is now a quantity you can
      // plan against — "160 left, I am taking one a second" — which is the readable form.
      const yieldScale = isResidue ? Math.min(1, dep.richness / 0.25) : dep.richness;
      const perSecond = rate * ports * reach * yieldScale;

      // Report the rate on every transporter of this type, in PARTICLES PER SECOND.
      //
      // It used to report grains/s under a label that read as molecules, which understated
      // glucose delivery fourfold, and left the HUD quoting four different quantities under
      // one word: deposits counted in particles, enzymes consuming molecules, carriers
      // exporting units, ports reporting grains. For residues a parcel WAS one residue, so
      // the bug was invisible there, which is why it survived. §5d collapsed the lot.
      //
      // Particles is the unit the player can actually see, because it is the thing drawn
      // on screen and the thing counted on the deposit.
      for (const tr of this.transporters.values()) {
        if (tr.species === id) tr.lastFlux = -perSecond / Math.max(1, ports);
      }

      // ── §5c: imports arrive as PARTICLES at the transporter, not as a number ──
      //
      // They used to be added straight to the inventory, which meant the supply line had
      // no physical existence: "the gly acids just seem to go directly into my inventory,
      // there are no particles to pick up". A count that increments on its own is not a
      // loop — nothing happens anywhere, and the transporter you placed has no visible
      // output.
      //
      // Now each import mints a residue at the transporter's own tile and LEAVES IT
      // THERE. It is findable because you built the thing that made it, and collecting it
      // is a trip with a destination rather than a search.
      const carried = (this.importCarry.get(id) ?? 0) + perSecond * dt;
      const whole = Math.floor(carried);
      this.importCarry.set(id, carried - whole);
      if (whole <= 0) continue;

      // One hopper per transporter, and it FILLS UP. An importer whose output is not
      // collected stalls — the backpressure is visible at the wall, which is what turns
      // "your importer is producing" into something you can see across the cell.
      let minted = 0;
      for (const [tile, tr] of this.transporters) {
        if (tr.species !== id || tr.closed === true) continue;
        const x = (tile % this.grid.width) + 0.5;
        const y = Math.floor(tile / this.grid.width) + 0.5;
        // Bias inward so the residue sits just inside the wall rather than in it.
        const ix = x + (this.cx - x) * 0.2;
        const iy = y + (this.cy - y) * 0.2;
        // The hopper cap is a RESIDUE mechanic: residues are held at the port and must be
        // collected, so an importer you never visit backs up and stalls. Glucose is eaten
        // by machinery, never collected, so a PORT-LOCAL cap is the wrong test for it —
        // and applying it anyway was a 30x throttle that starved the whole cell.
        //
        // The bug: §5b.7 slowed glucose drift to calm the visuals, which meant minted
        // grains stopped clearing the port. Eight of them within six tiles was reached
        // almost immediately, the port stalled, and measured import fell from a theoretical
        // 28.8 ATP/s to 0.53 — so the cell starved with a full larder sitting against its
        // own wall. Every "denaturation kills the cell" result traced back to here.
        //
        // Glucose still saturates, but against the WHOLE INTERIOR, which is the honest
        // question: is the cell holding more fuel than it can burn?
        const waiting = this.grains.totalNear(id, ix, iy, 6);
        if (isResidue) {
          if (waiting >= HOPPER_CAPACITY) continue; // backed up — this port stalls
        } else if (this.grains.count(id) >= INTERIOR_SATURATION) {
          continue; // the cell is already carrying more than it can use
        }

        // Lay them out in a small cluster rather than all at one point. Minting every
        // residue at the same coordinate drew eight particles exactly on top of each
        // other, so a full hopper was indistinguishable from a single bead — the pile had
        // no visible size, which is the one thing a backlog needs to communicate.
        //
        // A fixed golden-angle packing rather than mutual repulsion or jitter: it is
        // deterministic (§3.7 replay), needs no per-tick work, and guarantees separation
        // instead of merely tending toward it.
        const k = Math.round(waiting);
        const a = k * 2.399963; // golden angle
        const rr = HOPPER_SPREAD * Math.sqrt((k + 0.5) / HOPPER_CAPACITY);
        // §5d — one particle, whatever it is. This used to branch on species because a
        // glucose parcel held four molecules and a residue held one bond.
        this.grains.add(id, ix + Math.cos(a) * rr, iy + Math.sin(a) * rr, PARTICLE);
        minted++;
        if (minted >= whole) break;
      }
      // Hand back whatever could not be placed — not just the all-blocked case.
      //
      // The refund only fired when `minted === 0`, so a partially blocked tick silently
      // DESTROYED the difference: ask for three grains, place one, lose two. And what it
      // handed back was the integer `whole` rather than the units actually unplaced, which
      // corrupts an accumulator that is supposed to hold a fraction. Between them the
      // import accounting drifted until it stopped delivering at all.
      const unplaced = whole - minted;
      if (unplaced > 0) this.importCarry.set(id, (this.importCarry.get(id) ?? 0) + unplaced);
      if (minted === 0) continue;
      // §5d — parcels ARE the quantity now, so this is just the count. It used to convert,
      // and getting the conversion wrong here made glucose deposits last four times as long
      // as their reserve claimed. One unit is how that class of bug stops existing.
      dep.richness = Math.max(0, dep.richness - (minted * PARTICLE) / dep.reserve);
    }
  }

  /**
   * §5c — pick up residue particles the nanobot walks over.
   *
   * Automatic within reach rather than click-per-item: the trip is the mechanic, not the
   * clicking. Walking to your importer and hoovering up what it has made is a journey with
   * a destination; forty individual clicks would be an interface.
   */
  private collectResidues(): void {
    for (const t of AMINO_TYPES) {
      const id = aminoId(t);
      for (;;) {
        const g = this.grains.nearest(id, this.bot.x, this.bot.y, COLLECT_REACH);
        if (!g) break;
        this.grains.remove(g);
        this.inventory.add(t, Math.max(1, Math.round(g.amount)));
      }
    }
  }

  /**
   * The deposit of `species` this cell can draw from best right now — highest reach, which
   * accounts for both distance and each deposit's own harvest radius.
   */
  bestDepositFor(species: SpeciesId): Patch | null {
    let best: Patch | null = null;
    let bestReach = 0;
    for (const p of this.patches.patches) {
      if (p.species !== species || p.hostile || p.richness <= 0) continue;
      const gap = Math.max(0, Math.hypot(p.x - this.motility.x, p.y - this.motility.y) - this.radius);
      const reach =
        gap <= p.radius ? 1 : gap >= p.harvestRadius ? 0 : 1 - (gap - p.radius) / (p.harvestRadius - p.radius);
      if (reach > bestReach) {
        bestReach = reach;
        best = p;
      }
    }
    return best;
  }

  /** The closest deposit of `species` with anything left — what a course is set for. */
  nearestDepositFor(species: SpeciesId): Patch | null {
    let best: Patch | null = null;
    let bestD = Infinity;
    for (const p of this.patches.patches) {
      if (p.species !== species || p.hostile || p.richness <= 0.01) continue;
      const d = Math.hypot(p.x - this.motility.x, p.y - this.motility.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /**
   * §10A.9 — what the cell has least of, lowest first.
   *
   * Counts, straight off the things the player is already looking at: the residue
   * inventory, and the glucose particles inside the cell. No rates, no estimates, nothing
   * derived — the number the seeker compares is the number on the HUD, so "why is it going
   * there" is answered by looking.
   */
  scarcity(): Stock[] {
    const table: Stock[] = [
      { species: GLU, name: speciesName(GLU), count: this.grains.count(GLU) },
    ];
    for (const t of AMINO_TYPES) {
      table.push({ species: aminoId(t), name: t, count: this.inventory.get(t) });
    }
    table.sort((a, b) => a.count - b.count);
    return table;
  }

  /**
   * §10A.9 — hand steering to whatever is most urgent, and keep it there.
   *
   * Re-evaluated on a slow cadence rather than every step: the table moves on the
   * timescale of minutes, sampling it at 120 Hz buys nothing, and doing so would make the
   * hysteresis in `chooseTarget` fight 120 times a second instead of twice.
   */
  private stepAutoSeek(dt: number): void {
    if (!this.motility.autoSeek) return;
    this.autoSeekT += dt;
    if (this.autoSeekT < AUTO_SEEK_INTERVAL) return;
    this.autoSeekT = 0;

    this.motility.chemotaxis = chooseTarget(this.scarcity(), this.motility.chemotaxis);
  }

  /**
   * §9.5 — run every ribosome for one step.
   *
   * Each one looks at ITS OWN NEIGHBOURHOOD and decides what to make: first anything that
   * has failed within reach, then whatever the player has queued. That is what makes
   * siting a ribosome a decision — it maintains what is near it and nothing else, so a
   * cell with one ribosome on its glucose face and none on its waste face will watch the
   * carriers rot.
   */
  /** Which gene produced a given transporter — so a repair rebuilds the same thing. */
  private geneFor(species: SpeciesId): GeneId {
    if (species === LAC) return 'lactateCarrier';
    if (aminoTypeOf(species) !== null) return 'aminoTransporter';
    return 'glucoseChannel';
  }

  private stepRibosomes(dt: number): number {
    let finished = 0;
    const stress = stressLevel(this.cyto.tension, this.energy.brownedOut);
    void stress;

    for (const r of this.ribosomes) {
      if (r.integrity <= 0) continue;

      // Pick up work. Repairs first — something in range has already stopped working, and
      // that is more urgent than anything speculative.
      if (!r.job) {
        // RIBOSOMES FIRST. A ribosome is the thing that repairs things, so a dead one costs
        // not just its own function but everything it would have maintained.
        //
        // Without this the whole mechanic collapsed in about seven minutes: ribosomes
        // denature like any other protein, they were all folded at the same moment so they
        // expired together, and once the last one went nothing could rebuild anything —
        // leaving the cell worse off than before it had automation, with a pile of
        // vacancies and no machinery.
        //
        // The point is not to make them immortal. It is to make COVERAGE the decision:
        // ribosomes whose ranges overlap keep each other alive indefinitely, and an
        // isolated one eventually dies of old age no matter how well the cell is run.
        // Siting is now a network problem, which is the same shape as §6.8's circulation
        // layout arriving early and small.
        // Triage, in the order a cell would care about:
        //   1. ribosomes  — the thing that repairs things
        //   2. production — a channel or an enzyme; without ATP nothing else can be built
        //   3. everything else
        // Without step 2 the cell spends its last ATP rebuilding a lactate carrier while
        // the glucose channel that would have paid for it stays broken.
        //
        // ── ...and then, when nothing is broken, whatever is ABOUT to break ────
        //
        // Playtested: "the ribosome should pre-emptively repair proteins when they are
        // close to denaturing, rather than waiting for the end." Right, and it fixes a
        // real hole — waiting for failure means every protein has a dead window between
        // stopping and being put back, so a cell running a full ribosome network still
        // spends a slice of every protein's life with that protein missing.
        //
        // An EARLIER attempt at this was removed, and the difference is worth being precise
        // about because the objection to it was correct. That version was a cheap partial
        // top-up: a second cost, a second threshold and a second timescale, three more
        // things to tune and three more for a player to model. This one adds none of those
        // — a renewal costs exactly what a replacement costs, because it IS a replacement,
        // and the threshold is not a new number but REPAIR_AT, which already exists as the
        // point where `efficiency` says the protein has begun to falter.
        //
        // So the rule is still one sentence: **a protein is replaced, at full price, when
        // it starts to falter.** It just no longer has to die first.
        //
        // Renewals sit BELOW every vacancy in the triage, which is the other half of the
        // old objection: pre-emptive work that outranks actual failures can starve the
        // path it was meant to assist. Dead beats tired, always.
        const inRange = (v: Vacancy): boolean => inReach(this.grid.width, r.tile, v.tile);

        const PRODUCTION: GeneId[] = ['glucoseChannel', 'glycolysisEnzyme'];
        let vi = this.vacancies.findIndex((v) => v.gene === 'ribosome' && inRange(v));
        if (vi < 0) vi = this.vacancies.findIndex((v) => PRODUCTION.includes(v.gene) && inRange(v));
        if (vi < 0) vi = this.vacancies.findIndex(inRange);
        if (vi >= 0) {
          const v = this.vacancies.splice(vi, 1)[0]!;
          r.job = {
            gene: v.gene, source: 'repair', tile: v.tile,
            species: v.species, transporter: v.transporter, residue: v.residue ?? null,
            placed: 0, bondT: 0, blockedOn: null, starved: 0,
          };
        } else if (this.claimRenewal(r)) {
          // claimed in place
        } else if (this.orders.length > 0) {
          // The residue rides along. Dropping it here would silently turn every ordered
          // amino transporter into a glycine one — §5a.10's bug, rebuilt one layer up.
          const o = this.orders.shift()!;
          r.job = {
            gene: o.gene, source: 'order', tile: null,
            residue: o.residue, placed: 0, bondT: 0, blockedOn: null, starved: 0,
          };
        }
      }
      const job = r.job;
      if (!job) continue;

      const gene = GENES[job.gene];
      const want = gene.sequence[job.placed];
      if (want === undefined) continue;

      // Same bill and the same 4 ATP per bond as hand-assembly (§9.1) — a ribosome is
      // faster, not cheaper. Automation buys throughput, never material.
      if (this.inventory.get(want) < 1) {
        // Waiting on a bead is legitimate — the supply line may deliver shortly — but not
        // forever, and not while holding a vacancy another ribosome could serve.
        job.blockedOn = want;
        job.starved += dt;
        if (job.starved > JOB_PATIENCE) {
          if (job.tile !== null) {
            this.vacancies.push({
              tile: job.tile, gene: job.gene,
              species: job.species, transporter: job.transporter, residue: job.residue,
            });
          } else {
            this.orders.push({ gene: job.gene, residue: job.residue ?? null });
          }
          r.job = null;
        }
        continue;
      }
      job.starved = 0;
      if (this.energy.level < ATP_PER_PEPTIDE_BOND) {
        // PUT THE JOB BACK rather than sitting on it.
        //
        // A claimed job holds its vacancy, and `if (!r.job)` means a ribosome with a job
        // can never do anything else — so a ribosome that stalled on ATP stayed wedged on
        // that one job forever. Traced: two of three ribosomes frozen at `glyc:3` and
        // `glyc:2` for eight solid minutes while five vacancies went unserved.
        //
        // Partial work is discarded, which is the honest cost of an interrupted synthesis
        // — a half-built chain is not a protein — and it means a cell that browns out
        // wastes what it had started, which is a real consequence rather than a soft one.
        if (job.tile !== null) {
          this.vacancies.push({
            tile: job.tile, gene: job.gene,
            species: job.species, transporter: job.transporter, residue: job.residue,
          });
        } else {
          this.orders.push({ gene: job.gene, residue: job.residue ?? null });
        }
        r.job = null;
        continue;
      }
      job.blockedOn = null;

      job.bondT += dt * efficiency(r);
      if (job.bondT < RIBOSOME_BOND_TIME) continue;
      job.bondT = 0;
      if (this.inventory.take(want, 1) <= 0) continue;
      if (this.energy.draw(ATP_PER_PEPTIDE_BOND) <= 0) {
        this.inventory.add(want, 1);
        continue;
      }
      job.placed++;

      if (job.placed >= gene.sequence.length) {
        this.completeJob(job);
        r.job = null;
        finished++;
      }
    }
    return finished;
  }

  /**
   * §9.6 — ask the ribosomes for a protein.
   *
   * The queue is what makes a ribosome a FACTORY rather than a repair crew. Until this
   * existed a ribosome could only put back what had already been there, so nothing new
   * could be built without the nanobot walking a chain bead by bead — automation that
   * could not actually make anything.
   *
   * Orders sit BELOW every repair and renewal in the triage (§9.5), and that ordering is
   * the design rather than an implementation detail: a cell that spends its last lysine on
   * something you asked for while a glucose channel rots is not automating, it is obeying.
   * A queue is what the ribosomes do with SPARE capacity.
   */
  queueProtein(gene: GeneId, residue?: AminoType): { ok: boolean; reason?: string } {
    const g = GENES[gene];
    if (!g) return { ok: false, reason: 'no such gene' };
    if (this.orders.length >= MAX_ORDERS) {
      return { ok: false, reason: `the queue holds ${MAX_ORDERS}` };
    }
    this.orders.push({ gene, residue: g.selectableResidue ? (residue ?? 'gly') : null });
    return { ok: true };
  }

  /** Drop a queued order. Anything already being assembled is a job, not an order. */
  cancelOrder(index: number): boolean {
    if (index < 0 || index >= this.orders.length) return false;
    this.orders.splice(index, 1);
    return true;
  }

  /**
   * Pick up a protein a ribosome finished, so it can be carried and sited.
   *
   * Loads it into the SAME carrying state hand-assembly ends in, which is why this is a
   * few lines: §9.2's deploy, the membrane validation, the client's "click a membrane
   * tile" prompt and every deploy event already operate on that state and need to know
   * nothing about where the protein came from.
   */
  takePending(index: number): { ok: boolean; reason?: string } {
    if (this.build.phase !== 'idle') {
      return { ok: false, reason: 'finish or cancel what you are holding first' };
    }
    if (index < 0 || index >= this.pendingProteins.length) {
      return { ok: false, reason: 'nothing there' };
    }
    const o = this.pendingProteins.splice(index, 1)[0]!;
    const gene = GENES[o.gene];
    this.build.phase = 'carrying';
    this.build.gene = gene;
    this.build.chain = [...gene.sequence];
    this.build.fold = 1;
    this.build.bondT = 0;
    this.build.blockedOn = null;
    this.build.residue = o.residue;
    this.bot.carrying = [...gene.sequence];
    return { ok: true };
  }

  /**
   * §9.5 — everything still working but worn to REPAIR_AT, as renewal targets.
   *
   * Ribosomes are included: a ribosome maintains other ribosomes, and this is the same
   * network property §9.5a already relies on, just arriving before death instead of after.
   */
  private *renewalTargets(): Generator<{ tile: number; gene: GeneId; p: Perishable; species?: SpeciesId; transporter?: TransporterKind; residue?: AminoType | null }> {
    for (const [tile, t] of this.transporters) {
      if (worn(t)) {
        yield {
          tile, gene: this.geneFor(t.species), p: t,
          species: t.species, transporter: t.kind, residue: aminoTypeOf(t.species),
        };
      }
    }
    for (const e of this.enzymes) if (worn(e)) yield { tile: e.tile, gene: 'glycolysisEnzyme', p: e };
    for (const f of this.flagella) if (worn(f)) yield { tile: f.tile, gene: 'flagellum', p: f };
    for (const rb of this.ribosomes) if (worn(rb)) yield { tile: rb.tile, gene: 'ribosome', p: rb };
  }

  /**
   * Can any living ribosome reach this tile? (§9.5b)
   *
   * The question the client could not ask, and the reason a hard lock was invisible: a
   * vacancy inside somebody's radius is a queue, and a vacancy outside every radius is a
   * permanent hole in the cell. They looked identical.
   */
  coveredByRibosome(tile: number): boolean {
    return this.ribosomes.some((r) => r.integrity > 0 && inReach(this.grid.width, r.tile, tile));
  }

  /**
   * §9.5b — the cell cannot swim, and nothing in it is going to fix that.
   *
   * Deliberately NOT just `flagella.length === 0`. Losing a flagellum with a ribosome
   * covering the tile is a thirty-second inconvenience; losing one that nothing covers,
   * with no way to fold another, is terminal. Only the second is worth interrupting the
   * player about, and conflating them would train them to ignore the warning.
   *
   * "No way to fold another" is checked against the actual bill of materials rather than
   * against a general sense of scarcity, because that is what the build will block on.
   */
  stranded(): boolean {
    if (this.flagella.length > 0) return false;
    // Something is already on its way — a claimed job or a covered vacancy.
    if (this.ribosomes.some((r) => r.job?.gene === 'flagellum')) return false;
    if (this.vacancies.some((v) => v.gene === 'flagellum' && this.coveredByRibosome(v.tile))) {
      return false;
    }
    // Could the player fold one by hand instead?
    for (const [type, need] of billOfMaterials(GENES.flagellum)) {
      if (this.inventory.get(type) < need) return true;
    }
    return this.energy.level < atpCost(GENES.flagellum);
  }

  /** Is another ribosome already renewing this tile? */
  private renewalClaimed(tile: number): boolean {
    return this.ribosomes.some((r) => r.job?.source === 'renew' && r.job.tile === tile);
  }

  /**
   * Give `r` the most urgent worn protein within its reach, if there is one. Returns
   * whether it took a job.
   *
   * Same triage as repairs — ribosomes, then production, then the rest — because the
   * reason a dead glucose channel outranks a dead lactate carrier does not change when the
   * protein is merely tired. Within a class, the WORST one first, so the thing closest to
   * failing is the thing that gets seen to.
   */
  private claimRenewal(r: Ribosome): boolean {
    const PRODUCTION: GeneId[] = ['glucoseChannel', 'glycolysisEnzyme'];
    const rank = (g: GeneId): number => (g === 'ribosome' ? 0 : PRODUCTION.includes(g) ? 1 : 2);

    let best: { tile: number; gene: GeneId; species?: SpeciesId; transporter?: TransporterKind; residue?: AminoType | null } | null = null;
    let bestKey = [Infinity, Infinity];
    for (const t of this.renewalTargets()) {
      if (!inReach(this.grid.width, r.tile, t.tile)) continue;
      if (this.renewalClaimed(t.tile)) continue;
      const key = [rank(t.gene), t.p.integrity];
      if (key[0]! < bestKey[0]! || (key[0] === bestKey[0] && key[1]! < bestKey[1]!)) {
        bestKey = key;
        best = t;
      }
    }
    if (!best) return false;
    r.job = {
      gene: best.gene, source: 'renew', tile: best.tile,
      species: best.species, transporter: best.transporter, residue: best.residue ?? null,
      placed: 0, bondT: 0, blockedOn: null, starved: 0,
    };
    return true;
  }

  /** Install what a ribosome just finished. */
  private completeJob(job: RibosomeJob): void {
    const product = GENES[job.gene].product;

    // A REPAIR knows where it goes — back into the tile whose protein failed. An ORDER
    // does not, so it is folded and handed to the player to site (§6.7 stays theirs).
    if (job.source === 'order' || job.tile === null) {
      this.pendingProteins.push({ gene: job.gene, residue: job.residue ?? null });
      return;
    }
    const tile = job.tile;

    // A RENEWAL finishes on a protein that is (usually) still sitting there, so it restores
    // that one rather than installing a second copy into an occupied tile. If the original
    // failed while the replacement was being folded — which it can, since a renewal starts
    // at REPAIR_AT and the fold is not instant — this falls through and installs fresh,
    // which is exactly what a repair would have done. Either way the tile ends up holding
    // one working protein.
    if (job.source === 'renew') {
      for (const t of this.renewalTargets()) {
        if (t.tile === tile && t.gene === job.gene) {
          t.p.integrity = 1;
          return;
        }
      }
    }
    if (product.kind === 'enzyme') {
      this.enzymes.push(new Enzyme(tile));
    } else if (product.kind === 'flagellum') {
      this.addFlagellum(tile);
    } else if (product.kind === 'ribosome') {
      this.ribosomes.push(new Ribosome(tile));
    } else if (isGateTile(this.grid, tile)) {
      const species = job.species ?? product.species;
      const kind = job.transporter ?? product.transporter;
      this.transporters.set(
        tile,
        kind === 'channel'
          ? channel(species, P_CHANNEL_GLUCOSE * (job.residue ? 0.6 : 1))
          : kind === 'carrier'
            ? carrier(species)
            : pump(species, 1, 1, 0.5),
      );
    }
  }

  /** Is this point inside the cytoplasm? The containment test grains reflect off. */
  private insideCell = (x: number, y: number): boolean => {
    const i = this.grid.idx(Math.floor(x), Math.floor(y));
    return i >= 0 && i < this.grid.tileCount && this.grid.compartment[i] === CYTOPLASM;
  };

  /**
   * The interior half of §5a's transport, as `applyGrainTransport` sees it.
   *
   * Defined here rather than in transport.ts so the transport module never has to know
   * that grains exist — it computes flux from concentrations and asks this to store the
   * result, which is what lets §6.1's law be asserted once for both representations.
   */
  private grainSide: GrainSide = {
    innerConc: (s, tile) => {
      const inI = this.grid.inward[tile]!;
      const x = (inI % this.grid.width) + 0.5;
      const y = Math.floor(inI / this.grid.width) + 0.5;
      let area = this.senseArea.get(tile);
      if (area === undefined) {
        area = 0;
        const r2 = SENSE_RADIUS * SENSE_RADIUS;
        for (let j = 0; j < this.grid.tileCount; j++) {
          if (this.grid.compartment[j] !== CYTOPLASM) continue;
          const dx = (j % this.grid.width) + 0.5 - x;
          const dy = Math.floor(j / this.grid.width) + 0.5 - y;
          if (dx * dx + dy * dy <= r2) area++;
        }
        this.senseArea.set(tile, area);
      }
      if (area === 0) return 0;
      return this.grains.totalNear(s, x, y, SENSE_RADIUS) / (area * this.cyto.tileVolume);
    },
    innerTotal: (s) => this.grains.total(s),
    takeNear: (s, tile, want) => {
      const inI = this.grid.inward[tile]!;
      const x = (inI % this.grid.width) + 0.5;
      const y = Math.floor(inI / this.grid.width) + 0.5;
      return this.grains.take(s, x, y, SENSE_RADIUS, want);
    },
    giveNear: (s, tile, amount) => {
      const key = tile * 64 + s;
      const carried = (this.importRemainder.get(key) ?? 0) + amount;
      const inI = this.grid.inward[tile]!;
      const x = (inI % this.grid.width) + 0.5;
      const y = Math.floor(inI / this.grid.width) + 0.5;
      this.importRemainder.set(key, this.grains.mint(s, x, y, carried));
    },
  };

  // ── §10A, motility ─────────────────────────────────────────────────────────

  /**
   * Seat a flagellum in a membrane tile. Thrust runs along the INWARD normal, because a
   * flagellum pushes the cell away from itself — so where you put them determines which
   * way you can go, and steering is choosing which to fire (§10A.1, and §6.7 again).
   */
  addFlagellum(tile: number): Flagellum | null {
    if (this.grid.role[tile] !== Role.MEMBRANE) return null;
    const inI = this.grid.inward[tile];
    if (inI === undefined || inI < 0) return null;
    const tx = (tile % this.grid.width) + 0.5;
    const ty = Math.floor(tile / this.grid.width) + 0.5;
    // Inward = toward the cell centre.
    let dx = this.cx - tx;
    let dy = this.cy - ty;
    const mag = Math.hypot(dx, dy) || 1;
    dx /= mag;
    dy /= mag;
    const f: Flagellum = { tile, dx, dy, firing: false, integrity: 1 };
    this.flagella.push(f);
    return f;
  }

  /** Steer toward a fixed heading, or pass null to coast (which is free). */
  setHeading(heading: number | null): void {
    this.motility.heading = heading;
    this.motility.chemotaxis = null;
  }

  /** §10A.3 — hand steering over to the gradient of a species. */
  setChemotaxis(species: SpeciesId | null): void {
    this.motility.chemotaxis = species;
    // Picking a target by hand is a statement that you want to steer, so it takes the
    // wheel back off the seeker rather than fighting it for the next half second.
    this.motility.autoSeek = false;
  }

  /** §10A.9 — let the cell choose its own target, or stop letting it. */
  setAutoSeek(on: boolean): void {
    this.motility.autoSeek = on;
    // Decide immediately rather than after AUTO_SEEK_INTERVAL: a button that visibly does
    // nothing for half a second reads as a button that did not work.
    this.autoSeekT = AUTO_SEEK_INTERVAL;
    if (on) this.stepAutoSeek(0);
  }

  /**
   * The sense → decide → actuate loop, then the actual swim.
   *
   * §10A.3 is emphatic that this "costs no new primitive": the sensing is just
   * concentration differences, which the simulation is already made of. What it adds is a
   * BEHAVIOURAL output for gradients — until now a gradient only drove transport.
   */
  private stepSwimming(dt: number) {
    // Sense. Sample the patch field around the cell rather than the local grid, because a
    // cell steers toward food it has not reached yet — the grid window only shows what is
    // already alongside it.
    if (this.motility.chemotaxis !== null) {
      const target = this.motility.chemotaxis;
      // NORMALISED against each species' own peak, because absolute concentrations of
      // different species are not comparable. Residue deposits peak near 0.07 (scaled to
      // the cell's interior) and the hostile lactate zone peaks at 2.0, so subtracting raw
      // values let the repellent outweigh the attractant about forty to one: seeking
      // lysine steered the cell AWAY from lysine, 82 tiles to 99.
      const attractPeak = this.patches.peakOf(target);
      const hostilePeak = this.patches.hostilePeak();
      const field = (ox: number, oy: number): number =>
        this.patches.sample(this.motility.x + ox, this.motility.y + oy, target) / attractPeak -
        // Repellents subtract, which is all a "toxic zone" needs to be (§10A.2).
        HOSTILE_WEIGHT *
          (this.patches.hostileAt(this.motility.x + ox, this.motility.y + oy) / hostilePeak);

      let heading = senseGradient(field, this.radius * 2.5);

      // ── When there is nothing to smell, navigate ──────────────────────────
      //
      // Gradient following is greedy and LOCAL, and the map is not. The lysine deposit sits
      // 90 tiles out with sigma 12 — seven and a half sigma, where the gaussian is about
      // 1e-12 — so there is literally no gradient at the cell, and "seek lysine" made the
      // cell wander. The player could SEE the deposit and the cell could not smell it,
      // which reads as the control being broken.
      //
      // So sensing handles the last stretch, where it is real biology (§10A.3), and a known
      // BEARING handles the rest. That is not a cheat dressed up as chemotaxis: the player
      // has seen the deposit on the map, and setting a course for something you can see is
      // a different act from sniffing your way to something you cannot. The hostile
      // deflection still applies, so a toxic zone continues to bend the route.
      if (heading === null) {
        const dep = this.nearestDepositFor(target);
        if (dep) {
          const dx = dep.x - this.motility.x;
          const dy = dep.y - this.motility.y;
          const hostileHere = this.patches.hostileAt(this.motility.x, this.motility.y) / hostilePeak;
          let ax = Math.atan2(dy, dx);
          if (hostileHere > 0.02) {
            // Bend around the hazard rather than driving through it.
            const away = senseGradient(
              (ox, oy) => -this.patches.hostileAt(this.motility.x + ox, this.motility.y + oy),
              this.radius * 2.5,
            );
            if (away !== null) {
              ax = Math.atan2(
                Math.sin(ax) + Math.sin(away) * HOSTILE_WEIGHT * hostileHere,
                Math.cos(ax) + Math.cos(away) * HOSTILE_WEIGHT * hostileHere,
              );
            }
          }
          heading = ax;
        }
      }

      this.motility.heading = heading;
    }

    // Actuate. Payment comes out of the ATP field itself, spread across the cytoplasm, so
    // this is the same pool the nanobot spends on peptide bonds.
    return stepMotility(this.motility, this.flagella, dt, (want) => this.drawATP(want));
  }

  /**
   * Take up to `want` ATP from the cytoplasm, returning what was actually available.
   *
   * Proportional across tiles rather than from one spot: thrust is generated at the
   * membrane by many flagella at once, and metering it per-tile would make swimming a
   * spatial puzzle it is not meant to be. The important property is only that it comes
   * out of the SAME field as everything else.
   */
  private drawATP(want: number): number {
    return this.energy.draw(want);
  }

  /** The adenine pool ceiling — total ATP this cell can hold (see ATP_POOL_PER_TILE). */
  get atpCapacity(): number {
    return this.energy.capacity;
  }

  /**
   * Internal totals for every osmotically active species, plus the fixed baseline.
   *
   * §7.2 makes volume a function of TOTAL solute regardless of identity, so "why is my
   * cell swelling" has a specific, per-species answer that the simulation knows and the
   * player could not see. Without it the volume climbs for no visible reason and the only
   * available response is to guess.
   */
  osmoticBreakdown(): Array<{ name: string; amount: number }> {
    const out: Array<{ name: string; amount: number }> = [
      { name: 'baseline', amount: this.cyto.baselineOsmolytes },
    ];
    for (const s of this.active) {
      if (!OSMOTIC_BY_ID[s]) continue; // ATP and water are excluded — see species.ts
      out.push({ name: SPECIES[s] ?? String(s), amount: this.interiorAmount(s) });
    }
    return out.sort((a, b) => b.amount - a.amount);
  }

  /**
   * Rebuild the extracellular baseline by sampling the patch field through the cell's
   * current window on the world (§10A.2).
   *
   * The grid is a window that travels with the cell: a tile at grid position (gx,gy) is
   * looking at world position (gx - cx + motility.x, gy - cy + motility.y). Swimming
   * therefore changes what the medium contains without any tile ever moving, which keeps
   * §3.6's re-tiling problem out of motility entirely.
   */
  private rebuildBaseline(): void {
    const ox = this.motility.x - this.cx;
    const oy = this.motility.y - this.cy;
    for (const s of this.active) {
      let base = this.bathBaseline.get(s);
      if (!base) {
        base = new Float64Array(this.grid.tileCount);
        this.bathBaseline.set(s, base);
      }
      base.fill(0);
      if (s === SPECIES_ID.atp) continue; // ATP is never in the medium
      for (let gy = 0; gy < this.grid.height; gy++) {
        for (let gx = 0; gx < this.grid.width; gx++) {
          const i = gy * this.grid.width + gx;
          if (this.grid.compartment[i] !== EXTRACELLULAR) continue;
          base[i] = this.patches.sample(gx + ox, gy + oy, s);
        }
      }
    }
    this.baselineBuiltAt = { x: this.motility.x, y: this.motility.y };
  }

  /** Relax the extracellular field toward its baseline — the open medium (§2.5). */
  private refreshMedium(dt: number): void {
    if (this.bathRate <= 0) return;
    // Only resample the terrain once the cell has actually moved somewhere different.
    const moved = Math.hypot(
      this.motility.x - this.baselineBuiltAt.x,
      this.motility.y - this.baselineBuiltAt.y,
    );
    if (!(moved < 0.25)) this.rebuildBaseline();

    const k = Math.min(1, this.bathRate * dt);
    for (const s of this.active) {
      const base = this.bathBaseline.get(s);
      if (!base) continue;
      const plane = this.grid.plane(s);
      for (let i = 0; i < plane.length; i++) {
        if (this.grid.compartment[i] !== EXTRACELLULAR) continue;
        plane[i]! += (base[i]! - plane[i]!) * k;
      }
    }
  }

  /**
   * §12.1's opening state used to be painted directly into the extracellular tiles here.
   * It now comes from the patch field (§10A.2) instead, so the same two pockets exist but
   * as terrain the cell can swim away from rather than as a fixed backdrop. See
   * PatchField.intro — the intro pockets are placed around the cell's starting position,
   * so a player who never builds a flagellum sees exactly the cell they saw before.
   */


  /** §6.7 — place a transporter across the face pointing at `angle`. */
  buildFace(angle: number, t: () => Transporter, count = TRANSPORTER_FACE_TILES): number[] {
    const tiles = faceTiles(this.grid, this.cx, this.cy, angle, count);
    for (const i of tiles) this.transporters.set(i, t());
    return tiles;
  }

  /**
   * §12.2 — Act 1. A CHANNEL, not a pump: do not pump in what already wants to enter.
   *
   * ONE tile, because that is what one protein is. These `build*` helpers exist for tests
   * and scripted setup; they must produce exactly what a player hand-building the same
   * gene through §9.2 would get, or the tests stop testing the game.
   */
  buildGlucoseChannel(): number[] {
    return this.buildFace(FACE.glucose, () => channel(GLU, P_CHANNEL_GLUCOSE), 1);
  }

  /**
   * §12.3 — the amino-acid transporter. Imports every residue type across one face, so
   * the stockpile it builds is the material §9.2 actually consumes.
   */
  /**
   * Seat a channel for ONE residue, on the face pointing at that residue's deposit.
   *
   * Aiming matters now in a way it did not before §5a.11. The five residue deposits used
   * to sit at one coordinate, so any face labelled "amino" pointed at all of them and
   * aiming was meaningless. Each residue now has its own place, so a transporter has to
   * face the right way to see anything — which is §6.7's placement decision applied to
   * materials instead of to fuel.
   */
  buildAminoChannelFor(type: AminoType): number[] {
    const id = aminoId(type);
    const dep = this.patches.patches.find((p) => p.species === id && !p.hostile);
    const angle = dep
      ? Math.atan2(dep.y - this.motility.y, dep.x - this.motility.x)
      : FACE.amino;

    // Nearest FREE gate tile to that bearing. Picking the single best tile silently
    // overwrote whatever was already there: gly's deposit and val's sit at almost the same
    // angle (-0.49 vs -0.52 rad), so seating both put them on the same tile and the second
    // deleted the first. The player had built a glycine transporter and did not have one.
    let best = -1;
    let bestD = Infinity;
    const wantX = this.cx + Math.cos(angle) * this.radius;
    const wantY = this.cy + Math.sin(angle) * this.radius;
    for (const tile of gateTiles(this.grid)) {
      if (this.transporters.has(tile)) continue; // §6.7 — one protein per tile
      const x = (tile % this.grid.width) + 0.5;
      const y = Math.floor(tile / this.grid.width) + 0.5;
      const d = Math.hypot(x - wantX, y - wantY);
      if (d < bestD) {
        bestD = d;
        best = tile;
      }
    }
    if (best < 0) return [];
    this.transporters.set(best, channel(id, P_CHANNEL_GLUCOSE * 0.6));
    return [best];
  }

  buildAminoTransporter(): number[] {
    // One tile per residue type — a membrane tile carries ONE transporter, so importing
    // five types genuinely costs five slots (§6.7's finite real estate, priced honestly).
    // Each is now aimed at its OWN deposit rather than all five sharing a face, because
    // the deposits are no longer in the same place (§5a.11).
    const tiles: number[] = [];
    for (const type of AMINO_TYPES) tiles.push(...this.buildAminoChannelFor(type));
    return tiles;
  }

  /**
   * §12.3 — the lactate carrier. Structural life support, not cosmetic cleanup.
   *
   * Twice the width of an import face, and for a real reason rather than to make the
   * numbers work. An import face has to point AT something — §12.1's glucose pocket sits
   * on one side, so a narrow, aimed face is correct. Waste export points at nothing; the
   * medium is equally empty in every direction, so there is no reason to concentrate it.
   *
   * Measured, the difference is large. A 13-tile face drew so hard that its inner
   * neighbours sat at 2-8% of bulk concentration — the carrier was starved of its own
   * substrate while the cell backed up behind it, exporting 3.6/s against 7.1/s of
   * production. Spreading the same total demand over more perimeter shortens every
   * diffusion path and cuts the per-tile draw that causes the depletion.
   */
  /**
   * TWO by default, because that is what the job actually takes.
   *
   * Import and export turn out to be asymmetric, and it is not a tuning accident. A
   * channel is fed from a well-stirred external medium that never depletes, so one
   * transporter runs at its full gradient. A carrier is fed by INTERIOR diffusion
   * carrying waste to a single tile, and a single tile can only receive about
   * `D × Δc × 3 edges` per second — right at one enzyme's output and therefore always
   * losing. Measured: one carrier leaves lactate rising (132 → 191 over a minute), two
   * bring it down (132 → 112), three drain it (132 → 47).
   *
   * So "one channel feeds one enzyme, but it takes two carriers to clean up after it" is
   * a real spatial fact, and a nice early rhyme with §17 — where interior transport is
   * again the thing that fails first.
   */
  buildLactateCarrier(count = 2): number[] {
    // Placed FLANKING the enzyme rather than on some distant "third face", and the
    // difference is stark. Measured over a minute, starting from 132 lactate:
    //
    //   1 carrier, opposite face   132 → 191   (still rising)
    //   1 carrier, near the enzyme 132 → 181   (still rising)
    //   2 carriers, opposite face  132 → 173   (still rising)
    //   2 carriers, flanking       132 → 112   (falling)
    //   3 carriers, flanking       132 →  47   (draining)
    //
    // §12.3 says to put the carrier "on a third face", which reads naturally but is
    // wrong on this grid: waste is produced at a point (the enzyme) and interior
    // diffusion is what carries it out, so an exporter on the far side is fed the dregs.
    // Placement beats count — two carriers in the right place beat two in the wrong one
    // by more than adding a third does. That is §6.7 earning its section.
    const tiles: number[] = [];
    for (let k = 0; k < count; k++) {
      const spread = 0.5 * (k % 2 === 0 ? 1 : -1) * (1 + Math.floor(k / 2));
      const angle = FACE.glucose + spread;
      for (const tile of this.buildFace(angle, () => carrier(LAC, VMAX_CARRIER_LACTATE), 1)) {
        tiles.push(tile);
      }
    }
    return tiles;
  }

  /**
   * §12.3 — Act 2. Placed one tile inward from the glucose face by default, because
   * §13.4's arithmetic says one full-gradient face feeds exactly one enzyme, and §4.7
   * says distance from supply is a real cost. Where this goes is a decision, not flavour.
   */
  buildEnzyme(tile?: number): Enzyme {
    const t = tile ?? this.defaultEnzymeTile();
    const e = new Enzyme(t);
    this.enzymes.push(e);
    return e;
  }

  private defaultEnzymeTile(): number {
    const inner = this.radius - 4;
    const x = Math.round(this.cx + Math.cos(FACE.glucose) * inner);
    const y = Math.round(this.cy + Math.sin(FACE.glucose) * inner);
    return this.grid.idx(x, y);
  }

  bleb(): boolean {
    // Residues are not in the cytoplasm as solute any more (§5b), so a bleb sheds only
    // what is actually dissolved. It does NOT cost you building material, which is a
    // small mercy the old model could not offer.
    return bleb(this.grid, this.cyto, [GLU, LAC], 0.55);
  }

  // ── §9.2, the player-facing pipeline ───────────────────────────────────────

  /** Is the bot close enough to the nucleus to take a blueprint? (§9.2 step 1) */
  get atNucleus(): boolean {
    return Math.hypot(this.bot.x - this.nucleus.x, this.bot.y - this.nucleus.y) <= this.nucleus.r + 1.5;
  }

  /**
   * §9.2 step 1 — take a blueprint from the nucleus. The bot has to physically be there;
   * "the nucleus hands over the blueprint directly" only works if you went and got it.
   */
  selectGene(
    id: GeneId,
    /** §5 — for a type-selectable product, which amino acid it will carry. */
    residue?: AminoType,
  ): { ok: boolean; reason?: string; shortfall?: Map<AminoType, number> } {
    if (!this.atNucleus) return { ok: false, reason: 'the nanobot must be at the nucleus' };
    if (this.build.phase !== 'idle') return { ok: false, reason: 'a build is already in progress' };
    const res = startBuild(this.build, id, this.residuePool(), residue);
    return res.shortfall ? { ok: true, shortfall: res.shortfall } : { ok: true };
  }

  cancelBuild(): void {
    cancelBuild(this.build);
    this.bot.carrying = null;
  }

  /**
   * §9.2 step 5 — "this is where enzyme and transporter split."
   *
   * A TRANSPORTER must be carried to a membrane tile and embedded on the correct face;
   * the instant it seats, that tile's permeability for its species jumps and transport
   * begins. An ENZYME is simply released into the cytoplasm, where it floats and works
   * wherever substrate is.
   *
   * The membrane tile is chosen by the PLAYER, which is §6.7's placement decision finally
   * being a decision: membrane surface is finite real estate and a glucose channel does
   * nothing on the face pointing at the amino-acid zone.
   */
  deploy(tile?: number): { ok: boolean; reason?: string } {
    if (this.build.phase !== 'carrying' || !this.build.gene) {
      return { ok: false, reason: 'nothing folded to deploy' };
    }
    const product = this.build.gene.product;

    if (product.kind === 'enzyme') {
      // Released wherever the bot is standing. Position still matters — §4.7 — but it is
      // a free agent in the soup, not infrastructure bolted to a wall.
      this.enzymes.push(new Enzyme(this.bot.tile(this.grid)));
      this.finishBuild();
      return { ok: true };
    }

    if (product.kind === 'ribosome') {
      // A ribosome is CYTOPLASMIC, like an enzyme — it is not embedded in anything, and
      // asking for a membrane tile made it unplaceable. The check used to sit after the
      // membrane validation below, so a folded ribosome demanded a gate tile it could
      // never legitimately occupy and simply refused every click.
      //
      // Where it goes still matters enormously — RIBOSOME_REACH decides what it maintains
      // (§9.5) — but that is a decision about the interior, not about the wall.
      this.ribosomes.push(new Ribosome(this.bot.tile(this.grid)));
      this.finishBuild();
      return { ok: true };
    }

    if (tile === undefined) return { ok: false, reason: 'pick a membrane tile' };
    if (this.grid.role[tile] !== Role.MEMBRANE) {
      return {
        ok: false,
        reason:
          product.kind === 'flagellum'
            ? 'a flagellum must be anchored in the membrane'
            : 'transporters must be embedded in the membrane',
      };
    }
    // The bot has to actually reach the spot to seat it.
    const tx = (tile % this.grid.width) + 0.5;
    const ty = Math.floor(tile / this.grid.width) + 0.5;
    if (Math.hypot(this.bot.x - tx, this.bot.y - ty) > 3) {
      return { ok: false, reason: 'the nanobot is too far from that membrane tile' };
    }

    // Wall, not gate — see `isGateTile`. This check used to exist only inside
    // `addFlagellum`, so a flagellum was refused here (confusingly, but correctly) while
    // a TRANSPORTER was accepted onto the same dead tile and then silently transported
    // nothing for the rest of the run.
    if (!isGateTile(this.grid, tile)) {
      return {
        ok: false,
        reason: 'that tile is buried inside a doubled stretch of wall — it touches neither ' +
          'the inside nor the outside, so nothing could cross there. Pick a tile on the open ring.',
      };
    }

    if (product.kind === 'flagellum') {
      if (!this.addFlagellum(tile)) return { ok: false, reason: 'cannot anchor there' };
      this.finishBuild();
      return { ok: true };
    }

    // A type-selectable gene carries whatever the player chose at the nucleus (§5).
    // Without this the amino transporter was permanently a glycine channel, so a cell
    // starved of lysine had no way to build a lysine importer — "rare types gate rare
    // proteins" was a rule the game stated and then refused to let you play against.
    const species =
      this.build.residue !== null ? aminoId(this.build.residue) : product.species;
    const t: Transporter =
      product.transporter === 'channel'
        ? channel(species, P_CHANNEL_GLUCOSE * (this.build.residue ? 0.6 : 1))
        : product.transporter === 'carrier'
          ? carrier(species)
          : pump(species, 1, 1, 0.5);
    this.transporters.set(tile, t);
    this.finishBuild();
    return { ok: true };
  }

  private finishBuild(): void {
    this.build.phase = 'idle';
    this.build.gene = null;
    this.build.chain = [];
    this.build.fold = 0;
    this.build.bondT = 0;
    this.build.blockedOn = null;
    this.bot.carrying = null;
  }

  get tileVolumes(): Map<number, number> {
    return new Map([
      [CYTOPLASM, this.cyto.tileVolume],
      [EXTRACELLULAR, this.extra.tileVolume],
    ]);
  }

  get atp(): number {
    return this.energy.level;
  }

  get health(): number {
    return healthOf(this.atp);
  }

  /**
   * One fixed step. Order matters:
   *   transport → diffusion → metabolism → osmosis
   * Transport first so freshly imported substrate is available to diffuse and be consumed
   * in the same step; osmosis last so volume responds to the solute state the step
   * actually produced.
   */
  // ── §15.8 saving and restoring ─────────────────────────────────────────────

  /**
   * Everything about this cell that play can change.
   *
   * Geometry is omitted on purpose — see `snapshot.ts`. What is here is the state, and
   * the test that keeps it honest is `snapshot.test.ts`: a restored world must step
   * BIT-IDENTICALLY to one that never stopped, for thousands of steps. That is a much
   * stronger check than "the numbers look right", and it is the only one that catches a
   * forgotten accumulator, because a dropped remainder is invisible for one step and
   * compounds forever.
   */
  snapshot(): WorldSnapshot {
    const T = this.grid.tileCount;
    const planes: PlaneSnapshot[] = [];
    for (let sp = 0; sp < SPECIES.length; sp++) {
      const base = sp * T;
      let live = false;
      for (let i = 0; i < T; i++) {
        if (this.grid.amount[base + i] !== 0) { live = true; break; }
      }
      if (live) planes.push({ species: sp as SpeciesId, data: this.grid.amount.slice(base, base + T) });
    }

    const transporters: TransporterSnapshot[] = [];
    for (const [tile, t] of this.transporters) {
      const e: TransporterSnapshot = {
        tile, kind: t.kind, species: t.species, p: t.p, integrity: t.integrity,
      };
      if (t.closed !== undefined) e.closed = t.closed;
      if (t.vmax !== undefined) e.vmax = t.vmax;
      if (t.rate !== undefined) e.rate = t.rate;
      if (t.direction !== undefined) e.direction = t.direction;
      if (t.atpPerUnit !== undefined) e.atpPerUnit = t.atpPerUnit;
      if (t.lastFlux !== undefined) e.lastFlux = t.lastFlux;
      transporters.push(e);
    }

    return {
      v: SNAPSHOT_VERSION,
      tick: this.tick,
      planes,
      cyto: {
        volume: this.cyto.volume, tension: this.cyto.tension,
        stretch: this.cyto.stretch, lysed: this.cyto.lysed,
      },
      extra: {
        volume: this.extra.volume, tension: this.extra.tension,
        stretch: this.extra.stretch, lysed: this.extra.lysed,
      },
      energy: this.energy.snapshot(),
      inventory: Object.fromEntries(this.inventory.snapshot()) as Partial<Record<AminoType, number>>,
      grains: this.grains.snapshot(),
      transporters,
      enzymes: this.enzymes.map((e) => e.snapshot()),
      ribosomes: this.ribosomes.map((r) => ({
        tile: r.tile,
        integrity: r.integrity,
        job: r.job ? { ...r.job } : null,
      })),
      flagella: this.flagella.map((f) => ({
        tile: f.tile, dx: f.dx, dy: f.dy, firing: f.firing, integrity: f.integrity,
      })),
      vacancies: this.vacancies.map((v) => ({ ...v })),
      orders: this.orders.map((o) => ({ ...o })),
      pendingProteins: this.pendingProteins.map((o) => ({ ...o })),
      bot: {
        x: this.bot.x, y: this.bot.y,
        targetX: this.bot.targetX, targetY: this.bot.targetY,
        carrying: this.bot.carrying ? [...this.bot.carrying] : null,
        inventory: this.bot.inventory.map((g) => ({ ...g })),
      },
      build: {
        phase: this.build.phase,
        gene: this.build.gene?.id ?? null,
        chain: [...this.build.chain],
        fold: this.build.fold,
        bondT: this.build.bondT,
        blockedOn: this.build.blockedOn ? { ...this.build.blockedOn } : null,
        residue: this.build.residue,
      },
      motility: { ...this.motility },
      patchRichness: this.patches.patches.map((pt) => pt.richness),
      carry: {
        importCarry: [...this.importCarry],
        exportCarry: [...this.exportCarry],
        exportRate: [...this.exportRate],
        autoSeekT: this.autoSeekT,
      },
    };
  }

  /**
   * Overwrite this world with a saved one.
   *
   * Refuses a snapshot from a different format version rather than reading it wrongly —
   * a save that half-loads is worse than one that will not load, because the failure is
   * silent and the cell simply behaves oddly.
   */
  restore(s: WorldSnapshot): void {
    if (s.v !== SNAPSHOT_VERSION) {
      throw new Error(`snapshot version ${s.v}, expected ${SNAPSHOT_VERSION}`);
    }
    const T = this.grid.tileCount;

    this.tick = s.tick;

    // Every plane, not only the saved ones: a plane that is empty in the snapshot must be
    // empty here too, and this world may have been played before being restored into.
    this.grid.amount.fill(0);
    for (const pl of s.planes) this.grid.amount.set(pl.data, pl.species * T);

    this.cyto.volume = s.cyto.volume;
    this.cyto.tension = s.cyto.tension;
    this.cyto.stretch = s.cyto.stretch;
    this.cyto.lysed = s.cyto.lysed;
    this.extra.volume = s.extra.volume;
    this.extra.tension = s.extra.tension;
    this.extra.stretch = s.extra.stretch;
    this.extra.lysed = s.extra.lysed;

    this.energy.restore(s.energy);
    this.inventory.restore(s.inventory);
    this.grains.restore(s.grains);

    this.transporters.clear();
    for (const t of s.transporters) {
      const tr: Transporter = {
        kind: t.kind, species: t.species, p: t.p, integrity: t.integrity,
      };
      if (t.closed !== undefined) tr.closed = t.closed;
      if (t.vmax !== undefined) tr.vmax = t.vmax;
      if (t.rate !== undefined) tr.rate = t.rate;
      if (t.direction !== undefined) tr.direction = t.direction;
      if (t.atpPerUnit !== undefined) tr.atpPerUnit = t.atpPerUnit;
      if (t.lastFlux !== undefined) tr.lastFlux = t.lastFlux;
      this.transporters.set(t.tile, tr);
    }

    this.enzymes.length = 0;
    for (const e of s.enzymes) this.enzymes.push(Enzyme.restore(e));

    this.ribosomes.length = 0;
    for (const r of s.ribosomes) {
      const rb = new Ribosome(r.tile);
      rb.integrity = r.integrity;
      rb.job = (r.job as RibosomeJob | null) ?? null;
      this.ribosomes.push(rb);
    }

    this.flagella.length = 0;
    for (const f of s.flagella) this.flagella.push({ ...f });

    this.vacancies.length = 0;
    for (const v of s.vacancies) this.vacancies.push(v as Vacancy);
    // Orders used to be bare gene ids and are now {gene, residue}. Normalised rather
    // than version-bumped: a bump would refuse every save written before today, which for
    // a deployed game means telling live players their cell cannot be loaded. A two-line
    // migration is a much better trade than a clean format.
    const asOrder = (o: GeneId | Order): Order =>
      typeof o === 'string' ? { gene: o, residue: null } : { gene: o.gene, residue: o.residue };
    this.orders.length = 0;
    this.orders.push(...s.orders.map(asOrder));
    this.pendingProteins.length = 0;
    this.pendingProteins.push(...s.pendingProteins.map(asOrder));

    this.bot.x = s.bot.x;
    this.bot.y = s.bot.y;
    this.bot.targetX = s.bot.targetX;
    this.bot.targetY = s.bot.targetY;
    this.bot.carrying = s.bot.carrying ? [...s.bot.carrying] : null;
    this.bot.inventory.length = 0;
    for (const g of s.bot.inventory) this.bot.inventory.push({ ...g });

    const b = s.build as {
      phase: BuildState['phase']; gene: GeneId | null; chain: AminoType[];
      fold: number; bondT: number; blockedOn: BuildState['blockedOn']; residue: AminoType | null;
    };
    this.build.phase = b.phase;
    this.build.gene = b.gene ? GENES[b.gene] : null;
    this.build.chain = [...b.chain];
    this.build.fold = b.fold;
    this.build.bondT = b.bondT;
    this.build.blockedOn = b.blockedOn;
    this.build.residue = b.residue;

    Object.assign(this.motility, s.motility);

    this.patches.patches.forEach((pt, i) => {
      pt.richness = s.patchRichness[i] ?? pt.richness;
    });

    this.importCarry.clear();
    for (const [k, v] of s.carry.importCarry) this.importCarry.set(k, v);
    this.exportCarry.clear();
    for (const [k, v] of s.carry.exportCarry) this.exportCarry.set(k, v);
    this.exportRate.clear();
    for (const [k, v] of s.carry.exportRate) this.exportRate.set(k, v);
    this.autoSeekT = s.carry.autoSeekT;

    // The extracellular baseline is rebuilt lazily from the cell's world position, and
    // its cache key is a position that may now be different. Invalidate it so the next
    // step repaints rather than trusting a baseline built for somewhere else.
    this.baselineBuiltAt = { x: Number.NaN, y: Number.NaN };

    syncTileCounts(this.grid, [this.cyto, this.extra]);
    this.energy.setCapacityTiles(this.cyto.tileCount + this.membraneTiles);
  }

  step(): StepStats {
    const wasLysed = this.cyto.lysed;
    this.tick++;

    const volumes = this.tileVolumes;
    const atpAvailable = this.atp > 0;
    const beforeImport = new Map<SpeciesId, number>();
    for (const s of this.active) beforeImport.set(s, this.interiorAmount(s));

    // §5a — two representations, one law. Continuum species move between tile pools;
    // discrete species move between the bath and the grain population. Both compute their
    // flux with `fluxOf`, so §6.1 binds identically for each.
    const { atpSpent } = applyTransport(
      this.grid,
      this.transporters,
      this.continuum,
      SIM_DT,
      atpAvailable,
      volumes,
    );
    const grainT = applyGrainTransport(
      this.grid,
      this.transporters,
      [],
      this.grainSide,
      SIM_DT,
      atpAvailable,
      this.extra.tileVolume,
    );

    // Net import per species, so §10A.2's patches can be drawn down by what was actually
    // eaten rather than by a proxy. Only gains count — export is not foraging.
    for (const s of this.active) {
      const gained = this.interiorAmount(s) - (beforeImport.get(s) ?? 0);
      if (gained > 0) this.importedThisStep.set(s, (this.importedThisStep.get(s) ?? 0) + gained);
    }

    // Continuum species diffuse on the lattice. Discrete species diffuse by RANDOM WALK,
    // which is not an approximation of the above but the microscopic process of which it
    // is the continuum limit — and `GrainStore.step` derives its step size from the very
    // same DIFFUSION table, so both reproduce the same D.
    for (const s of this.continuum) {
      const d = DIFFUSION[SPECIES[s]!] ?? 1;
      diffuse(this.grid, s, d, SIM_DT);
    }
    // The bath outside still needs to spread, and for discrete species the interior has no
    // field to corrupt, so this is safe to run over the whole plane.
    for (const s of this.discrete) {
      const d = DIFFUSION[SPECIES[s]!] ?? 1;
      diffuse(this.grid, s, d, SIM_DT);
    }
    this.grains.step(SIM_DT, this.insideCell);
    // §5b.5 — waiting output spreads out instead of sitting in a heap.
    this.grains.settle(SIM_DT, SETTLE_RADIUS, SETTLE_SPEED, this.insideCell);

    const met = stepMetabolism(
      this.grid, this.cyto, this.enzymes, this.grains, this.energy, SIM_DT, this.membraneTiles,
    );

    // §10A — swim. Deliberately AFTER metabolism and BEFORE the medium refresh: thrust is
    // paid out of the same ATP field that peptide bonds are paid from, so a swimming cell
    // genuinely has less to build with. That competition is the whole of §10A.1 and it is
    // precisely what `motility_chemotaxis.html` did not model.
    const swim = this.stepSwimming(SIM_DT);

    this.refreshMedium(SIM_DT);
    // §10A.2 — what the cell ate comes out of the patch it ate it from, so a pocket runs
    // down and staying put stops being a winning strategy.
    this.patches.step(SIM_DT, this.motility.x, this.motility.y, this.importedThisStep);
    this.importedThisStep.clear();
    this.stepResidueImport(SIM_DT);
    // §10A.9 — after import, so the seeker judges scarcity on this step's delivery rather
    // than on last step's, and before the ribosomes spend anything.
    this.stepAutoSeek(SIM_DT);
    this.stepLactateExport(SIM_DT);
    const failed = this.stepDenaturation(SIM_DT);
    const synthesised = this.stepRibosomes(SIM_DT);
    this.collectResidues();
    const osm = stepOsmosis(this.grid, this.cyto, SIM_DT, this.grainOsmolytes());

    // The bot moves, then assembles from whatever is under it — in that order, so a
    // residue picked up this step is one the bot has actually arrived at.
    this.bot.step(SIM_DT);
    this.bot.confineTo(this.grid, CYTOPLASM, this.cx, this.cy);
    // §5a — scoop up beads the build still needs as the bot passes them.
    //
    // The alternative, a click per bead, was rejected on inspection: a 14-residue protein
    // would be fourteen round trips, which is busywork rather than logistics. This keeps
    // the part that IS a decision — you must still walk to where the lysine actually is,
    // and the satchel only holds eight — while dropping the part that is just clicking.
    // Beads the current build does not need are left alone, so the satchel never silently
    // fills with glycine while you are trying to fetch a lysine.
    this.autoCollect();
    const asm = stepConstruction(this.build, this.bot, this.grid, this.inventory, this.energy, SIM_DT);


    return {
      cracked: met.cracked,
      brownedOut: met.brownedOut,
      dissipated: met.dissipated,
      atpSpentSwimming: swim.atpSpent,
      swimStalled: swim.stalled,
      atpSpentOnPumps: atpSpent,
      lysedThisStep: osm.lysed && !wasLysed,
      proteinsFailed: failed,
      placed: asm.placed ?? null,
      folded: asm.folded === true,
    };
  }

  /**
   * Read a species plane as CONCENTRATION, which is what the renderer needs (§2.2).
   *
   * For a DISCRETE species (§5a) the interior half of this is projected from the grains,
   * because the grid genuinely holds nothing there. Without the projection this returned a
   * flat zero inside the cell — so the tint showed an empty cytoplasm, the wire carried
   * empty field frames, and §16.1's plane-agreement check (the direct test of §2.1: the
   * costume must reconstruct the HUD total) failed by the entire contents of the cell.
   *
   * This is a read-only summary built on demand, never a second copy of the truth: nothing
   * in the physics reads it back, so grains stay the single authority and there is no path
   * by which the two could drift.
   */
  concentrationPlane(s: SpeciesId, out?: Float32Array): Float32Array {
    const dst = out ?? new Float32Array(this.grid.tileCount);
    const plane = this.grid.plane(s);
    const cytoV = this.cyto.tileVolume;
    const extraV = this.extra.tileVolume;
    for (let i = 0; i < dst.length; i++) {
      const c = this.grid.compartment[i];
      if (c === CYTOPLASM) dst[i] = plane[i]! / cytoV;
      else if (c === EXTRACELLULAR) dst[i] = plane[i]! / extraV;
      else dst[i] = 0; // membrane holds no pool (§4.2); void holds nothing
    }

    if (isDiscrete(s)) {
      // Deposit each grain into the tile it is standing in. Interior tiles were set from
      // the (empty) grid above, so this replaces rather than adds to them.
      for (const g of this.grains.grains) {
        if (g.species !== s || g.held) continue;
        const i = this.grid.idx(Math.floor(g.x), Math.floor(g.y));
        if (i < 0 || i >= dst.length) continue;
        if (this.grid.compartment[i] !== CYTOPLASM) continue;
        dst[i]! += g.amount / cytoV;
      }
    }
    return dst;
  }

  /** Membrane tiles that currently carry a transporter, for the renderer to mark. */
  transporterTiles(): Array<{ tile: number; species: number; kind: string }> {
    const out: Array<{ tile: number; species: number; kind: string }> = [];
    for (const [tile, t] of this.transporters) {
      out.push({ tile, species: t.species, kind: t.kind });
    }
    return out;
  }
}

export { Role };
