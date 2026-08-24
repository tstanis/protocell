/**
 * Carving a cell into the lattice, and orienting its membrane. SPEC.md §4.1, §4.2.
 *
 * §3.6 names this the genuinely difficult seam: "A grid is fixed space with variable
 * content; a cell is variable space with its own boundary." Growth, division, and
 * blebbing all move a boundary through a fixed lattice, which means re-partitioning
 * which tiles are membrane and which are interior MID-SIMULATION. Everything else on
 * the grid is comparatively easy, so this module is where the care goes.
 */

import { Grid, Role, CYTOPLASM, EXTRACELLULAR, NO_COMPARTMENT } from './grid.js';

export interface CellSpec {
  cx: number;
  cy: number;
  /** Outer radius in tiles. §4.1's default cell is R0 = 17.84. */
  radius: number;
  /** Compartment id for the interior. Defaults to CYTOPLASM. */
  interior?: number;
  /** Compartment id for everything outside. Defaults to EXTRACELLULAR. */
  exterior?: number;
}

/**
 * Stamp a disc-shaped cell: a filled interior wrapped in a ONE-TILE-THICK membrane ring.
 *
 * §4.1 is emphatic about size, and the reason is worth keeping in view: at ~1000
 * interior tiles the ring is ~10% and reads as a proper skin, the interior has a deep
 * middle (a dropped solute has ~15 tiles to traverse, so gradients form visibly over
 * seconds), and division leaves two comfortable ~500-tile daughters. At ~100 tiles the
 * ring would be ~36% — a fat rind, not a skin — with no interior depth for a gradient to
 * exist in and near-instant equilibration. There would be no game.
 */
export function stampCell(grid: Grid, spec: CellSpec): void {
  const interior = spec.interior ?? CYTOPLASM;
  const exterior = spec.exterior ?? EXTRACELLULAR;
  const { cx, cy, radius } = spec;
  const inner = radius - 1;

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = grid.idx(x, y);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);

      if (d <= inner) {
        grid.role[i] = Role.FLUID;
        grid.compartment[i] = interior;
      } else if (d <= radius) {
        grid.role[i] = Role.MEMBRANE;
        grid.compartment[i] = NO_COMPARTMENT;
      } else {
        grid.role[i] = Role.FLUID;
        grid.compartment[i] = exterior;
      }
    }
  }

  orientMembrane(grid, interior);
}

/**
 * Compute each membrane tile's normal and transport area.
 *
 * §4.2: "Each membrane tile needs a normal pointing toward its cytoplasm neighbour (so a
 * pump knows which way is 'out')."
 *
 * The fiddly case, called out in the spec and handled explicitly here, is a corner tile
 * with interior on two sides. Two things fall out of it:
 *
 *   - It faces outward on more than one edge, so it exchanges faster than a flat tile.
 *     `edgeArea` records that, and transport scales by it, so total flux across a
 *     wrinkled boundary is right rather than silently under-counted. That matters
 *     directly for §17.5's "flatten/wrinkle to pack surface" escape — wrinkling has to
 *     actually buy intake, or the escape is cosmetic.
 *   - Its normal is ambiguous. We pick the interior neighbour best aligned with the
 *     averaged inward direction, which is stable under growth and does not flip-flop
 *     between frames the way a first-match rule does.
 *
 * A membrane tile with no interior neighbour at all (a spur, or a one-tile-wide neck
 * mid-division) is left unoriented with inward = -1, and transport skips it. That is the
 * correct conservative behaviour: an unoriented wall is still a wall.
 */
export function orientMembrane(grid: Grid, interior: number): void {
  const { width, height, role, compartment, inward, outward, edgeArea } = grid;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = grid.idx(x, y);
      if (role[i] !== Role.MEMBRANE) continue;

      inward[i] = -1;
      outward[i] = -1;
      edgeArea[i] = 0;

      const neighbours: Array<{ idx: number; dx: number; dy: number }> = [];
      if (x > 0) neighbours.push({ idx: i - 1, dx: -1, dy: 0 });
      if (x < width - 1) neighbours.push({ idx: i + 1, dx: 1, dy: 0 });
      if (y > 0) neighbours.push({ idx: i - width, dx: 0, dy: -1 });
      if (y < height - 1) neighbours.push({ idx: i + width, dx: 0, dy: 1 });

      // Averaged inward direction, used to disambiguate corners.
      let ax = 0;
      let ay = 0;
      let innerEdges = 0;
      let outerEdges = 0;
      for (const n of neighbours) {
        if (role[n.idx] !== Role.FLUID) continue;
        if (compartment[n.idx] === interior) {
          ax += n.dx;
          ay += n.dy;
          innerEdges++;
        } else {
          outerEdges++;
        }
      }

      if (innerEdges === 0 || outerEdges === 0) continue;

      // Pick the interior neighbour best aligned with the averaged inward direction.
      let best = -1;
      let bestScore = -Infinity;
      for (const n of neighbours) {
        if (role[n.idx] !== Role.FLUID || compartment[n.idx] !== interior) continue;
        const score = n.dx * ax + n.dy * ay;
        if (score > bestScore) {
          bestScore = score;
          best = n.idx;
        }
      }

      // The outer neighbour most nearly opposite that normal.
      let bestOut = -1;
      let bestOutScore = -Infinity;
      for (const n of neighbours) {
        if (role[n.idx] !== Role.FLUID || compartment[n.idx] === interior) continue;
        const score = -(n.dx * ax + n.dy * ay);
        if (score > bestOutScore) {
          bestOutScore = score;
          bestOut = n.idx;
        }
      }

      inward[i] = best;
      outward[i] = bestOut;
      edgeArea[i] = outerEdges;
    }
  }
}

