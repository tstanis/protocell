/**
 * The simulation server. SPEC.md §3.7, §15.3, §15.6.
 *
 * Owns the clock and all state. Ticks whether or not anyone is watching — which is not a
 * technicality but the literal thesis of §2.3: being alive is the ongoing act of paying
 * to stay out of equilibrium, and it does not pause because you closed the tab.
 *
 * Clients connect, subscribe to a VIEW (region + resolution + species), and receive
 * downsampled binary field frames plus JSON scalars. They send commands back. That is the
 * entire surface: a renderer cannot reach into sim state because it is in another process.
 *
 * This file is now only TRANSPORT. One cell and everything belonging to it lives in
 * `Game`; which cells are ticking lives in `GameRegistry`. What used to be a dozen
 * module-level `let`s was per-cell state that happened to have nowhere else to live, and
 * the server could not host two games because of it.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { constants } from '@protocell/sim';
import type { ClientMsg } from '@protocell/protocol';
import { Game, type Client } from './game.js';
import { AUTOSAVE_S, GameRegistry, MAX_LIVE_GAMES, MAX_RESIDENT_GAMES } from './registry.js';
import { loadStore } from './store.js';
import { StaticFiles } from './static.js';
import {
  beginLogin,
  cellIdFor,
  handleCallback,
  loadAuthConfig,
  logout,
  sessionFrom,
  type Session,
} from './auth.js';

/**
 * Load `.env` before anything reads `process.env`.
 *
 * `process.loadEnvFile` is built into Node (20.12+), so this needs no dotenv dependency.
 * Both locations are tried because `npm run server` sets the working directory to
 * `apps/server` while the natural home for one shared file is the repo root — and a
 * config file that is silently in the wrong place is the worst kind, since the server
 * starts perfectly and merely behaves as though you had configured nothing.
 *
 * Values already in the real environment always win: a `.env` is for local convenience,
 * and in production the platform's own secrets must not be overridable by a file that
 * happened to get deployed.
 */
function loadDotEnv(): string[] {
  const loadedFrom: string[] = [];
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const candidates = [resolve(root, '.env'), resolve(process.cwd(), '.env')];
  // Deduped, because `npm run server` from the repo root makes both paths the same file
  // and loading it twice would report two config sources that are one.
  for (const file of [...new Set(candidates)]) {
    try {
      process.loadEnvFile(file);
      loadedFrom.push(file);
    } catch {
      // Absent or unreadable. Both are fine — every variable has a default or is optional.
    }
  }
  return loadedFrom;
}
const dotEnvFiles = loadDotEnv();

const PORT = Number(process.env['PORT'] ?? 8787);
const SEND_HZ = Number(process.env['SEND_HZ'] ?? 30);

/**
 * The cell a client gets when it does not name one.
 *
 * Keeps `npm run client` against `npm run server` behaving exactly as it always has —
 * one cell, no lobby, no sign-in. Once Google accounts land the id comes from the
 * authenticated session instead, and this becomes the anonymous sandbox.
 */
const DEFAULT_GAME = process.env['DEFAULT_GAME'] ?? 'solo';

/**
 * The built client, served from this same origin in production (§15.10).
 *
 * Absent in development — vite serves it on :5173 — so a missing dist is normal rather
 * than an error, and the server simply does not serve static files.
 */
const clientDir =
  process.env['CLIENT_DIR'] ?? fileURLToPath(new URL('../../client/dist', import.meta.url));
const statics = new StaticFiles(clientDir);

const store = loadStore();
const games = new GameRegistry(store);

/**
 * Null when GOOGLE_CLIENT_ID is unset, which is a supported state: the server then
 * behaves exactly as it did before — anonymous, `?game=<id>`, no sign-in. See auth.ts.
 */
const auth = loadAuthConfig();

