/**
 * §15.9 — cells to bytes, bytes to disk, and back.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '@protocell/sim';
import { decodeSnapshot, encodeSnapshot } from '../src/codec.js';
import { FileCellStore, __fromKey, __toKey } from '../src/store.js';

const dirs: string[] = [];
async function tempStore(): Promise<FileCellStore> {
  const d = await mkdtemp(join(tmpdir(), 'protocell-store-'));
  dirs.push(d);
  return new FileCellStore(d);
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function played(seconds: number): World {
  const w = new World();
  w.buildGlucoseChannel();
  w.buildEnzyme();
  w.buildLactateCarrier(2);
  for (let i = 0; i < 120 * seconds; i++) w.step();
  return w;
}

/** The same divergence check §15.8 uses — the only assertion that catches a lossy codec. */
function fingerprint(w: World): string {
  const p: (string | number)[] = [w.tick, w.atp.toFixed(9), w.cyto.volume.toFixed(9)];
  for (const g of w.grains.grains) p.push(g.id, g.x.toFixed(9), g.y.toFixed(9));
  return p.join('|');
}

describe('§15.9 — the codec', () => {
  it('round-trips a played cell exactly', () => {
    const a = played(20);
    const b = new World();
    b.restore(decodeSnapshot(encodeSnapshot(a.snapshot())));
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('a decoded cell keeps stepping identically', () => {
    const a = played(15);
    const b = new World();
    b.restore(decodeSnapshot(encodeSnapshot(a.snapshot())));
    for (let i = 0; i < 120 * 10; i++) {
      a.step();
      b.step();
    }
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('survives a base64 payload landing at an unaligned buffer offset', () => {
    // THE trap this codec is written around. `Buffer.from(b64,'base64')` returns a view
    // into Node's shared pool, so byteOffset is rarely a multiple of 8 — and handing that
    // to `new Float64Array(buf.buffer, buf.byteOffset, n)` throws. The failure is
    // data-dependent, so it hides until some payload happens to land badly.
    //
    // Decoding many snapshots in a row walks the allocation pool through every alignment,
    // which is the cheapest way to make that non-determinism deterministic.
    const blob = encodeSnapshot(played(10).snapshot());
    for (let i = 0; i < 64; i++) {
      // Churn the pool so the next decode starts from a different offset.
      Buffer.from('x'.repeat(i + 1));
      const snap = decodeSnapshot(blob);
      expect(snap.planes[0]!.data.length).toBeGreaterThan(0);
      expect(Number.isFinite(snap.planes[0]!.data[0]!)).toBe(true);
    }
  });

  it('compresses to something worth storing', () => {
    const blob = encodeSnapshot(played(60).snapshot());
    expect(blob.length).toBeLessThan(120 * 1024); // measured ~31 KB
  });

  it('refuses a blob it did not write rather than returning nonsense', () => {
    expect(() => decodeSnapshot(Buffer.from('not gzip'))).toThrow();
  });
});

describe('§15.9 — FileCellStore', () => {
  it('returns null for a cell that was never saved', async () => {
    const s = await tempStore();
    expect(await s.load('u:nobody')).toBeNull();
  });

  it('round-trips a blob', async () => {
    const s = await tempStore();
    const blob = encodeSnapshot(played(10).snapshot());
    await s.save('u:abc', blob);
    expect(await s.load('u:abc')).toEqual(blob);
  });

  it('overwrites in place, leaving no temp files behind', async () => {
    const s = await tempStore();
    await s.save('u:abc', Buffer.from('one'));
    await s.save('u:abc', Buffer.from('two'));
    expect((await s.load('u:abc'))!.toString()).toBe('two');

    const d = dirs[dirs.length - 1]!;
    const names = await readdir(d);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(names.length).toBe(1);
  });

  it('keeps ids off the filesystem, so `:` and `../` are not filenames', async () => {
    // `u:<sub>` contains a colon, which is illegal on Windows; and an id used raw would
    // make `../` a traversal straight out of the data directory.
    expect(__toKey('u:abc')).not.toContain(':');
    expect(__toKey('../../etc/passwd')).not.toContain('/');
    expect(__fromKey(__toKey('u:abc'))).toBe('u:abc');

    const s = await tempStore();
    await s.save('../../escape', Buffer.from('x'));
    const names = await readdir(dirs[dirs.length - 1]!);
    expect(names.length).toBe(1); // it landed inside, not outside
  });

  it('finds stale cells by mtime, which is why it needs no index', async () => {
    const s = await tempStore();
    await s.save('u:old', Buffer.from('x'));
    const cutoff = Date.now() + 1000; // everything written so far is "old"
    expect(await s.stale(cutoff)).toEqual(['u:old']);
    expect(await s.stale(Date.now() - 60_000)).toEqual([]);
  });

  it('ignores files it did not write', async () => {
    const s = await tempStore();
    await s.save('u:mine', Buffer.from('x'));
    await writeFile(join(dirs[dirs.length - 1]!, 'README.txt'), 'not a cell');
    expect(await s.stale(Date.now() + 1000)).toEqual(['u:mine']);
  });

  it('removes', async () => {
    const s = await tempStore();
    await s.save('u:abc', Buffer.from('x'));
    await s.remove('u:abc');
    expect(await s.load('u:abc')).toBeNull();
    await expect(s.remove('u:never')).resolves.toBeUndefined(); // idempotent
  });
});
