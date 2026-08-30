/**
 * One cell, and everything that belongs to it. SPEC.md §3.7, §15.6.
 *
 * The server used to hold exactly one `World` in a module-level `const`, along with its
 * clock, its pause flag, its smoothed ATP rates, its pending event queue and its client
 * set. That is the right shape for a single local game and it cannot host two, because
 * every one of those globals is per-cell state that happened to have nowhere else to live.
 *
 * A `Game` is that state given a home. Nothing here is new behaviour — it is the same
 * simulation, the same tick body and the same frame assembly, scoped to an instance.
 *
 * ── Ticking is not free, and that is the whole hosting problem ───────────────
 * Measured: **0.46 ms per step, so 55 ms of CPU per wall-second per live cell — 5.5% of
 * one core.** About 18 cells per core saturated, 12 with headroom.
 *
 * §2.3 makes it a point of principle that the simulation runs whether or not anyone is
 * watching. That is a lovely property of a local game and a ruinous hosting policy: every
 * account that ever signs up would cost 5.5% of a core forever. So a game can be FROZEN —
 * it keeps all its state and simply stops stepping (see `GameRegistry`).
 *
 * The obvious escape does not work, and it is worth recording why. Because the sim is
 * deterministic (§3.7), a frozen cell could in principle be fast-forwarded on reconnect.
 * But catch-up costs the same 5.5% of a core per second of absence: a ten-minute gap is
 * **33 seconds of compute** and an hour is **3.3 minutes**. There is no replaying the gap.
 * A frozen cell resumes exactly where it stopped, and the client is told how long it was
 * out so it can say so rather than quietly losing time.
 */

import { WebSocket } from 'ws';
import {
  Clock,
  SPECIES,
  World,
  constants,
  carrier,
  channel,
  pump,
  atpCost,
  membraneTiles,
  gateTiles,
  GENES,
  RIBOSOME_REACH,
  type AminoType,
  type GeneId,
} from '@protocell/sim';
import {
  PROTOCOL_VERSION,
  downsample,
  encodeFieldFrame,
  type ClientMsg,
  type EventMsg,
  type ScalarsMsg,
  type ViewSpec,
} from '@protocell/protocol';

/**
 * Drop a client's frame rather than queueing when its socket is congested (§15.3).
 * A slow client must never stall the simulation, and a backlog of stale field frames is
 * worthless anyway — the next one supersedes it entirely.
 */
const BACKPRESSURE_BYTES = 1 << 20;

export interface Client {
  socket: WebSocket;
  view: ViewSpec | null;
  game: Game;
}

export class Game {
  readonly id: string;
  readonly world = new World();
  readonly clock = new Clock();

  /** The real membrane ring, sent to clients so they never have to infer it (§16.3). */
  readonly membraneTileList: number[];
  readonly gateTileList: number[];

  paused = false;
  speed = 1;
  stepsRequested = 0;

  /**
   * ATP/s wasted at the pool ceiling, smoothed. Per-step dissipation fires only on the
   * ticks an enzyme completes, so the raw number flickers uselessly (§8.2a).
   */
  dissipatedRate = 0;
  /** ATP/s going into thrust, smoothed the same way. */
  swimRate = 0;

  readonly pending: EventMsg[] = [];
  readonly clients = new Set<Client>();

  /** Wall-clock ms of the last client activity. The LRU key. */
  lastActiveAt = Date.now();
  /** While false the cell keeps all its state and simply does not step. */
  live = true;
  /** When it was frozen, so a returning player can be told how long they were out. */
  frozenAt: number | null = null;
  /** Seconds the cell spent frozen since it was last thawed. */
  frozenSeconds = 0;

  /**
   * The tick this cell was last written at, so an unchanged cell is never rewritten.
   *
   * Bytes are free and requests are not (§15.9), and a frozen cell would otherwise be
   * saved identically on every autosave sweep forever. -1 means "never saved", which is
   * distinct from "saved at tick 0" — a brand new cell that has not stepped still needs
   * its first write.
   */
  savedAtTick = -1;

