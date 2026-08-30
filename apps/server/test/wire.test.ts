/**
 * End-to-end over a real socket. SPEC.md §16.1 — "detachment" and the protocol round-trip.
 *
 * These are the tests that justify the process boundary of §3.7. If a client attaching,
 * subscribing, issuing commands, and vanishing can perturb the simulation, the separation
 * bought nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { decodeFieldFrame, type ScalarsMsg, type ServerMsg } from '@protocell/protocol';

/**
 * A fresh random port per run.
 *
 * A fixed port meant a server left behind by an earlier run kept the port, the new one
 * failed to bind, and every test then talked to the OLD binary — so a passing change
 * looked broken and a stale one looked fine. That has now cost four debugging cycles.
 * Randomising removes the collision entirely instead of relying on cleanup.
 */
const PORT = 9000 + Math.floor(Math.random() * 900);
let server: ChildProcess;

/**
 * Messages that arrived before a test got around to asking for them.
 *
 * THE RACE THIS FIXES. `connect()` used to resolve on 'open', and the caller then attached
 * its own 'message' listener. The server sends `hello` the instant it accepts the socket,
 * so anything arriving in that gap was emitted to an EventEmitter with no listener and
 * dropped on the floor. The test then waited 25 s for a message that had already been and
 * gone. Intermittent by nature — it passed 10/10 alone and failed twice inside a full run,
 * which is exactly the profile that gets mistaken for "the wire tests are flaky".
 *
 * The listener is now attached synchronously inside `connect()`, before the promise
 * resolves, and everything is queued. `waitFor` drains the queue before waiting.
 */
const inbox = new WeakMap<WebSocket, unknown[]>();

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.binaryType = 'arraybuffer';
    const queue: unknown[] = [];
    inbox.set(ws, queue);
    // Attached BEFORE 'open' resolves, so nothing can slip through.
    ws.on('message', (raw: unknown, isBinary: boolean) => {
      try {
        queue.push(isBinary ? decodeFieldFrame(toArrayBuffer(raw)) : (JSON.parse(String(raw)) as ServerMsg));
        // Bounded: scalars arrive at SEND_HZ whether or not a test is currently reading,
        // so an unread socket would otherwise accumulate for the length of the run.
        // Oldest-first eviction is safe because every test reads `hello` immediately.
        if (queue.length > 4096) queue.shift();
      } catch {
        // A malformed frame is a test concern, not a transport one; drop it here.
      }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/**
 * Normalise whatever `ws` hands us into a plain ArrayBuffer.
 *
 * With `binaryType = 'arraybuffer'` Node's ws delivers an ArrayBuffer directly; without
 * it, a pooled Buffer whose `.buffer` is a large shared arena, so it must be sliced by
 * byteOffset/byteLength or you decode a neighbouring message's bytes. Getting this wrong
 * silently yields an empty buffer and looks exactly like "the server never sent anything".
 */
function toArrayBuffer(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;
  const b = raw as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** Wait for the first message satisfying `pred`, or reject after `ms`. */
function waitFor<T>(ws: WebSocket, pred: (m: unknown) => T | null, ms = 25000): Promise<T> {
  // Drain anything that arrived before we started looking. Without this the `hello` sent
  // on connect is unobservable — see `inbox`.
  const queued = inbox.get(ws);
  if (queued) {
    while (queued.length > 0) {
      const hit = pred(queued.shift());
      if (hit !== null) return Promise.resolve(hit);
    }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timed out waiting for message'));
    }, ms);
    const onMsg = (raw: unknown, isBinary: boolean): void => {
      let parsed: unknown;
      try {
        parsed = isBinary ? decodeFieldFrame(toArrayBuffer(raw)) : (JSON.parse(String(raw)) as ServerMsg);
      } catch (err) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // The queue listener has already pushed this; keep it from growing without bound.
      inbox.get(ws)?.pop();
      const hit = pred(parsed);
      if (hit !== null) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(hit);
      }
    };
    ws.on('message', onMsg);
  });
}

