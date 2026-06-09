// Per-COLUMN run-length encoding of a chunk's voxel array, used to shrink the
// idle ~80KB block-id buffer of FAR (batched) chunks — they're read only by the
// rare demotion remesh and a seam backstop, so the bytes sit cold. Decoded back
// to a flat Uint8Array synchronously on demand (WorldChunk.ensureFlat).
//
// The flat layout is ((x*height)+y)*width+z (chunkGen.blockIndex), so the cells
// of one column are `width` apart along y. A column is the only axis with long
// runs (a tall air run on top + a tall stone run below + a thin surface band),
// so we walk per-(x,z) column down y. A naive flat-order RLE would straddle
// columns every `width` cells and barely compress (the layout trap).
//
// A run is [u16 length (LE), u8 id] = 3 bytes; runs never cross a column
// boundary and every column holds exactly `height` cells, so the decoder
// re-segments columns by counting to `height` — no per-column run count stored.
// length<=height<=65535 always fits a u16.
//
// This module is intentionally DOM-free and import-free (size is inlined, not
// the ChunkSize type) so the node byte-parity test can transpile it standalone.

type Size = { width: number; height: number };

export function encodeColumnRLE(data: Uint8Array, size: Size): Uint8Array {
  const W = size.width, H = size.height;
  // Pass 1: count runs so the output buffer is sized exactly (no growth copies).
  let runs = 0;
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < W; z++) {
      const base = x * H * W + z;
      let prev = data[base];
      runs++;
      for (let y = 1; y < H; y++) {
        const id = data[base + y * W];
        if (id !== prev) { runs++; prev = id; }
      }
    }
  }
  // Pass 2: emit [u16 len, u8 id] per run, column-major (x outer, z inner, y axis).
  const out = new Uint8Array(runs * 3);
  let o = 0;
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < W; z++) {
      const base = x * H * W + z;
      let prev = data[base];
      let len = 1;
      for (let y = 1; y < H; y++) {
        const id = data[base + y * W];
        if (id === prev) { len++; continue; }
        out[o++] = len & 0xff; out[o++] = (len >> 8) & 0xff; out[o++] = prev;
        prev = id; len = 1;
      }
      out[o++] = len & 0xff; out[o++] = (len >> 8) & 0xff; out[o++] = prev;
    }
  }
  return out;
}

export function decodeColumnRLE(rle: Uint8Array, size: Size): Uint8Array {
  const W = size.width, H = size.height;
  const data = new Uint8Array(W * H * W);
  let o = 0;
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < W; z++) {
      const base = x * H * W + z;
      let y = 0;
      while (y < H) {
        const len = rle[o] | (rle[o + 1] << 8);
        const id = rle[o + 2];
        o += 3;
        for (let k = 0; k < len; k++) { data[base + y * W] = id; y++; }
      }
    }
  }
  return data;
}
