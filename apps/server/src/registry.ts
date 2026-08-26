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

export class GameRegistry {
  private readonly games = new Map<string, Game>();

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
  }
}
