// Worker-pipeline phase bench: measures generateChunkData + buildChunkGeometry +
// map tile + emitters over real chunks, phase by phase, in node (esbuild-bundled).
// Usage: node bench-gen.mjs [--save baseline.json] [--compare baseline.json]
// --save also records byte checksums of data+geometry so an optimized build can
// prove output is BYTE-IDENTICAL (stronger than mesh-parity over a fixed set).
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const entry = `
export { generateChunkData, createWorldSampler, createCaveSampler, wellShaftRange, ICE_SURFACE_TEMP, biomeWaterHex, climateGrassTint } from '${ROOT}/src/scripts/chunkGen.ts';
export { buildChunkGeometry, buildChunkMapTile, scanEmitters } from '${ROOT}/src/scripts/chunkMesh.ts';
export { resources } from '${ROOT}/src/scripts/blocks.ts';
export { BLOCK_IDS } from '${ROOT}/src/scripts/blockTypes.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'mc-bench-'));
writeFileSync(join(dir, 'entry.ts'), entry);
await build({
  entryPoints: [join(dir, 'entry.ts')],
  bundle: true, format: 'esm', platform: 'node',
  outfile: join(dir, 'bundle.mjs'),
  absWorkingDir: process.cwd(),
  alias: {},
});
const M = await import(pathToFileURL(join(dir, 'bundle.mjs')).href);

const size = { width: 16, height: 320 };
const params = {
  seed: 4242,
  terrain: { scale: 260, magnitude: 60, offset: 10, waterOffset: 128 },
  trees: { trunk: { minHeight: 4, maxHeight: 7 }, canopy: { minRadius: 2, maxRadius: 3, density: 0.7 }, frequency: 0.04 },
  clouds: { scale: 20, density: 0.2 },
};
const resourcePayload = M.resources.map(r => ({
  id: r.id, scale: { x: r.scale.x, y: r.scale.y, z: r.scale.z },
  scarcity: r.scarcity, minY: r.minY, maxY: r.maxY,
}));

// Chunk set: a ring around spawn + a far band (mountains/ocean variety), fixed.
const coords = [];
for (let cx = -4; cx <= 4; cx += 2) for (let cz = -4; cz <= 4; cz += 2) coords.push([cx, cz]);
for (let cx = 40; cx <= 48; cx += 4) for (let cz = -8; cz <= 8; cz += 4) coords.push([cx, cz]);
const W = size.width;

function meshChunk(data, worldX, worldZ, sample, caveAt) {
  // mirrors chunkWorker.ts getOutside/getTint
  const surfCache = new Map();
  const carveCache = new Map();
  const sea = params.terrain.waterOffset;
  const getOutside = (lx, y, lz) => {
    const key = (lx + 1) * 100000 + (lz + 1);
    let s = surfCache.get(key);
    if (s === undefined) { s = sample(worldX + lx, worldZ + lz); surfCache.set(key, s); }
    const h = s.height;
    if (y > h) {
      if (h < sea && (y === sea || y === sea - 1) && s.temp < M.ICE_SURFACE_TEMP) return 1;
      return 0;
    }
    let carve = carveCache.get(key);
    if (carve === undefined) { carve = M.wellShaftRange(params, sample, worldX + lx, worldZ + lz); carveCache.set(key, carve); }
    if (carve && y >= carve[0] && y <= carve[1]) return 0;
    if (caveAt(worldX + lx, y, worldZ + lz, h)) return y <= 11 ? 1 : 0;
    return 1;
  };
  const tintMap = new Uint8Array(W * W * 3);
  for (let lx = 0; lx < W; lx++) for (let lz = 0; lz < W; lz++) {
    const s = sample(worldX + lx, worldZ + lz);
    const t = M.climateGrassTint(s.temp, s.humid);
    const i = (lx * W + lz) * 3;
    tintMap[i] = (t[0] * 255) | 0; tintMap[i + 1] = (t[1] * 255) | 0; tintMap[i + 2] = (t[2] * 255) | 0;
  }
  const getTint = (lx, lz) => { const i = (lx * W + lz) * 3; return [tintMap[i] / 255, tintMap[i + 1] / 255, tintMap[i + 2] / 255]; };
  return M.buildChunkGeometry(data, size, getOutside, getTint);
}

const hash = (bufs) => {
  const h = createHash('sha256');
  for (const b of bufs) if (b) h.update(Buffer.from(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength));
  return h.digest('hex').slice(0, 16);
};

// warmup (JIT)
{
  const sample = M.createWorldSampler(params, size);
  const caveAt = M.createCaveSampler(params);
  const d = M.generateChunkData(size, params, 0, 0, resourcePayload);
  meshChunk(d, 0, 0, sample, caveAt);
}

const t = { genFull: 0, genNoOres: 0, genSurface: 0, mesh: 0, mapTile: 0, emitters: 0 };
const checks = [];
const sample = M.createWorldSampler(params, size);
const caveAt = M.createCaveSampler(params);
for (const [cx, cz] of coords) {
  const wx = cx * W, wz = cz * W;
  let t0 = performance.now();
  const data = M.generateChunkData(size, params, wx, wz, resourcePayload);
  t.genFull += performance.now() - t0;

  t0 = performance.now();
  M.generateChunkData(size, params, wx, wz, []);
  t.genNoOres += performance.now() - t0;

  t0 = performance.now();
  M.generateChunkData(size, params, wx, wz, resourcePayload, undefined, { surfaceOnly: true, skipFoliage: true });
  t.genSurface += performance.now() - t0;

  t0 = performance.now();
  const geo = meshChunk(data, wx, wz, sample, caveAt);
  t.mesh += performance.now() - t0;

  t0 = performance.now();
  const tile = M.buildChunkMapTile(data, size, params.terrain.waterOffset, undefined, undefined);
  t.mapTile += performance.now() - t0;

  t0 = performance.now();
  const em = M.scanEmitters(data, size, wx, wz);
  t.emitters += performance.now() - t0;

  checks.push({
    key: `${cx},${cz}`,
    data: hash([data]),
    geo: hash([geo.casters?.positions, geo.casters?.indices, geo.casters?.layers, geo.casters?.colors,
      geo.nonCasters?.positions, geo.nonCasters?.indices, geo.plants?.positions, geo.plants?.indices, geo.plants?.colors]),
    tile: hash([tile]), em: hash([em]),
  });
}

const n = coords.length;
const per = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +(v / n).toFixed(3)]));
per.genDeepFill = +(per.genFull - per.genSurface).toFixed(3); // deep fill + foliage cost (skipped in surface mode)
per.genOres = +(per.genFull - per.genNoOres).toFixed(3);
per.totalPerChunk = +(per.genFull + per.mesh + per.mapTile + per.emitters).toFixed(3);
console.log(`chunks: ${n}  (ms/chunk)`);
console.table(per);

const args = process.argv.slice(2);
const si = args.indexOf('--save');
if (si >= 0) { writeFileSync(args[si + 1], JSON.stringify({ per, checks }, null, 1)); console.log('saved', args[si + 1]); }
const ci = args.indexOf('--compare');
if (ci >= 0) {
  const base = JSON.parse(readFileSync(args[ci + 1], 'utf8'));
  let ok = true;
  for (let i = 0; i < checks.length; i++) {
    const a = base.checks[i], b = checks[i];
    for (const f of ['data', 'geo', 'tile', 'em']) if (a[f] !== b[f]) { ok = false; console.error(`MISMATCH ${b.key} ${f}: ${a[f]} != ${b[f]}`); }
  }
  console.log(ok ? 'PARITY OK — output byte-identical to baseline' : 'PARITY FAILED');
  console.log('speedup genFull:', (base.per.genFull / per.genFull).toFixed(2) + 'x', ' mesh:', (base.per.mesh / per.mesh).toFixed(2) + 'x',
    ' total:', (base.per.totalPerChunk / per.totalPerChunk).toFixed(2) + 'x');
  if (!ok) process.exit(1);
}
