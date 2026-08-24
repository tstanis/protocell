/**
 * SPEC.md §16.1 — the transport laws of §6.
 *
 * §6.1 calls one property mandatory for anything passive: net flux is proportional to
 * the gradient, reaches ZERO at equilibrium, and REVERSES past it. These tests are
 * written so that `cell_prototype.html`'s implementation could not pass them — its
 * "channel" gates on geometry with no gradient term and clamps interior particles in, so
 * it can never reflux, which by §6.1's own test makes it a free pump (§16.2).
 */

import { describe, expect, it } from 'vitest';
import {
  applyTransport,
  carrier,
  channel,
  clampToEquilibrium,
  fluxOf,
  pump,
} from '../src/transport.js';
import { CYTOPLASM, EXTRACELLULAR, Grid, Role } from '../src/grid.js';
import { SPECIES_ID } from '../src/species.js';
import { SIM_DT, VMAX_CARRIER_LACTATE } from '../src/constants.js';

const GLU = SPECIES_ID.glucose;
const LAC = SPECIES_ID.lactate;

/**
 * The minimum viable two-compartment rig: one cytoplasm tile, one membrane tile, one
 * extracellular tile. Small enough that flux is the only thing that can move anything.
 */
function twoCompartments(cIn: number, cOut: number, species = GLU) {
  const g = new Grid(5, 3);
  const inI = g.idx(1, 1);
  const memI = g.idx(2, 1);
  const outI = g.idx(3, 1);

  g.role[inI] = Role.FLUID;
  g.compartment[inI] = CYTOPLASM;
  g.role[memI] = Role.MEMBRANE;
  g.role[outI] = Role.FLUID;
  g.compartment[outI] = EXTRACELLULAR;

  g.inward[memI] = inI;
  g.outward[memI] = outI;
  g.edgeArea[memI] = 1;

  g.set(species, inI, cIn);
  g.set(species, outI, cOut);
  return { g, inI, memI, outI };
}

describe('§6.1 — the law every passive transporter must obey', () => {
  // `sub` is a gradient comfortably below this transporter's saturation point, if it has
  // one. The default lactate carrier saturates at only 3.2/55 = 0.058, so probing the
  // proportional regime needs a deliberately small gradient — see the note in §13.4.
  for (const [name, t, sub] of [
    ['channel', channel(GLU), 1.0],
    ['carrier', carrier(GLU), 0.01],
  ] as const) {
    describe(name, () => {
      it('moves exactly zero at equilibrium', () => {
        expect(fluxOf(t, 5, 5, true)).toBe(0);
      });

      it('reverses sign past equilibrium', () => {
        const forward = fluxOf(t, 10, 2, true);
        const backward = fluxOf(t, 2, 10, true);
        expect(forward).toBeGreaterThan(0);
        expect(backward).toBeLessThan(0);
      });

      it('scales with the gradient below saturation, not at a fixed rate', () => {
        // §6.1's consequence that confuses players: a passive transporter looks "slow"
        // near equilibrium and "fast" with a steep gradient — because net flux literally
        // depends on the gradient, not because its intrinsic speed changed.
        const gentle = fluxOf(t, 1 + sub, 1.0, true);
        const steep = fluxOf(t, 1 + sub * 4, 1.0, true);
        expect(steep).toBeCloseTo(gentle * 4, 8);
      });
    });
  }
});

describe('§6.3 — channel: fast, uncapped, symmetric', () => {
  it('is uncapped: doubling the gradient doubles the flux, without limit', () => {
    const c = channel(GLU, 0.5);
    expect(fluxOf(c, 100, 0, true)).toBeCloseTo(2 * fluxOf(c, 50, 0, true), 10);
    expect(fluxOf(c, 10_000, 0, true)).toBeCloseTo(5000, 6);
  });

  it('refluxes as hard as it exports — perfectly symmetric', () => {
    const c = channel(GLU);
    expect(fluxOf(c, 10, 0, true)).toBeCloseTo(-fluxOf(c, 0, 10, true), 12);
  });
});

