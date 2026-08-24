/**
 * Proteins wear out. SPEC.md §9.4.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * §14's ribosome retires hand-assembly, and on its own that is only a convenience: a full
 * build-out is about fifteen proteins — three channels, three enzymes, two carriers, five
 * transporters, a flagellum — and then you are finished forever. A factory over a finite
 * job is a shortcut, not a factory. **Production lines exist because demand recurs.**
 *
 * So proteins denature. Every one carries an `integrity` that falls over time; at zero it
 * stops working and has to be replaced. That is what turns the supply chain built in §5b
 * — deposits, ports, hoppers, an inventory — from a one-time errand into something the
 * cell must keep doing to stay alive, which is §2.3's thesis applied to structure rather
 * than to energy.
 *
 * ── It is a consequence, not a tax ───────────────────────────────────────────
 * A flat decay rate is a maintenance chore: it costs the same however well you play, so it
 * teaches nothing. Denaturation is therefore driven mostly by STRESS —
 *
 *   - **tension** (§7.3): a membrane stretched toward rupture strains the proteins in it,
 *   - **brownout** (§2.3): a cell that cannot pay its upkeep cannot run its chaperones,
 *
 * — so a well-run cell replaces proteins slowly and a struggling one sheds them fast. That
 * makes decay a readout of how the cell is doing rather than a clock, and it gives a
 * failing cell a death spiral it can actually see coming: swelling strains the carriers,
 * losing carriers means more swelling.
 *
 * §9.2 already anticipated this — "misfolding under stress wastes the spent amino acids +
 * ATP → proteostasis mechanic with chaperones and recycling" — so it is a promise the spec
 * had already made.
 */

/** Anything the cell builds and can lose. */
export interface Perishable {
  /** 1 = freshly folded, 0 = denatured and no longer working. */
  integrity: number;
}

/**
 * Mean working life of a folded protein, in seconds, in a completely unstressed cell.
 *
 * FOUR MINUTES, and deliberately the only timescale in the mechanic. Proteins wear out,
 * they fail, a ribosome in range rebuilds them. There is no early top-up, no cheaper
 * refold, no distinction between a busy protein and an idle one — every extra timescale
 * was another thing to tune and another thing for a player to have to model.
 *
 * An earlier version set a "half-life" of 720 s and decayed `integrity` exponentially
 * toward a 0.02 failure threshold, which takes 5.6 half-lives: nothing failed for 68
 * minutes and a ten-minute measurement saw zero attrition. **A half-life of a VALUE is not
 * a half-life to an EVENT.** This is a plain countdown, so the number means what it says.
 */
export const MEAN_LIFETIME = 240;

/**
 * How much faster proteins denature under maximum stress.
 *
 * At 6x, a cell held at rupture tension loses proteins in about a minute instead of seven.
 * Fast enough to be a genuine spiral — carriers fail, swelling worsens, the survivors fail
 * sooner — and slow enough that a player who notices has time to act. §10.3's doom spiral,
 * expressed in infrastructure rather than in dilution.
 */
export const STRESS_FACTOR = 6;

/**
 * Spread of individual lifespans, as a fraction of MEAN_LIFETIME.
 *
 * WIDE ON PURPOSE, and the first attempt at ±25% was the whole problem. A player builds
 * their infrastructure in one burst, so with a narrow spread everything expires together:
 * measured, all six proteins and all three ribosomes failed inside a single minute at the
 * seven-minute mark. The repair bill — 88 ATP for a ribosome alone — then arrived at
 * exactly the moment the glucose channels were dying and production was at its lowest, so
 * the cell could not pay it and collapsed from a state that had been stable for six
 * minutes.
 *
 * A correlated failure of everything at once is not a maintenance mechanic, it is a
 * cliff. At 0.4–1.7 the same burst of construction fails over roughly ten minutes instead
 * of one, so attrition arrives as a stream the cell can service rather than as a bill it
 * cannot.
 */
export const FRAILTY_MIN = 0.4;
export const FRAILTY_MAX = 1.7;

