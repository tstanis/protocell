/**
 * Camera round-tripping. The zoom/pan bugs were all coordinate-space mistakes, and every
 * one of them is checkable without a browser.
 */
import { describe, expect, it } from 'vitest';

const W = 700;
const H = 700;
const worldW = 96;
const worldH = 96;

/** The client's model, extracted so the arithmetic can be tested on its own. */
function makeCam() {
  const cam = { zoom: 1, x: 0, y: 0 };
  const baseK = Math.min(W / worldW, H / worldH);
  const k = () => baseK * cam.zoom;
  const toTile = (px: number, py: number) => ({ x: (px - cam.x) / k(), y: (py - cam.y) / k() });
  const toScreen = (tx: number, ty: number) => ({ x: tx * k() + cam.x, y: ty * k() + cam.y });
  /** Wheel: zoom about a cursor position, keeping the world point under it fixed. */
  const wheelAt = (px: number, py: number, factor: number) => {
    const before = toTile(px, py);
    cam.zoom = Math.max(0.6, Math.min(8, cam.zoom * factor));
    cam.x = px - before.x * k();
    cam.y = py - before.y * k();
  };
  return { cam, k, toTile, toScreen, wheelAt, baseK };
}

describe('camera', () => {
  it('screen and world round-trip at any zoom and pan', () => {
    const c = makeCam();
    for (const [zoom, camX, camY] of [[1, 0, 0], [2.5, -300, -120], [0.7, 80, 40], [8, -2000, -1500]] as const) {
      c.cam.zoom = zoom;
      c.cam.x = camX;
      c.cam.y = camY;
      for (const [tx, ty] of [[0, 0], [48, 48], [95.5, 3.25]] as const) {
        const sc = c.toScreen(tx, ty);
        const back = c.toTile(sc.x, sc.y);
        expect(back.x).toBeCloseTo(tx, 9);
        expect(back.y).toBeCloseTo(ty, 9);
      }
    }
  });

  it('wheel zoom keeps the point under the cursor fixed', () => {
    // The property that makes zooming feel anchored rather than lurching.
    const c = makeCam();
    const cursor = { x: 512, y: 190 };
    const before = c.toTile(cursor.x, cursor.y);
    for (const f of [1.2, 1.2, 1.2, 0.8, 0.8, 1.5]) {
      c.wheelAt(cursor.x, cursor.y, f);
      const after = c.toTile(cursor.x, cursor.y);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it('respects the zoom limits', () => {
    const c = makeCam();
    for (let i = 0; i < 60; i++) c.wheelAt(350, 350, 1.3);
    expect(c.cam.zoom).toBeLessThanOrEqual(8);
    for (let i = 0; i < 120; i++) c.wheelAt(350, 350, 0.7);
    expect(c.cam.zoom).toBeGreaterThanOrEqual(0.6);
  });

  it('a zoom rescale maps old cached px to new cached px by a single factor', () => {
    // This is what SoftBody.rescale and FieldRenderer.rescale rely on: world -> px is a
    // pure multiply, so a zoom change is a uniform scale about the origin. Rebuilding
    // instead of rescaling is what reset the membrane and made the dots slide.
    const c = makeCam();
    const kOld = c.k();
    const worldPt = { x: 30, y: 61 };
    const pxOld = { x: worldPt.x * kOld, y: worldPt.y * kOld };

    c.cam.zoom = 3.7;
    const kNew = c.k();
    const factor = kNew / kOld;

    expect(pxOld.x * factor).toBeCloseTo(worldPt.x * kNew, 9);
    expect(pxOld.y * factor).toBeCloseTo(worldPt.y * kNew, 9);
  });

  it('hit-testing agrees with drawing after pan and zoom', () => {
    // The tooltip bug in miniature: a thing drawn at tile T must be found by a hover at
    // the screen position T was drawn to.
    const c = makeCam();
    c.cam.zoom = 2.3;
    c.wheelAt(200, 600, 1.0); // re-anchor without changing zoom
    c.cam.x -= 137;
    c.cam.y += 44;

    const tile = { x: 48.5, y: 48.5 };
    const drawnAt = c.toScreen(tile.x, tile.y);
    const found = c.toTile(drawnAt.x, drawnAt.y);
    expect(Math.hypot(found.x - tile.x, found.y - tile.y)).toBeLessThan(1e-9);
  });
});