beforeAll(async () => {
  server = spawn('npx', ['tsx', 'apps/server/src/main.ts'], {
    // The test owns its environment. Inheriting a developer's .env made these tests fail
    // the moment sign-in was configured locally: the spawned server started demanding
    // auth, refused the unauthenticated upgrade with a 401, and the harness reported
    // "server did not come up" — which is true of the socket and false of the server.
    //
    // Storage is redirected too, so a run never touches a real bucket or a real cell.
    env: {
      ...process.env,
      PORT: String(PORT),
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GCS_BUCKET: '',
      DATA_DIR: join(tmpdir(), `protocell-wire-${process.pid}`),
    },
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  // If the child dies (a bind failure, a crash on boot), fail fast and loudly instead of
  // letting every test time out one by one against nothing.
  let died: string | null = null;
  server.once('exit', (code) => {
    if (code !== 0 && code !== null) died = `sim server exited with code ${code}`;
  });

  // Poll until it accepts connections rather than sleeping a fixed amount.
  for (let i = 0; i < 60; i++) {
    if (died) throw new Error(died);
    try {
      const ws = await connect();
      ws.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`server did not come up on port ${PORT}`);
}, 60_000);

afterAll(() => {
  server?.kill();
});

describe('the wire (§15.3)', () => {
  it('greets a new client with everything it needs to size itself', async () => {
    const ws = await connect();
    const hello = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'hello' ? (m as Extract<ServerMsg, { t: 'hello' }>) : null,
    );
    expect(hello.protocolVersion).toBe(4);
    expect(hello.worldWidth).toBeGreaterThan(0);
    expect(hello.simHz).toBe(120);
    expect(hello.species[0]).toBe('glucose');
    ws.close();
  });

  it('serves a subscribed view as a decodable binary frame', async () => {
    const ws = await connect();
    const hello = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'hello' ? (m as Extract<ServerMsg, { t: 'hello' }>) : null,
    );
    ws.send(
      JSON.stringify({
        t: 'subscribe',
        view: { x: 0, y: 0, w: hello.worldWidth, h: hello.worldHeight, lod: 2, species: [0, 3] },
      }),
    );

    const frame = await waitFor(ws, (m) =>
      typeof m === 'object' && m !== null && 'speciesIds' in m ? (m as ReturnType<typeof decodeFieldFrame>) : null,
    );
    expect(frame.speciesIds).toEqual([0, 3]);
    expect(frame.lod).toBe(2);
    expect(frame.data.length).toBe(2 * frame.width * frame.height);
    expect(frame.width).toBeCloseTo(hello.worldWidth / 2, 0);
    ws.close();
  });

  it('changing lod is just a new subscription (§3.5)', async () => {
    const ws = await connect();
    const hello = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'hello' ? (m as Extract<ServerMsg, { t: 'hello' }>) : null,
    );
    const view = { x: 0, y: 0, w: hello.worldWidth, h: hello.worldHeight, species: [0] };

    ws.send(JSON.stringify({ t: 'subscribe', view: { ...view, lod: 1 } }));
    const fine = await waitFor(ws, (m) =>
      typeof m === 'object' && m !== null && 'speciesIds' in m ? (m as ReturnType<typeof decodeFieldFrame>) : null,
    );

    ws.send(JSON.stringify({ t: 'subscribe', view: { ...view, lod: 4 } }));
    const coarse = await waitFor(ws, (m) => {
      if (typeof m !== 'object' || m === null || !('speciesIds' in m)) return null;
      const f = m as ReturnType<typeof decodeFieldFrame>;
      // Frames already in flight still carry the old lod, so wait for one that reflects
      // the new subscription rather than taking the next binary message.
      return f.lod === 4 ? f : null;
    });

    expect(coarse.width).toBeLessThan(fine.width);
    expect(coarse.data.length).toBeLessThan(fine.data.length);
    ws.close();
  });

  it('the sim keeps running across a disconnect, and reattaching is seamless (§3.7)', async () => {
    const a = await connect();
    const first = await waitFor(a, (m) =>
      (m as ServerMsg).t === 'scalars' ? (m as ScalarsMsg) : null,
    );
    a.close();

    await new Promise((r) => setTimeout(r, 1500));

    const b = await connect();
    const second = await waitFor(b, (m) =>
      (m as ServerMsg).t === 'scalars' ? (m as ScalarsMsg) : null,
    );

    // It ticked on with nobody watching — §2.3, over a socket.
    //
    // Only the TICK is asserted. ATP direction depends on what other tests in this file
    // have already built on the shared server: with an enzyme running it climbs, without
    // one it falls, and asserting either way makes the test depend on execution order.
    // The claim here is "the simulation advanced while nothing was attached", and the
    // tick count is exactly that claim.
    expect(second.tick).toBeGreaterThan(first.tick);
    expect(Number.isFinite(second.atp)).toBe(true);
    b.close();
  });

  it('a command changes the simulation, and only a command can', async () => {
    const ws = await connect();
    await waitFor(ws, (m) => ((m as ServerMsg).t === 'hello' ? true : null));

    ws.send(
      JSON.stringify({
        t: 'command',
        cmd: { op: 'placeFace', face: 'glucose', species: 0, kind: 'channel' },
      }),
    );
    const ev = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'event' && (m as { kind: string }).kind === 'transporterPlaced'
        ? (m as Extract<ServerMsg, { t: 'event' }>)
        : null,
    );
    expect(ev.tile).toBeGreaterThan(0);
    ws.close();
  });

  it('carries the nanobot and build state so the client can render §9.2', async () => {
    const ws = await connect();
    const first = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'scalars' ? (m as ScalarsMsg) : null,
    );
    expect(first.bot).toBeDefined();
    expect(Number.isFinite(first.bot.x)).toBe(true);
    expect(first.nucleus.r).toBeGreaterThan(0);
    expect(first.build.phase).toBe('idle');
    // The residue pool is what the bill-of-materials panel reads (§5).
    for (const t of ['gly', 'leu', 'lys', 'ala', 'val']) {
      expect(first.residues[t]).toBeGreaterThan(0);
    }
    ws.close();
  });

  it('drives the nanobot, and refuses a blueprint away from the nucleus (§9.2 step 1)', async () => {
    const ws = await connect();
    const before = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'scalars' ? (m as ScalarsMsg) : null,
    );

    // Drive the bot somewhere that is definitely NOT the nucleus first, rather than
    // assuming its starting position — this suite talks to a long-lived server process
    // and must not depend on what a previous test left behind.
    const away = { x: before.nucleus.x + 12, y: before.nucleus.y - 12 };
    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'moveTo', ...away } }));
    const arrived = await waitFor(
      ws,
      (m) => {
        if ((m as ServerMsg).t !== 'scalars') return null;
        const sc = m as ScalarsMsg;
        return !sc.bot.atNucleus && Math.hypot(sc.bot.x - away.x, sc.bot.y - away.y) < 2 ? sc : null;
      },
      20_000,
    );
    expect(arrived.bot.atNucleus).toBe(false);

    // A blueprint request from here must be refused — a client asking is not authorisation.
    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'selectGene', gene: 'glycolysisEnzyme' } }));
    await new Promise((r) => setTimeout(r, 300));
    const stillIdle = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'scalars' ? (m as ScalarsMsg) : null,
    );
    expect(stillIdle.build.phase).toBe('idle');

    // Now send it there and confirm it actually travels.
    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'moveTo', x: before.nucleus.x, y: before.nucleus.y } }));
    const moved = await waitFor(
      ws,
      (m) => {
        if ((m as ServerMsg).t !== 'scalars') return null;
        const sc = m as ScalarsMsg;
        return sc.bot.atNucleus ? sc : null;
      },
      20_000,
    );
    expect(moved.bot.atNucleus).toBe(true);
    ws.close();
  });


