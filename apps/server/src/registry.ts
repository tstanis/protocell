/**
 * Which cells are alive right now. SPEC.md §15.6.
 *
 * ── The collision this exists to resolve ────────────────────────────────────
 * §2.3 is not decoration: "being alive is the ongoing act of paying to stay out of
 * equilibrium, and it does not pause because you closed the tab." §3.7 builds the whole
 * server around it — the sim ticks with zero clients attached, and that is the point.
 *
 * Hosting turns that principle into a bill. Measured, a live cell costs **5.5% of one
 * core** (0.46 ms/step at 120 Hz), so:
 *
 *     1 core   ~18 cells saturated, ~12 with headroom
 *     4 vCPU   ~48 concurrent live cells
 *
 * Ticking every account's cell forever means the cost scales with **total signups rather
 * than active players**, which is the wrong axis for anything public: a thousand people
 * who tried it once would cost fifty-five cores in perpetuity.
 *
 * ── Freezing, and why catch-up is not the answer ────────────────────────────
 * A frozen cell keeps every byte of its state and simply stops stepping. It is not a
 * snapshot, a save, or a shutdown — it is the same object, not being called.
 *
 * The tempting alternative is to fast-forward on reconnect: the sim is deterministic
 * (§3.7), so a gap could in principle be replayed. It cannot, and the arithmetic is the
 * same arithmetic — catch-up costs the same 5.5% of a core per second of absence, so a
 * ten-minute gap is **33 s of compute** and an hour is **3.3 minutes**. Nobody waits that
 * long to log in, and a busy server would spend everything it has on absent players.
 *
 * So a returning player's cell resumes exactly where it stopped, and `hello` carries how
 * long it was out. Resuming silently would read as the simulation having lost time, which
 * is the one thing §2.1 will not tolerate: the number on screen has to mean what it says.
 *
 * ── What the LRU preserves ──────────────────────────────────────────────────
 * §2.3's thesis survives for **anyone actually playing**: close the tab, come back in ten
 * minutes, and your cell has been living without you — dying, if you left it badly. What
 * is given up is the cell of someone who has not played for a week, which is the version
 * of the promise nobody is there to observe.
 *
 * A game with a client attached is NEVER frozen, whatever the pressure. That would be
 * freezing a cell somebody is looking at.
 */

import os from 'node:os';
import { Game } from './game.js';
import { decodeSnapshot, encodeSnapshot } from './codec.js';
import type { CellStore } from './store.js';

/**
 * How many cells may tick at once.
 *
 * Derived rather than picked: 5.5% of a core each, one core held back for the event loop,
 * sockets and frame assembly, and 70% headroom on what remains so a burst of activity does
 * not turn into dropped steps across every game at once.
 */
function defaultLiveCap(): number {
  const cores = Math.max(1, os.cpus().length);
  const usable = Math.max(1, cores - 1) * 0.7;
  return Math.max(1, Math.floor(usable / 0.055));
}

export const MAX_LIVE_GAMES = Number(process.env['MAX_LIVE_GAMES'] ?? defaultLiveCap());

/**
 * How many cells may stay in MEMORY, ticking or not.
 *
 * A second, larger bound than the live cap, and it exists because freezing a cell stopped
 * it costing CPU and did nothing about RAM: a `World` is about 1 MB — the field alone is
 * 119,808 Float64s — so ten thousand accounts is ten gigabytes of cells nobody is playing.
 * The LRU bounded the wrong resource on its own.
 *
 * With a store there is a third state. A cell past this bound is saved and dropped
 * entirely; reopening it is a `load` plus a `restore`. So:
 *
 *     live    ticking, in RAM       bounded by CPU  (MAX_LIVE_GAMES)
 *     warm    in RAM, not ticking   bounded by RAM  (MAX_RESIDENT_GAMES)
 *     cold    in the store only     unbounded
 */
export const MAX_RESIDENT_GAMES = Number(process.env['MAX_RESIDENT_GAMES'] ?? MAX_LIVE_GAMES * 4);

/**
 * Seconds between autosaves of a live cell.
 *
 * Sized against request cost rather than against risk, because that is what actually
 * binds: at 31 KB a write, storage for ten thousand cells is under a cent a month, while
 * writing every live cell every minute is ~$60/month in requests alone. Five minutes with
 * the transition saves below costs a few dollars.
 *
 * The exposure this leaves is narrow. Disconnect, freeze and shutdown all save
 * immediately, so five minutes of loss requires the process to die *without* SIGTERM —
 * an OOM or a hard kill — while somebody is mid-play.
 */
export const AUTOSAVE_S = Number(process.env['AUTOSAVE_S'] ?? 300);

export class GameRegistry {
  private readonly games = new Map<string, Game>();
  private readonly store: CellStore | null;
  /** Saves in flight, so a cell is never written twice concurrently. */
  private readonly saving = new Map<string, Promise<void>>();

  constructor(store: CellStore | null = null) {
    this.store = store;
  }

  get size(): number {
    return this.games.size;
  }

  get liveCount(): number {
    let n = 0;
    for (const g of this.games.values()) if (g.live) n++;
    return n;
  }

  /** Every game that should be stepped this tick. */
  *liveGames(): Generator<Game> {
    for (const g of this.games.values()) if (g.live) yield g;
  }

  all(): Iterable<Game> {
    return this.games.values();
  }

  /**
   * The game for `id`, created and thawed as needed.
   *
   * This is the only way a game becomes live, which is deliberate: liveness is a
   * consequence of somebody asking for it, never a default.
   */
  open(id: string): Game {
    let g = this.games.get(id);
    if (!g) {
      g = new Game(id);
      this.games.set(id, g);
    }
    this.thaw(g);
    this.touch(g);
    this.enforceCap();
    return g;
  }

