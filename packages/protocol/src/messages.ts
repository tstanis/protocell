/**
 * Wire message types. SPEC.md §15.3, §3.7.
 *
 * Two channels, deliberately different:
 *
 *   Client → server   JSON text, low volume. COMMANDS ARE THE ONLY WAY A CLIENT AFFECTS
 *                     THE SIM. There is no other verb, which is what makes the whole run
 *                     replayable from a seed plus a command log.
 *
 *   Server → client   Binary frames for fields (codec.ts), JSON for scalars and events.
 *                     Fields are large and numeric; scalars are small and worth being
 *                     able to read in devtools.
 *
 * Nothing here imports @protocell/sim. The protocol describes the WIRE, not the
 * simulation, and keeping it independent is what lets a client be written against it
 * without pulling in the truth layer it is not allowed to touch.
 */

/** Region + resolution + species. §3.5's fractal zoom, expressed as a subscription. */
export interface ViewSpec {
  /** Top-left corner in world tiles. */
  x: number;
  y: number;
  /** Extent in world tiles (pre-downsample). */
  w: number;
  h: number;
  /**
   * Power-of-two downsample factor. 1 = full resolution (molecular scale, lush
   * individual dots); 8 = each output cell is an 8×8 box-average (organism scale,
   * heatmap tint). §3.5: "the zoom level IS the grid resolution."
   */
  lod: number;
  /** Which species to send. §11.4's toggleable layer overlays are just this list. */
  species: number[];
}

export type Command =
  /** §12.2 — place a transporter on a specific membrane tile. §6.7: where it sits matters. */
  | { op: 'placeTransporter'; tile: number; species: number; kind: 'channel' | 'carrier' | 'pump' }
  /**
   * Place a transporter across a whole FACE, letting the server resolve which membrane
   * tiles that is. §12's build buttons use this: at intro scale the player is choosing
   * "import glucose here", not picking individual tiles off a 108-tile ring.
   *
   * The tile-level op above is the same decision at higher resolution, and is what the
   * later game exposes once membrane real estate is genuinely contested (§6.7).
   */
  | {
      op: 'placeFace';
      face: 'glucose' | 'amino' | 'lactate';
      species: number;
      kind: 'channel' | 'carrier' | 'pump';
    }
  /** §9.2 step 5 — release an enzyme into the cytoplasm. Omit `tile` for the default site. */
  | { op: 'placeEnzyme'; tile?: number }
  /** §1.2 — send the nanobot somewhere. Tile coordinates, fractional. */
  | { op: 'moveTo'; x: number; y: number }
  /**
   * §9.2 step 1 — take a blueprint. Requires the bot to be at the nucleus.
   *
   * `residue` names WHICH amino acid a type-selectable transporter should carry. §5 is
   * emphatic that amino acids are typed and that "rare types gate rare proteins", but the
   * amino-transporter gene was hard-coded to glycine — so every one the player built was a
   * glycine channel and the choice §6.7 says should be real did not exist. Ignored by
   * genes whose product is not type-selectable.
   */
  | { op: 'selectGene'; gene: string; residue?: string }
  /**
   * §9.2 step 5 — deploy the folded protein. `tile` names the membrane tile for a
   * transporter (§6.7's placement decision) and is omitted for an enzyme, which is simply
   * released wherever the bot is standing.
   */
  | { op: 'deploy'; tile?: number }
  /** Abandon the chain. Spent residues and ATP are NOT refunded. */
  | { op: 'cancelBuild' }
  /**
   * §6.3 — "Can be gated open/closed." Shutting a channel is the player's only way to
   * stop importing something, and without it a cell with more channels than consumers
   * accumulates solute, swells, and has no lever to pull. Free and instant: a gate is a
   * conformational change, not construction.
   */
  | { op: 'gate'; tile: number; open: boolean }
  /**
   * §10A.1 — steer. `heading` in radians, or null to coast (which is free).
   *
   * Steering is a heading rather than a thrust level because §10A.1 frames control as
   * "biases which propellers fire": the cell decides where it wants to go and the flagella
   * that can contribute do. How much thrust that yields is a consequence of where the
   * player seated them, not a separate dial.
   */
  | { op: 'steer'; heading: number | null }
  /** §10A.3 — hand steering to the gradient of a species, or null to stop. */
  | { op: 'chemotaxis'; species: number | null }
  /**
   * §10A.9 — hand target selection to the cell: chase whatever it is most short of.
   *
   * A mode rather than a one-shot, because the answer changes as the cell plays. It drives
   * `chemotaxis` rather than replacing it, so turning it off leaves the last course it set
   * instead of dumping the player into no state at all.
   */
  | { op: 'autoSeek'; on: boolean }
  /**
   * Start this cell over from nothing. Destructive and deliberately not undoable.
   *
   * A command rather than an HTTP route, so §3.7's rule holds without exception: commands
   * are the only channel by which a client affects the simulation. It also means a reset
   * can only ever reach the cell the socket is already authorised for — with sign-in on,
   * the id comes from the session (§15.7), so there is no cell to name and therefore no
   * way to reset somebody else's.
   */
  /**
   * §9.6 — ask the ribosomes for a protein. `residue` picks the type for a selectable
   * gene, exactly as `selectGene` does for hand assembly.
   */
  | { op: 'queueProtein'; gene: string; residue?: string }
  /** Drop a queued order by index. Something already being assembled is a job, not an order. */
  | { op: 'cancelOrder'; index: number }
  /** Pick up a protein a ribosome finished, so it can be carried and sited (§9.2 step 5). */
  | { op: 'takePending'; index: number }
  | { op: 'reset' }
  /** §5a — pick a grain up into the nanobot's satchel. Server re-checks reach. */
  | { op: 'pickUp'; grain: number }
  /** §5a — put a carried grain back into the cytoplasm where the bot stands. */
  | { op: 'dropGrain'; grain: number }
  /** §10.4 — the emergency escape. Server re-checks the tension predicate. */
  | { op: 'bleb' }
  /** Dev/tuning only: inject solute. Never available in a shipped build. */
  | { op: 'debugAdd'; tile: number; species: number; amount: number };

