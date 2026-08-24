/**
 * Re-measure §17's SA:V sweep on the fixed-timestep grid.
 *
 * §17.2 flags every number in §17.3 and §17.4 as provisional, because `belts_vs_sav.html`
 * applied its diffusion term per frame with no `dt` while scaling consumption per second.
 * Penetration depth — and therefore the whole quantitative story — tracked the display's
 * refresh rate. This script measures the same phenomena with correct time scaling and no
 * display involved at all, which is the point of putting the sim in its own process.
 *
 * It measures the two bottlenecks §17.1 insists are distinct:
 *
 *   TRANSIT  — can nutrient reach the deep interior before being consumed en route?
 *              Cytoskeletal streaming (§4.7) fully solves this.
 *   FLUX     — can enough cross the membrane per second at all? Capped by
 *              transporter_density x membrane_area. Belts do NOTHING for this.
 *
 * Run: npm run sweep
 */

import {
  CYTOPLASM,
  EXTRACELLULAR,
  Grid,
  Role,
  constants,
  diffuse,
  stampCell,
} from '../packages/sim/src/index.js';
import { SPECIES_ID } from '../packages/sim/src/species.js';

const { SIM_DT } = constants;

const GLU = SPECIES_ID.glucose;

const D = constants.DIFFUSION.glucose!; // 10 tiles^2/s
const IMPORT_PER_MEM = constants.IMPORT_PER_MEM; // 0.2747 /tile/s — P x sustained density
const STARVE = 0.16; // §17.2's threshold, kept for comparability
const C_OUT = 1.0; // extracellular concentration held steep by circulation
const SETTLE_SECONDS = 400;

interface Row {
  radius: number;
  interiorRadius: number;
  membraneTiles: number;
  interiorTiles: number;
  supply: number;
  demand: number;
  sd: number;
  starvingPct: number;
  starvingPctStreaming: number;
}

/**
 * Steady state of the finite-flux model at one radius.
 *
 * `consumePerTile` is zero-order (constant, not proportional to concentration), per
 * §17.3: saturated enzymes run flat out, which is what makes the steady-state profile
 * fall PARABOLICALLY and hit zero at a finite depth — a genuine front, unlike the
 * never-quite-zero asymptote first-order decay would give.
 */
function measure(radius: number, consumePerTile: number, streaming: boolean): {
  starvingPct: number;
  membraneTiles: number;
  interiorTiles: number;
} {
  const size = Math.ceil(radius * 2) + 10;
  const grid = new Grid(size, size);
  const c = size / 2;
  stampCell(grid, { cx: c, cy: c, radius });

  const interior: number[] = [];
  const membrane: number[] = [];
  for (let i = 0; i < grid.tileCount; i++) {
    if (grid.role[i] === Role.MEMBRANE) membrane.push(i);
    else if (grid.compartment[i] === CYTOPLASM) interior.push(i);
  }

  // Outside is held at C_OUT: circulation keeps the far side clear (§6.8), so import is
  // limited by the membrane, not by a depleting neighbourhood.
  for (let i = 0; i < grid.tileCount; i++) {
    if (grid.compartment[i] === EXTRACELLULAR) grid.set(GLU, i, C_OUT);
  }

  const steps = Math.round(SETTLE_SECONDS / SIM_DT);
  for (let n = 0; n < steps; n++) {
    // FINITE influx: each membrane tile passes P*(c_out - c_in) into its inner neighbour.
    // Supply is therefore proportional to SURFACE, which is the whole point — §17.2 warns
    // that a fixed-concentration membrane makes it an infinite source and models only the
    // transit limit, which is the flaw that superseded `sav_wall.html`.
    for (const m of membrane) {
      const inI = grid.inward[m]!;
      if (inI < 0) continue;
      const j = IMPORT_PER_MEM * (C_OUT - grid.get(GLU, inI)) * SIM_DT;
      if (j > 0) grid.add(GLU, inI, j);
    }

    diffuse(grid, GLU, D, SIM_DT);

    for (const i of interior) {
      grid.set(GLU, i, Math.max(0, grid.get(GLU, i) - consumePerTile * SIM_DT));
    }

    // Streaming: motors homogenise the interior far faster than diffusion (§4.7). This is
    // the mechanism that fully solves TRANSIT — and, at large radius, socialises the
    // famine (§17.4).
    if (streaming) {
      let sum = 0;
      for (const i of interior) sum += grid.get(GLU, i);
      const mean = sum / interior.length;
      const k = Math.min(1, 3.5 * SIM_DT);
      for (const i of interior) grid.set(GLU, i, grid.get(GLU, i) + (mean - grid.get(GLU, i)) * k);
    }
  }

  let starving = 0;
  for (const i of interior) if (grid.get(GLU, i) < STARVE) starving++;

  return {
    starvingPct: (100 * starving) / interior.length,
    membraneTiles: membrane.length,
    interiorTiles: interior.length,
  };
}

