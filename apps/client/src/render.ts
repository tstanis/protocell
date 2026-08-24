/**
 * The particle and field renderer. SPEC.md §11.
 *
 * ── What this file is a rewrite of ───────────────────────────────────────────
 * The first version drew one dot per ~0.02 of concentration per tile, over the whole
 * world, for every species, with no aggregate budget. Measured against a live server that
 * came to **102,798 dots per frame**: 205,596 arcs, 205,596 canvas state changes (the
 * composite mode was toggled twice per dot), and 205,596 freshly built `rgba(...)` strings
 * per frame, on top of a ~100k-element array allocated and thrown away each time. At 60fps
 * that is 12.3M arcs/second against a canvas2d budget of roughly 50–100k. It was about
 * 150× over, and typing the amino acids (§5) had quietly multiplied it by five, because
 * each residue became its own full-field cloud.
 *
 * Four rules now hold the cost down, in descending order of what they saved:
 *
 *   1. DOTS ARE FOR THE CELL, TINT IS FOR THE MEDIUM. The extracellular space is ~90% of
 *      the tiles and the least interesting part of the picture; §11.4 already says distant
 *      or bulk regions should read as heatmap tint rather than individual dots. The whole
 *      field is drawn as one scaled image, and dots are spent only inside the cell.
 *   2. A HARD DOT BUDGET. Per-species caps summing to ~1,400, so a concentration spike
 *      costs brightness rather than framerate.
 *   3. BATCHED DRAWING. One `fillStyle`, one path, one `fill()` per species per layer —
 *      instead of two state changes and two paths per dot.
 *   4. NO PER-DOT ALLOCATION. Colours are precomputed; dot objects are pooled and
 *      retargeted rather than rebuilt.
 *
 * §2.1 still holds: dot density within a species is proportional to concentration, and
 * every dot is spawned FROM the received field. The budget clamps the top end, which is a
 * legibility limit rather than a lie — and it is logged in the on-screen counter so the
 * clamp is never invisible.
 */

import type { FieldFrame } from '@protocell/protocol';

/**
 * Dot shape. §11.1 gives density to concentration and colour to identity; shape is a third
 * channel, and it is the one that survives being small, dim, overlapped, or colour-blind.
 *
 * The mapping is not decorative — it is the carbon skeleton:
 *
 *   glucose  HEX      a hexose. Six carbons, six sides.
 *   lactate  TRIANGLE a triose. Three carbons, three sides.
 *   atp      SPARK    a four-pointed star. Energy, not matter.
 * The five residues each get their OWN shape, which was the correction after playtesting:
 * "really hard to see which amino acid is which." One shape for the family and five hues to
 * tell them apart put the entire discriminating burden back on colour — exactly the failure
 * shape was introduced to fix. Where possible the shape says something true about the
 * residue:
 *
 *   gly  CIRCLE   the simplest amino acid — its side chain is a single hydrogen.
 *   ala  SQUARE   the next simplest; a plain block.
 *   val  DIAMOND  branched (β-branched, in fact) — a tilted, pointier block.
 *   leu  PENTAGON bulkier still; the largest of the five aliphatics here.
 *   lys  PLUS     positively charged at physiological pH. The + is literal, not a glyph
 *                 chosen for contrast, which is why it is the one you will never confuse.
 *
 * The payoff is that glycolysis becomes readable without a HUD: **one hexagon disappears
 * and two triangles appear.** `LACTATE_PER_GLUCOSE = 2` is the C6 → 2×C3 split, and now
 * you can watch it happen instead of reading it in a tooltip.
 */
export type DotShape =
  | 'hex'
  | 'tri'
  | 'spark'
  | 'circle'
  | 'square'
  | 'diamond'
  | 'pentagon'
  | 'plus';

export interface SpeciesLook {
  colour: string;
  radius: number;
  /** Brownian step size — §11.2's speed channel. */
  jitter: number;
  /** Concentration per dot. Fixed, so density tracks concentration honestly. */
  scale: number;
  /** Hard ceiling on dots for this species. */
  cap: number;
  /** Weight of this species in the background tint, per unit concentration. */
  tint: number;
  shape: DotShape;
  /**
   * Does this species get individual dots, or only the background tint?
   *
   * False for the residues since §5a.9. They are a WELL-MIXED POOL — §9.2 draws them from
   * the whole cell, so their position carries no information a player can act on — and a
   * uniform wash is the honest depiction of that. Drawing them as dots would recreate the
   * exact problem §5a was written to solve: 436 dots depicting a field measured at 0.0389
   * mean against 0.0392 max, saying nothing, while implying there is somewhere to go.
   */
  dots: boolean;
}

