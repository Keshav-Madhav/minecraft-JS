import {
  createWorldSampler, WorldSampler, ChunkParams, ChunkSize, ColumnSurface, surfaceMapColor,
  generateChunkData, blockMapColor, biomeWaterHex, blockIndex,
} from './chunkGen';
import { BLOCK_IDS, PLANT_LOOKUP } from './blockTypes';

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

const VOXEL_MAX_L = 512;       // voxel-accurate when a tile spans ≤512 world (≤4 blocks/px) —
                               // raised from 256 so the real generated blocks stay visible
                               // further out before falling back to the cheap terrain sampler
const TOPS_CACHE_MAX = 6144;   // LRU cap on cached per-chunk column-tops (~1.5KB each). Per worker;
                               // covers a couple of in-flight 512-world tiles (32×32 chunks) without
                               // ballooning memory now that several map workers run in parallel.

let params: ChunkParams | null = null;
let size: ChunkSize = { width: 16, height: 320 };   // must match World.chunkSize.height
let sampler: WorldSampler | null = null;
let sea = 64;

const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;

// --- cheap sampler path (coarse zoom) --------------------------------------
function colourSampler(s: ColumnSurface, slope: number, out: Uint8ClampedArray, di: number) {
  const mc = surfaceMapColor(s.surfaceId, s.biome, s.height, sea);
  let r = mc[0], g = mc[1], b = mc[2];
  shade(s.height, slope, r, g, b, out, di);
}
function shade(height: number, slope: number, r: number, g: number, b: number, out: Uint8ClampedArray, di: number) {
  if (height < sea) { const f = 1 - 0.45 * clamp((sea - height) / 40, 0, 1); r *= f; g *= f; b *= f; }
  else { const f = 0.92 + clamp((height - sea) / 80, 0, 1) * 0.16; r *= f; g *= f; b *= f; }
  const sh = clamp(1 + slope * 0.07, 0.55, 1.45);
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
  // [] resources (ores never surface) + skipFoliage (map reads top NON-plant blocks)
  const data = generateChunkData(size, params!, cx * W, cz * W, [], tint, { skipFoliage: true });
  const ids = new Uint8Array(W * W), ys = new Int16Array(W * W);
  for (let lx = 0; lx < W; lx++) for (let lz = 0; lz < W; lz++) {
    let topY = 0, topId = 0;
    for (let y = H - 1; y >= 0; y--) {
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
        const north = ys[(py > 0 ? py - 1 : py) * tilePx + px];
        shade(y, y - north, r, g, b, data, di);
      }
    }
  } else {
    // Coarse overview: cheap terrain sampler.
    const cols: ColumnSurface[] = new Array(tilePx * tilePx);
    for (let py = 0; py < tilePx; py++) {
      const wz = originZ + py * wpp;
      for (let px = 0; px < tilePx; px++) cols[py * tilePx + px] = sampler(originX + px * wpp, wz);
    }
    for (let py = 0; py < tilePx; py++) for (let px = 0; px < tilePx; px++) {
      const i = py * tilePx + px;
      const north = cols[(py > 0 ? py - 1 : py) * tilePx + px];
      colourSampler(cols[i], cols[i].height - north.height, data, i * 4);
    }
  }
  const res: MapTileResponse = { key, tilePx, buffer: data.buffer };
  (self as unknown as Worker).postMessage(res, [data.buffer]);
};
