/**
 * SPEC.md §16.1 — "encode → decode round-trips exactly; downsampling preserves the mean."
 */

import { describe, expect, it } from 'vitest';
import { decodeFieldFrame, downsample, encodeFieldFrame, type FieldFrame } from '../src/codec.js';

function makeFrame(speciesIds: number[], width: number, height: number): FieldFrame {
  const data = new Float32Array(speciesIds.length * width * height);
  for (let i = 0; i < data.length; i++) data[i] = Math.fround(i * 0.125 - 3);
  return { tick: 8823, lod: 1, width, height, originX: 12, originY: 40, speciesIds, data };
}

describe('field frame codec', () => {
  it('round-trips exactly', () => {
    const frame = makeFrame([0, 2, 3], 17, 11);
    const decoded = decodeFieldFrame(encodeFieldFrame(frame));

    expect(decoded.tick).toBe(frame.tick);
    expect(decoded.lod).toBe(frame.lod);
    expect(decoded.width).toBe(frame.width);
    expect(decoded.height).toBe(frame.height);
    expect(decoded.originX).toBe(frame.originX);
    expect(decoded.originY).toBe(frame.originY);
    expect(decoded.speciesIds).toEqual(frame.speciesIds);
    expect(Array.from(decoded.data)).toEqual(Array.from(frame.data));
  });

  it('stays 4-byte aligned for any species count', () => {
    // An odd species count leaves the header at an odd 2-byte offset; without padding the
    // Float32Array constructor throws. Worth a test because it only breaks on odd counts.
    for (let n = 1; n <= 9; n++) {
      const ids = Array.from({ length: n }, (_, k) => k);
      const frame = makeFrame(ids, 5, 4);
      expect(() => decodeFieldFrame(encodeFieldFrame(frame))).not.toThrow();
    }
  });

  it('is self-describing — no side channel needed to interpret it', () => {
    const frame = makeFrame([4, 7], 9, 6);
    const decoded = decodeFieldFrame(encodeFieldFrame(frame));
    expect(decoded.data.length).toBe(decoded.speciesIds.length * decoded.width * decoded.height);
  });

  it('rejects a non-PCFF buffer rather than reading garbage', () => {
    const junk = new ArrayBuffer(64);
    new DataView(junk).setUint32(0, 0xdeadbeef, true);
    expect(() => decodeFieldFrame(junk)).toThrow(/bad magic/);
  });

  it('rejects a truncated frame', () => {
    const full = encodeFieldFrame(makeFrame([0, 1], 8, 8));
    expect(() => decodeFieldFrame(full.slice(0, full.byteLength - 40))).toThrow(/truncated/);
  });

  it('catches a payload/header mismatch at encode time', () => {
    const frame = makeFrame([0, 1], 8, 8);
    frame.width = 7; // header now disagrees with the payload
    expect(() => encodeFieldFrame(frame)).toThrow(/payload mismatch/);
  });
});

describe('downsampling (§15.3)', () => {
  it('preserves the mean — the §2.1 requirement', () => {
    // A zoomed-out view must not disagree with a zoomed-in one about how much is there.
    const w = 16;
    const h = 16;
    const src = new Float32Array(w * h);
    for (let i = 0; i < src.length; i++) src[i] = (i % 7) + 1;
    const srcMean = src.reduce((a, b) => a + b, 0) / src.length;

    for (const lod of [2, 4, 8]) {
      const out = downsample(src, w, h, lod);
      const outMean = Array.from(out.data).reduce((a, b) => a + b, 0) / out.data.length;
      expect(outMean).toBeCloseTo(srcMean, 5);
    }
  });

  it('lod 1 is identity', () => {
    const src = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const out = downsample(src, 3, 2, 1);
    expect(Array.from(out.data)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
  });

  it('box-averages a known block', () => {
    // 2x2 -> 1x1, mean of 1,2,3,4
    const out = downsample(Float32Array.from([1, 2, 3, 4]), 2, 2, 2);
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    expect(out.data[0]).toBeCloseTo(2.5, 6);
  });

  it('does not darken partial edge blocks with phantom zeros', () => {
    // 3x3 at lod 2 gives 2x2 output; the right column and bottom row are partial. If
    // those averaged over a full 2x2 with zeros, an edge would read as artificially
    // sparse — a costume lying about a boundary, which is exactly what §2.1 forbids.
    const src = Float32Array.from([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    const out = downsample(src, 3, 3, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    for (const v of out.data) expect(v).toBeCloseTo(5, 6);
  });

  it('a uniform field stays uniform at every lod', () => {
    const src = new Float32Array(64).fill(0.375);
    for (const lod of [1, 2, 4, 8]) {
      for (const v of downsample(src, 8, 8, lod).data) expect(v).toBeCloseTo(0.375, 6);
    }
  });
});
