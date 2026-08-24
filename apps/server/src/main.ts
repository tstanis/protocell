/**
 * The simulation server. SPEC.md §3.7, §15.3.
 *
 * Owns the clock and all state. Ticks whether or not anyone is watching — which is not a
 * technicality but the literal thesis of §2.3: being alive is the ongoing act of paying
 * to stay out of equilibrium, and it does not pause because you closed the tab.
 *
 * Clients connect, subscribe to a VIEW (region + resolution + species), and receive
 * downsampled binary field frames plus JSON scalars. They send commands back. That is the
 * entire surface: a renderer cannot reach into sim state because it is in another process.
 */

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  Clock,
  SPECIES,

  World,
  constants,
  carrier,
  channel,
  pump,
  Enzyme,
  atpCost,
  membraneTiles,
  gateTiles,
  GENES,
  RIBOSOME_REACH,
  grainUnit,
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

const PORT = Number(process.env['PORT'] ?? 8787);
const SEND_HZ = Number(process.env['SEND_HZ'] ?? 30);

/**
 * Drop a client's frame rather than queueing when its socket is congested (§15.3).
 * A slow client must never stall the simulation, and a backlog of stale field frames is
 * worthless anyway — the next one supersedes it entirely.
 */
const BACKPRESSURE_BYTES = 1 << 20;

const world = new World();
const clock = new Clock();

/** The real membrane ring, sent to clients so they never have to infer it. See HelloMsg. */
const membraneTileList = membraneTiles(world.grid);
const gateTileList = gateTiles(world.grid);

let paused = false;
let speed = 1;
let stepsRequested = 0;
/**
 * ATP/s currently being wasted at the pool ceiling, smoothed.
 *
 * Per-step dissipation is spiky (it fires only on the ticks an enzyme completes), so the
 * raw number flickers uselessly. A running average is what a player can actually read.
 */
let dissipatedRate = 0;
/** ATP/s currently going into thrust, smoothed the same way. */
let swimRate = 0;
const pending: EventMsg[] = [];

interface Client {
  socket: WebSocket;
  view: ViewSpec | null;
}
const clients = new Set<Client>();

function emit(kind: EventMsg['kind'], tile?: number, reason?: string): void {
  const ev: EventMsg = { t: 'event', tick: world.tick, kind };
  if (tile !== undefined) ev.tile = tile;
  if (reason !== undefined) ev.reason = reason;
  pending.push(ev);
}

// ── the clock ────────────────────────────────────────────────────────────────

let last = process.hrtime.bigint();

function tickLoop(): void {
  const now = process.hrtime.bigint();
  const elapsed = Number(now - last) / 1e9;
  last = now;

  if (paused) {
    // Honour any single-step requests so the client can inspect a tick at a time.
    while (stepsRequested > 0) {
      stepsRequested--;
      const s = world.step();
      if (s.lysedThisStep) emit('lysed');
      if (s.cracked > 0) emit('glucoseCracked');
    }
  } else {
    clock.pump(Math.min(elapsed, 0.25) * speed, () => {
      const s = world.step();
      // Exponential average over ~1 s of sim time.
      dissipatedRate += (s.dissipated / constants.SIM_DT - dissipatedRate) * constants.SIM_DT;
      swimRate += (s.atpSpentSwimming / constants.SIM_DT - swimRate) * constants.SIM_DT;
      if (s.lysedThisStep) emit('lysed');
      // §9.2's click-clack: one event per bead, so each bond can land with feedback.
      if (s.placed) emit('residuePlaced');
      if (s.folded) emit('folded');
    });
  }
}

setInterval(tickLoop, 1000 / 240);

// ── sending ──────────────────────────────────────────────────────────────────

const scratch = new Float32Array(world.grid.tileCount);

