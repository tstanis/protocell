/**
 * Snapshots to bytes and back. SPEC.md §15.9.
 *
 * `packages/sim` deliberately hands out raw `Float64Array` planes and has no opinion about
 * encoding (§15.8) — this is where that opinion lives.
 *
 * Measured on a cell two minutes into real play:
 *
 *     snapshot()          2.0 ms
 *     JSON + base64     194 KB
 *     gzip               31 KB   1.3 ms    16% of raw
 *     brotli q5          26 KB   9.3 ms    not worth 7x the time for 5 KB
 *
 * So gzip, and the interesting consequence is that **bytes are free and requests are
 * not**: 10,000 cells is 305 MB, which costs about half a cent a month in object storage,
 * while writing every cell every minute would cost ~$60. That is what shapes the save
 * POLICY in `registry.ts`, not the size of a snapshot.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import type { WorldSnapshot } from '@protocell/sim';

/** Bumped only if this encoding changes; the snapshot's own `v` covers its shape. */
const CODEC_VERSION = 1;

interface WirePlane {
  species: number;
  b64: string;
}

export function encodeSnapshot(snap: WorldSnapshot): Buffer {
  const wire = {
    c: CODEC_VERSION,
    ...snap,
    planes: snap.planes.map((p): WirePlane => ({
      species: p.species,
      b64: Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength).toString('base64'),
    })),
  };
  return gzipSync(Buffer.from(JSON.stringify(wire), 'utf8'));
}

export function decodeSnapshot(blob: Buffer): WorldSnapshot {
  const wire = JSON.parse(gunzipSync(blob).toString('utf8')) as Omit<WorldSnapshot, 'planes'> & {
    c?: number;
    planes: WirePlane[];
  };
  if (wire.c !== CODEC_VERSION) throw new Error(`codec version ${wire.c}, expected ${CODEC_VERSION}`);

  return {
    ...wire,
    planes: wire.planes.map((p) => ({ species: p.species, data: toFloat64(p.b64) })),
  };
}

/**
 * Base64 back to a Float64Array — and this is the one genuinely dangerous line in the file.
 *
 * `Buffer.from(b64, 'base64')` returns a view into Node's shared 8 KB allocation pool, so
 * its `byteOffset` is wherever the pool happened to be — almost never a multiple of 8.
 * Handing that offset to `new Float64Array(buf.buffer, buf.byteOffset, n)` throws when the
 * alignment is wrong, and the failure is **data-dependent**: it works in tests and on small
 * payloads, then throws in production when a differently-sized allocation lands at an odd
 * offset. So the bytes are copied into their own ArrayBuffer, which is aligned by
 * construction.
 */
function toFloat64(b64: string): Float64Array {
  const bytes = Buffer.from(b64, 'base64');
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Float64Array(copy);
}
