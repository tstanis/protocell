/**
 * Binary field frames. SPEC.md §15.3.
 *
 * Layout — self-describing, so a frame needs no side channel to interpret:
 *
 *   0   4   magic 'PCFF'
 *   4   4   uint32  tick
 *   8   2   uint16  lod
 *   10  2   uint16  speciesCount
 *   12  2   uint16  width            (post-downsample)
 *   14  2   uint16  height
 *   16  2   uint16  originX          (world tiles)
 *   18  2   uint16  originY
 *   20  n*2 uint16  speciesIds[]     → padded to 4-byte alignment
 *   ..      Float32Array[speciesCount * width * height]
 *
 * Float32 on the wire even though the sim runs Float64 (§15.4). That is the general rule
 * stated concretely: the truth layer is exact to the practical limit, and the COSTUME is
 * what gets quantized. Halving the bytes costs a renderer nothing — it is about to turn
 * these into dot counts and tint alphas.
 */

export const MAGIC = 0x50434646; // 'PCFF'
export const HEADER_FIXED_BYTES = 20;

export interface FieldFrame {
  tick: number;
  lod: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  speciesIds: number[];
  /** speciesCount planes of width*height, species-major. */
  data: Float32Array;
}

function alignedHeaderBytes(speciesCount: number): number {
  const raw = HEADER_FIXED_BYTES + speciesCount * 2;
  return (raw + 3) & ~3; // Float32Array needs 4-byte alignment
}

export function encodeFieldFrame(frame: FieldFrame): ArrayBuffer {
  const { speciesIds, width, height, data } = frame;
  const expected = speciesIds.length * width * height;
  if (data.length !== expected) {
    throw new RangeError(
      `field frame payload mismatch: expected ${expected} floats ` +
        `(${speciesIds.length} species × ${width}×${height}), got ${data.length}`,
    );
  }

  const headerBytes = alignedHeaderBytes(speciesIds.length);
  const buf = new ArrayBuffer(headerBytes + data.length * 4);
  const view = new DataView(buf);

  view.setUint32(0, MAGIC, true);
  view.setUint32(4, frame.tick >>> 0, true);
  view.setUint16(8, frame.lod, true);
  view.setUint16(10, speciesIds.length, true);
  view.setUint16(12, width, true);
  view.setUint16(14, height, true);
  view.setUint16(16, frame.originX, true);
  view.setUint16(18, frame.originY, true);
  for (let i = 0; i < speciesIds.length; i++) {
    view.setUint16(HEADER_FIXED_BYTES + i * 2, speciesIds[i]!, true);
  }

  new Float32Array(buf, headerBytes).set(data);
  return buf;
}

export function decodeFieldFrame(buf: ArrayBuffer): FieldFrame {
  if (buf.byteLength < HEADER_FIXED_BYTES) {
    throw new RangeError(`field frame too short: ${buf.byteLength} bytes`);
  }
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new RangeError('field frame: bad magic — not a PCFF frame');
  }

  const tick = view.getUint32(4, true);
  const lod = view.getUint16(8, true);
  const speciesCount = view.getUint16(10, true);
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const originX = view.getUint16(16, true);
  const originY = view.getUint16(18, true);

  const speciesIds: number[] = [];
  for (let i = 0; i < speciesCount; i++) {
    speciesIds.push(view.getUint16(HEADER_FIXED_BYTES + i * 2, true));
  }

  const headerBytes = alignedHeaderBytes(speciesCount);
  const expected = speciesCount * width * height;
  const available = (buf.byteLength - headerBytes) / 4;
  if (available < expected) {
    throw new RangeError(`field frame truncated: expected ${expected} floats, have ${available}`);
  }

  return {
    tick,
    lod,
    width,
    height,
    originX,
    originY,
    speciesIds,
    data: new Float32Array(buf, headerBytes, expected),
  };
}

/**
 * Box-average a full-resolution plane down by `lod`. SPEC.md §15.3.
 *
 * MEAN is the correct reducer because the payload is CONCENTRATION and tile volume is
 * fixed per resolution — §3.5's "each cell coarsens toward a single averaged tile".
 * Averaging *amounts* would be wrong the moment tile volumes differ between compartments,
 * and would make a zoomed-out view quietly disagree with a zoomed-in one about how much
 * is there, which is precisely the §2.1 violation the whole architecture exists to
 * prevent.
 *
 * Partial blocks at the right/bottom edge average only the cells they actually contain,
 * so an edge block is not darkened by phantom zeros.
 */
export function downsample(
  src: ArrayLike<number>,
  srcWidth: number,
  srcHeight: number,
  lod: number,
): { data: Float32Array; width: number; height: number } {
  if (lod <= 1) {
    return { data: Float32Array.from(src as ArrayLike<number>), width: srcWidth, height: srcHeight };
  }

  const width = Math.ceil(srcWidth / lod);
  const height = Math.ceil(srcHeight / lod);
  const out = new Float32Array(width * height);

  for (let oy = 0; oy < height; oy++) {
    for (let ox = 0; ox < width; ox++) {
      let sum = 0;
      let n = 0;
      const y1 = Math.min((oy + 1) * lod, srcHeight);
      const x1 = Math.min((ox + 1) * lod, srcWidth);
      for (let y = oy * lod; y < y1; y++) {
        for (let x = ox * lod; x < x1; x++) {
          sum += src[y * srcWidth + x]!;
          n++;
        }
      }
      out[oy * width + ox] = n > 0 ? sum / n : 0;
    }
  }
  return { data: out, width, height };
}
