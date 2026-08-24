/**
 * Motility. SPEC.md §10A.
 *
 * The load-bearing test in this file is "swimming competes with construction". §10A.1
 * makes that the entire point of motility — "kept in permanent tension with everything
 * else, never free" — and §16.2 records that `motility_chemotaxis.html` did not model it
 * at all: swim speed was assigned unconditionally every frame, so it was a fixed
 * background drain that could not be turned off or traded against anything.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../src/world.js';
import { SIM_DT, ATP_POOL_PER_TILE, P_CHANNEL_GLUCOSE } from '../src/constants.js';
import { FLAGELLUM_ATP_PER_SECOND, FLAGELLUM_SPEED, senseGradient } from '../src/motility.js';
import { CYTOPLASM, Role } from '../src/grid.js';
import { SPECIES_ID } from '../src/species.js';
import { channel } from '../src/transport.js';

function run(w: World, seconds: number): void {
  const steps = Math.round(seconds / SIM_DT);
  for (let n = 0; n < steps; n++) w.step();
}

/** Membrane tiles nearest a given angle, for placing flagella deliberately. */
function membraneAt(w: World, angle: number, count = 1): number[] {
  const tx = w.cx + Math.cos(angle) * w.radius;
  const ty = w.cy + Math.sin(angle) * w.radius;
  const scored: Array<{ i: number; d: number }> = [];
  for (let i = 0; i < w.grid.tileCount; i++) {
    if (w.grid.role[i] !== Role.MEMBRANE || w.grid.inward[i]! < 0) continue;
    const x = (i % w.grid.width) + 0.5;
    const y = Math.floor(i / w.grid.width) + 0.5;
    scored.push({ i, d: Math.hypot(x - tx, y - ty) });
  }
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, count).map((s) => s.i);
}

/** Top the cell up so a test measures swimming rather than starvation. */
function charge(w: World): void {
  // §5c — charge the pool, not the field.
  w.energy.add(w.energy.capacity * 0.9);
}

describe('§10A.1 — a flagellum is a protein you build and anchor', () => {
  it('a cell with no flagella does not move, however you steer it', () => {
    const w = new World();
    w.setHeading(0);
    const x0 = w.motility.x;
    run(w, 5);
    expect(w.motility.x).toBe(x0);
    expect(w.motility.vx).toBe(0);
  });

  it('anchors only in the membrane', () => {
    const w = new World();
    const cytoTile = w.grid.idx(Math.round(w.cx), Math.round(w.cy));
    expect(w.addFlagellum(cytoTile)).toBeNull();
    expect(w.addFlagellum(membraneAt(w, 0)[0]!)).not.toBeNull();
  });

  it('thrust points AWAY from the flagellum, so placement decides where you can go', () => {
    // §10A.1: "steering biases which propellers fire". A flagellum on the right pushes the
    // cell left; that is what makes where you seat them a real decision (§6.7 again).
    const w = new World();
    const f = w.addFlagellum(membraneAt(w, 0)[0]!)!; // east face
    expect(f.dx).toBeLessThan(-0.5); // pushes west
    expect(Math.abs(f.dy)).toBeLessThan(0.5);
  });
});