/**
 * ONE scale for every amino acid, deliberately.
 *
 * Per-residue scales would make dot counts incomparable between residues — five dots of
 * lysine and five of glycine would mean different amounts — and comparing residues is the
 * single thing this layer is for. §9.2 blocks a build on a *specific* bead, so "which am I
 * short of?" has to be answerable by looking. One scale makes the picture a bar chart.
 */
/**
 * ONE DOT IS ONE PEPTIDE BOND. `RESIDUE_UNIT` is 0.25, so this is the most meaningful unit
 * the value could take: you can count how many more residues you are able to place.
 *
 * Residues were briefly drawn as tint only (§5a.9), on the reasoning that a well-mixed pool
 * has no position worth depicting. True, and it made them INVISIBLE — the stock had also
 * been cut ~7x to make scarcity bite (§5a.11), so the interior concentration is ~0.007 and
 * a 0.30 tint weight renders as nothing at all. "I don't see any amino acids in the cell."
 *
 * The original failure was never that residues were drawn; it was that 436 of them were
 * drawn, at a density that implied there was somewhere to go. At the current stock this is
 * about 22 units — under 90 dots across all five types — few enough to read as a COUNT
 * rather than as terrain, which is exactly what a stock should look like. They remain
 * uniformly spread, because that is where they actually are, and §9.2 still draws from the
 * whole cell so they are never something to walk to.
 */
const AMINO_SCALE = 0.25;
const AMINO_CAP = 70;

/**
 * Scales are DERIVED from measured interior concentrations, not chosen by eye.
 *
 * Measured on a representative mid-game cell (glucose channel + 3 enzymes + lactate
 * carrier, 90 s in, 896 interior tiles), the previous table produced **1,386 dots** — which
 * is what "overwhelming" meant. The worst of it was that the five residues contributed 436
 * of those while being essentially FLAT (gly mean 0.0389 against max 0.0392): four hundred
 * dots encoding no spatial information whatsoever, competing for attention with ATP, which
 * genuinely varies from 0.386 to 0.889 and is the number the player is actually playing.
 *
 * So each species now gets a dot budget proportional to how much it has to SAY, and its
 * scale falls out of that:
 *
 *     scale = (mean concentration × interior tiles) / target dots
 *
 *   atp      0.3863 × 896 = 346  → 90 dots → 3.8
 *   lactate  0.1701 × 896 = 152  → 70 dots → 2.2
 *   glucose  0.0729 × 896 =  65  → 60 dots → 1.1
 *   residues ~0.0292 × 896 × 5 = 131 → ~55 dots total → 2.4 shared
 *
 * ≈275 dots in the same scene: **five times fewer, each worth five times more.** Caps sit
 * near 2× the steady count so a genuine spike still reads as a spike before §8.2a's clamp
 * indicator lights.
 */
export const LOOK: Record<string, SpeciesLook> = {
  glucose: { colour: '#ffb03a', radius: 4.4, jitter: 6, scale: 1.1, cap: 140, tint: 0.55, shape: 'hex', dots: true },
  atp: { colour: '#ffe98a', radius: 3.4, jitter: 16, scale: 3.8, cap: 200, tint: 0.0, shape: 'spark', dots: true },
  lactate: { colour: '#9db06f', radius: 3.6, jitter: 5, scale: 2.2, cap: 160, tint: 0.35, shape: 'tri', dots: true },
  gly: { colour: '#3bd6b4', radius: 3.0, jitter: 12, scale: AMINO_SCALE, cap: AMINO_CAP, tint: 0.30, shape: 'circle', dots: true },
  leu: { colour: '#9b8cff', radius: 3.2, jitter: 11, scale: AMINO_SCALE, cap: AMINO_CAP, tint: 0.30, shape: 'pentagon', dots: true },
  lys: { colour: '#ff7eb0', radius: 3.2, jitter: 12, scale: AMINO_SCALE, cap: AMINO_CAP, tint: 0.30, shape: 'plus', dots: true },
  ala: { colour: '#5bb8ff', radius: 2.9, jitter: 12, scale: AMINO_SCALE, cap: AMINO_CAP, tint: 0.30, shape: 'square', dots: true },
  val: { colour: '#7ee787', radius: 3.1, jitter: 11, scale: AMINO_SCALE, cap: AMINO_CAP, tint: 0.30, shape: 'diamond', dots: true },
};