  /**
   * The cell for `id`, faulted in from the store if it is not resident.
   *
   * A failed load does NOT fall back to a fresh cell. Handing a player an empty world
   * because the bucket had a bad minute would silently destroy their save the moment the
   * next autosave wrote over it — losing the connection is recoverable, losing the cell
   * is not.
   */
  async openAsync(id: string): Promise<Game> {
    const resident = this.games.get(id);
    if (resident) return this.open(id);

    let blob: Buffer | null = null;
    if (this.store) blob = await this.store.load(id);

    // Another socket may have faulted the same cell in while we were awaiting.
    const raced = this.games.get(id);
    if (raced) return this.open(id);

    const g = new Game(id);
    if (blob) {
      g.world.restore(decodeSnapshot(blob));
      g.savedAtTick = g.world.tick;
    }
    this.games.set(id, g);
    this.thaw(g);
    this.touch(g);
    this.enforceCap();
    return g;
  }

  /** Write a cell if it has changed. Never two writes of the same cell at once. */
  async save(g: Game): Promise<void> {
    if (!this.store || !g.dirty) return;
    const inFlight = this.saving.get(g.id);
    if (inFlight) return inFlight;

    const tick = g.world.tick;
    const blob = encodeSnapshot(g.world.snapshot());
    const p = this.store
      .save(g.id, blob)
      .then(() => {
        g.savedAtTick = tick;
      })
      .catch((e: unknown) => {
        // Reported and swallowed: a failed save must not take down the tick loop, and the
        // next autosave will try again. `savedAtTick` is left alone so it stays dirty.
        console.error(`save ${g.id} failed:`, (e as Error).message);
      })
      .finally(() => {
        this.saving.delete(g.id);
      });
    this.saving.set(g.id, p);
    return p;
  }

  /**
   * Save every changed cell. For SIGTERM.
   *
   * Bounded concurrency and a deadline, because shutdown is not open-ended: platforms
   * allow a grace period (Cloud Run 10 s, Fly 5 s by default) and then send SIGKILL. A
   * naive `Promise.all` over hundreds of cells opens hundreds of sockets at once, which
   * is slower than a pool rather than faster, and if it overruns the window the process
   * is killed mid-flight and saves nothing.
   *
   * So: save as many as fit, newest activity first, and report what did not fit rather
   * than pretending everything was written.
   */
  async saveAll(deadlineMs = 8000): Promise<{ saved: number; missed: number }> {
    const due = [...this.games.values()]
      .filter((g) => g.dirty)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const until = Date.now() + deadlineMs;
    const POOL = 16;

    let saved = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < due.length && Date.now() < until) {
        const g = due[next++]!;
        await this.save(g);
        if (!g.dirty) saved++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, due.length) }, worker));
    return { saved, missed: due.length - saved };
  }

  /**
   * Drop cold cells out of memory, saving them first.
   *
   * Only frozen, unattached, already-saved cells are eligible — evicting one with a
   * pending write would lose whatever had not landed.
   */
  private async evict(): Promise<void> {
    if (!this.store) return;
    const resident = [...this.games.values()];
    if (resident.length <= MAX_RESIDENT_GAMES) return;

    const cold = resident
      .filter((g) => !g.live && g.clients.size === 0)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);

    let over = resident.length - MAX_RESIDENT_GAMES;
    for (const g of cold) {
      if (over <= 0) break;
      await this.save(g);
      if (!g.dirty && g.clients.size === 0 && !g.live) {
        this.games.delete(g.id);
        over--;
      }
    }
  }

  /** Called on the autosave timer. Staggered by the caller — see main.ts. */
  async maintain(): Promise<void> {
    await this.evict();
  }

  /** Mark recent activity. The LRU key, and the only thing that keeps a cell alive. */
  touch(g: Game): void {
    g.lastActiveAt = Date.now();
  }

  private thaw(g: Game): void {
    if (g.live) return;
    if (g.frozenAt !== null) g.frozenSeconds += (Date.now() - g.frozenAt) / 1000;
    g.frozenAt = null;
    g.live = true;
    // The clock's own accumulator is wall-clock-driven; the tick loop simply stops calling
    // a frozen game, so there is nothing to reset. It resumes mid-breath.
  }

  private freeze(g: Game): void {
    if (!g.live) return;
    g.live = false;
    g.frozenAt = Date.now();
    // A cell that has stopped ticking will not change again until someone opens it, so
    // this is the cheapest possible moment to write it and the last one that is free.
    void this.save(g);
  }

  /**
   * Freeze the least-recently-active *unattached* games until the live set fits.
   *
   * Attached games are skipped entirely rather than counted-and-spared, so a server whose
   * live cap is smaller than its connection count will overshoot rather than freeze
   * somebody mid-play. Overshooting degrades framerate for everyone; freezing an attached
   * cell would stop a simulation a player is watching, and those are not comparable costs.
   */
  private enforceCap(): void {
    const live = [...this.liveGames()];
    if (live.length <= MAX_LIVE_GAMES) return;

    const evictable = live
      .filter((g) => g.clients.size === 0)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);

    let over = live.length - MAX_LIVE_GAMES;
    for (const g of evictable) {
      if (over <= 0) break;
      this.freeze(g);
      over--;
    }
  }

  /**
   * Called when a client disconnects. The game stays live — §2.3 — and only becomes a
   * freeze candidate when something else needs the capacity.
   */
  release(g: Game): void {
    this.touch(g);
    this.enforceCap();
    // The player left. This is the save that matters most, and the one a crash would
    // otherwise make expensive.
    void this.save(g);
    void this.evict();
  }
}
