/**
 * Which membrane tiles can actually hold a protein. SPEC.md §4.2, §6.7.
 *
 * This file exists because of a bug that was invisible from every direction at once.
 *
 * §4.1 stamps the ring as the annulus `radius-1 < d <= radius` — one tile thick RADIALLY.
 * On a square lattice that rasterizes to a wall two tiles thick wherever the boundary runs
 * diagonally, and the buried tile of each doubled stretch touches fluid on neither side.
 * `orientMembrane` correctly leaves those unoriented and `stepTransport` correctly skips
 * them. Nothing in the sim was wrong.
 *
 * What was wrong was everything built on top:
 *   - the client lit up all 108 ring tiles as legal deployment sites,
 *   - `deploy` checked orientation only for flagella, so a transporter was ACCEPTED onto a
 *     dead tile, drawn there, and reported as a success — and then moved nothing, ever,
 *   - and the wire test covering exactly this path chose the FARTHEST membrane tile, which
 *     is one of the dead ones, so the test asserted the bug and passed.
 *
 * A fifth of the ring behaved this way. §12.3 already found that placement beats count for
 * transporters; a placement that silently does nothing is the worst version of that.
 */

import { describe, expect, it } from 'vitest';
import { World, FACE } from '../src/world.js';
import { Role } from '../src/grid.js';
import { faceTiles, gateTiles, isGateTile, membraneTiles } from '../src/membrane.js';
import { TRANSPORTER_FACE_TILES } from '../src/constants.js';
import { AMINO_TYPES, SPECIES_ID, aminoId, type AminoType } from '../src/species.js';

describe('membrane gates (§4.2)', () => {
  it('the ring contains tiles that are wall rather than gate, and there are a lot of them', () => {
    const w = new World();
    const ring = membraneTiles(w.grid);
    const gates = gateTiles(w.grid);

    expect(gates.length).toBeGreaterThan(0);
    expect(gates.length).toBeLessThan(ring.length);
    for (const g of gates) expect(ring).toContain(g);

    // The headline number. Not asserted tightly — it is a property of the rasterization
    // and would move if §4.1's radius changed — but asserted as SUBSTANTIAL, because the
    // entire reason this concept exists is that it is not a negligible corner case.
    const dead = ring.length - gates.length;
    expect(dead / ring.length).toBeGreaterThan(0.1);
  });

  it('a gate tile touches both sides; a dead tile touches neither', () => {
    const w = new World();
    for (const i of membraneTiles(w.grid)) {
      const hasIn = (w.grid.inward[i] ?? -1) >= 0;
      const hasOut = (w.grid.outward[i] ?? -1) >= 0;
      expect(isGateTile(w.grid, i)).toBe(hasIn && hasOut);
      if (isGateTile(w.grid, i)) {
        // And the neighbours it names really are fluid on the correct sides.
        expect(w.grid.role[w.grid.inward[i]!]).toBe(Role.FLUID);
        expect(w.grid.role[w.grid.outward[i]!]).toBe(Role.FLUID);
      }
    }
  });

  it('REFUSES a transporter on dead wall instead of silently accepting it', () => {
    // The trap, stated directly. Before this check the deploy succeeded, the client drew a
    // channel on the wall, and the player had a pore that could never move anything with
    // no feedback of any kind.
    const w = new World();
    const dead = membraneTiles(w.grid).filter((i) => !isGateTile(w.grid, i));
    expect(dead.length).toBeGreaterThan(0);
    const tile = dead[0]!;

    w.bot.x = (tile % w.grid.width) + 0.5;
    w.bot.y = Math.floor(tile / w.grid.width) + 0.5;

    // Both membrane-bound products, because the bug was that only ONE of them checked.
    for (const gene of ['glucoseChannel', 'flagellum'] as const) {
      w.cancelBuild();
      w.bot.x = w.nucleus.x;
      w.bot.y = w.nucleus.y;
      expect(w.selectGene(gene).ok).toBe(true);
      // Fast-forward the assembly rather than simulating every bond.
      for (let i = 0; i < 200_000 && w.build.phase !== 'carrying'; i++) w.step();
      expect(w.build.phase).toBe('carrying');

      w.bot.x = (tile % w.grid.width) + 0.5;
      w.bot.y = Math.floor(tile / w.grid.width) + 0.5;
      const res = w.deploy(tile);
      expect(res.ok).toBe(false);
      expect(res.reason).toBeTruthy();
      // And nothing was seated as a consolation prize.
      expect(w.transporters.has(tile)).toBe(false);
      expect(w.flagella.some((f) => f.tile === tile)).toBe(false);
    }
  });

  it('faceTiles never hands back dead wall (§13.4 counts on every face tile working)', () => {
    const w = new World();
    for (const angle of Object.values(FACE)) {
      const face = faceTiles(w.grid, w.cx, w.cy, angle, TRANSPORTER_FACE_TILES);
      expect(face.length).toBe(TRANSPORTER_FACE_TILES);
      for (const t of face) expect(isGateTile(w.grid, t)).toBe(true);
    }
  });

  it('a face wide enough to reach the diagonals still returns only live tiles', () => {
    // The case the measured no-op does not cover: the three faces §12 uses are cardinal
    // and never reach the diagonal shoulders, so filtering changed nothing for them. A
    // wider face does reach them, and that is the case the filter is actually for.
    const w = new World();
    const wide = faceTiles(w.grid, w.cx, w.cy, Math.PI / 4, 40);
    expect(wide.length).toBeGreaterThan(TRANSPORTER_FACE_TILES);
    for (const t of wide) expect(isGateTile(w.grid, t)).toBe(true);
  });

  it('every gate tile can actually host a flagellum (§10A.1)', () => {
    // The client offers precisely `gateTiles` as deployment sites, so any tile in that
    // list that `addFlagellum` rejects is a click that does nothing.
    const w = new World();
    const gates = gateTiles(w.grid);
    for (const t of gates) {
      const f = w.addFlagellum(t);
      expect(f).not.toBeNull();
      // Thrust points inward — §10A.1's "pushes the cell away from the face it sits on".
      const tx = (t % w.grid.width) + 0.5;
      const ty = Math.floor(t / w.grid.width) + 0.5;
      expect(f!.dx * (w.cx - tx) + f!.dy * (w.cy - ty)).toBeGreaterThan(0);
    }
    expect(w.flagella.length).toBe(gates.length);
  });

  it('the intro economy is unchanged by all of this', () => {
    // Guard against the regression class that has bitten twice: anything that alters
    // EFFECTIVE membrane area silently re-tunes import, and the cell lyses on an arc it
    // used to survive. The three §12 faces must still be 13 live tiles each.
    const w = new World();
    const glucose = faceTiles(w.grid, w.cx, w.cy, FACE.glucose, TRANSPORTER_FACE_TILES);
    expect(glucose.length).toBe(13);
    expect(glucose.every((t) => isGateTile(w.grid, t))).toBe(true);
    expect(new Set(glucose).size).toBe(13);
    expect(SPECIES_ID.glucose).toBe(0);
  });
});