/**
 * A TEST CANNOT BE MORE PATIENT THAN ITS OWN TIMEOUT.
 *
 * The two long tests below wait on real wall-clock simulation — walking the nanobot across
 * the cell, assembling seven to fourteen peptide bonds, folding — with inner `waitFor`
 * budgets of 20 s, 40 s and 30 s. The global `testTimeout` is 30 s, so every inner budget
 * above that was unreachable: the test died at 30 s no matter what it had been told to
 * wait for, and passed or failed on whether the run happened to come in under the wire.
 *
 * That is the shape §16.1 already warned about — a failure that only shows up under load
 * looks like flakiness and is actually a defect in the harness. Here the defect is that
 * two numbers disagreed and the smaller one silently won. The per-test timeouts below
 * exceed the sum of what each test actually waits for.
 */
  it('carries a transporter to a distant membrane tile and reports it correctly', async () => {
    // Two bugs met here and both were player-visible.
    //
    // 1. Every canvas click while carrying was a DEPLOY, never a move, so once a protein
    //    folded the bot was stranded wherever it had gathered residues and could not
    //    reach the membrane. The server refused correctly and the player was stuck.
    // 2. The success event was chosen with `enzymes.length > 0`, which is true for every
    //    protein built after the first enzyme — so later transporters reported themselves
    //    as `enzymePlaced`, the client never marked them, and a correctly seated carrier
    //    looked like it had done nothing.
    //
    // This drives the real client flow: walk, then seat on arrival.
    const ws = await connect();
    const hello = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'hello' ? (m as Extract<ServerMsg, { t: 'hello' }>) : null,
    );

    // This suite shares one long-lived server, so clear anything a previous test left
    // mid-build — `selectGene` refuses while a build is in progress and the failure looks
    // like a hang rather than a conflict.
    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'cancelBuild' } }));

    // Make sure an enzyme exists first — that is the precondition bug 2 needed.
    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'placeEnzyme' } }));
    await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'event' && (m as { kind: string }).kind === 'enzymePlaced' ? true : null,
    );

    const start = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'scalars' ? (m as ScalarsMsg) : null,
    );
    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'moveTo', x: start.nucleus.x, y: start.nucleus.y } }));
    await waitFor(ws, (m) => {
      const sc = m as ScalarsMsg;
      return (m as ServerMsg).t === 'scalars' && sc.bot.atNucleus ? sc : null;
    }, 20_000);

    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'selectGene', gene: 'lactateCarrier' } }));
    const carrying = await waitFor(ws, (m) => {
      const sc = m as ScalarsMsg;
      return (m as ServerMsg).t === 'scalars' && sc.build.phase === 'carrying' ? sc : null;
    }, 40_000);

    // The client needs this to tell "walk there" from "seat it there".
    expect(carrying.build.productKind).toBe('transporter');

    // Deliberately the farthest GATE tile — the case that used to be unreachable.
    //
    // This used to search `membraneTiles`, and the farthest such tile is a buried one at a
    // diagonal shoulder (see `isGateTile`). So this test was seating a carrier into dead
    // wall and asserting `transporterPlaced` — which the server dutifully sent, because
    // `deploy` only checked orientation for flagella. The test passed for years of runs
    // while the carrier it placed transported precisely nothing.
    let far = -1;
    let bestD = -1;
    for (const m of hello.gateTiles) {
      const mx = (m % hello.worldWidth) + 0.5;
      const my = Math.floor(m / hello.worldWidth) + 0.5;
      const d = Math.hypot(mx - carrying.bot.x, my - carrying.bot.y);
      if (d > bestD) {
        bestD = d;
        far = m;
      }
    }
    expect(bestD).toBeGreaterThan(5); // genuinely out of the 3-tile seating reach

    const fx = (far % hello.worldWidth) + 0.5;
    const fy = Math.floor(far / hello.worldWidth) + 0.5;
    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'moveTo', x: fx, y: fy } }));
    await waitFor(ws, (m) => {
      const sc = m as ScalarsMsg;
      if ((m as ServerMsg).t !== 'scalars') return null;
      return Math.hypot(sc.bot.x - fx, sc.bot.y - fy) <= 2.6 ? sc : null;
    }, 30_000);

    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'deploy', tile: far } }));
    const ev = await waitFor(ws, (m) => {
      if ((m as ServerMsg).t !== 'event') return null;
      const e = m as Extract<ServerMsg, { t: 'event' }>;
      return e.kind === 'transporterPlaced' || e.kind === 'enzymePlaced' || e.kind === 'deployRefused'
        ? e
        : null;
    }, 15_000);

    expect(ev.kind).toBe('transporterPlaced');
    expect(ev.tile).toBe(far);
    ws.close();
  }, 120_000);

  it('reports a seated flagellum as a flagellum, not a transporter (§10A.1)', async () => {
    // A flagellum is a membrane protein, so it deploys through exactly the same gesture
    // as a transporter — and that similarity is what broke it. The client asked
    // `productKind === 'transporter'` in four separate places to decide whether a click
    // on the membrane meant "seat it here", so a folded flagellum fell through to the
    // plain "walk there" branch: the hint said "click a membrane tile", and clicking a
    // membrane tile did nothing at all.
    //
    // The server half was wrong in the mirror-image way — it emitted `transporterPlaced`
    // for a flagellum, so the client marked a motor as a gateable pore.
    //
    // Both halves are asserted here: the client must be able to TELL the two apart from
    // `productKind` before deploying, and the event afterwards must name what was built.
    const ws = await connect();
    const hello = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'hello' ? (m as Extract<ServerMsg, { t: 'hello' }>) : null,
    );
    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'cancelBuild' } }));

    const start = await waitFor(ws, (m) =>
      (m as ServerMsg).t === 'scalars' ? (m as ScalarsMsg) : null,
    );
    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'moveTo', x: start.nucleus.x, y: start.nucleus.y } }));
    await waitFor(ws, (m) => {
      const sc = m as ScalarsMsg;
      return (m as ServerMsg).t === 'scalars' && sc.bot.atNucleus ? sc : null;
    }, 20_000);

    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'selectGene', gene: 'flagellum' } }));
    const carrying = await waitFor(ws, (m) => {
      const sc = m as ScalarsMsg;
      return (m as ServerMsg).t === 'scalars' && sc.build.phase === 'carrying' ? sc : null;
    }, 60_000);

    // The one field the client's membrane-seating branch keys off. If this is not a
    // recognised membrane-bound kind, the deploy gesture is unreachable in the UI.
    expect(carrying.build.productKind).toBe('flagellum');
    expect(['transporter', 'flagellum']).toContain(carrying.build.productKind);

    let tile = -1;
    let bestD = Infinity;
    for (const m of hello.gateTiles) {
      const mx = (m % hello.worldWidth) + 0.5;
      const my = Math.floor(m / hello.worldWidth) + 0.5;
      const d = Math.hypot(mx - carrying.bot.x, my - carrying.bot.y);
      if (d < bestD) { bestD = d; tile = m; }
    }
    const tx = (tile % hello.worldWidth) + 0.5;
    const ty = Math.floor(tile / hello.worldWidth) + 0.5;
    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'moveTo', x: tx, y: ty } }));
    await waitFor(ws, (m) => {
      const sc = m as ScalarsMsg;
      if ((m as ServerMsg).t !== 'scalars') return null;
      return Math.hypot(sc.bot.x - tx, sc.bot.y - ty) <= 2.6 ? sc : null;
    }, 30_000);

    ws.send(JSON.stringify({ t: 'command', cmd: { op: 'deploy', tile } }));
    const ev = await waitFor(ws, (m) => {
      if ((m as ServerMsg).t !== 'event') return null;
      const e = m as Extract<ServerMsg, { t: 'event' }>;
      return e.kind === 'flagellumPlaced' || e.kind === 'transporterPlaced' || e.kind === 'deployRefused'
        ? e
        : null;
    }, 15_000);

    expect(`${ev.kind} ${ev.reason ?? ''}`.trim()).toBe('flagellumPlaced');

    // And it must arrive as an actual motor, not just a successful event.
    const after = await waitFor(ws, (m) => {
      const sc = m as ScalarsMsg;
      return (m as ServerMsg).t === 'scalars' && sc.motility.flagella.length > 0 ? sc : null;
    }, 10_000);
    expect(after.motility.flagella.some((f) => f.tile === tile)).toBe(true);
    // Never listed as a pore — clicking it must not offer to gate it (§6.3).
    expect(after.transporters.some((t) => t.tile === tile)).toBe(false);
    ws.close();
  }, 120_000);

  it('survives malformed input without taking the sim down', async () => {
    const ws = await connect();
    await waitFor(ws, (m) => ((m as ServerMsg).t === 'hello' ? true : null));
    ws.send('this is not json {{{');
    ws.send(JSON.stringify({ t: 'nonsense' }));

    const s = await waitFor(ws, (m) => ((m as ServerMsg).t === 'scalars' ? (m as ScalarsMsg) : null));
    expect(Number.isFinite(s.atp)).toBe(true);
    ws.close();
  });
});