describe('§6.4 — carrier: slow, saturable, gentle', () => {
  it('saturates at Vmax no matter how steep the gradient', () => {
    const c = carrier(LAC);
    expect(fluxOf(c, 1e6, 0, true)).toBe(VMAX_CARRIER_LACTATE);
  });

  it('below the ceiling, delivered flux still scales with gradient', () => {
    // §6.4: "Its fixed quantity is its CEILING (Vmax), not its throughput." A carrier
    // that always ran at Vmax would be a pump.
    const c = carrier(LAC, 100, 55);
    expect(fluxOf(c, 0.02, 0, true)).toBeCloseTo(1.1, 10);
    expect(fluxOf(c, 0.04, 0, true)).toBeCloseTo(2.2, 10);
  });

  it('refluxes far more gently than a channel — the reason to accept a lower ceiling', () => {
    const carr = carrier(LAC, 3.2, 55);
    const chan = channel(LAC, 55);
    const gradient = -0.5;
    expect(Math.abs(fluxOf(carr, 0, -gradient, true))).toBeLessThan(
      Math.abs(fluxOf(chan, 0, -gradient, true)),
    );
  });
});

describe('§6.5 / §6.6 — pump: fixed rate, uphill, ATP-gated', () => {
  const p = pump(GLU, 2, 1, 0.5);

  it('moves at a fixed rate regardless of the gradient, including uphill', () => {
    expect(fluxOf(p, 10, 0, true)).toBe(2);
    expect(fluxOf(p, 0, 10, true)).toBe(2); // uphill, unbothered
    expect(fluxOf(p, 5, 5, true)).toBe(2); // at equilibrium, still working
  });

  it('stops when ATP runs out — §2.3, the brownout that kills a cell', () => {
    expect(fluxOf(p, 10, 0, false)).toBe(0);
  });

  it('charges ATP proportional to what it moved', () => {
    const { g, inI, outI, memI } = twoCompartments(10, 0);
    const res = applyTransport(g, new Map([[memI, p]]), [GLU], SIM_DT, true);
    const moved = 10 - g.get(GLU, inI);
    expect(moved).toBeGreaterThan(0);
    expect(res.atpSpent).toBeCloseTo(moved * 0.5, 12);
    expect(g.get(GLU, outI)).toBeCloseTo(moved, 12);
  });
});

describe('§3.3 — the overshoot clamp', () => {
  it('never lets a transfer cross the equilibrium point', () => {
    // Two equal-volume tiles equilibrate at their mean, so the largest legal move is
    // half the difference.
    expect(clampToEquilibrium(100, 10, 0)).toBe(5);
    expect(clampToEquilibrium(-100, 0, 10)).toBe(-5);
    expect(clampToEquilibrium(1, 10, 0)).toBe(1); // small moves pass through
    expect(clampToEquilibrium(5, 5, 5)).toBe(0); // already equilibrated
  });

  it('a huge permeability equilibrates without oscillating', () => {
    // Without the clamp this is the classic explicit-scheme blow-up: overshoot, reverse,
    // overshoot further, NaN. §3.3 says do not skip it, so here is the proof.
    const { g, inI, outI, memI } = twoCompartments(100, 0);
    const t = channel(GLU, 1e6);
    const map = new Map([[memI, t]]);

    for (let n = 0; n < 500; n++) applyTransport(g, map, [GLU], SIM_DT, true);

    const a = g.get(GLU, inI);
    const b = g.get(GLU, outI);
    expect(Number.isFinite(a)).toBe(true);
    expect(a).toBeCloseTo(50, 6);
    expect(b).toBeCloseTo(50, 6);
  });
});