export type ClientMsg =
  | { t: 'subscribe'; view: ViewSpec }
  | { t: 'command'; cmd: Command }
  | { t: 'control'; op: 'pause' | 'resume' | 'step' | 'speed'; value?: number };

/** Sent once on connect so a client can size itself without guessing. */
export interface HelloMsg {
  t: 'hello';
  protocolVersion: number;
  worldWidth: number;
  worldHeight: number;
  simHz: number;
  /** Species id → name, so the client can label without hardcoding the registry. */
  species: Record<number, string>;

  /**
   * The actual membrane tile indices.
   *
   * Sent rather than left for the client to infer, because inferring it was WRONG in a
   * way that took a while to see. `ScalarsMsg.radius` is the OSMOTIC radius, √(volume/π),
   * which changes as the cell swells — but the membrane TILES sit at the fixed geometric
   * radius the cell was stamped at, because volume is deliberately decoupled from tile
   * count until re-tiling exists (§3.6, and the note on Compartment). A client drawing its
   * membrane from `radius` therefore drew it in the wrong place, and clicks meant to seat
   * a transporter landed on cytoplasm.
   *
   * That is exactly the class of bug §2.1 exists to prevent — a costume contradicting the
   * truth — so the truth is now sent instead of reconstructed. It also lets the client
   * highlight where a transporter may legally go, which makes §6.7's placement decision
   * visible rather than guessed at.
   *
   * Static until growth and division move the boundary; at that point this becomes a
   * per-tick field rather than a hello-time constant.
   */
  membraneTiles: number[];

