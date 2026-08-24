/**
 * Seeded PRNG. SPEC.md §3.7.
 *
 * `Math.random` is banned inside packages/sim, and so is reading the wall clock. Every
 * player input reaches the simulation as a discrete command message, so a seed plus a
 * command log reproduces a run EXACTLY — replay, regression tests, and bug reports that
 * can be re-run rather than described, all for free.
 *
 * mulberry32: small, fast, and good enough for jitter and sampling. Not cryptographic,
 * and nothing here should ever want it to be.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  int(nExclusive: number): number {
    return Math.floor(this.next() * nExclusive);
  }

  /** Snapshot/restore, so a save file can round-trip mid-run without desyncing. */
  save(): number {
    return this.state;
  }

  restore(state: number): void {
    this.state = state >>> 0;
  }
}
