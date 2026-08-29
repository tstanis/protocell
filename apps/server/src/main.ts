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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { constants } from '@protocell/sim';
import type { ClientMsg } from '@protocell/protocol';
import { Game, type Client } from './game.js';
import { GameRegistry, MAX_LIVE_GAMES } from './registry.js';
import {
  beginLogin,
  cellIdFor,
  handleCallback,
  loadAuthConfig,
  logout,
  sessionFrom,
  type Session,
} from './auth.js';

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

const games = new GameRegistry();

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
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('sign-in is not configured on this server');
    return;
  }

  if (url.pathname === '/auth/google') return beginLogin(auth, res);
  if (url.pathname === '/auth/logout') return logout(auth, res);
  if (url.pathname === '/auth/callback') {
    void handleCallback(auth, req, res, url);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
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

  const game: Game = games.open(id);
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
});

http.listen(PORT, () => {
  const g = games.open(DEFAULT_GAME);
  console.log(`protocell sim server on ws://localhost:${PORT}`);
  console.log(`  world ${g.world.grid.width}×${g.world.grid.height}, cell R=${g.world.radius.toFixed(1)}`);
  console.log(`  cytoplasm ${g.world.cyto.tileCount} tiles, membrane ${g.world.membraneTiles}`);
  console.log(`  sim ${constants.SIM_HZ} Hz, sending ${SEND_HZ} Hz`);
  console.log(`  up to ${MAX_LIVE_GAMES} cells ticking at once; default cell "${DEFAULT_GAME}"`);
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
