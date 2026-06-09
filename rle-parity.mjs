// Byte-parity + compressibility test for the per-column chunk RLE (chunkRle.ts),
// which shrinks the idle voxel array of FAR/batched chunks. Run: `node rle-parity.mjs`.
//
// chunkRle.ts is intentionally import-free, so we transpile it with the project's
// `typescript` devDependency and import the JS as a data: URL module — no build
// step, no test runner. The round-trip property decode(encode(x)) === x must hold
// for ANY array (it's data-agnostic), so we hammer it with synthetic patterns +
// edited columns; the compressibility gate is asserted on a realistic terrain chunk.

import { readFileSync } from 'node:fs';
import ts from 'typescript';

const src = readFileSync(new URL('./src/scripts/chunkRle.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { encodeColumnRLE, decodeColumnRLE } =
  await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const SIZE = { width: 16, height: 320 };
const W = SIZE.width, H = SIZE.height;
const idx = (x, y, z) => (x * H + y) * W + z;

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ✓ ' + msg);

// A tiny deterministic PRNG so the "random" cases are reproducible across runs.
let _s = 0x9e3779b9 >>> 0;
const rnd = () => { _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5; _s >>>= 0; return _s / 0xffffffff; };

function assertParity(name, data) {
  const enc = encodeColumnRLE(data, SIZE);
  const dec = decodeColumnRLE(enc, SIZE);
  if (dec.length !== data.length) { fail(`${name}: length ${dec.length} != ${data.length}`); return enc; }
  for (let i = 0; i < data.length; i++) {
    if (dec[i] !== data[i]) {
      // Decode the offending flat index back to x,y,z to catch the y-stride layout trap.
      const z = i % W, x = (i / (H * W)) | 0, y = ((i - x * H * W) / W) | 0;
      fail(`${name}: mismatch at index ${i} (x=${x},y=${y},z=${z}): got ${dec[i]}, want ${data[i]}`);
      return enc;
    }
  }
  ok(`${name}: byte-identical round-trip (${(enc.length / 1024).toFixed(1)} KiB encoded)`);
  return enc;
}

const blank = () => new Uint8Array(W * H * W);

// 1) Synthetic patterns — exercise run boundaries + the per-column stride.
console.log('byte-parity:');
assertParity('all-air', blank());
{ const d = blank(); d.fill(1); assertParity('all-stone', d); }
{ // alternating along y in every column (worst case for run count, still must round-trip)
  const d = blank();
  for (let x = 0; x < W; x++) for (let z = 0; z < W; z++) for (let y = 0; y < H; y++) d[idx(x, y, z)] = y & 1 ? 1 : 0;
  assertParity('alternating-y', d);
}
{ // distinct id per column → proves columns don't bleed into each other
  const d = blank();
  for (let x = 0; x < W; x++) for (let z = 0; z < W; z++) { const id = ((x * W + z) % 200) + 1; for (let y = 0; y < H; y++) d[idx(x, y, z)] = id; }
  assertParity('per-column-distinct-id', d);
}
{ const d = blank(); for (let i = 0; i < d.length; i++) d[i] = (rnd() * 174) | 0; assertParity('random', d); }

// 2) Realistic terrain column + edits.
function realisticChunk() {
  const d = blank();
  const SEA = 128;
  for (let x = 0; x < W; x++) for (let z = 0; z < W; z++) {
    const h = (90 + Math.floor(rnd() * 70)); // surface 90..160
    for (let y = 0; y < h - 3; y++) d[idx(x, y, z)] = 1;          // stone
    for (let y = Math.max(0, h - 3); y < h; y++) d[idx(x, y, z)] = 3; // dirt band
    if (h - 1 >= 0) d[idx(x, h - 1, z)] = 2;                      // grass top
    if (h < SEA) for (let y = h; y < SEA; y++) d[idx(x, y, z)] = 9; // water fill to sea level
    // occasional ore speckle (adds a couple of runs without exploding count)
    if (rnd() < 0.3) d[idx(x, (rnd() * (h - 5)) | 0, z)] = 15;
  }
  return d;
}
console.log('edited-chunk parity:');
{
  const d = realisticChunk();
  // simulate ~30 player edits (loadPlayerChanges-style mutations)
  for (let k = 0; k < 30; k++) d[idx((rnd() * W) | 0, (rnd() * H) | 0, (rnd() * W) | 0)] = 1 + ((rnd() * 50) | 0);
  assertParity('realistic+edits', d);
}

// 3) Compressibility HARD GATE — guards against a future flat-layout change
//    silently collapsing compression while parity still passes.
console.log('compressibility gate:');
{
  const LIMIT = 26 * 1024;
  let worst = 0;
  for (let t = 0; t < 16; t++) worst = Math.max(worst, encodeColumnRLE(realisticChunk(), SIZE).length);
  const flat = W * H * W;
  if (worst < LIMIT) ok(`realistic chunk encodes to ${(worst / 1024).toFixed(1)} KiB < ${LIMIT / 1024} KiB limit (flat ${(flat / 1024).toFixed(0)} KiB → ${(100 - 100 * worst / flat).toFixed(0)}% saved)`);
  else fail(`realistic chunk encoded to ${(worst / 1024).toFixed(1)} KiB >= ${LIMIT / 1024} KiB limit — compression regressed (flat-layout y-stride changed?)`);
}

console.log('');
if (failures) { console.error(`FAILED: ${failures} assertion(s)`); process.exit(1); }
console.log('All RLE parity + compressibility checks passed.');
