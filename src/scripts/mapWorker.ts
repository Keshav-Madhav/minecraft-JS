import { createWorldSampler, WorldSampler, ChunkParams, ChunkSize, ColumnSurface } from './chunkGen';
import { BLOCK_IDS } from './blockTypes';

// Renders top-down map TILES off the main thread (the map used to sample terrain
// on the main thread, which was very laggy). Each tile is a fixed-resolution
// RGBA image of a square world region; the main thread caches them and just
// composites (drawImage) — so pan/zoom is cheap and smooth, and missing tiles
// fill in progressively.

type ConfigMsg = { type: 'config', params: ChunkParams, size: ChunkSize, sea: number };
type TileMsg = { type: 'tile', key: string, originX: number, originZ: number, tileWorld: number, tilePx: number };
export type MapWorkerRequest = ConfigMsg | TileMsg;
export type MapTileResponse = { key: string, tilePx: number, buffer: ArrayBuffer };

let sampler: WorldSampler | null = null;
let sea = 64;

const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;

function colour(s: ColumnSurface, slope: number, out: Uint8ClampedArray, di: number) {
  let r: number, g: number, b: number;
  if (s.height <= sea) {
    const depth = clamp((sea - s.height) / 28, 0, 1);
    r = 38 - 18 * depth; g = 96 - 44 * depth; b = 168 - 58 * depth;   // water
  } else {
    switch (s.surfaceId) {
      case BLOCK_IDS.grass: {
        // Plains -> forest: blend toward a darker, bluer green by forest density
        // so wooded regions read distinctly on the map.
        const t = s.forest;
        r = 92 + (38 - 92) * t;
        g = 150 + (92 - 150) * t;
        b = 64 + (46 - 64) * t;
        break;
      }
      case BLOCK_IDS.sand:  r = 214; g = 203; b = 146; break;
      case BLOCK_IDS.snow:  r = 236; g = 240; b = 246; break;
      case BLOCK_IDS.stone: r = 124; g = 120; b = 116; break;
      default:              r = 120; g = 120; b = 120;
    }
    const elev = clamp((s.height - sea) / 80, 0, 1);
    const f = 0.82 + elev * 0.32;
    r *= f; g *= f; b *= f;
  }
  const sh = clamp(1 + slope * 0.07, 0.55, 1.45); // hillshade
  out[di] = clamp(r * sh, 0, 255);
  out[di + 1] = clamp(g * sh, 0, 255);
  out[di + 2] = clamp(b * sh, 0, 255);
  out[di + 3] = 255;
}

self.onmessage = (e: MessageEvent<MapWorkerRequest>) => {
  const m = e.data;
  if (m.type === 'config') {
    sampler = createWorldSampler(m.params, m.size);
    sea = m.sea;
    return;
  }
  if (!sampler) return;

  const { key, originX, originZ, tileWorld, tilePx } = m;
  const wpp = tileWorld / tilePx;
  const cols: ColumnSurface[] = new Array(tilePx * tilePx);
  for (let py = 0; py < tilePx; py++) {
    const wz = originZ + py * wpp;
    for (let px = 0; px < tilePx; px++) {
      cols[py * tilePx + px] = sampler(originX + px * wpp, wz);
    }
  }
  const data = new Uint8ClampedArray(tilePx * tilePx * 4);
  for (let py = 0; py < tilePx; py++) {
    for (let px = 0; px < tilePx; px++) {
      const i = py * tilePx + px;
      const north = cols[(py > 0 ? py - 1 : py) * tilePx + px];
      colour(cols[i], cols[i].height - north.height, data, i * 4);
    }
  }
  const res: MapTileResponse = { key, tilePx, buffer: data.buffer };
  (self as unknown as Worker).postMessage(res, [data.buffer]);
};
