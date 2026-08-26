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

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { constants } from '@protocell/sim';
import type { ClientMsg } from '@protocell/protocol';
import { Game, type Client } from './game.js';
import { GameRegistry, MAX_LIVE_GAMES } from './registry.js';

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

const http = createServer();
const wss = new WebSocketServer({ server: http });

wss.on('connection', (socket, req) => {
  // `?game=<id>` for now. Google sign-in replaces this with the id on the authenticated
  // session — a client naming its own game is fine for a local sandbox and is not
  // authorisation.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = (url.searchParams.get('game') ?? DEFAULT_GAME).slice(0, 64);

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