interface Dot {
  x: number;
  y: number;
  /** Home tile centre in canvas px. A dot jitters around this and does not travel. */
  tx: number;
  ty: number;
  /** Index of the home tile in the received frame, so we can check it still has content. */
  cell: number;
  ph: number;
}

/**
 * A fixed pseudo-random value in [0,1) for a world tile.
 *
 * Must depend only on the tile's world position — not on its index in the current frame,
 * which changes with zoom (lod) and with the view origin. Keying off the index instead
 * would make every dot re-roll the moment the player scrolled the wheel, which is the very
 * artifact this exists to remove.
 *
 * Integer hash rather than a lookup table because the world is unbounded once the cell can
 * swim (§10A), so there is no finite grid to precompute over.
 */
function dither(wx: number, wy: number): number {
  let h = (Math.imul(wx | 0, 374761393) + Math.imul(wy | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

/** Precomputed rgb triples, so no string is built in the hot loop. */
const RGB = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
  let v = RGB.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    RGB.set(hex, v);
  }
  return v;
}

/**
 * Append one dot's outline to the current path. No `beginPath`, no `fill` — the caller
 * batches a whole species into a single path, which is what keeps canvas state changes at
 * two per species rather than two per dot.
 *
 * Vertices are unrolled rather than looped over a cos/sin table because this runs for
 * every dot every frame, and the shapes are fixed at four to six points.
 */
export function addShape(
  ctx: CanvasRenderingContext2D | Path2D,
  shape: DotShape,
  x: number,
  y: number,
  r: number,
): void {
  switch (shape) {
    case 'hex': {
      // Flat-topped hexagon — a sugar ring.
      const h = r * 0.866;
      ctx.moveTo(x - r * 0.5, y - h);
      ctx.lineTo(x + r * 0.5, y - h);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x + r * 0.5, y + h);
      ctx.lineTo(x - r * 0.5, y + h);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    }
    case 'tri': {
      // Point-up triangle, slightly enlarged: at equal `r` a triangle carries much less
      // ink than a hexagon, and two lactate should not read as fainter than the one
      // glucose they came from.
      const s = r * 1.18;
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s * 0.866, y + s * 0.5);
      ctx.lineTo(x - s * 0.866, y + s * 0.5);
      ctx.closePath();
      break;
    }
    case 'spark': {
      // Four-pointed star. Reads as energy rather than matter, and its thin waist keeps a
      // dense ATP field from turning into a solid sheet.
      const w = r * 0.34;
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + w, y - w);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x + w, y + w);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - w, y + w);
      ctx.lineTo(x - r, y);
      ctx.lineTo(x - w, y - w);
      ctx.closePath();
      break;
    }
    case 'circle': {
      // Glycine — the simplest residue, so the simplest mark.
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, 6.283185);
      break;
    }
    case 'diamond': {
      // Valine — branched, so a tilted block rather than a flat one.
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    }
    case 'pentagon': {
      // Leucine — the bulkiest of the aliphatics here, so the most sides short of a hex.
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'plus': {
      // Lysine — positively charged at physiological pH. The mark IS the charge.
      const a = r * 0.36;
      ctx.moveTo(x - a, y - r);
      ctx.lineTo(x + a, y - r);
      ctx.lineTo(x + a, y - a);
      ctx.lineTo(x + r, y - a);
      ctx.lineTo(x + r, y + a);
      ctx.lineTo(x + a, y + a);
      ctx.lineTo(x + a, y + r);
      ctx.lineTo(x - a, y + r);
      ctx.lineTo(x - a, y + a);
      ctx.lineTo(x - r, y + a);
      ctx.lineTo(x - r, y - a);
      ctx.lineTo(x - a, y - a);
      ctx.closePath();
      break;
    }
    default: {
      // Alanine — a plain block. §9.2 threads these onto a chain.
      const s = r * 0.82;
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.lineTo(x - s, y + s);
      ctx.closePath();
    }
  }
}

export class FieldRenderer {
  /** Dot pools, keyed by species name. Reused across frames — never reallocated. */
  private pools = new Map<string, Dot[]>();
  /** How many of each pool are live this frame. */
  private live = new Map<string, number>();