/**
 * Browser origins allowed to call the auth endpoints with credentials.
 *
 * A wildcard is not an option here. `Access-Control-Allow-Credentials` with
 * `Allow-Origin: *` is rejected by every browser precisely because it would let any site
 * read a signed-in user's session, so the list is explicit.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env['ALLOWED_ORIGINS'] ?? auth?.appOrigin ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
}

// ── the clock ────────────────────────────────────────────────────────────────

let last = process.hrtime.bigint();

function tickLoop(): void {
  const now = process.hrtime.bigint();
  const elapsed = Number(now - last) / 1e9;
  last = now;
  // Only live games. A frozen cell is not stepped at all — see GameRegistry for why that
  // is necessary and what it costs.
  for (const g of games.liveGames()) g.advance(elapsed);
}

setInterval(tickLoop, 1000 / 240);

setInterval(() => {
  for (const g of games.liveGames()) g.flush();
}, 1000 / SEND_HZ);

// ── connections ──────────────────────────────────────────────────────────────

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', auth?.origin ?? `http://localhost:${PORT}`);
  cors(req, res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204);
    res.end();
    return;
  }

  // Liveness, for the platform's probe. Deliberately does NOT report on storage or
  // sign-in: a health check that fails when a dependency wobbles makes the platform kill
  // and restart a server that was serving everybody perfectly well, turning a partial
  // outage into a total one.
  // NOT `/healthz`: Cloud Run's frontend intercepts that exact path and returns its own
  // 404, so the request never reaches the container. Verified against the deployed
  // service — `/healthz` 404s from Google while `/healthz2` and `/_health` both arrive.
  if (url.pathname === '/_health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, games: games.size, live: games.liveCount }));
    return;
  }

  // `whoami` is deliberately available even with auth off, so the client has one shape to
  // code against: it asks who it is, and gets either a user or `signedIn: false`.
  if (url.pathname === '/auth/me') {
    const session = auth ? sessionFrom(auth, req) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        enabled: auth !== null,
        signedIn: session !== null,
        email: session?.email ?? null,
        name: session?.name ?? null,
      }),
    );
    return;
  }

  if (!auth) {
    if (url.pathname.startsWith('/auth/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('sign-in is not configured on this server');
      return;
    }
  } else {

    if (url.pathname === '/auth/google') return beginLogin(auth, res);
    if (url.pathname === '/auth/logout') return logout(auth, res);
    if (url.pathname === '/auth/callback') {
      void handleCallback(auth, req, res, url);
      return;
    }
  }

  void statics.serve(req, res, url.pathname).then((served) => {
    if (served) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
});

/**
 * The upgrade is where a socket earns its cell.
 *
 * With auth configured, an unauthenticated upgrade is refused outright rather than being
 * handed a sandbox — a socket that connects and then cannot do anything is a worse
 * failure than one that does not connect, because the client cannot tell it apart from a
 * server that is down.
 */
const wss = new WebSocketServer({
  server: http,
  verifyClient: (info, done) => {
    if (!auth) return done(true);
    const session = sessionFrom(auth, info.req);
    if (!session) return done(false, 401, 'sign in first');
    // Stash it so the connection handler does not have to parse cookies again.
    (info.req as IncomingMessage & { session?: Session }).session = session;
    done(true);
  },
});

wss.on('connection', (socket, req) => {
  // WHERE THE CELL ID COMES FROM, and it is the whole of the authorisation model.
  //
  // Signed in: the id is derived from the Google subject and the client has no say in it.
  // A `?game=` parameter is ignored entirely rather than merged, because honouring it
  // would let anyone read or drive anyone else's cell simply by naming it — the classic
  // shape of an insecure direct object reference.
  //
  // Not configured: anonymous sandboxes keyed by whatever the client asks for, which is
  // the behaviour this server has always had locally.
  const session = (req as IncomingMessage & { session?: Session }).session;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = session
    ? cellIdFor(session)
    : (url.searchParams.get('game') ?? DEFAULT_GAME).slice(0, 64);

  // Faulting a cold cell in is a `load` from the store, so this is async — and the socket
  // may already be gone by the time it lands, which is normal rather than exceptional.
  void games.openAsync(id).then((game: Game) => {
    if (socket.readyState !== socket.OPEN) {
      games.release(game);
      return;
    }
    attachClient(socket, game);
  }).catch((e: unknown) => {
    // Refuse rather than hand over a blank cell: an empty world would be overwritten by
    // the next autosave, turning a transient storage fault into permanent data loss.
    console.error(`open ${id} failed:`, (e as Error).message);
    socket.close(1011, 'could not load your cell');
  });
});

function attachClient(socket: import('ws').WebSocket, game: Game): void {
  const client: Client = { socket, view: null, game };
  game.clients.add(client);

  socket.send(game.helloFor());
  // Consumed on arrival, so a later reconnect does not re-report a gap already announced.
  game.frozenSeconds = 0;

  socket.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return; // malformed input from a client must never take the sim down
    }
    games.touch(game);
    switch (msg.t) {
      case 'subscribe':
        client.view = msg.view;
        break;
      case 'command':
        game.applyCommand(msg);
        break;
      case 'control':
        game.applyControl(msg);
        break;
    }
  });

  const drop = (): void => {
    game.clients.delete(client);
    games.release(game);
  };
  socket.on('close', drop);
  socket.on('error', drop);
}

