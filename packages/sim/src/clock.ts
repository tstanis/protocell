/**
 * The fixed-timestep clock. SPEC.md §3.4, §3.7.
 *
 * "The sim solves on stability-sized sub-steps; the render interpolates between sim
 * states at whatever framerate the visuals need. Bind them but do not lock them to one
 * heartbeat."
 *
 * The simulation advances ONLY in whole SIM_DT steps and never sees a frame delta. This
 * is the structural fix for the defect in §17.2 — the SA:V prototypes scaled consumption
 * by dt but not diffusion, so penetration depth tracked the display's refresh rate. A
 * variable dt cannot leak in here because nothing in this process has frames: the sim
 * server owns the clock and renderers are separate processes downstream (§3.7).
 *
 * The accumulator also gives the server a spiral-of-death guard. If a step ever takes
 * longer than real time, we drop simulated time rather than queueing an ever-growing
 * backlog — the sim runs slow and says so, instead of freezing while it tries to catch
 * up forever.
 */

import { SIM_DT } from './constants.js';

export interface ClockOptions {
  dt?: number;
  /** Ceiling on steps per pump, to bound catch-up work. */
  maxStepsPerPump?: number;
}

export class Clock {
  readonly dt: number;
  private readonly maxSteps: number;
  private accumulator = 0;

  /** Steps completed since construction. This is the canonical "now" — not a timestamp. */
  tick = 0;

  /** Steps dropped to avoid a death spiral. Non-zero means the sim is running behind. */
  droppedSteps = 0;

  constructor(opts: ClockOptions = {}) {
    this.dt = opts.dt ?? SIM_DT;
    this.maxSteps = opts.maxStepsPerPump ?? 8;
  }

  /**
   * Feed elapsed real seconds; invoke `step` once per whole simulated step.
   *
   * `elapsed` is the ONLY place real time enters the simulation, and it never reaches
   * `step` — which takes no arguments precisely so that no operation can accidentally
   * scale itself by a frame delta.
   */
  pump(elapsed: number, step: () => void): number {
    this.accumulator += elapsed;
    let steps = 0;
    while (this.accumulator >= this.dt) {
      if (steps >= this.maxSteps) {
        const dropped = Math.floor(this.accumulator / this.dt);
        this.droppedSteps += dropped;
        this.accumulator -= dropped * this.dt;
        break;
      }
      this.accumulator -= this.dt;
      this.tick++;
      steps++;
      step();
    }
    return steps;
  }

  /**
   * Fraction through the current step, in [0, 1). Sent to clients so they can interpolate
   * — §2.4's third pair, "sim clock (truth) → render framerate (costume)".
   */
  get alpha(): number {
    return this.accumulator / this.dt;
  }

  /** Simulated seconds elapsed. Derived from ticks, never from a timestamp. */
  get simTime(): number {
    return this.tick * this.dt;
  }
}