  /** Offscreen buffer holding the background tint at FIELD resolution. */
  private tintCanvas: HTMLCanvasElement | null = null;
  private tintCtx: CanvasRenderingContext2D | null = null;
  private tintImage: ImageData | null = null;

  lastDotCount = 0;
  lastClamped = false;

  /**
   * Rebuild everything derived from the field. Called ONCE PER RECEIVED FRAME (~30 Hz),
   * not per rendered frame (~60 Hz) — the old code did all of this twice as often as the
   * data actually changed.
   *
   * ── Placement is QUOTA-driven, not order-driven ─────────────────────────────
   * Each tile gets the number of dots its own concentration justifies. Dots that already
   * sit on a tile with quota remaining stay exactly where they are; whatever quota is
   * left over is filled with dots spawned AT those tiles.
   *
   * Two artifacts died with the order-driven version this replaced, and both looked like
   * physics that was not happening:
   *
   *   - Growth appended `targets[cur..want]`, and targets are built in row-major order,
   *     so a rising concentration appeared to fill the cell FROM THE BOTTOM no matter
   *     where it was actually produced. ATP made at an enzyme in the middle showed up
   *     along the bottom edge.
   *   - Re-homed dots took an arbitrary target index and eased there, streaking across
   *     the cell — a tornado in a cytoplasm where nothing was flowing.
   *
   * §11.1's rule is that dots are "spawned/despawned to match" the field. Matching a
   * per-tile quota is that rule stated exactly, and it makes both artifacts impossible
   * rather than merely unlikely.
   */
  ingest(
    f: FieldFrame,
    nameById: Record<number, string>,
    tilePx: number,
    /** Predicate for "this tile is inside the cell", where dots are worth spending. */
    isInterior: (worldX: number, worldY: number) => boolean,
  ): void {
    this.buildTint(f, nameById);

    let total = 0;
    let clamped = false;

    f.speciesIds.forEach((id, k) => {
      const name = nameById[id] ?? '';
      const look = LOOK[name];
      // `dots: false` species contribute tint only — see SpeciesLook.dots.
      if (!look || !look.dots) return;

      const plane = f.data.subarray(k * f.width * f.height, (k + 1) * f.width * f.height);
      let pool = this.pools.get(name);
      if (!pool) {
        pool = [];
        this.pools.set(name, pool);
      }

      // ── Per-tile quota, from that tile's OWN concentration ────────────────────
      //
      // This replaces a running accumulator that walked the interior in row-major order
      // and awarded a dot whenever a carried sum crossed 1. That was spatially honest but
      // TEMPORALLY unstable, and it is the whole of the flashing: because `acc` carried
      // across tiles, a small change in one tile shifted every later crossing onto a
      // different tile, so a large fraction of the dot set was reassigned — despawned and
      // respawned somewhere else — thirty times a second. Nothing was moving in the
      // simulation; the renderer was re-rolling the whole picture each frame.
      //
      // The fix is to make a tile's dot count depend on nothing but that tile:
      //
      //     quota = floor(c / scale + dither(tile))
      //
      // `dither` is a fixed hash of the tile's WORLD coordinates, so it is identical every
      // frame and survives zoom (which changes lod and therefore cell indices). A tile
      // holding 0.3 of a dot's worth shows a dot iff its dither is below 0.3 — so across
      // many tiles the expected count is still exactly Σ c/scale, sparse regions still
      // contribute instead of rounding away, and §11.1's proportionality is untouched.
      //
      // What changes is that a tile only gains or loses a dot when ITS OWN value crosses a
      // threshold. Dots now wink in and out one at a time as the field genuinely changes,
      // instead of the entire cloud reshuffling continuously. It also removes the last
      // trace of scan-order dependence — the defect class behind the swirl, the tornado,
      // and the fill-from-the-bottom.
      const quota = this.quotaFor(name, f.width * f.height);
      const cells: number[] = [];

      // Pass 1 at the honest scale. If it overshoots the cap, pass 2 runs at a coarser
      // scale rather than truncating mid-scan — truncation would silently delete whatever
      // happened to be late in row-major order, putting the bottom-fill artifact back.
      let want = 0;
      let effScale = look.scale;
      for (let pass = 0; pass < 2; pass++) {
        quota.fill(0);
        cells.length = 0;
        want = 0;
        for (let gy = 0; gy < f.height; gy++) {
          for (let gx = 0; gx < f.width; gx++) {
            const wx = f.originX + gx * f.lod;
            const wy = f.originY + gy * f.lod;
            if (!isInterior(wx, wy)) continue;
            const cell = gy * f.width + gx;
            const n = Math.floor(plane[cell]! / effScale + dither(wx, wy));
            if (n <= 0) continue;
            quota[cell] = n;
            cells.push(cell);
            want += n;
          }
        }
        if (want <= look.cap) break;
        // Coarsen just enough to fit, then re-quantise. §8.2a: the ceiling must be
        // visible, so this also lights the clamp indicator.
        clamped = true;
        effScale = look.scale * (want / look.cap) * 1.02;
      }
      if (want > look.cap) want = look.cap;

      // Keep every dot whose tile still has quota. These do not move at all.
      const cur = this.live.get(name) ?? 0;
      let write = 0;
      for (let i = 0; i < cur; i++) {
        const d = pool[i]!;
        if ((quota[d.cell] ?? 0) <= 0) continue;
        quota[d.cell]!--;
        pool[i] = pool[write]!;
        pool[write] = d;
        write++;
      }

      // Fill whatever quota is still owed, spawning at the tile rather than easing to it.
      // A dot that has to move is a despawn plus a spawn, never a glide.
      for (const cell of cells) {
        while (quota[cell]! > 0 && write < want) {
          quota[cell]!--;
          let d = pool[write];
          if (!d) {
            d = { x: 0, y: 0, tx: 0, ty: 0, cell: 0, ph: Math.random() * 6.28 };
            pool[write] = d;
          }
          this.home(d, cell, f, tilePx);
          d.x = d.tx;
          d.y = d.ty;
          write++;
        }
      }

      this.live.set(name, write);
      total += write;
    });

    this.lastDotCount = total;
    this.lastClamped = clamped;
  }