/** Membrane tile indices, in row-major order. The clickable, hand-scale slots (§4.1). */
export function membraneTiles(grid: Grid): number[] {
  const out: number[] = [];
  for (let i = 0; i < grid.tileCount; i++) if (grid.role[i] === Role.MEMBRANE) out.push(i);
  return out;
}

/**
 * Can this membrane tile actually host a protein?
 *
 * Not every membrane tile can. §4.1's ring is the annulus `radius-1 < d <= radius` — a
 * radial thickness of exactly one tile, which rasterizes to a wall that is genuinely TWO
 * tiles thick wherever the boundary runs diagonally. The buried tiles of those doubled
 * stretches touch fluid on neither side, so `orientMembrane` leaves them unoriented and
 * `stepTransport` skips them. They are wall, not gate.
 *
 * Measured on §4.1's default cell: **20 of 108 membrane tiles, 18.5%**, clustered at the
 * four diagonal shoulders. That is not a rare corner case, it is a fifth of the ring.
 *
 * This predicate exists because two player-visible bugs came from not having it:
 *   - The client lit up all 108 tiles as legal deployment sites, so ~1 click in 5 landed
 *     on a tile that refused a flagellum with "cannot anchor there" and no explanation.
 *   - Worse, `deploy` only checked orientation for flagella. A TRANSPORTER seated on a
 *     buried tile was accepted, drawn, and reported as success — and then transported
 *     nothing, ever, with no error. Given §12.3's finding that placement beats count,
 *     a silently inert carrier is about the most expensive lie this game can tell.
 */
export function isGateTile(grid: Grid, i: number): boolean {
  return grid.role[i] === Role.MEMBRANE && (grid.inward[i] ?? -1) >= 0 && (grid.outward[i] ?? -1) >= 0;
}

/** The membrane tiles a protein can actually be seated in. See {@link isGateTile}. */
export function gateTiles(grid: Grid): number[] {
  const out: number[] = [];
  for (let i = 0; i < grid.tileCount; i++) if (isGateTile(grid, i)) out.push(i);
  return out;
}

/**
 * The membrane tiles whose outward normal points closest to `angle` (radians), spanning
 * `count` tiles. This is how "place a transporter on the face pointing at the glucose
 * zone" (§12.2) resolves to concrete tiles.
 *
 * §6.7: transporters are directional and face-specific, membrane surface is finite real
 * estate, and where each one sits is a real decision. §13.4 makes the arithmetic
 * legible — one full-gradient face of TRANSPORTER_FACE_TILES feeds exactly one enzyme.
 */
export function faceTiles(grid: Grid, cx: number, cy: number, angle: number, count: number): number[] {
  // Gate tiles only. A face built from the full ring can include buried wall, and a
  // transporter seated there is accepted and then transports nothing — so a "13-tile
  // face" would quietly deliver less flux than §13.4's arithmetic promises.
  //
  // Measured no-op for the three faces §12 actually uses: the dead tiles sit at the
  // diagonal shoulders and all of glucose/amino/lactate are cardinal, so each already
  // selected 13 live tiles. This is insurance against a wider face or a new angle, not a
  // re-tuning — checked deliberately, because changing effective membrane area is exactly
  // what silently re-tunes the whole economy.
  const tiles = gateTiles(grid);
  const scored = tiles.map((i) => {
    const x = (i % grid.width) + 0.5;
    const y = Math.floor(i / grid.width) + 0.5;
    const a = Math.atan2(y - cy, x - cx);
    let d = Math.abs(a - angle) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return { i, d };
  });
  scored.sort((p, q) => p.d - q.d);
  return scored.slice(0, count).map((s) => s.i);
}

export { EXTRACELLULAR, CYTOPLASM };
