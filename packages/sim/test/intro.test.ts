/**
 * The §12 intro, played end to end on the real grid.
 *
 * This is the integration test the whole architecture is for: every beat below has to
 * EMERGE from the coupled systems, not from a script. §10.1 is explicit that "solute X
 * exceeds threshold → die" is a made-up mechanic, so nothing here may be triggered
 * directly — the crisis has to arrive on its own, and the fix has to work for a reason.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../src/world.js';
import { SIM_DT, UPKEEP_PER_TILE } from '../src/constants.js';
import { CYTOPLASM } from '../src/grid.js';
import { SPECIES_ID, aminoId } from '../src/species.js';

const GLU = SPECIES_ID.glucose;
const LAC = SPECIES_ID.lactate;

function run(w: World, seconds: number): void {
  const steps = Math.round(seconds / SIM_DT);
  for (let n = 0; n < steps; n++) w.step();
}

describe('§12.1 — opening state', () => {
  it('builds a cell with roughly the §4.1 geometry', () => {
    const w = new World();
    // ~1000 interior tiles wrapped by a ~10% membrane ring. Discretising a circle onto a
    // lattice will not hit the numbers exactly; the ratio is what matters.
    expect(w.cyto.tileCount).toBeGreaterThan(800);
    expect(w.cyto.tileCount).toBeLessThan(1100);
    const ring = w.grid.countRole(1);
    expect(ring / w.cyto.tileCount).toBeGreaterThan(0.08);
    expect(ring / w.cyto.tileCount).toBeLessThan(0.20);
  });

  it('starts with a draining ATP reserve and no way to make more', () => {
    // "Do nothing and ATP falls, the membrane slackens, motion slows — the pressure that
    // makes the first build urgent."
    const w = new World();
    const start = w.atp;
    run(w, 10);

    // §13.2's rate is per tile, so the drain follows the cell's ACTUAL size rather than
    // §4.1's nominal 1120 — discretising a circle onto a lattice lands a bit under that.
    // Asserting against the nominal 1.8/s would be asserting against a number this cell
    // does not have.
    const expected = UPKEEP_PER_TILE * (w.cyto.tileCount + w.membraneTiles) * 10;
    expect(w.atp).toBeLessThan(start);
    expect(w.atp).toBeCloseTo(start - expected, 1);
  });

  it('has a real extracellular gradient before the player does anything', () => {
    const w = new World();
    const conc = w.concentrationPlane(GLU);
    const near = conc[w.grid.idx(Math.round(w.cx - w.radius - 20), Math.round(w.cy))]!;
    const far = conc[w.grid.idx(Math.round(w.cx + w.radius + 20), Math.round(w.cy))]!;
    expect(near).toBeGreaterThan(0.5);
    expect(far).toBeLessThan(near / 10);
  });

  it('a bare membrane keeps glucose out — no transporter, no import', () => {
    // §4.2: near-zero permeability by default. The cell must be genuinely sealed, or
    // Act 1 has nothing to accomplish.
    const w = new World();
    run(w, 20);
    expect(w.interiorAmount(GLU)).toBeLessThan(0.5);
  });
});

describe('§12.2 — Act 1: import food, and discover it is not energy yet', () => {
  it('the channel imports down-gradient, for free', () => {
    const w = new World();
    w.buildGlucoseChannel();
    run(w, 20);
    expect(w.interiorAmount(GLU)).toBeGreaterThan(1);
  });

  it('but ATP keeps falling — raw glucose is not energy', () => {
    // The Act 1 → Act 2 hinge. Importing food must NOT solve the death clock, or the
    // enzyme has no reason to exist.
    const w = new World();
    w.buildGlucoseChannel();
    const start = w.atp;
    run(w, 20);
    expect(w.interiorAmount(GLU)).toBeGreaterThan(1);
    expect(w.atp).toBeLessThan(start);
  });
});

describe('§12.3 — Act 2: close the loop', () => {
  it('the enzyme turns the ATP curve around — the emotional peak', () => {
    const w = new World();
    w.buildGlucoseChannel();
    w.buildEnzyme();

    run(w, 15); // let import reach the enzyme
    const mid = w.atp;
    run(w, 25);

    expect(w.atp).toBeGreaterThan(mid);
    expect(w.cyto.lysed).toBe(false);
  });

  it('an enzyme with no supply line starves — §4.7 previewed', () => {
    // Same enzyme, placed at the far side of the cell from the channel. Diffusion alone
    // has to carry substrate ~2R, and §13.4's "one face feeds one enzyme" assumes the
    // enzyme is near the face. This is the honest preview of spatial logistics.
    const near = new World();
    near.buildGlucoseChannel();
    near.buildEnzyme();

    const far = new World();
    far.buildGlucoseChannel();
    const opposite = far.grid.idx(Math.round(far.cx + far.radius - 4), Math.round(far.cy));
    far.buildEnzyme(opposite);

    run(near, 40);
    run(far, 40);

    expect(near.interiorAmount(LAC)).toBeGreaterThan(
      far.interiorAmount(LAC),
    );
  });

  it('lactate accumulates and the cell SWELLS — the crisis arrives unprompted', () => {
    // Nothing triggers this. The enzyme runs, waste builds, osmolarity rises, water
    // follows. §10.2's chain, entirely from existing mechanics.
    const w = new World();
    w.buildGlucoseChannel();
    w.buildEnzyme();
    const restVolume = w.cyto.volume;

    run(w, 60);

    expect(w.interiorAmount(LAC)).toBeGreaterThan(10);
    expect(w.cyto.volume).toBeGreaterThan(restVolume);
    expect(w.cyto.tension).toBeGreaterThan(0);
  });

  it('the lactate carrier is life support, not cleanup — measured against a control', () => {
    // Act 2's resolution. Compared against an identical cell that never builds the
    // carrier, rather than against its own earlier self, because the two are different
    // claims and only one of them is true on this timescale: waste falls immediately, but
    // VOLUME lags well behind it. `LP` sets how fast water follows, and `resist` slows the
    // approach further once past rest (§7.3), so a cell can be shedding solute for a
    // minute and still be fractionally larger than when it started.
    //
    // The control isolates what the carrier actually does, and is the honest form of
    // §12.3's promise: build it and you are better off than if you had not.
    const withCarrier = new World();
    const control = new World();
    for (const w of [withCarrier, control]) {
      w.buildGlucoseChannel();
      w.buildEnzyme();
    }
    run(withCarrier, 60);
    run(control, 60);

    const swollenLactate = withCarrier.interiorAmount(LAC);
    expect(withCarrier.cyto.tension).toBeGreaterThan(0);

    // Two carriers, flanking the enzyme — one cannot keep up and placement beats count.
    // See World.buildLactateCarrier for the measurements.
    withCarrier.buildLactateCarrier();
    run(withCarrier, 60);
    run(control, 60);

    // Waste genuinely falls, in absolute terms.
    expect(withCarrier.interiorAmount(LAC)).toBeLessThan(swollenLactate);
    // And against the control, every consequence follows: less waste, less volume,
    // less tension.
    expect(withCarrier.interiorAmount(LAC)).toBeLessThan(
      control.interiorAmount(LAC) * 0.6,
    );
    expect(withCarrier.cyto.volume).toBeLessThan(control.cyto.volume);
    expect(withCarrier.cyto.tension).toBeLessThan(control.cyto.tension);
    expect(withCarrier.cyto.lysed).toBe(false);
  });

  it('a transporter replenishes THE RESIDUE IT CARRIES, and only at its deposit', () => {
    // Two earlier versions of this test asserted things that were true for bad reasons:
    // first that one amino transporter tops up EVERY residue (true only because all five
    // deposits sat at one coordinate), then that it works via a concentration gradient
    // (true only while residues were a field). Since §5b a residue transporter is an
    // INSERTER: in range of its deposit it pulls whole residues at a rate, and the deposit
    // counts down. No gradient, no equilibrium, nothing to render illegibly.
    // IN RANGE: glycine's deposit deliberately overlaps the cell at spawn (§5b.3), so the
    // supply loop is reachable from a fresh cell that cannot yet move. Build the channel,
    // sit still, watch the count climb and the deposit drain.
    const near = new World();
    near.buildAminoChannelFor('gly');
    const nearBefore = near.inventory.get('gly');
    const glyDep = near.patches.patches.find((p) => p.species === aminoId('gly'))!;

    // Park the bot ON the port. Since §5b.5 an import does not reach the inventory by
    // itself — it becomes a particle waiting at the transporter, and someone has to go and
    // collect it. A test that leaves the bot in the middle of the cell measures a hopper
    // filling up, not a supply line working.
    const port = [...near.transporters.keys()].find(
      (t) => near.transporters.get(t)!.species === aminoId('gly'),
    )!;
    const px = (port % near.grid.width) + 0.5;
    const py = Math.floor(port / near.grid.width) + 0.5;
    for (let n = 0; n < Math.round(60 / SIM_DT); n++) {
      near.bot.x = px;
      near.bot.y = py;
      near.step();
    }

    expect(near.inventory.get('gly')).toBeGreaterThan(nearBefore);
    expect(Number.isInteger(near.inventory.get('gly'))).toBe(true); // whole residues only
    expect(glyDep.richness).toBeLessThan(1); // and the deposit is finite

    // OUT OF RANGE: lysine's deposit is 82 tiles out, far beyond its harvest ring, so an
    // identical transporter delivers nothing at all until the cell travels. That gap is
    // what a flagellum is for, and it is why lysine is the residue §12.3 squeezes.
    const far = new World();
    far.buildAminoChannelFor('lys');
    const farBefore = far.inventory.get('lys');
    run(far, 60);
    expect(far.inventory.get('lys')).toBe(farBefore);

    // ...and it starts working once the cell gets there — with the bot at the port to
    // collect what arrives (§5b.5). Both halves are needed: being in range makes the port
    // produce, and collecting is what turns production into stock.
    const lysDep = far.patches.patches.find((p) => p.species === aminoId('lys'))!;
    far.motility.x = lysDep.x;
    far.motility.y = lysDep.y;
    const lysPort = [...far.transporters.keys()].find(
      (t) => far.transporters.get(t)!.species === aminoId('lys'),
    )!;
    const lx = (lysPort % far.grid.width) + 0.5;
    const ly = Math.floor(lysPort / far.grid.width) + 0.5;
    for (let n = 0; n < Math.round(60 / SIM_DT); n++) {
      far.bot.x = lx;
      far.bot.y = ly;
      far.step();
    }
    expect(far.inventory.get('lys')).toBeGreaterThan(farBefore);

    // Typed: a glycine transporter never helps with lysine.
    expect(near.inventory.get('lys')).toBe(new World().inventory.get('lys'));
  });
});

describe('§12 — un-loseable, and the numbers never contradict the costume', () => {
  it('survives the full arc without lysing', () => {
    const w = new World();
    w.buildGlucoseChannel();
    run(w, 10);
    w.buildEnzyme();
    run(w, 40);
    w.buildAminoTransporter();
    run(w, 20);
    w.buildLactateCarrier();
    run(w, 60);

    expect(w.cyto.lysed).toBe(false);
    expect(w.atp).toBeGreaterThan(0);
    expect(w.cyto.tension).toBeLessThan(1);
  });

  it('concentration planes agree with the underlying amounts (§2.1)', () => {
    // The costume is a function of the truth. A renderer reading these planes must see
    // exactly what the HUD totals say is there — no drift, no independent state.
    const w = new World();
    w.buildGlucoseChannel();
    w.buildEnzyme();
    run(w, 30);

    const conc = w.concentrationPlane(LAC);
    let reconstructed = 0;
    for (let i = 0; i < w.grid.tileCount; i++) {
      if (w.grid.compartment[i] === CYTOPLASM) reconstructed += conc[i]! * w.cyto.tileVolume;
    }
    // Relative, not absolute-to-6-places, and the reason is the §15 rule that truth is
    // exact and the costume is quantised: planes are Float32 on purpose. Since §5a a grain
    // deposits its whole ~4.0 into ONE cell where lactate used to be spread thinly across
    // ~900, so the per-cell values are larger and their Float32 steps are correspondingly
    // coarser — the old 5e-7 bound failed at 6.5e-7 on a total of 88. That is rounding in
    // the renderer's copy, which is exactly what the architecture asks for; a tolerance
    // tighter than Float32 was asserting something the wire never promised.
    const truth = w.interiorAmount(LAC);
    expect(truth).toBeGreaterThan(1);
    expect(Math.abs(reconstructed - truth) / truth).toBeLessThan(1e-5);
  });

  it('membrane tiles never accumulate a pool (§4.2)', () => {
    const w = new World();
    w.buildGlucoseChannel();
    w.buildEnzyme();
    w.buildLactateCarrier();
    run(w, 40);

    for (let i = 0; i < w.grid.tileCount; i++) {
      if (w.grid.role[i] !== 1) continue;
      for (const s of w.active) expect(w.grid.get(s, i)).toBe(0);
    }
  });

  it('is deterministic — same inputs, same tick, same state', () => {
    const build = (): World => {
      const w = new World();
      w.buildGlucoseChannel();
      w.buildEnzyme();
      run(w, 30);
      return w;
    };
    const a = build();
    const b = build();
    expect(a.atp).toBe(b.atp);
    expect(a.cyto.volume).toBe(b.cyto.volume);
    expect(Array.from(a.grid.plane(LAC))).toEqual(Array.from(b.grid.plane(LAC)));
  });
});