function sendView(c: Client): void {
  const view = c.view;
  if (!view || c.socket.readyState !== c.socket.OPEN) return;
  if (c.socket.bufferedAmount > BACKPRESSURE_BYTES) return; // §15.3 backpressure

  const { grid } = world;
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
    world.concentrationPlane(s, scratch);

    const cropped = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        cropped[y * w + x] = scratch[(y0 + y) * grid.width + (x0 + x)]!;
      }
    }
    const ds = downsample(cropped, w, h, lod);
    outW = ds.width;
    outH = ds.height;
    planes.push(ds.data);
  }

  if (planes.length === 0) return;

  const data = new Float32Array(planes.length * outW * outH);
  planes.forEach((p, i) => data.set(p, i * outW * outH));

  c.socket.send(
    encodeFieldFrame({
      tick: world.tick,
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

function sendScalars(c: Client): void {
  if (c.socket.readyState !== c.socket.OPEN) return;
  const b = world.build;
  const msg: ScalarsMsg = {
    t: 'scalars',
    tick: world.tick,
    alpha: clock.alpha,
    atp: world.atp,
    atpCapacity: world.atpCapacity,
    atpDissipated: dissipatedRate,
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
      atpPerSecond: swimRate,
      flagella: world.flagella.map((f) => ({ tile: f.tile, dx: f.dx, dy: f.dy, firing: f.firing })),
    },
    grains: world.grains.grains.map((g) => ({
      id: g.id,
      species: g.species,
      x: g.x,
      y: g.y,
      amount: g.amount,
    })),
    satchel: {
      items: world.bot.inventory.map((g) => ({ id: g.id, species: g.species, amount: g.amount })),
      capacity: 8,
    },
    patches: world.patches.patches.map((p) => ({
      x: p.x, y: p.y, radius: p.radius, species: p.species,
      richness: p.richness, hostile: p.hostile === true, harvestRadius: p.harvestRadius,
      remaining: Math.round((p.richness * p.reserve) / grainUnit(p.species)),
    })),
  };
  c.socket.send(JSON.stringify(msg));
}

setInterval(() => {
  const events = pending.splice(0, pending.length);
  for (const c of clients) {
    sendView(c);
    sendScalars(c);
    for (const e of events) {
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(e));
    }
  }
}, 1000 / SEND_HZ);

// ── commands ─────────────────────────────────────────────────────────────────

function applyCommand(msg: Extract<ClientMsg, { t: 'command' }>): void {
  const cmd = msg.cmd;
  switch (cmd.op) {
    case 'placeTransporter': {
      const make =
        cmd.kind === 'channel'
          ? () => channel(cmd.species, constants.P_CHANNEL_GLUCOSE)
          : cmd.kind === 'carrier'
            ? () => carrier(cmd.species)
            : () => pump(cmd.species, 1, 1, 0.5);
      world.transporters.set(cmd.tile, make());
      emit('transporterPlaced', cmd.tile);
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
      for (const tile of tiles) emit('transporterPlaced', tile);
      break;
    }
    case 'placeEnzyme': {
      const e = cmd.tile === undefined ? world.buildEnzyme() : world.buildEnzyme(cmd.tile);
      emit('enzymePlaced', e.tile);
      break;
    }
    case 'moveTo':
      world.bot.moveTo(cmd.x, cmd.y);
      break;

    case 'selectGene': {
      // The server re-checks that the bot is at the nucleus. Every predicate the UI gates
      // on is re-evaluated here, because a client asking nicely is not authorisation.
      const res = world.selectGene(cmd.gene as GeneId, cmd.residue as AminoType | undefined);
      if (res.ok) emit('geneSelected');
      break;
    }

    case 'pickUp': {
      const r = world.pickUp(cmd.grain);
      if (!r.ok) emit('deployRefused', undefined, r.reason);
      break;
    }
    case 'dropGrain': {
      world.dropGrain(cmd.grain);
      break;
    }
    case 'deploy': {
      // Capture what is being deployed BEFORE deploying, because a successful deploy
      // clears the build. The previous version inferred it afterwards from
      // `enzymes.length > 0`, which is true for every protein built after the first
      // enzyme — so every later transporter reported itself as an enzyme, the client
      // never marked it, and a correctly seated carrier looked like a no-op.
      const kind = world.build.gene?.product.kind;
      const res = cmd.tile === undefined ? world.deploy() : world.deploy(cmd.tile);
      if (res.ok) {
        // Three products, three events. Mapping flagellum onto `transporterPlaced` was
        // the same mistake in a new place: the client marked the tile as a pore, offered
        // to gate it, and announced "Transporter seated" for a motor.
        emit(
          kind === 'enzyme' ? 'enzymePlaced'
          : kind === 'flagellum' ? 'flagellumPlaced'
          : kind === 'ribosome' ? 'ribosomePlaced'
          : 'transporterPlaced',
          cmd.tile,
        );
      } else {
        emit('deployRefused', undefined, res.reason);
      }
      break;
    }

    case 'cancelBuild':
      world.cancelBuild();
      break;

    case 'gate': {
      // §6.3. Free and instant — a gate is a conformational change, not construction.
      const t = world.transporters.get(cmd.tile);
      if (t) {
        t.closed = !cmd.open;
        emit('gated', cmd.tile);
      }
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
      // The server re-checks the tension predicate; a client cannot bleb by asking nicely.
      if (world.bleb()) emit('blebbed');
      break;
    case 'debugAdd':
      world.grid.add(cmd.species, cmd.tile, cmd.amount);
      break;
  }
}

// ── connections ──────────────────────────────────────────────────────────────

const http = createServer();
const wss = new WebSocketServer({ server: http });

wss.on('connection', (socket) => {
  const client: Client = { socket, view: null };
  clients.add(client);

  socket.send(
    JSON.stringify({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      worldWidth: world.grid.width,
      worldHeight: world.grid.height,
      simHz: constants.SIM_HZ,
      species: Object.fromEntries(SPECIES.map((n, i) => [i, n])),
      membraneTiles: membraneTileList,
      gateTiles: gateTileList,
      cellRadius: world.radius,
    }),
  );

  socket.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return; // malformed input from a client must never take the sim down
    }
    switch (msg.t) {
      case 'subscribe':
        client.view = msg.view;
        break;
      case 'command':
        applyCommand(msg);
        break;
      case 'control':
        if (msg.op === 'pause') paused = true;
        else if (msg.op === 'resume') paused = false;
        else if (msg.op === 'step') stepsRequested += msg.value ?? 1;
        else if (msg.op === 'speed') speed = Math.max(0, Math.min(8, msg.value ?? 1));
        break;
    }
  });

  socket.on('close', () => clients.delete(client));
  socket.on('error', () => clients.delete(client));
});

http.listen(PORT, () => {
  console.log(`protocell sim server on ws://localhost:${PORT}`);
  console.log(`  world ${world.grid.width}×${world.grid.height}, cell R=${world.radius.toFixed(1)}`);
  console.log(`  cytoplasm ${world.cyto.tileCount} tiles, membrane ${world.membraneTiles}`);
  console.log(`  sim ${constants.SIM_HZ} Hz, sending ${SEND_HZ} Hz`);
  console.log(`  ticking with 0 clients attached — §2.3`);
});

// A heartbeat proving the sim runs unattended (§3.7). Also the fastest way to see that a
// disconnect did not perturb anything.
setInterval(() => {
  console.log(
    `t=${clock.simTime.toFixed(0)}s tick=${world.tick} clients=${clients.size} ` +
      `ATP=${world.atp.toFixed(1)} vol=${world.cyto.volume.toFixed(0)} ` +
      `tension=${world.cyto.tension.toFixed(2)}${clock.droppedSteps ? ` dropped=${clock.droppedSteps}` : ''}`,
  );
}, 10_000);


