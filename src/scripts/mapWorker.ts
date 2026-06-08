import {
  createWorldSampler, WorldSampler, ChunkParams, ChunkSize, ColumnSurface, surfaceMapColor,
  generateChunkData, blockMapColor, biomeWaterHex, blockIndex,
  structInfo, structureFitsBiome, structureMapMark, STRUCT_CELL, STRUCT_MAX_R,
  LOD_CANOPY,
} from './chunkGen';
import { BLOCK_IDS, PLANT_LOOKUP } from './blockTypes';

// Statistical canopy hash — mirrors lodMesh's so the map's forest density
// agrees with the in-world far-LOD trees. Pure fn of the 4-block canopy cell.
function canopyHash(x: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Renders top-down map TILES off the main thread. Two paths:
//  • VOXEL-ACCURATE (zoomed in, tileWorld ≤ VOXEL_MAX_L): generates the REAL chunk
//    data and reads the top non-plant block of each column — so structures, ice
//    spikes, terrain edits, everything show with NO separate map logic to keep in
//    sync. Per-chunk "tops" are cached (LRU) and reused across tiles/frames.
//  • SAMPLER (far-out overview, tileWorld > VOXEL_MAX_L): the cheap terrain
//    function only — at continent scale individual blocks are sub-pixel anyway.
// (Structure MARKERS, drawn by the main thread, make structures findable at any zoom.)

type ConfigMsg = { type: 'config', params: ChunkParams, size: ChunkSize, sea: number };
type TileMsg = { type: 'tile', key: string, originX: number, originZ: number, tileWorld: number, tilePx: number };
export type MapWorkerRequest = ConfigMsg | TileMsg;
export type MapTileResponse = { key: string, tilePx: number, buffer: ArrayBuffer };

// voxel-accurate only at the DEEPEST zoom (1 block/px). 512 was catastrophic:
// the DEFAULT open zoom (wpp 6 → L 512) took this path, and one 512-tile is
// 32×32 = 1024 full generateChunkData calls — a cold open queued ~30 such
// tiles ≈ tens of thousands of chunk gens, so the map took ages to fill ("map
// opening is absurdly slow"). At 128 a tile is ≤64 gens and only when the user
// deliberately zooms all the way in; everything coarser uses the sampler path
// (~16k columnSurface evals ≈ tens of ms per tile). The loaded-chunk overlay
// still paints the REAL voxel world around the player at every zoom.
const VOXEL_MAX_L = 256;       // voxel-accurate when a tile spans ≤256 world (≤2 blocks/px) —
                               // surfaceOnly + bounded scan put a chunk at ~1.0ms, so a 256-tile
                               // (256 chunks) ≈ 0.26s and a cold medium-zoom view fills <1s across
                               // the worker pool (nearest-first), then caches. This is the true
                               // per-block range; raised from 128 once voxel gen got ~9× cheaper.
                               // 512 stays sampler (1024 chunks/tile ≈ 1s/tile = too slow);
                               // sampler + structure overlay covers the overview, fast & accurate.
const TOPS_CACHE_MAX = 6144;   // LRU cap on cached per-chunk column-tops (~1.5KB each). Per worker;
                               // covers a couple of in-flight 512-world tiles (32×32 chunks) without
                               // ballooning memory now that several map workers run in parallel.

let params: ChunkParams | null = null;
let size: ChunkSize = { width: 16, height: 320 };   // must match World.chunkSize.height
let sampler: WorldSampler | null = null;
let sea = 64;

const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;

// --- cheap sampler path (coarse zoom) --------------------------------------
// Pre-shade top-down colour for a sampled column: leaves if a tree tops this
// 4-block cell (STATISTICAL CANOPY — same CGRID + density as the far-LOD, and
// the SAME blockMapColor a leaf-topped voxel column uses, so the paths agree),
// else the terrain surface block. Returned UN-shaded so the supersampler can
// average raw colours before the single hillshade pass.
function baseColorAt(s: ColumnSurface, wx: number, wz: number): readonly [number, number, number] {
  if (s.height >= sea) {
    const lc = LOD_CANOPY[s.biome];
    if (lc) {
      const cx = Math.floor(wx / 4) * 4, cz = Math.floor(wz / 4) * 4;
      if (canopyHash(cx, cz) < lc.prob) return blockMapColor(lc.leafId);
    }
  }
  return surfaceMapColor(s.surfaceId, s.biome, s.height, sea);
}
function shade(height: number, slope: number, r: number, g: number, b: number, out: Uint8ClampedArray, di: number) {
  if (height < sea) { const f = 1 - 0.45 * clamp((sea - height) / 40, 0, 1); r *= f; g *= f; b *= f; }
  // hypsometric + hillshade constants MUST mirror chunkMesh.ts tileShade —
  // scaled to the post-orogeny world (peaks ~+170): 0.84 at sea → 1.30 summits.
  else { const f = 0.84 + clamp((height - sea) / 170, 0, 1) * 0.46; r *= f; g *= f; b *= f; }
  const sh = clamp(1 + slope * 0.12, 0.45, 1.6);
  out[di] = clamp(r * sh, 0, 255); out[di + 1] = clamp(g * sh, 0, 255); out[di + 2] = clamp(b * sh, 0, 255); out[di + 3] = 255;
}

// --- voxel path (fine zoom): real per-chunk top blocks ---------------------
type ChunkTops = { ids: Uint8Array, ys: Int16Array, tint: Uint8Array };
const topsCache = new Map<string, ChunkTops>();
function chunkTops(cx: number, cz: number): ChunkTops {
  const key = cx + ',' + cz;
  let t = topsCache.get(key);
  if (t) { topsCache.delete(key); topsCache.set(key, t); return t; }   // LRU touch
  const W = size.width, H = size.height;
  const tint = new Uint8Array(W * W * 3);
  // surfaceOnly: skip the deep cave/deepslate noise fill (invisible from above,
  // ~89% of chunk-gen cost) — the map stays voxel-accurate (real terrain top +
  // trees + structures + snow) but generates ~9× faster.
  // [] resources (ores never surface) + skipFoliage (map reads top NON-plant blocks).
  const hmap = new Int16Array(W * W);
  const data = generateChunkData(size, params!, cx * W, cz * W, [], tint, { skipFoliage: true, surfaceOnly: true, outHeight: hmap });
  const ids = new Uint8Array(W * W), ys = new Int16Array(W * W);
  // SCAN_MARGIN: tallest thing a structure/tree puts above terrain height (tower
  // ~+24, monastery bell +13, ice spike, snow) — start the per-column top-down
  // scan at height+margin instead of the world ceiling, skipping ~150 air-reads.
  const SCAN_MARGIN = 64;
  for (let lx = 0; lx < W; lx++) for (let lz = 0; lz < W; lz++) {
    let topY = 0, topId = 0;
    const ceil = Math.min(H - 1, hmap[lx * W + lz] + SCAN_MARGIN);
    for (let y = ceil; y >= 0; y--) {
      const id = data[blockIndex(lx, y, lz, size)];
      if (id !== BLOCK_IDS.air && PLANT_LOOKUP[id] === 0) { topY = y; topId = id; break; }  // plants omitted
    }
    ids[lx * W + lz] = topId; ys[lx * W + lz] = topY;
  }
  t = { ids, ys, tint };
  topsCache.set(key, t);
  if (topsCache.size > TOPS_CACHE_MAX) topsCache.delete(topsCache.keys().next().value as string);
  return t;
}

// Paint deterministic structures over a sampler tile. Scans the structInfo
// region grid overlapping the tile (+STRUCT_MAX_R pad for origins just outside
// whose footprint reaches in), biome-checks each, and fills a footprint disc
// shaded into the same hypsometric ramp as the terrain so it sits in the map.
// Min ~0.8px radius so a structure is a visible dot even at continent zoom.
function paintStructures(data: Uint8ClampedArray, tilePx: number, originX: number, originZ: number, wpp: number) {
  if (!sampler) return;
  const tileWorld = tilePx * wpp;
  const cx0 = Math.floor((originX - STRUCT_MAX_R) / STRUCT_CELL), cx1 = Math.floor((originX + tileWorld + STRUCT_MAX_R) / STRUCT_CELL);
  const cz0 = Math.floor((originZ - STRUCT_MAX_R) / STRUCT_CELL), cz1 = Math.floor((originZ + tileWorld + STRUCT_MAX_R) / STRUCT_CELL);
  for (let gx = cx0; gx <= cx1; gx++) {
    for (let gz = cz0; gz <= cz1; gz++) {
      const s = structInfo(gx, gz, params!.seed);
      if (!s) continue;
      const mark = structureMapMark(s.kind);
      if (!mark) continue;
      const col = sampler(s.ox, s.oz);
      if (!structureFitsBiome(s.kind, col.biome)) continue;
      // shade the marker by the structure's ground height (flat marker, no slope)
      const tmp = new Uint8ClampedArray(4);
      shade(col.height, 0, mark.col[0], mark.col[1], mark.col[2], tmp, 0);
      const cpx = (s.ox - originX) / wpp, cpz = (s.oz - originZ) / wpp;
      const rp = Math.max(0.8, mark.r / wpp);
      const x0 = Math.max(0, Math.floor(cpx - rp)), x1 = Math.min(tilePx - 1, Math.ceil(cpx + rp));
      const z0 = Math.max(0, Math.floor(cpz - rp)), z1 = Math.min(tilePx - 1, Math.ceil(cpz + rp));
      const rp2 = rp * rp;
      for (let py = z0; py <= z1; py++) for (let px = x0; px <= x1; px++) {
        const dx = px - cpx, dz = py - cpz;
        if (dx * dx + dz * dz > rp2) continue;
        const di = (py * tilePx + px) * 4;
        data[di] = tmp[0]; data[di + 1] = tmp[1]; data[di + 2] = tmp[2]; data[di + 3] = 255;
      }
    }
  }
}

self.onmessage = (e: MessageEvent<MapWorkerRequest>) => {
  const m = e.data;
  if (m.type === 'config') {
    params = m.params; size = m.size; sea = m.sea;
    sampler = createWorldSampler(m.params, m.size);
    topsCache.clear();
    return;
  }
  if (!sampler || !params) return;
  const { key, originX, originZ, tileWorld, tilePx } = m;
  const wpp = tileWorld / tilePx;
  const data = new Uint8ClampedArray(tilePx * tilePx * 4);
  const W = size.width;

  if (tileWorld <= VOXEL_MAX_L) {
    // Voxel-accurate: sample the REAL top block per pixel. Two passes so hillshade
    // can use the north pixel's height.
    const ids = new Int32Array(tilePx * tilePx), ys = new Int16Array(tilePx * tilePx);
    const tr = new Uint8Array(tilePx * tilePx), tg = new Uint8Array(tilePx * tilePx), tb = new Uint8Array(tilePx * tilePx);
    for (let py = 0; py < tilePx; py++) {
      const wz = Math.floor(originZ + py * wpp);
      for (let px = 0; px < tilePx; px++) {
        const wx = Math.floor(originX + px * wpp);
        const cx = Math.floor(wx / W), cz = Math.floor(wz / W);
        const lx = wx - cx * W, lz = wz - cz * W, c = lx * W + lz;
        const t = chunkTops(cx, cz);
        const o = py * tilePx + px;
        ids[o] = t.ids[c]; ys[o] = t.ys[c];
        tr[o] = t.tint[c * 3]; tg[o] = t.tint[c * 3 + 1]; tb[o] = t.tint[c * 3 + 2];
      }
    }
    for (let py = 0; py < tilePx; py++) {
      for (let px = 0; px < tilePx; px++) {
        const o = py * tilePx + px, di = o * 4, id = ids[o], y = ys[o];
        let r: number, g: number, b: number;
        if (y < sea) {                                   // open water above the bed → water hue + depth
          const wx = Math.floor(originX + px * wpp), wz = Math.floor(originZ + py * wpp);
          const hex = biomeWaterHex(sampler!(wx, wz).biome);
          r = (hex >> 16) & 255; g = (hex >> 8) & 255; b = hex & 255;
        } else if (id === BLOCK_IDS.grass) {             // climate-tinted grass
          r = tr[o]; g = tg[o]; b = tb[o];
        } else {
          const mc = blockMapColor(id); r = mc[0]; g = mc[1]; b = mc[2];
        }
        // NW light (matches chunkMesh tile hillshade)
        const north = ys[(py > 0 ? py - 1 : py) * tilePx + px];
        const west = ys[py * tilePx + (px > 0 ? px - 1 : px)];
        shade(y, ((y - north) + (y - west)) * 0.6, r, g, b, data, di);
      }
    }
  } else {
    // Coarse overview: terrain sampler with ADAPTIVE SUPERSAMPLING. At ≥7 blocks/
    // px (the 1024+ levels) one sample per pixel ALIASES — thin rivers/coasts
    // flicker and the binary tree canopy turns to salt-and-pepper speckle. So
    // each pixel averages an S×S grid of subsamples (S grows with wpp), blending
    // tree coverage into smooth canopy and anti-aliasing thin features — the
    // coarse map then reads as clean as the 512 level. S² sampler calls/pixel,
    // but coarse tiles are huge on screen so few cover the view; fills fast +
    // caches. 512 (wpp≤6) stays S=1 — already crisp, no extra cost.
    const S = wpp >= 13 ? 3 : wpp >= 7 ? 2 : 1;
    const inv = 1 / S, n = S * S;
    const avgH = new Float32Array(tilePx * tilePx);
    const br = new Float32Array(tilePx * tilePx), bg = new Float32Array(tilePx * tilePx), bb = new Float32Array(tilePx * tilePx);
    for (let py = 0; py < tilePx; py++) {
      for (let px = 0; px < tilePx; px++) {
        let rs = 0, gs = 0, bs = 0, hs = 0;
        for (let sj = 0; sj < S; sj++) {
          const wz = originZ + (py + (sj + 0.5) * inv) * wpp;
          for (let si = 0; si < S; si++) {
            const wx = originX + (px + (si + 0.5) * inv) * wpp;
            const c = sampler(wx, wz);
            const col = baseColorAt(c, Math.floor(wx), Math.floor(wz));
            rs += col[0]; gs += col[1]; bs += col[2]; hs += c.height;
          }
        }
        const i = py * tilePx + px;
        avgH[i] = hs / n; br[i] = rs / n; bg[i] = gs / n; bb[i] = bs / n;
      }
    }
    for (let py = 0; py < tilePx; py++) for (let px = 0; px < tilePx; px++) {
      const i = py * tilePx + px;
      const north = avgH[(py > 0 ? py - 1 : py) * tilePx + px];
      const west = avgH[py * tilePx + (px > 0 ? px - 1 : px)];
      shade(avgH[i], ((avgH[i] - north) + (avgH[i] - west)) * 0.6, br[i], bg[i], bb[i], data, i * 4);
    }
    // STRUCTURE OVERLAY: the sampler only knows terrain, so paint structures
    // from the deterministic structInfo grid — accurate placement + footprint
    // at sampler speed (no voxel generation). This is what makes the fast
    // overview "voxel-accurate-looking": real terrain + real structures.
    paintStructures(data, tilePx, originX, originZ, wpp);
  }
  const res: MapTileResponse = { key, tilePx, buffer: data.buffer };
  (self as unknown as Worker).postMessage(res, [data.buffer]);
};