/**
 * Autosave: each live cell on its own schedule.
 *
 * Every cell carries its own due time, set on first sight to a random point inside the
 * interval, so the population spreads itself without anyone coordinating. A cell that is
 * not dirty costs nothing to skip and its clock still advances, so an idle cell is written
 * once and then left alone.
 *
 * On failure the next attempt backs off rather than retrying every second — a store that
 * is rate-limiting or down should not be hammered by the thing it is rate-limiting.
 */
setInterval(() => {
  const now = Date.now();
  for (const g of games.liveGames()) {
    if (g.nextSaveAt === 0) {
      g.nextSaveAt = now + Math.random() * AUTOSAVE_S * 1000;
      continue;
    }
    if (now < g.nextSaveAt) continue;
    const wasDirty = g.dirty;
    g.nextSaveAt = now + AUTOSAVE_S * 1000;
    if (wasDirty) {
      void games.save(g).then(() => {
        // Still dirty means the write did not land; wait longer before trying again.
        if (g.dirty) g.nextSaveAt = Date.now() + AUTOSAVE_S * 1000 * 2;
      });
    }
  }
  void games.maintain();
}, 1000);

/**
 * Save everything before exiting.
 *
 * Deploys are frequent and PLANNED, so losing a player's progress to your own rollout is
 * the least excusable kind of data loss. The handler is idempotent because a platform
 * that does not see the process exit will send SIGKILL after its grace period, and a
 * second SIGTERM in the meantime must not start a second flush.
 */
let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const t0 = Date.now();
  const { saved, missed } = await games.saveAll();
  console.log(`${sig} — saved ${saved} cells in ${Date.now() - t0} ms` + (missed ? `, ${missed} MISSED` : ''));
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => void shutdown(sig));
}

// Pay the token exchange and TLS handshake now: measured, the first GCS write costs
// ~2 s and the fourth ~200 ms, and there is no reason for a player to absorb that.
if (store.warm) {
  void store.warm().catch((e: unknown) => console.error(`  ! storage warm-up failed: ${(e as Error).message}`));
}

http.listen(PORT, () => {
  // With sign-in on, every cell is `u:<sub>` and the anonymous default is unreachable —
  // so creating it would tick a cell nobody can ever visit, at 5.5% of a core, forever.
  const g = auth ? new Game('__probe__') : games.open(DEFAULT_GAME);
  console.log(`protocell sim server on ws://localhost:${PORT}`);
  for (const f of dotEnvFiles) console.log(`  config from ${f}`);
  console.log(`  world ${g.world.grid.width}×${g.world.grid.height}, cell R=${g.world.radius.toFixed(1)}`);
  console.log(`  cytoplasm ${g.world.cyto.tileCount} tiles, membrane ${g.world.membraneTiles}`);
  console.log(`  sim ${constants.SIM_HZ} Hz, sending ${SEND_HZ} Hz`);
  console.log(`  up to ${MAX_LIVE_GAMES} cells ticking, ${MAX_RESIDENT_GAMES} resident; default cell "${DEFAULT_GAME}"`);
  console.log(`  storage: ${store.kind}, autosave every ${AUTOSAVE_S}s (staggered)`);
  console.log(`  client:  ${clientDir}`);
  if (auth) {
    console.log(`  Google sign-in ON — one cell per account`);
    console.log(`    redirect URI (must match Google exactly): ${auth.origin}/auth/callback`);
    console.log(`    app origin: ${auth.appOrigin}`);
  } else {
    console.log(`  Google sign-in OFF (set GOOGLE_CLIENT_ID) — anonymous ?game=<id>`);
  }
  console.log(`  ticking with 0 clients attached — §2.3`);
});

// A heartbeat proving the sim runs unattended (§3.7). Also the fastest way to see that a
// disconnect did not perturb anything.
setInterval(() => {
  let attached = 0;
  for (const g of games.all()) attached += g.clients.size;
  const rows = [...games.liveGames()]
    .slice(0, 4)
    .map(
      (g) =>
        `${g.id}: t=${g.clock.simTime.toFixed(0)}s ATP=${g.world.atp.toFixed(0)} ` +
        `vol=${g.world.cyto.volume.toFixed(0)}${g.clock.droppedSteps ? ` dropped=${g.clock.droppedSteps}` : ''}`,
    );
  console.log(
    `games=${games.size} live=${games.liveCount} clients=${attached}` +
      (rows.length ? ` | ${rows.join(' | ')}` : ''),
  );
}, 10_000);