  /**
   * The subset of `membraneTiles` a protein can actually be seated in — every tile that
   * touches both the inside and the outside.
   *
   * These differ by more than a rounding error: §4.1's ring is an annulus one tile thick
   * radially, which rasterizes to a wall TWO tiles thick along the diagonals, and the
   * buried tiles there are wall rather than gate. On the default cell that is 20 of 108
   * tiles — **18.5% of the ring cannot host anything.**
   *
   * The client must highlight and snap to THIS list, not `membraneTiles`. Highlighting the
   * full ring meant roughly one deployment click in five landed on a dead tile: a
   * flagellum was refused with "cannot anchor there", and a transporter was accepted and
   * then silently never transported anything.
   */
  gateTiles: number[];

  /** Geometric radius the cell was stamped at, in tiles. */
  cellRadius: number;
}

/**
 * Per-tick scalars — the HUD numbers. Small enough for JSON, and being able to read them
 * in devtools is worth more than the bytes.
 *
 * §2.1: these are the TRUTH the costume must never contradict. If the HUD says 40, the
 * picture may not look like 20.
 */
export interface ScalarsMsg {
  t: 'scalars';
  tick: number;
  /** Fraction through the current sim step, for client-side interpolation (§2.4). */
  alpha: number;
  atp: number;
  /**
   * The adenine pool ceiling — the most a cell this size can hold.
   *
   * Sent because a bare ATP figure cannot distinguish "full" from "stalled": both look
   * like a number that has stopped moving, and they call for opposite responses. Adenine
   * nucleotides are conserved (ATP ⇌ ADP + Pi), so a charged cell pins at this value and
   * sheds everything past it. §12.4 treats that full battery as the intro's cliffhanger —
   * which only works if the player can SEE the battery is full.
   */
  atpCapacity: number;
  /** ATP/s currently being shed as heat because the pool is at capacity. */
  atpDissipated: number;
  /**
   * What is actually driving osmolarity, per species, largest first (§7.2).
   *
   * "Why is my cell swelling" has a specific per-species answer the simulation knows and
   * the player could not see. Without it the volume climbs for no visible reason.
   */
  osmolarity: Array<{ name: string; amount: number }>;
  /** §7.3's master variable, 0..1. */
  tension: number;
  volume: number;
  radius: number;
  /** §13.2 — drives ooze amplitude and particle speed. */
  health: number;
  lysed: boolean;
  /** Tiles that could not pay upkeep this tick (§2.3's brownout, made spatial). */
  brownedOut: number;

  /** §1.2 — the avatar. Tile coordinates, fractional. */
  bot: { x: number; y: number; carrying: boolean; atNucleus: boolean };

  /** §12.1 — the blueprint library, so the client knows where to draw it and when to enable it. */
  nucleus: { x: number; y: number; r: number };

  /**
   * §9.2 — the in-progress protein. `blockedOn` is the readable half of the blocking
   * case: a stalled build must be distinguishable from a broken one.
   */
  build: {
    phase: 'idle' | 'assembling' | 'folding' | 'carrying';
    gene: string | null;
    geneName: string | null;
    sequence: string[];
    chain: string[];
    fold: number;
    blockedOn: { residue: string; reason: 'residue' | 'atp' } | null;
    atpCost: number;
    /**
     * What the folded protein becomes (§9.2 step 5), so the client can tell the two
     * deployment idioms apart: a transporter is walked to a membrane tile the player
     * picks, an enzyme is released wherever the bot stands. Without this the client has
     * to guess from the gene name, and guessing wrong strands the player mid-carry.
     */
    productKind: 'enzyme' | 'transporter' | 'flagellum' | 'ribosome' | null;
    /** Which amino acid a type-selectable product will carry (§5), or null. */
    residue: string | null;
  };

  /** Cytoplasmic totals per residue type (§5) — the bill-of-materials panel reads this. */
  residues: Record<string, number>;