describe('§10A.1 — SWIMMING COMPETES WITH CONSTRUCTION', () => {
  it('running a flagellum drains ATP', () => {
    const w = new World();
    w.addFlagellum(membraneAt(w, 0)[0]!);
    charge(w);
    const before = w.atp;

    w.setHeading(Math.PI); // west, which the east-face flagellum can deliver
    let spent = 0;
    for (let n = 0; n < Math.round(4 / SIM_DT); n++) spent += w.step().atpSpentSwimming;

    expect(spent).toBeGreaterThan(0);
    expect(w.atp).toBeLessThan(before);
    // ~4 s of one flagellum, within upkeep's noise.
    expect(spent).toBeCloseTo(FLAGELLUM_ATP_PER_SECOND * 4, 0);
  });

  it('coasting is free — not swimming costs nothing', () => {
    // The prototype could not express this: its speed was assigned every frame regardless.
    // Without a genuine zero there is no trade to make.
    const w = new World();
    w.addFlagellum(membraneAt(w, 0)[0]!);
    charge(w);

    w.setHeading(null);
    let spent = 0;
    for (let n = 0; n < Math.round(4 / SIM_DT); n++) spent += w.step().atpSpentSwimming;
    expect(spent).toBe(0);
    expect(w.motility.vx).toBe(0);
  });

  it('a swimming cell has measurably less ATP to build with', () => {
    // The claim in its most direct form: identical cells, one swimming, and the swimmer
    // is poorer. Both are charged identically and neither is producing.
    const still = new World();
    const swimmer = new World();
    for (const w of [still, swimmer]) {
      w.addFlagellum(membraneAt(w, 0)[0]!);
      charge(w);
    }
    still.setHeading(null);
    swimmer.setHeading(Math.PI);

    run(still, 6);
    run(swimmer, 6);

    expect(swimmer.atp).toBeLessThan(still.atp);
    // And by roughly the thrust bill, not some incidental amount.
    expect(still.atp - swimmer.atp).toBeCloseTo(FLAGELLUM_ATP_PER_SECOND * 6, -1);
  });

  it('a browning-out cell slows down before it stops', () => {
    // Partial payment throttles thrust rather than cutting out, which is both truer and
    // more readable than a switch — you can see the cell labouring.
    const w = new World();
    for (const t of membraneAt(w, 0, 3)) w.addFlagellum(t);
    // A few steps' worth at most, so thrust throttles and then stalls (§10A.1).
    w.energy.draw(w.energy.level);
    w.energy.add(0.4);
    w.setHeading(Math.PI);

    // Run until it runs dry — 0.4 ATP covers several steps at 3 flagella, so the stall is
    // a second or so away rather than immediate.
    let stalled = false;
    for (let n = 0; n < Math.round(3 / SIM_DT) && !stalled; n++) stalled = w.step().swimStalled;

    expect(stalled).toBe(true);
    expect(Math.hypot(w.motility.vx, w.motility.vy)).toBeLessThan(FLAGELLUM_SPEED);
  });

  it('more flagella cost more — thrust is not free above one', () => {
    const one = new World();
    const three = new World();
    one.addFlagellum(membraneAt(one, 0)[0]!);
    for (const t of membraneAt(three, 0, 3)) three.addFlagellum(t);
    charge(one);
    charge(three);
    one.setHeading(Math.PI);
    three.setHeading(Math.PI);

    let a = 0;
    let b = 0;
    for (let n = 0; n < Math.round(3 / SIM_DT); n++) {
      a += one.step().atpSpentSwimming;
      b += three.step().atpSpentSwimming;
    }
    expect(b).toBeGreaterThan(a * 2);
  });
});