/**
 * How stressed the cell is right now, 0..1. Drives the decay multiplier.
 *
 * NOTHING UNTIL IT IS ACTUALLY IN TROUBLE. The first version was `tension * 0.8`, which is
 * linear from the very first drop of swelling — so a cell at a perfectly ordinary tension
 * of 0.42 was already decaying three times faster and lost its enzymes at 80 s instead of
 * 240. Measured: ATP climbed healthily to 467 and then the cell collapsed, and it read as
 * the ribosome being broken rather than as an osmotic problem.
 *
 * Stress now stays at zero until tension passes STRESS_ONSET and only then ramps. Below
 * that, decay is a plain clock and the player can plan around it; above it, they are in
 * §12.3's swelling crisis and losing machinery is part of what that crisis IS.
 *
 * A brownout is a step rather than a ramp — either the cell is paying its rent or it is
 * not — but it is a small step, because being briefly out of ATP should not also cost you
 * the infrastructure you need to recover.
 */
export const STRESS_ONSET = 0.6;

export function stressLevel(tension: number, brownedOut: boolean): number {
  const swelling = Math.max(0, (tension - STRESS_ONSET) / (1 - STRESS_ONSET));
  return Math.min(1, swelling * 0.85 + (brownedOut ? 0.2 : 0));
}

/**
 * Per-protein variation in lifespan, from its own identity.
 *
 * Deterministic — §3.7 needs the whole run replayable, so this cannot call `Math.random`.
 * Hashing an id gives every protein a fixed frailty between 0.75 and 1.25 of the mean, so
 * they do not all expire together like a metronome, and a given run always plays out the
 * same way.
 *
 * Deliberately NOT a true Poisson process, though a real protein's failure is one. A
 * memoryless lifetime means the protein you folded a moment ago is exactly as likely to
 * fail as the one that has been running for ten minutes, which reads as arbitrary. A
 * countdown with a visible integrity bar is something a player can plan around, and
 * planning is the point.
 */
export function frailtyOf(id: number): number {
  let h = Math.imul(id, 374761393) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  h ^= h >>> 16;
  return FRAILTY_MIN + ((h >>> 8) / 16777216) * (FRAILTY_MAX - FRAILTY_MIN);
}

/**
 * Age one protein. Returns true if it just failed this step.
 *
 * Linear in remaining life rather than exponential in value, so `integrity` reads directly
 * as "fraction of its working life left" — which is what an integrity bar should mean, and
 * what makes the number plannable.
 */
export function decay(p: Perishable, dt: number, stress: number, frailty = 1): boolean {
  if (p.integrity <= 0) return false;
  const life = MEAN_LIFETIME * frailty;
  p.integrity -= (dt / life) * (1 + STRESS_FACTOR * stress);
  if (p.integrity <= 0) {
    p.integrity = 0;
    return true;
  }
  return false;
}

/** Is this protein still doing its job? */
export function working(p: Perishable): boolean {
  return p.integrity > 0;
}

/**
 * Integrity at which a protein starts to falter, and therefore at which it is worth
 * replacing.
 *
 * ONE NUMBER, doing both jobs. `efficiency` tapers below it and §9.5's ribosomes act on
 * it, so "repair it the moment it starts to falter" is not a tuned threshold — it is the
 * definition of faltering. A cell's machinery therefore never runs at reduced rate while
 * a ribosome is covering it.
 */
export const REPAIR_AT = 0.25;

/**
 * How well it is doing it. Tapers only at the end of life, so a protein works at full
 * rate for most of its span and then visibly falters — which is the readable shape. A
 * linear ramp from 1 to 0 would make everything permanently half-broken.
 */
export function efficiency(p: Perishable): number {
  if (p.integrity <= 0) return 0;
  return p.integrity >= REPAIR_AT ? 1 : p.integrity / REPAIR_AT;
}

/** Is this protein worn enough to be worth pre-emptively replacing? (§9.5) */
export function worn(p: Perishable): boolean {
  return p.integrity > 0 && p.integrity <= REPAIR_AT;
}