  /**
   * Every seated transporter: which tile, which species, what kind, and whether it is
   * currently gated shut (§6.3).
   *
   * Sent every tick rather than inferred from the event stream, because the event stream
   * only tells a client what happened while it was CONNECTED — reattach mid-game (§3.7
   * makes that a first-class case) and you would see an empty membrane on a cell full of
   * transporters. State that the player can act on has to be state, not history.
   */
  transporters: Array<{
    tile: number;
    species: number;
    kind: string;
    closed: boolean;
    /**
     * §9.4 — 1 is freshly folded, 0 is denatured and gone. Drawn as wear, so the cell shows
     * what is ABOUT to fail rather than only what already has.
     */
    integrity: number;
    /**
     * Signed amount/s, positive = export.
     *
     * §6.1's central lesson is invisible without a rate: "a passive transporter looks SLOW
     * near equilibrium and FAST with a steep gradient — because net flux literally depends
     * on the gradient, not because its intrinsic speed changed." A player who cannot see
     * the rate cannot learn that, and cannot tell a working channel from a stalled one.
     */
    flux: number;
  }>;

  /**
   * Enzymes floating in the cytoplasm (§9.2 step 5: "released into the cytoplasm, where it
   * floats and works wherever substrate is").
   *
   * These were not on the wire at all, so the single most important thing a player builds
   * — the thing that turns the ATP curve around — was invisible on screen. `occupied` is
   * the active site holding a substrate (§8.1), which is what makes a working enzyme look
   * busy rather than merely present.
   */
  enzymes: Array<{ tile: number; occupied: boolean; integrity: number }>;

  /**
   * §9.5 — the ribosomes, and what each is currently building.
   *
   * `reach` rides along so the client can draw the coverage circle: siting a ribosome is
   * the decision the whole mechanic is about, and it cannot be made against an invisible
   * radius.
   */
  ribosomes: Array<{
    tile: number;
    job: string | null;
    progress: number;
    blockedOn: string | null;
  }>;
  /** Tiles a ribosome senses and reaches. Constant, but the client must not hardcode it. */
  ribosomeReach: number;
  /**
   * §9.4 — proteins that have denatured past use since the last frame.
   *
   * `covered` says whether ANY ribosome can reach this tile. An uncovered vacancy is never
   * going to be repaired, and before this field existed the client could not tell the two
   * cases apart: the ring looked the same whether a ribosome was on its way or nothing in
   * the cell would ever come. Playtested as a hard lock — the last flagellum denatured on
   * a membrane tile outside every ribosome's reach, the cell could no longer swim to a
   * deposit, and without residues it could not hand-fold a replacement either. Silent, and
   * permanent. See §9.5b.
   */
  vacancies: Array<{ tile: number; gene: string; covered: boolean }>;

  /**
   * §9.6 — what the ribosomes have been asked for, and what they have finished.
   *
   * `orders` is the queue in service order; `pending` is folded and waiting for the player
   * to carry and site. A ribosome knows where a REPAIR goes and cannot know where you want
   * something new, so that decision stays yours (§6.7).
   */
  orders: Array<{ gene: string; residue: string | null }>;
  pending: Array<{ gene: string; residue: string | null }>;

  /**
   * §10A.9 — every stock the seeker compares, lowest first.
   *
   * Just counts: residues from the inventory, glucose particles inside the cell. Sent so
   * the client can show the ranking, not so it can recompute the choice — the sim decides.
   */
  scarcity: Array<{ species: number; name: string; count: number }>;

  /**
   * §9.5 — the cell cannot move and nothing is fixing that.
   *
   * Promoted to a top-level flag rather than left for the client to infer, because it is
   * the one failure that removes the player's ability to recover from it: with no
   * flagellum you cannot reach a deposit, and with no residues you cannot fold a
   * flagellum. It needs to be stated, not deduced.
   */
  stranded: boolean;