describe('§6.3 — gating, the only self-regulation the cell has', () => {
  it('a gated-shut channel passes nothing but the bare bilayer leak', () => {
    // Without this the player has no lever at all: build more channels than consumers and
    // solute accumulates, volume climbs, and the only options are watch or bleb.
    const open = twoCompartments(0, 60);
    const shut = twoCompartments(0, 60);
    const openMap = new Map([[open.memI, channel(GLU)]]);
    const shutMap = new Map([[shut.memI, { ...channel(GLU), closed: true }]]);

    for (let n = 0; n < 600; n++) {
      applyTransport(open.g, openMap, [GLU], SIM_DT, true);
      applyTransport(shut.g, shutMap, [GLU], SIM_DT, true);
    }

    expect(open.g.get(GLU, open.inI)).toBeGreaterThan(10);
    expect(shut.g.get(GLU, shut.inI)).toBeLessThan(0.1);
  });

  it('re-opening restores full flux — a gate is reversible, not destruction', () => {
    const { g, inI, memI } = twoCompartments(0, 60);
    const t = { ...channel(GLU), closed: true };
    const map = new Map([[memI, t]]);

    for (let n = 0; n < 400; n++) applyTransport(g, map, [GLU], SIM_DT, true);
    const whileShut = g.get(GLU, inI);
    expect(whileShut).toBeLessThan(0.1);

    t.closed = false;
    for (let n = 0; n < 400; n++) applyTransport(g, map, [GLU], SIM_DT, true);
    expect(g.get(GLU, inI)).toBeGreaterThan(10);
  });
});

describe('membrane transport end to end', () => {
  it('conserves mass — the membrane holds no pool of its own (§4.2)', () => {
    const { g, memI } = twoCompartments(80, 5);
    const before = g.total(GLU);
    const map = new Map([[memI, channel(GLU)]]);

    for (let n = 0; n < 2000; n++) applyTransport(g, map, [GLU], SIM_DT, true);

    expect(g.total(GLU)).toBeCloseTo(before, 10);
    // The membrane tile itself must be empty: it is a gate, not a tank.
    expect(g.get(GLU, memI)).toBe(0);
  });

  it('converges on equilibrium and never overshoots it', () => {
    // Approach is asymptotic, so "stays there" means the error keeps SHRINKING — not
    // that consecutive samples are bit-identical. The failure mode worth excluding is
    // oscillation or drift past the equilibrium point, not continued convergence.
    const { g, inI, outI, memI } = twoCompartments(80, 0);
    const map = new Map([[memI, channel(GLU)]]);
    const EQ = 40; // equal volumes, so the analytic equilibrium is the mean

    for (let n = 0; n < 5000; n++) applyTransport(g, map, [GLU], SIM_DT, true);
    const errAfterFirst = Math.abs(g.get(GLU, inI) - EQ);

    for (let n = 0; n < 5000; n++) applyTransport(g, map, [GLU], SIM_DT, true);
    const errAfterSecond = Math.abs(g.get(GLU, inI) - EQ);

    expect(errAfterFirst).toBeLessThan(1e-6);
    expect(errAfterSecond).toBeLessThanOrEqual(errAfterFirst);
    expect(g.get(GLU, inI)).toBeGreaterThanOrEqual(EQ - 1e-9); // never crossed over
    expect(g.get(GLU, inI)).toBeCloseTo(g.get(GLU, outI), 8);
  });

  it('imports down-gradient, then reverses when the gradient does', () => {
    // The full §6.1 arc in one test, and the specific behaviour cell_prototype cannot
    // produce: it is a diode there, and physics here.
    const { g, inI, outI, memI } = twoCompartments(0, 60);
    const map = new Map([[memI, channel(GLU)]]);

    for (let n = 0; n < 400; n++) applyTransport(g, map, [GLU], SIM_DT, true);
    expect(g.get(GLU, inI)).toBeGreaterThan(0); // imported

    // Now flood the inside and watch it run the other way, unprompted.
    g.set(GLU, inI, 500);
    const outBefore = g.get(GLU, outI);
    for (let n = 0; n < 400; n++) applyTransport(g, map, [GLU], SIM_DT, true);
    expect(g.get(GLU, outI)).toBeGreaterThan(outBefore); // exported
  });

  it('a bare bilayer passes gases and effectively blocks glucose (§6.2)', () => {
    const gas = twoCompartments(0, 100, SPECIES_ID.o2);
    const sugar = twoCompartments(0, 100, GLU);
    const empty = new Map();

    for (let n = 0; n < 500; n++) {
      applyTransport(gas.g, empty, [SPECIES_ID.o2], SIM_DT, true);
      applyTransport(sugar.g, empty, [GLU], SIM_DT, true);
    }

    expect(gas.g.get(SPECIES_ID.o2, gas.inI)).toBeGreaterThan(20);
    expect(sugar.g.get(GLU, sugar.inI)).toBeLessThan(0.1);
  });
});