  /** Scratch quota buffers, one per species, grown on demand and reused. */
  private quotas = new Map<string, Int32Array>();
  private quotaFor(name: string, cells: number): Int32Array {
    let q = this.quotas.get(name);
    if (!q || q.length < cells) {
      q = new Int32Array(cells);
      this.quotas.set(name, q);
    }
    return q;
  }



  /** Assign a dot to a frame cell, with a stable sub-tile offset so it is not on a grid. */
  private home(d: Dot, cell: number, f: FieldFrame, tilePx: number): void {
    const gx = cell % f.width;
    const gy = Math.floor(cell / f.width);
    d.cell = cell;
    // A fixed pseudo-random offset within the tile, derived from the cell index, so dots
    // scatter naturally but never jump when re-homed to the same tile.
    const jx = (((Math.sin(cell * 12.9898) * 43758.5453) % 1) + 1) % 1;
    const jy = (((Math.sin(cell * 78.233) * 43758.5453) % 1) + 1) % 1;
    d.tx = (f.originX + (gx + jx) * f.lod) * tilePx;
    d.ty = (f.originY + (gy + jy) * f.lod) * tilePx;
  }

  /**
   * §11.4's level-of-detail handoff, doing most of the work: the whole field becomes one
   * additively-blended image at field resolution, then a single scaled `drawImage`. This
   * is what lets the extracellular medium — 90% of the tiles — cost one blit instead of
   * ninety thousand arcs.
   */
  private buildTint(f: FieldFrame, nameById: Record<number, string>): void {
    // The dot logic is pure geometry and worth testing headlessly; the tint needs a
    // canvas. Skipping it without a DOM keeps `ingest` runnable under vitest, which is
    // where the "no dot travels across the cell" guarantee is actually verified.
    if (typeof document === 'undefined') return;
    if (!this.tintCanvas || this.tintCanvas.width !== f.width || this.tintCanvas.height !== f.height) {
      this.tintCanvas = document.createElement('canvas');
      this.tintCanvas.width = f.width;
      this.tintCanvas.height = f.height;
      this.tintCtx = this.tintCanvas.getContext('2d');
      this.tintImage = this.tintCtx!.createImageData(f.width, f.height);
    }
    const img = this.tintImage!;
    const px = img.data;
    px.fill(0);

    f.speciesIds.forEach((k_, k) => {
      const look = LOOK[nameById[f.speciesIds[k]!] ?? ''];
      if (!look || look.tint <= 0) return;
      const [r, g, b] = rgb(look.colour);
      const plane = f.data.subarray(k * f.width * f.height, (k + 1) * f.width * f.height);
      for (let i = 0; i < plane.length; i++) {
        const c = plane[i]!;
        if (c <= 0) continue;
        const a = Math.min(1, c * look.tint);
        const o = i * 4;
        // Additive, matching §11.1's 'lighter' compositing: overlapping species brighten.
        px[o] = Math.min(255, px[o]! + r * a);
        px[o + 1] = Math.min(255, px[o + 1]! + g * a);
        px[o + 2] = Math.min(255, px[o + 2]! + b * a);
        px[o + 3] = Math.min(255, px[o + 3]! + 255 * a * 0.5);
      }
    });
    this.tintCtx!.putImageData(img, 0, 0);
  }