  /**
   * §10A — where the cell is in the world, where it is going, and what that costs.
   *
   * `atpPerSecond` is here rather than left to be inferred because §10A.1's tension only
   * exists if the player can see the bill: "swimming is expensive and competes directly
   * with construction for ATP". A cost you cannot read is not a trade you can make.
   */
  motility: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    heading: number | null;
    chemotaxis: number | null;
    /** §10A.9 — the cell is choosing its own target. */
    autoSeek: boolean;
    /** Flagella wanted to fire and the cell could not pay. */
    stalled: boolean;
    /**
     * Which way the body is pointing, in radians (§10A.1a). Flagella are welded to the
     * membrane and turn with it, so the client must rotate them by this or they will be
     * drawn where they no longer are — and the cell will appear to swim sideways.
     */
    facing: number;
    atpPerSecond: number;
    flagella: Array<{ tile: number; dx: number; dy: number; firing: boolean }>;
  };

  /**
   * §10A.2 — the terrain within sight, in world coordinates, so the client can draw where
   * food actually is rather than only what has already diffused up against the membrane.
   */
  /**
   * §5a — the countable matter inside the cell.
   *
   * These are real simulation entities, not render hints: `id` is stable for the lifetime
   * of the grain, so the client can track one, hover it, and watch it be consumed. That is
   * the difference between this and the dot cloud it replaces — a dot was whatever the
   * renderer chose that frame and could not be pointed at.
   *
   * Sent as JSON with the scalars rather than in a binary field frame because there are
   * ~85–135 of them, they carry identity rather than density, and being able to read them
   * in devtools is worth more than the bytes.
   */
  grains: Array<{
    id: number;
    species: number;
    x: number;
    y: number;
    amount: number;
  }>;

  /** §5a — what the nanobot is carrying. Construction draws residues from here only. */
  satchel: { items: Array<{ id: number; species: number; amount: number }>; capacity: number };

  patches: Array<{
    x: number;
    y: number;
    radius: number;
    species: number;
    richness: number;
    hostile: boolean;
    /**
     * How close the cell must be for a transporter to draw from this deposit (§5b).
     *
     * On the wire because the client draws it as a ring — "am I in range" has to be a
     * question the picture answers. It used to be an invisible gaussian threshold, and a
     * channel aimed at a deposit the player could see did nothing, silently.
     */
    harvestRadius: number;
    /**
     * What is left, as a COUNT of particles rather than a fraction.
     *
     * A percentage cannot answer "will this last me" — it hides how big the thing was to
     * begin with, so a 77% deposit and a 77% deposit ten times the size read identically.
     * A count is the number a player actually reasons with, and it is what makes "the
     * source ran out" distinguishable from "my channel died", which a percentage does not.
     */
    remaining: number;
  }>;
}

export type EventKind =
  | 'lysed'
  | 'blebbed'
  | 'transporterPlaced'
  | 'enzymePlaced'
  /**
   * §10A.1. Distinct from `transporterPlaced` even though both seat a protein in a
   * membrane tile: a flagellum is not a pore, it does not gate, and the client marks and
   * describes the two differently. Collapsing them was the second instance of a deploy
   * event being inferred rather than carried — see the `deploy` handler.
   */
  | 'flagellumPlaced'
  /** §9.5 — the machine that retires hand-assembly is sited. */
  | 'ribosomePlaced'
  | 'glucoseCracked'
  | 'geneSelected'
  /** One per peptide bond — §9.2's click-clack, so each bead can land with feedback. */
  | 'residuePlaced'
  | 'folded'
  | 'deployRefused'
  | 'gated'
  /** §9.6 — a queued protein was finished and is waiting to be sited. */
  | 'orderReady'
  /** The cell was started over (§15.11). */
  | 'reset';

export interface EventMsg {
  t: 'event';
  tick: number;
  kind: EventKind;
  tile?: number;
  /**
   * Why a refusal happened. The sim already computes a precise, player-readable reason
   * for every refused deploy ("the nanobot is too far from that membrane tile") and the
   * server used to discard it in favour of one generic sentence that guessed. Carrying it
   * costs a few bytes on a rare message and turns "it just doesn't work" into an
   * instruction.
   */
  reason?: string;
}

export type ServerMsg = HelloMsg | ScalarsMsg | EventMsg;

/**
 * Bumped to 2 when the generic `amino` species was replaced by the five typed residues
 * (§5) and the §9.2 construction pipeline arrived. Species ids are stable within a
 * version; renumbering always requires a bump.
 */
export const PROTOCOL_VERSION = 4;
