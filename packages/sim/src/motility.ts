/**
 * Motility. SPEC.md §10A.
 *
 * ── The requirement the prototype missed ─────────────────────────────────────
 * §10A.1: "Swimming is expensive and competes directly with construction for ATP, so
 * exploration is a deliberate diversion of the energy economy — kept in permanent tension
 * with everything else, never free."
 *
 * `motility_chemotaxis.html` assigned `cell.speed = 74` unconditionally every frame, so
 * swimming was a fixed background drain that could neither be turned off nor traded
 * against anything (§16.2). The tension §10A is built around did not exist. Here thrust is
 * a decision, it is paid for out of the same ATP field that peptide bonds are paid from,
 * and it stops when the cell cannot afford it.
 *
 * ── How the cell moves without re-tiling ─────────────────────────────────────
 * The cell keeps a continuous position in a larger WORLD, and the grid is a window that
 * travels with it: the cell's tiles never move relative to the lattice, and what changes
 * is which part of the world the extracellular tiles are looking at. That sidesteps §3.6's
 * moving-boundary problem entirely, which is the right trade — re-tiling is the genuinely
 * hard seam and motility does not need it. When growth and division arrive and the
 * boundary really must move through the lattice, this stays valid: the window follows the
 * cell either way.
 */

import type { SpeciesId } from './species.js';
import { efficiency, type Perishable } from './denature.js';

/**
 * Thrust per firing flagellum, in tiles/second of resulting speed.
 *
 * Sized against the cell: R0 is ~17.8 tiles, so a single flagellum moves the cell about a
 * quarter of its own diameter per second. Slow enough that crossing to a new patch is a
 * commitment, fast enough not to be tedious.
 */
export const FLAGELLUM_SPEED = 4.5;

/**
 * ATP per second per firing flagellum.
 *
 * Derived against the thing it has to compete with. One glycolysis enzyme nets ~7.14
 * ATP/s and baseline upkeep is ~1.6 ATP/s, so a flagellum at 3.6 ATP/s costs almost
 * exactly HALF AN ENZYME to run. That is the trade §10A.1 wants made explicit: swimming
 * somewhere is worth roughly what an enzyme is worth, and you feel it immediately.
 */
/**
 * How fast the body comes about, in radians per second (§10A.1a).
 *
 * ~1.6 rad/s is a half-turn in about two seconds: long enough to see the cell swing round
 * and to feel that a badly-placed flagellum costs you time, short enough that steering
 * never feels unresponsive.
 */
export const TURN_RATE = 1.6;

export const FLAGELLUM_ATP_PER_SECOND = 3.6;

/**
 * A flagellum, seated in a membrane tile like a transporter (§6.7 again: where it sits is
 * the decision). It pushes the cell AWAY from itself — thrust runs along the inward
 * normal — so a cell with every flagellum on one face can only travel one way, and
 * steering means choosing which ones to fire (§10A.1).
 */
export interface Flagellum extends Perishable {
  tile: number;
  /** Unit thrust direction in world space: inward, i.e. away from this patch of membrane. */
  dx: number;
  dy: number;
  /** Firing this step. Set by the steering logic, not by the player directly. */
  firing: boolean;
}

export interface MotilityState {
  /** Continuous position of the cell in world tiles. */
  x: number;
  y: number;
  /** Velocity in tiles/second — recomputed each step, never integrated (see below). */
  vx: number;
  vy: number;
  /** Desired heading in radians, or null to coast. */
  heading: number | null;
  /** §10A.3 — steer up the gradient of this species instead of a fixed heading. */
  chemotaxis: SpeciesId | null;
  /**
   * §10A.9 — let the cell pick its own target: whatever it is most short of.
   *
   * Sits ABOVE `chemotaxis` rather than replacing it. The seeker's whole output is a
   * choice of species, and chemotaxis is already the machinery for climbing toward one —
   * so this drives that instead of duplicating it, and turning it off leaves the last
   * course it set rather than dumping the player into no state at all.
   */
  autoSeek: boolean;
  /** Flagella cannot fire without ATP; this records that they tried and could not. */
  stalled: boolean;
  /**
   * Which way the cell is currently facing, in radians. §10A.1a.
   *
   * WITHOUT THIS, ONE FLAGELLUM IS USELESS. Flagella are welded to fixed membrane tiles,
   * so a single one thrusts along exactly one bearing; if the target lay anywhere else,
   * `align` failed, nothing fired, and the cell sat still — 0.2 tiles in sixty seconds.
   * The player's first flagellum costs 56 ATP and 14 residues and did nothing at all
   * unless the destination happened to be opposite it.
   *
   * A real cell solves this by reorienting, and so does this one: the body turns until its
   * propulsion points where it wants to go. Placement still matters — more flagella mean
   * more thrust and less turning to do — but one is now genuinely a vehicle rather than a
   * lottery ticket.
   */
  facing: number;
}

export function emptyMotility(): MotilityState {
  return {
    x: 0, y: 0, vx: 0, vy: 0,
    heading: null, chemotaxis: null, autoSeek: false, stalled: false, facing: 0,
  };
}

/**
 * Which flagella should fire to travel along `heading`, and the thrust that produces.
 *
 * A flagellum contributes only if its thrust points broadly the right way — the dot
 * product against the desired heading must be positive. Firing one that pushes backwards
 * would cost ATP to go slower.
 */
