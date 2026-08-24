/**
 * What is the cell lowest on? SPEC.md §10A.9.
 *
 * Sort the counts. Go to the lowest one. That is the whole rule.
 *
 * ── What this deliberately is not ────────────────────────────────────────────
 * The first version of this modelled it properly: seconds of runway (stock ÷ net drain),
 * minus seconds of travel to the deposit, with glucose converted into ATP-equivalents so
 * it could be compared against a pool it feeds rather than against a particle count. Every
 * piece of that was defensible and the whole thing was wrong for this game — it needed
 * income metering, a drain meter, a brownout special case and a demand model, all to
 * produce a number no player could see or predict.
 *
 * A counter the player is already looking at, sorted, is a mechanic they can reason about:
 * "it is going for lysine because lysine is lowest" needs no explanation and no readout to
 * audit. If the resulting behaviour is wrong, that is a balance problem to see in a
 * playtest, not an argument for a cleverer estimator.
 */

import type { SpeciesId } from './species.js';

/**
 * How much lower a rival has to be before the seeker abandons its current errand, in
 * particles.
 *
 * The one piece of machinery worth keeping, because without it the feature does not
 * function at all: two resources a single particle apart swap places as they drain, so the
 * cell turns around every time the numbers cross and travels nowhere. Five is well inside
 * a deposit's worth of collection, so it never blocks a real change of plan.
 */
export const SWITCH_MARGIN = 5;

export interface Stock {
  species: SpeciesId;
  name: string;
  count: number;
}

/**
 * The lowest stock, or null if there is nothing to compare.
 *
 * Holds the current target unless something is lower by SWITCH_MARGIN, so an errand gets
 * finished. Ties break by the order of the table, which is fixed, so the choice is
 * deterministic — §3.7 needs the whole run replayable.
 */
export function chooseTarget(table: readonly Stock[], current: SpeciesId | null): SpeciesId | null {
  let best: Stock | null = null;
  for (const s of table) if (!best || s.count < best.count) best = s;
  if (!best) return null;
  if (current === null || current === best.species) return best.species;

  const held = table.find((s) => s.species === current);
  if (!held) return best.species;
  return best.count < held.count - SWITCH_MARGIN ? best.species : current;
}