describe('one protein per tile, actually enforced (§6.7, §5b)', () => {
  it('seating a transporter for every residue gives FIVE, on five distinct tiles', () => {
    // The bug this locks down was invisible from the HUD and from the sim's own totals.
    // Each residue transporter is aimed at its own deposit, and gly's deposit sits at
    // almost the same bearing as val's (-0.49 vs -0.52 rad) — so both resolved to the
    // single nearest gate tile and the second silently overwrote the first. The player
    // had built a glycine transporter and did not have one, and the only symptom was that
    // glycine never arrived.
    //
    // §6.7 says membrane real estate is finite and one tile carries one protein. That is
    // a constraint on PLACEMENT, not just a fact about storage: seating must find a free
    // tile rather than evict whatever is already there.
    const w = new World();
    w.buildAminoTransporter();

    const seated = new Map<number, AminoType>();
    for (const [tile, t] of w.transporters) {
      const type = AMINO_TYPES.find((a) => aminoId(a) === t.species);
      if (type) seated.set(tile, type);
    }

    expect(seated.size).toBe(AMINO_TYPES.length);
    expect(new Set(seated.values()).size).toBe(AMINO_TYPES.length); // all five types
    for (const tile of seated.keys()) expect(isGateTile(w.grid, tile)).toBe(true);
  });

  it('never evicts an existing transporter to seat a new one', () => {
    const w = new World();
    const first = w.buildAminoChannelFor('gly')[0]!;
    const before = w.transporters.get(first)!.species;

    // Every other residue in turn — none of them may take gly's tile.
    for (const t of ['val', 'leu', 'lys', 'ala'] as const) w.buildAminoChannelFor(t);

    expect(w.transporters.get(first)?.species).toBe(before);
    expect(w.transporters.size).toBe(AMINO_TYPES.length);
  });
});
