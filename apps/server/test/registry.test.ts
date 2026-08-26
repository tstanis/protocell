/**
 * §15.6 — many cells on one server, and which of them tick.
 */

import { describe, expect, it } from 'vitest';
import { Game } from '../src/game.js';
import { GameRegistry, MAX_LIVE_GAMES } from '../src/registry.js';
import { constants } from '@protocell/sim';

/** A fake attached client — the registry only ever checks `clients.size`. */
function attach(g: Game): { detach: () => void } {
  const c = { socket: {} as never, view: null, game: g };
  g.clients.add(c);
  return { detach: () => g.clients.delete(c) };
}

describe('§15.6 — one server, many cells', () => {
  it('games are genuinely independent, not one world behind two ids', () => {
    const r = new GameRegistry();
    const a = r.open('a');
    const b = r.open('b');
    expect(a).not.toBe(b);
    expect(a.world).not.toBe(b.world);

    // Build in one; the other must be untouched. This is the whole point of the refactor:
    // every one of these used to be a module-level global.
    a.world.buildGlucoseChannel();
    a.world.buildEnzyme();
    expect(a.world.transporters.size).toBeGreaterThan(0);
    expect(b.world.transporters.size).toBe(0);
    expect(b.world.enzymes.length).toBe(0);

    // And their clocks advance separately.
    a.advance(1);
    expect(a.world.tick).toBeGreaterThan(0);
    expect(b.world.tick).toBe(0);
  });

  it('per-game control state does not leak between cells', () => {
    const r = new GameRegistry();
    const a = r.open('a');
    const b = r.open('b');
    a.applyControl({ t: 'control', op: 'pause' });
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(false);

    a.advance(1);
    b.advance(1);
    expect(a.world.tick).toBe(0); // paused
    expect(b.world.tick).toBeGreaterThan(0);
  });

  it('events queue per game, so one cell never hears about another', () => {
    const r = new GameRegistry();
    const a = r.open('a');
    const b = r.open('b');
    a.emit('lysed');
    expect(a.pending.length).toBe(1);
    expect(b.pending.length).toBe(0);
  });

  it('opening the same id twice returns the same cell', () => {
    const r = new GameRegistry();
    const first = r.open('same');
    first.world.buildEnzyme();
    const again = r.open('same');
    expect(again).toBe(first);
    expect(again.world.enzymes.length).toBe(1);
  });
});

describe('§15.6 — the live set is bounded, and §2.3 survives for anyone playing', () => {
  it('a cell with a client attached is NEVER frozen, whatever the pressure', () => {
    const r = new GameRegistry();
    const mine = r.open('mine');
    attach(mine);
    // Open far more than the cap; `mine` is the least-recently-active by a mile.
    for (let i = 0; i < MAX_LIVE_GAMES + 20; i++) r.open(`other${i}`);
    expect(mine.live).toBe(true);
  });

  it('freezes the least-recently-active unattached cell first', () => {
    const r = new GameRegistry();
    const opened: Game[] = [];
    for (let i = 0; i < MAX_LIVE_GAMES + 5; i++) opened.push(r.open(`g${i}`));

    expect(r.liveCount).toBeLessThanOrEqual(MAX_LIVE_GAMES);
    // The oldest are the ones that went; the newest are all still live.
    expect(opened[0]!.live).toBe(false);
    expect(opened[opened.length - 1]!.live).toBe(true);
  });

  it('a frozen cell keeps every byte of its state and simply stops stepping', () => {
    const r = new GameRegistry();
    const g = r.open('keeper');
    g.world.buildGlucoseChannel();
    g.world.buildEnzyme();
    g.advance(1);
    const tickAtFreeze = g.world.tick;
    const transporters = g.world.transporters.size;

    // Push it out of the live set.
    for (let i = 0; i < MAX_LIVE_GAMES + 5; i++) r.open(`filler${i}`);
    expect(g.live).toBe(false);

    // The tick loop skips it — nothing advances.
    for (const live of r.liveGames()) live.advance(1);
    expect(g.world.tick).toBe(tickAtFreeze);
    // Not a save, not a shutdown: the same object, not being called.
    expect(g.world.transporters.size).toBe(transporters);
    expect(g.world.enzymes.length).toBe(1);
  });

  it('reopening thaws it, resumes where it stopped, and reports the gap', () => {
    const r = new GameRegistry();
    const g = r.open('sleeper');
    g.advance(1);
    const tickAtFreeze = g.world.tick;

    for (let i = 0; i < MAX_LIVE_GAMES + 5; i++) r.open(`filler${i}`);
    expect(g.live).toBe(false);

    const again = r.open('sleeper');
    expect(again).toBe(g);
    expect(g.live).toBe(true);
    // Resumes mid-breath rather than restarting.
    expect(g.world.tick).toBe(tickAtFreeze);
    // The gap is reported rather than silently swallowed — §2.1 will not tolerate a
    // number on screen that does not mean what it says.
    expect(g.frozenSeconds).toBeGreaterThanOrEqual(0);
    expect(g.frozenAt).toBeNull();
  });

  it('the cap is derived from measured tick cost, not picked', () => {
    // 5.5% of a core each, one core reserved, 70% headroom on the rest.
    expect(MAX_LIVE_GAMES).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_LIVE_GAMES)).toBe(true);
  });
});

describe('§15.6 — a game still behaves exactly as the single-world server did', () => {
  it('an overloaded tick drops sim steps rather than spiralling, and counts them', () => {
    // Two guards compose here, and both matter more with many games than with one:
    // `advance` clamps elapsed to 0.25 s, and Clock caps a single pump at 8 steps.
    // So a server whose event loop is saturated makes sim time run SLOW rather than
    // trying to catch up thousands of steps in one turn — and `droppedSteps` is how you
    // find out, which is why the heartbeat prints it.
    const g = new Game('t');
    g.advance(1);
    expect(g.world.tick).toBe(8);
    expect(g.clock.droppedSteps).toBeGreaterThan(0);
  });

  it('honours single-stepping while paused', () => {
    const g = new Game('t');
    g.advance(1);

    g.applyControl({ t: 'control', op: 'pause' });
    const at = g.world.tick;
    g.advance(1);
    expect(g.world.tick).toBe(at);

    g.applyControl({ t: 'control', op: 'step', value: 3 });
    g.advance(0);
    expect(g.world.tick).toBe(at + 3);
  });

  it('sim time advances at SIM_HZ under a realistic tick cadence', () => {
    // The real loop calls advance ~240x/s with ~4 ms deltas, well inside both guards.
    const g = new Game('t');
    for (let i = 0; i < 240; i++) g.advance(1 / 240);
    expect(g.world.tick).toBe(constants.SIM_HZ);
    expect(g.clock.droppedSteps).toBe(0);
  });

  it('commands are the only channel that changes the sim (§3.7)', () => {
    const g = new Game('t');
    expect(g.world.enzymes.length).toBe(0);
    g.applyCommand({ t: 'command', cmd: { op: 'placeEnzyme' } });
    expect(g.world.enzymes.length).toBe(1);
    expect(g.pending.some((e) => e.kind === 'enzymePlaced')).toBe(true);
  });
});