describe('§10A.1 — steering by choosing which propellers fire', () => {
  it('only flagella pushing the right way fire', () => {
    const w = new World();
    const east = w.addFlagellum(membraneAt(w, 0)[0]!)!; // pushes west
    const west = w.addFlagellum(membraneAt(w, Math.PI)[0]!)!; // pushes east
    charge(w);

    w.setHeading(Math.PI); // want to go west
    w.step();
    expect(east.firing).toBe(true);
    expect(west.firing).toBe(false);

    w.setHeading(0); // now east
    w.step();
    expect(east.firing).toBe(false);
    expect(west.firing).toBe(true);
  });

  it('a cell can travel ANY direction, by turning to face it (§10A.1a)', () => {
    // This asserted the opposite until playtesting: that flagella on one face meant you
    // could go one way and no other. It was true, and it made the first flagellum almost
    // worthless — 56 ATP and 14 residues bought a vehicle that moved only if the
    // destination happened to lie opposite where you had seated it. Measured, a cell with
    // one flagellum covered 0.2 tiles in sixty seconds of trying.
    //
    // The body turns now. Flagella stay welded to the membrane and rotate with it, so
    // placement still decides how much thrust you get and how far you must come about —
    // but every direction is reachable.
    const w = new World();
    for (const t of membraneAt(w, 0, 3)) w.addFlagellum(t); // all on the east face
    charge(w);

    w.setHeading(Math.PI); // west — immediately achievable
    run(w, 2);
    expect(w.motility.x).toBeLessThan(w.cx);

    // East: nothing points that way to begin with, so the cell must turn right around.
    const xAt = w.motility.x;
    w.setHeading(0);
    run(w, 4);
    expect(w.motility.x).toBeGreaterThan(xAt + 2);
  });

  it('turning takes time, so placement still costs you (§10A.1a)', () => {
    // The counterweight to the test above: if reorienting were free, where you seat a
    // flagellum would stop mattering and §6.7's placement decision would be decoration.
    const aligned = new World();
    for (const t of membraneAt(aligned, 0, 3)) aligned.addFlagellum(t);
    charge(aligned);
    aligned.setHeading(Math.PI); // already pointing this way
    run(aligned, 2);
    const easy = aligned.cx - aligned.motility.x;

    const opposed = new World();
    for (const t of membraneAt(opposed, 0, 3)) opposed.addFlagellum(t);
    charge(opposed);
    opposed.setHeading(0); // must come about first
    run(opposed, 2);
    const hard = opposed.motility.x - opposed.cx;

    // Same flagella, same two seconds: the one that had to turn covers less ground.
    expect(hard).toBeLessThan(easy);
  });

  it('actually moves the cell through the world', () => {
    const w = new World();
    for (const t of membraneAt(w, 0, 2)) w.addFlagellum(t);
    charge(w);
    w.setHeading(Math.PI);
    run(w, 3);

    // ~FLAGELLUM_SPEED tiles/s west, minus alignment losses.
    expect(w.cx - w.motility.x).toBeGreaterThan(FLAGELLUM_SPEED);
    expect(Math.abs(w.motility.y - w.cy)).toBeLessThan(2);
  });
});

describe('§10A.2 — the outside is a place', () => {
  it('the medium changes as the cell swims', () => {
    // The whole point of terrain: what is outside you depends on where you are.
    const w = new World();
    const sampleHere = (): number =>
      w.patches.sample(w.motility.x, w.motility.y - 95, SPECIES_ID.glucose);
    const rich = sampleHere();
    expect(rich).toBeGreaterThan(0); // there IS a richer field to the north

    const homeGlucose = w.grid.totalIn(SPECIES_ID.glucose, w.extra.id);
    for (const t of membraneAt(w, Math.PI / 2, 3)) w.addFlagellum(t); // push north
    charge(w);
    w.setHeading(-Math.PI / 2);
    run(w, 12);

    expect(w.motility.y).toBeLessThan(w.cy - 10); // travelled north
    // And the extracellular field it is sitting in is genuinely different.
    expect(w.grid.totalIn(SPECIES_ID.glucose, w.extra.id)).not.toBeCloseTo(homeGlucose, 0);
  });

  it('foraging depletes the patch you are eating, so staying put loses', () => {
    // §10A.2's reason to move on. A patch that never runs out makes motility pointless.
    const w = new World();
    const home = w.patches.patches.find((p) => p.species === SPECIES_ID.glucose)!;
    home.richness = 1;

    // Forage HARD. The constants are balanced so a single channel is roughly sustainable
    // — depletion and regrowth nearly cancel, which is deliberate: §12's intro must not
    // starve on its own opening pocket. Depletion only bites once you scale up, which is
    // exactly the moment §10A.2 wants you to feel the ground running out beneath you.
    // Testing with one channel measured the balance point, not the mechanic.
    for (const tile of membraneAt(w, Math.PI, 8)) {
      w.transporters.set(tile, channel(SPECIES_ID.glucose, P_CHANNEL_GLUCOSE));
    }
    for (let i = 0; i < 6; i++) w.buildEnzyme();

    run(w, 40);
    expect(home.richness).toBeLessThan(0.95);
  });
});