  get dirty(): boolean {
    return this.world.tick !== this.savedAtTick;
  }

  private readonly scratch: Float32Array;

  constructor(id: string) {
    this.id = id;
    this.membraneTileList = membraneTiles(this.world.grid);
    this.gateTileList = gateTiles(this.world.grid);
    this.scratch = new Float32Array(this.world.grid.tileCount);
  }

  emit(kind: EventMsg['kind'], tile?: number, reason?: string): void {
    const ev: EventMsg = { t: 'event', tick: this.world.tick, kind };
    if (tile !== undefined) ev.tile = tile;
    if (reason !== undefined) ev.reason = reason;
    this.pending.push(ev);
  }

  // ── the clock ──────────────────────────────────────────────────────────────

  /**
   * Advance by `elapsed` wall-seconds. A frozen game is not called at all.
   *
   * The 0.25 s clamp is a stall guard: after a long pause — a laptop lid, a GC hitch, the
   * event loop blocked by another game — `elapsed` can be enormous, and pumping it whole
   * would try to catch up thousands of steps in one turn and stall the loop further.
   */
  advance(elapsed: number): void {
    if (this.paused) {
      // Honour single-step requests so a client can inspect a tick at a time.
      while (this.stepsRequested > 0) {
        this.stepsRequested--;
        const s = this.world.step();
        if (s.lysedThisStep) this.emit('lysed');
        if (s.cracked > 0) this.emit('glucoseCracked');
      }
      return;
    }
    this.clock.pump(Math.min(elapsed, 0.25) * this.speed, () => {
      const s = this.world.step();
      // Exponential average over ~1 s of sim time.
      this.dissipatedRate += (s.dissipated / constants.SIM_DT - this.dissipatedRate) * constants.SIM_DT;
      this.swimRate += (s.atpSpentSwimming / constants.SIM_DT - this.swimRate) * constants.SIM_DT;
      if (s.lysedThisStep) this.emit('lysed');
      // §9.2's click-clack: one event per bead, so each bond can land with feedback.
      if (s.placed) this.emit('residuePlaced');
      if (s.folded) this.emit('folded');
    });
  }

  // ── sending ────────────────────────────────────────────────────────────────

  helloFor(): string {
    return JSON.stringify({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      worldWidth: this.world.grid.width,
      worldHeight: this.world.grid.height,
      simHz: constants.SIM_HZ,
      species: Object.fromEntries(SPECIES.map((n, i) => [i, n])),
      membraneTiles: this.membraneTileList,
      gateTiles: this.gateTileList,
      cellRadius: this.world.radius,
      gameId: this.id,
      // §15.6 — how long this cell was frozen, so the client can say so. Silently
      // resuming after an hour away would read as the sim having lost time.
      frozenSeconds: Math.round(this.frozenSeconds),
    });
  }