export function selectFiring(
  flagella: Flagellum[],
  heading: number,
  /** The body's current orientation; flagella are welded to it and turn with it. */
  facing = 0,
): { dx: number; dy: number; count: number } {
  const hx = Math.cos(heading);
  const hy = Math.sin(heading);
  const cf = Math.cos(facing);
  const sf = Math.sin(facing);
  let dx = 0;
  let dy = 0;
  let count = 0;
  for (const f of flagella) {
    // The flagellum's thrust in WORLD space: its body-frame direction, rotated by facing.
    const wx = f.dx * cf - f.dy * sf;
    const wy = f.dx * sf + f.dy * cf;
    const align = wx * hx + wy * hy;
    f.firing = align > 0.15 && f.integrity > 0;
    if (!f.firing) continue;
    // Contribution is scaled by alignment, so an off-axis flagellum helps less than it
    // costs — which is what makes flagellum PLACEMENT matter rather than just count.
    // §9.4 — a worn flagellum pushes less.
    const eff = efficiency(f);
    dx += wx * align * eff;
    dy += wy * align * eff;
    count++;
  }
  return { dx, dy, count };
}

export interface SwimResult {
  /** ATP consumed this step. */
  atpSpent: number;
  /** True if flagella wanted to fire but there was not enough ATP. */
  stalled: boolean;
}

/**
 * Advance the cell one step.
 *
 * ── Why velocity is set, not integrated ──────────────────────────────────────
 * At cell scale the Reynolds number is minute: viscous drag dominates inertia so
 * completely that a bacterium which stops swimming coasts a fraction of an atomic
 * diameter before halting. Modelling momentum here would be actively wrong — the cell
 * would drift after the player stopped thrusting, which is a submarine, not a microbe.
 * Velocity is therefore a direct function of current thrust and vanishes the instant
 * thrust does.
 *
 * `payATP` draws from the same field that peptide bonds draw from, so a cell that is
 * swimming genuinely has less available to build with. That is the entire point of §10A.1
 * and it is the part the prototype did not have.
 */
export function stepMotility(
  m: MotilityState,
  flagella: Flagellum[],
  dt: number,
  payATP: (amount: number) => number,
): SwimResult {
  m.stalled = false;

  if (m.heading === null || flagella.length === 0) {
    for (const f of flagella) f.firing = false;
    m.vx = 0;
    m.vy = 0;
    return { atpSpent: 0, stalled: false };
  }

  // Turn so that the FLAGELLA point the right way — not so that the body's own reference
  // frame does. Those are different rotations, and conflating them was why a single
  // flagellum still could not move: setting `facing = heading` aligns the body's zero
  // angle with the heading, which leaves a flagellum seated at bearing b thrusting along
  // `heading + b`. What is wanted is `facing = heading - b`.
  //
  // With several flagella there is no single b, so evaluate one candidate per flagellum —
  // the rotation that would line THAT one up — plus holding the current facing, and take
  // whichever yields the most forward thrust. Deterministic, O(n²) over a handful of
  // flagella, and it naturally prefers to keep pointing where it already points.
  let bestFacing = m.facing;
  let bestThrust = -Infinity;
  const candidates = [m.facing];
  for (const f of flagella) candidates.push(m.heading - Math.atan2(f.dy, f.dx));
  for (const cand of candidates) {
    const probe = selectFiring(flagella, m.heading, cand);
    const forward =
      probe.dx * Math.cos(m.heading) + probe.dy * Math.sin(m.heading);
    if (forward > bestThrust) {
      bestThrust = forward;
      bestFacing = cand;
    }
  }

  const want = bestFacing;
  let diff = want - m.facing;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const step = Math.min(Math.abs(diff), TURN_RATE * dt) * Math.sign(diff);
  m.facing += step;

  const sel = selectFiring(flagella, m.heading, m.facing);
  if (sel.count === 0) {
    m.vx = 0;
    m.vy = 0;
    return { atpSpent: 0, stalled: false };
  }

  const wantATP = FLAGELLUM_ATP_PER_SECOND * sel.count * dt;
  const got = payATP(wantATP);
  // Partial payment throttles thrust proportionally rather than cutting out — a browning
  // cell slows down before it stops, which is both truer and more readable than a switch.
  const fraction = wantATP > 0 ? got / wantATP : 0;
  if (fraction < 0.999) {
    m.stalled = true;
    for (const f of flagella) f.firing = f.firing && fraction > 0.05;
  }

  const mag = Math.hypot(sel.dx, sel.dy) || 1;
  m.vx = (sel.dx / mag) * FLAGELLUM_SPEED * fraction;
  m.vy = (sel.dy / mag) * FLAGELLUM_SPEED * fraction;
  m.x += m.vx * dt;
  m.y += m.vy * dt;

  return { atpSpent: got, stalled: m.stalled };
}

/**
 * §10A.3 — chemotaxis, "free from existing mechanics".
 *
 * "A cell steers up a concentration gradient by sensing 'is [nutrient] denser ahead than
 * behind?' and biasing its motor. This is a sense → decide → actuate loop built entirely
 * from concentration differences — the game's core currency — so it costs no new
 * primitive."
 *
 * Sampled around a ring rather than from a two-point difference, because a real cell
 * compares across its whole surface and a two-point sample is degenerate exactly when the
 * gradient runs perpendicular to it. Returns null when the gradient is too flat to be
 * worth chasing, so the cell coasts instead of chasing noise — and coasting is free.
 */
export function senseGradient(
  sampleAt: (dx: number, dy: number) => number,
  radius: number,
  samples = 8,
  deadband = 1e-4,
): number | null {
  let gx = 0;
  let gy = 0;
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * 2 * Math.PI;
    const ox = Math.cos(a) * radius;
    const oy = Math.sin(a) * radius;
    const c = sampleAt(ox, oy);
    gx += Math.cos(a) * c;
    gy += Math.sin(a) * c;
  }
  const mag = Math.hypot(gx, gy);
  if (mag < deadband) return null;
  return Math.atan2(gy, gx);
}