  /** Draw the background tint, scaled up. One call, whatever the field size. */
  drawTint(ctx: CanvasRenderingContext2D, f: FieldFrame, tilePx: number): void {
    if (!this.tintCanvas) return;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      this.tintCanvas,
      f.originX * tilePx,
      f.originY * tilePx,
      f.width * f.lod * tilePx,
      f.height * f.lod * tilePx,
    );
    ctx.imageSmoothingEnabled = prev;
  }

  /**
   * Rescale every cached dot position when the zoom changes.
   *
   * Dot positions are stored in px, and a zoom change is a uniform scale about the
   * origin. Without this the homes jumped to the new scale while the dots themselves were
   * still at the old one, so every wheel notch sent the entire cytoplasm sliding across
   * the cell for half a second — the tether time constant, made visible as a lag.
   */
  rescale(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
    for (const [, pool] of this.pools) {
      for (const d of pool) {
        d.x *= factor;
        d.y *= factor;
        d.tx *= factor;
        d.ty *= factor;
      }
    }
  }

  /** Advance the Brownian walk (§11.2). Cheap — pure arithmetic over live dots only. */
  step(dt: number, health: number): void {
    for (const [name, pool] of this.pools) {
      const look = LOOK[name];
      if (!look) continue;
      const n = this.live.get(name) ?? 0;
      const j = look.jitter * dt * (0.35 + 0.65 * health);
      // §11.2's independent Brownian walk, TETHERED. The tether is what makes it read as
      // thermal jitter rather than as flow: a dot wanders around its own tile and is
      // pulled back, so the eye sees shimmer in place. Untethered — or worse, easing
      // toward a target that moves each frame — the same dots read as a current, and the
      // cytoplasm appears to be circulating when nothing of the sort is happening.
      for (let i = 0; i < n; i++) {
        const d = pool[i]!;
        d.x += (Math.random() - 0.5) * j;
        d.y += (Math.random() - 0.5) * j;
        d.x += (d.tx - d.x) * Math.min(1, dt * 2.2);
        d.y += (d.ty - d.y) * Math.min(1, dt * 2.2);
        d.ph += dt * 6;
      }
    }
  }

  /**
   * Draw every dot. ONE composite-mode change for the whole pass, and one fillStyle plus
   * one path per species per layer — versus the old two state changes and two paths per
   * dot. This is the difference between ~16 canvas state changes a frame and 205,596.
   */
  drawDots(ctx: CanvasRenderingContext2D, health: number): void {
    ctx.globalCompositeOperation = 'lighter';
    const dim = 0.35 + 0.65 * health;

    for (const [name, pool] of this.pools) {
      const look = LOOK[name];
      if (!look) continue;
      const n = this.live.get(name) ?? 0;
      if (n === 0) continue;
      const [r, g, b] = rgb(look.colour);

      // Halo layer. Still ONE path and ONE fill for the whole species — a polygon is more
      // lineTo calls than an arc, but there are now ~5× fewer dots, so the total path work
      // went down rather than up.
      ctx.fillStyle = `rgba(${r},${g},${b},${(0.4 * dim).toFixed(3)})`;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const d = pool[i]!;
        addShape(ctx, look.shape, d.x, d.y, look.radius + 1.4);
      }
      ctx.fill();

      // Core layer.
      ctx.fillStyle = `rgba(${r},${g},${b},${(0.95 * dim).toFixed(3)})`;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const d = pool[i]!;
        addShape(ctx, look.shape, d.x, d.y, look.radius * 0.62);
      }
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
  }
}