  sendView(c: Client): void {
    const view = c.view;
    if (!view || c.socket.readyState !== c.socket.OPEN) return;
    if (c.socket.bufferedAmount > BACKPRESSURE_BYTES) return; // §15.3 backpressure

    const { grid } = this.world;
    const x0 = Math.max(0, Math.min(grid.width - 1, view.x));
    const y0 = Math.max(0, Math.min(grid.height - 1, view.y));
    const w = Math.max(1, Math.min(grid.width - x0, view.w));
    const h = Math.max(1, Math.min(grid.height - y0, view.h));
    const lod = Math.max(1, view.lod);

    const planes: Float32Array[] = [];
    let outW = 0;
    let outH = 0;

    for (const s of view.species) {
      // CONCENTRATION, not amount — §7.1 makes volume the denominator, and the renderer
      // must see what the physics sees.
      this.world.concentrationPlane(s, this.scratch);

      const cropped = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          cropped[y * w + x] = this.scratch[(y0 + y) * grid.width + (x0 + x)]!;
        }
      }
      const ds = downsample(cropped, w, h, lod);
      outW = ds.width;
      outH = ds.height;
      planes.push(ds.data);
    }

    if (planes.length === 0) return;

    const data = new Float32Array(planes.length * outW * outH);
    planes.forEach((pl, i) => data.set(pl, i * outW * outH));

    c.socket.send(
      encodeFieldFrame({
        tick: this.world.tick,
        lod,
        width: outW,
        height: outH,
        originX: x0,
        originY: y0,
        speciesIds: view.species,
        data,
      }),
    );
  }

  sendScalars(c: Client): void {
    if (c.socket.readyState !== c.socket.OPEN) return;
    const world = this.world;
    const b = world.build;
    const msg: ScalarsMsg = {
      t: 'scalars',
      tick: world.tick,
      alpha: this.clock.alpha,
      atp: world.atp,
      atpCapacity: world.atpCapacity,
      atpDissipated: this.dissipatedRate,
      osmolarity: world.osmoticBreakdown(),
      tension: world.cyto.tension,
      volume: world.cyto.volume,
      radius: world.cyto.radius,
      health: world.health,
      lysed: world.cyto.lysed,
      brownedOut: 0,
      bot: {
        x: world.bot.x,
        y: world.bot.y,
        carrying: world.bot.carrying !== null,
        atNucleus: world.atNucleus,
      },
      nucleus: world.nucleus,
      build: {
        phase: b.phase,
        gene: b.gene?.id ?? null,
        geneName: b.gene?.name ?? null,
        sequence: b.gene ? [...b.gene.sequence] : [],
        chain: [...b.chain],
        fold: b.fold,
        blockedOn: b.blockedOn,
        atpCost: b.gene ? atpCost(b.gene) : 0,
        productKind: b.gene?.product.kind ?? null,
        residue: b.residue,
      },
      residues: Object.fromEntries(world.residuePool()),
      transporters: [...world.transporters].map(([tile, t]) => ({
        tile,
        species: t.species,
        kind: t.kind,
        closed: t.closed === true,
        flux: t.lastFlux ?? 0,
        integrity: t.integrity,
      })),
      enzymes: world.enzymes.map((e) => ({ tile: e.tile, occupied: e.occupied, integrity: e.integrity })),
      ribosomes: world.ribosomes.map((r) => ({
        tile: r.tile,
        job: r.job?.gene ?? null,
        progress: r.job ? r.job.placed / Math.max(1, GENES[r.job.gene].sequence.length) : 0,
        blockedOn: r.job?.blockedOn ?? null,
      })),
      ribosomeReach: RIBOSOME_REACH,
      vacancies: world.vacancies.map((v) => ({
        tile: v.tile,
        gene: v.gene,
        covered: world.coveredByRibosome(v.tile),
      })),
      stranded: world.stranded(),
      scarcity: world.scarcity(),
      motility: {
        x: world.motility.x,
        y: world.motility.y,
        vx: world.motility.vx,
        vy: world.motility.vy,
        heading: world.motility.heading,
        chemotaxis: world.motility.chemotaxis,
        autoSeek: world.motility.autoSeek,
        stalled: world.motility.stalled,
        facing: world.motility.facing,
        atpPerSecond: this.swimRate,
        flagella: world.flagella.map((f) => ({
          tile: f.tile,
          dx: f.dx,
          dy: f.dy,
          firing: f.firing,
          integrity: f.integrity,
        })),
      },
      satchel: {
        items: world.bot.inventory.map((g) => ({ id: g.id, species: g.species, amount: g.amount })),
        capacity: 8,
      },
      patches: world.patches.patches.map((pt) => ({
        x: pt.x,
        y: pt.y,
        radius: pt.radius,
        species: pt.species,
        richness: pt.richness,
        hostile: pt.hostile === true,
        harvestRadius: pt.harvestRadius,
        remaining: Math.round(pt.reserve * pt.richness),
      })),
      grains: world.grains.grains.map((g) => ({
        id: g.id,
        species: g.species,
        x: g.x,
        y: g.y,
        amount: g.amount,
      })),
    };
    c.socket.send(JSON.stringify(msg));
  }

  /** One send tick: frames, scalars, and whatever events accumulated. */
  flush(): void {
    const events = this.pending.splice(0, this.pending.length);
    for (const c of this.clients) {
      this.sendView(c);
      this.sendScalars(c);
      for (const e of events) {
        if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(e));
      }
    }
  }

  // ── commands ───────────────────────────────────────────────────────────────

  /**
   * Commands are the ONLY channel by which a client affects the simulation (§3.7), and
   * every predicate the UI gates on is re-evaluated here — a client asking nicely is not
   * authorisation.
   */
  applyCommand(msg: Extract<ClientMsg, { t: 'command' }>): void {
    const { world } = this;
    const cmd = msg.cmd;
    switch (cmd.op) {
      case 'placeTransporter': {
        const make =
          cmd.kind === 'channel'
            ? () => channel(cmd.species)
            : cmd.kind === 'carrier'
              ? () => carrier(cmd.species)
              : () => pump(cmd.species, 1, 1, 0.5);
        world.transporters.set(cmd.tile, make());
        this.emit('transporterPlaced', cmd.tile);
        break;
      }
      case 'placeFace': {
        // The face geometry lives with the physics, so the client never has to know which
        // tile is which — it asks for a face and the server resolves it from the same
        // membrane the simulation uses.
        const tiles =
          cmd.face === 'glucose'
            ? world.buildGlucoseChannel()
            : cmd.face === 'amino'
              ? world.buildAminoTransporter()
              : world.buildLactateCarrier();
        for (const tile of tiles) this.emit('transporterPlaced', tile);
        break;
      }
      case 'placeEnzyme': {
        const e = cmd.tile === undefined ? world.buildEnzyme() : world.buildEnzyme(cmd.tile);
        this.emit('enzymePlaced', e.tile);
        break;
      }
      case 'moveTo':
        world.bot.moveTo(cmd.x, cmd.y);
        break;

      case 'selectGene': {
        const res = world.selectGene(cmd.gene as GeneId, cmd.residue as AminoType | undefined);
        if (res.ok) this.emit('geneSelected');
        break;
      }

      case 'pickUp': {
        const r = world.pickUp(cmd.grain);
        if (!r.ok) this.emit('deployRefused', undefined, r.reason);
        break;
      }
      case 'dropGrain': {
        world.dropGrain(cmd.grain);
        break;
      }
      case 'deploy': {
        // Capture what is being deployed BEFORE deploying, because a successful deploy
        // clears the build. Inferring it afterwards from `enzymes.length > 0` reported
        // every later transporter as an enzyme (§16.3).
        const kind = world.build.gene?.product.kind;
        const res = cmd.tile === undefined ? world.deploy() : world.deploy(cmd.tile);
        if (res.ok) {
          this.emit(
            kind === 'enzyme' ? 'enzymePlaced'
            : kind === 'flagellum' ? 'flagellumPlaced'
            : kind === 'ribosome' ? 'ribosomePlaced'
            : 'transporterPlaced',
            cmd.tile,
          );
        } else {
          this.emit('deployRefused', undefined, res.reason);
        }
        break;
      }
      case 'cancelBuild':
        world.cancelBuild();
        break;

      case 'gate': {
        const t = world.transporters.get(cmd.tile);
        if (t) t.closed = !cmd.open;
        break;
      }

      case 'steer':
        world.setHeading(cmd.heading);
        break;

      case 'chemotaxis':
        world.setChemotaxis(cmd.species);
        break;

      case 'autoSeek':
        world.setAutoSeek(cmd.on);
        break;

      case 'bleb':
        // The server re-checks the tension predicate; a client cannot bleb by asking.
        if (world.bleb()) this.emit('blebbed');
        break;

      case 'debugAdd':
        world.grid.add(cmd.species, cmd.tile, cmd.amount);
        break;
    }
  }

  applyControl(msg: Extract<ClientMsg, { t: 'control' }>): void {
    if (msg.op === 'pause') this.paused = true;
    else if (msg.op === 'resume') this.paused = false;
    else if (msg.op === 'step') this.stepsRequested += msg.value ?? 1;
    else if (msg.op === 'speed') this.speed = Math.max(0, Math.min(8, msg.value ?? 1));
  }
}
