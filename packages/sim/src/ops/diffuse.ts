/**
 * Diffusion. SPEC.md §3.2 — "a blur", the cheapest of the four grid operations.
 *
 *     new = c + D*dt * (sum_neighbours(c) - n*c)
 *
 * ── The defect this file exists to not repeat ────────────────────────────────
 * Both SA:V prototypes wrote the diffusion term WITHOUT dt while scaling consumption
 * WITH it (`belts_vs_sav.html:102`, `sav_wall.html:124`). Diffusive transport therefore
 * ran at the display refresh rate while consumption ran in real time, so penetration
 * depth — the load-bearing quantity of all of §17 — came out ~2.4x deeper at 144 Hz
 * than at 60 Hz, and every number measured from those prototypes is display-dependent
 * (§17.2).
 *
 * Two things here make that unrepeatable rather than merely fixed:
 *   1. `dt` is a required parameter, not an ambient frame delta. The sim advances only
 *      in whole SIM_DT steps (§3.7) and this process has no frames at all.
 *   2. `assertCFL` throws in dev if D*dt exceeds the stability limit, so an unscaled
 *      or oversized coefficient fails loudly at the first step instead of quietly
 *      producing plausible-looking wrong physics.
 */

import { CFL_LIMIT } from '../constants.js';
import { Grid, Role } from '../grid.js';
import type { SpeciesId } from '../species.js';

/** Set false in a release build; the check is a few comparisons per call, not per tile. */
export let CFL_CHECKS_ENABLED = true;

export function setCFLChecks(on: boolean): void {
  CFL_CHECKS_ENABLED = on;
}

/**
 * §3.3: "Explicit diffusion BLOWS UP if a single step moves a tile more than partway to
 * its neighbours' average." For a 5-point 2D stencil with unit tile spacing the
 * stability condition is D*dt <= 0.25.
 */
export function assertCFL(D: number, dt: number): void {
  if (!CFL_CHECKS_ENABLED) return;
  const nu = D * dt;
  if (!(nu <= CFL_LIMIT)) {
    throw new RangeError(
      `CFL violation: D*dt = ${nu.toFixed(4)} exceeds ${CFL_LIMIT}. ` +
        `Either lower D (max ${(CFL_LIMIT / dt).toFixed(1)} at dt=${dt}), raise SIM_HZ, ` +
        `or sub-step this species. See SPEC.md §3.3 and §13.5.`,
    );
  }
}

/**
 * One diffusion step for one species, in place.
 *
 * Neighbour rules, all three load-bearing:
 *
 *  - Same compartment  → exchange normally.
 *  - VOID or MEMBRANE  → REFLECTING (no-flux): mirror this tile's own value so the term
 *                        contributes exactly zero. §17.2 flags the alternative — setting
 *                        outside tiles to zero and letting the boundary diffuse into
 *                        them — as the bug that cost a rebuild: the void becomes an
 *                        infinite absorbing sink, the membrane can never hold
 *                        concentration, and the cell reads as 100% starving from frame
 *                        one. The membrane is a BARRIER.
 *  - Other compartment → also reflecting. Compartments exchange ONLY through membrane
 *                        tiles (ops/fick.ts). That separation is what makes a gradient
 *                        possible at all, which is to say it is what makes the cell
 *                        alive rather than equilibrated (§2.3).
 */
export function diffuse(grid: Grid, s: SpeciesId, D: number, dt: number): void {
  assertCFL(D, dt);
  if (D <= 0) return;

  const { width, height, role, compartment, scratch } = grid;
  const c = grid.plane(s);
  const nu = D * dt;

  scratch.set(c);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (role[i] !== Role.FLUID) continue;

      const comp = compartment[i]!;
      const self = scratch[i]!;

      // Reflecting default: a neighbour that is not same-compartment fluid mirrors self.
      const l = x > 0 && compartment[i - 1] === comp && role[i - 1] === Role.FLUID
        ? scratch[i - 1]! : self;
      const r = x < width - 1 && compartment[i + 1] === comp && role[i + 1] === Role.FLUID
        ? scratch[i + 1]! : self;
      const u = y > 0 && compartment[i - width] === comp && role[i - width] === Role.FLUID
        ? scratch[i - width]! : self;
      const d = y < height - 1 && compartment[i + width] === comp && role[i + width] === Role.FLUID
        ? scratch[i + width]! : self;

      let next = self + nu * (l + r + u + d - 4 * self);

      // §3.3's second mitigation, belt-and-braces with the CFL condition above: a tile
      // may never leave the range spanned by itself and its neighbours. Under a valid
      // CFL this clamp never fires; if it ever does, the stencil is wrong and the
      // failure is bounded rather than explosive.
      const lo = Math.min(self, l, r, u, d);
      const hi = Math.max(self, l, r, u, d);
      if (next < lo) next = lo;
      else if (next > hi) next = hi;

      c[i] = next;
    }
  }
}