function main(): void {
  console.log('PROTOCELL — §17 SA:V sweep, re-measured on the fixed-timestep grid');
  console.log('='.repeat(78));
  console.log(
    `D=${D}  IMPORT_PER_MEM=${IMPORT_PER_MEM.toFixed(4)}  starve<${STARVE}  ` +
      `dt=1/${1 / SIM_DT}  settle=${SETTLE_SECONDS}s`,
  );

  // §13.6's first attempt put enzyme density at 0.0177 by solving the TRANSIT constraint
  // alone (L = R0). That is unachievable: at that density the membrane cannot supply the
  // interior at ANY size, and the first run of this sweep read 100% starving in every
  // row, with Supply/Demand never above 1.09x.
  //
  // The binding constraint is FLUX, and there is a hard condition for belts to matter at
  // all. In 2D, supply ~ perimeter and demand ~ area, so:
  //
  //     transit fails when  R_int > L      where L   = sqrt(2*D*c0/k)
  //     flux    fails when  R     > R_flux where R_f = 2*P/k
  //
  // Belts (§4.7) fix transit and do nothing for flux, so belts are only ever useful in
  // the window L < R < R_flux. That window exists only when L < R_flux, i.e.
  //
  //     k  <  2*P^2/(D*c0)   =  0.0151
  //
  // Above that threshold §17.5's three-tier ladder collapses to two: the cell hits the
  // absolute flux ceiling before transit ever becomes its problem, and cytoskeletal
  // belts are strictly a waste of ATP. That condition is not stated anywhere in §17 and
  // it is the single most important number for making the ladder real.
  const ENZYME_DENSITY = 0.00224; // ~2.2 enzymes per 1000 tiles
  const consumePerTile = ENZYME_DENSITY * constants.ENZYME_TURNOVER;
  const L = constants.penetrationDepth(D, C_OUT, consumePerTile);
  const rFlux = (2 * IMPORT_PER_MEM) / consumePerTile;
  const kMaxForBelts = (2 * IMPORT_PER_MEM ** 2) / (D * C_OUT);

  console.log(
    `enzyme density=${ENZYME_DENSITY} -> k=${consumePerTile.toFixed(4)} glucose/tile/s`,
  );
  console.log(`predicted transit knee   L = sqrt(2*D*c0/k) = ${L.toFixed(1)} tiles`);
  console.log(`predicted flux ceiling R_f = 2*P/k          = ${rFlux.toFixed(1)} tiles`);
  console.log(
    `belt window exists iff k < 2P^2/(D*c0) = ${kMaxForBelts.toFixed(4)}  ` +
      `(k=${consumePerTile.toFixed(4)} ${consumePerTile < kMaxForBelts ? 'OK' : 'FAILS'})`,
  );
  console.log(`§4.1 intro cell sits at R_interior = ${(constants.R0 - 1).toFixed(1)} — well inside both`);
  console.log('');

  const rows: Row[] = [];
  for (const radius of [18, 30, 45, 52, 58, 65, 72, 85]) {
    const plain = measure(radius, consumePerTile, false);
    const streamed = measure(radius, consumePerTile, true);

    const supply = plain.membraneTiles * IMPORT_PER_MEM * C_OUT;
    const demand = (plain.interiorTiles + plain.membraneTiles) * consumePerTile;

    rows.push({
      radius,
      interiorRadius: radius - 1,
      membraneTiles: plain.membraneTiles,
      interiorTiles: plain.interiorTiles,
      supply,
      demand,
      sd: supply / demand,
      starvingPct: plain.starvingPct,
      starvingPctStreaming: streamed.starvingPct,
    });
  }

  console.log(
    'R_int'.padStart(6) +
      'mem'.padStart(7) +
      'int'.padStart(8) +
      'Supply/Demand'.padStart(15) +
      'starve%'.padStart(10) +
      'starve% belts'.padStart(15),
  );
  console.log('-'.repeat(78));
  for (const r of rows) {
    console.log(
      String(r.interiorRadius).padStart(6) +
        String(r.membraneTiles).padStart(7) +
        String(r.interiorTiles).padStart(8) +
        (r.sd.toFixed(2) + '×').padStart(15) +
        r.starvingPct.toFixed(1).padStart(10) +
        r.starvingPctStreaming.toFixed(1).padStart(15),
    );
  }

  console.log('');
  const firstStarve = rows.find((r) => r.starvingPct > 0.5);
  const firstSdUnder1 = rows.find((r) => r.sd < 1);
  console.log(
    `TRANSIT knee (first dead core):   R_interior = ${firstStarve ? firstStarve.interiorRadius : '>90'}`,
  );
  console.log(
    `FLUX ceiling (Supply/Demand < 1): R_interior = ${firstSdUnder1 ? firstSdUnder1.interiorRadius : '>90'}`,
  );
  const worse = rows.filter((r) => r.starvingPctStreaming > r.starvingPct + 0.5);
  console.log(
    `§17.4 socialised famine (belts WORSE) first at: ` +
      `R_interior = ${worse.length ? worse[0]!.interiorRadius : 'never in range'}`,
  );
}

main();