describe('§10A.3 — chemotaxis, from concentration differences alone', () => {
  it('senses the direction of a gradient', () => {
    // A pure test of the sense step: a field increasing to the east should read as east.
    const heading = senseGradient((dx) => 10 + dx * 0.5, 5);
    expect(heading).not.toBeNull();
    expect(Math.abs(heading!)).toBeLessThan(0.2); // ~0 radians = east
  });

  it('returns null on a flat field, so the cell coasts instead of chasing noise', () => {
    expect(senseGradient(() => 7, 5)).toBeNull();
  });

  it('steers the cell UP the gradient it can actually sense', () => {
    // §10A.3's claim is "steers up a concentration gradient", and the honest test of it is
    // that the concentration WHERE THE CELL IS goes up.
    //
    // The first version of this test asserted the cell approached the distant rich patch,
    // and it failed — correctly. Chemotaxis is greedy and local: a real cell climbs the
    // gradient it can smell, not the best patch on the map. Sitting between a close pocket
    // and a far richer one, it climbs the near one, which is what a bacterium does. The
    // test was wrong about the biology, not the code.
    const w = new World();
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      for (const t of membraneAt(w, a, 2)) w.addFlagellum(t);
    }
    charge(w);

    const here = (): number => w.patches.sample(w.motility.x, w.motility.y, SPECIES_ID.glucose);
    const before = here();

    w.setChemotaxis(SPECIES_ID.glucose);
    for (let n = 0; n < Math.round(20 / SIM_DT); n++) {
      charge(w); // isolate steering from starvation
      w.step();
    }

    expect(here()).toBeGreaterThan(before);
    // And it genuinely travelled to get there, rather than sitting still.
    expect(Math.hypot(w.motility.x - w.cx, w.motility.y - w.cy)).toBeGreaterThan(3);
  });

  it('a repellent subtracts — hostile zones push the heading away', () => {
    // §10A.2's toxic zone needs no new primitive: it is the same sensing loop with a sign.
    const w = new World();
    const toxin = w.patches.patches.find((p) => p.hostile)!;
    const toward = Math.atan2(toxin.y - w.motility.y, toxin.x - w.motility.x);

    w.setChemotaxis(SPECIES_ID.glucose);
    w.step();
    const chosen = w.motility.heading;
    expect(chosen).not.toBeNull();

    // Whatever it picked, it is not steering straight into the toxin.
    let diff = Math.abs(chosen! - toward) % (2 * Math.PI);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    expect(diff).toBeGreaterThan(0.3);
  });
});

describe('motility does not disturb the intro', () => {
  it('a cell that never builds a flagellum behaves exactly as before', () => {
    // §10A.4's arc starts with a stationary cell, and adding motility must not change
    // what §12 feels like for a player who has not built one yet.
    const w = new World();
    w.buildGlucoseChannel();
    w.buildEnzyme();
    run(w, 30);

    expect(w.motility.x).toBe(w.cx);
    expect(w.motility.y).toBe(w.cy);
    expect(w.cyto.lysed).toBe(false);

    // The metabolism is RUNNING — asserted against a control rather than by counting
    // glucose on hand. A snapshot count is the wrong question now: one channel supplies
    // 3.6 units/s and one enzyme consumes 3.571, so §13.4's "one face feeds one enzyme"
    // holds almost exactly and the standing stock hovers at zero. That looks identical to
    // starvation and is the opposite of it.
    const control = new World();
    run(control, 30); // same clock, no channel and no enzyme
    expect(w.atp).toBeGreaterThan(control.atp);
  });
});
