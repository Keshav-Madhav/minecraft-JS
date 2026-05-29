import { generateChunkData, createWorldSampler, WorldSampler, ChunkParams, ChunkSize } from './chunkGen';
import { ResourceGenInfo, BLOCK_IDS } from './blockTypes';
import { buildChunkGeometry, GeometryArrays } from './chunkMesh';

// The worker generates a chunk's block data AND greedily meshes it, off the
// main thread. Cross-chunk border faces are culled by sampling the deterministic
// terrain function (`columnSurface`) for the neighbour's surface height — a
// 1-block "apron" / ghost-cell border — rather than waiting for the neighbour
// chunk to load. So each chunk meshes EXACTLY ONCE, correctly, with no cache and
// no neighbour re-mesh. (Player-edited borders are re-meshed on the main thread,
// which has the real edited data.) Being stateless also makes the worker
// trivially poolable later.

type ConfigMessage = {
  type: 'config',
  version: number,
  size: ChunkSize,
  params: ChunkParams,
  resources: ResourceGenInfo[],
};
type GenMessage = { type: 'gen', version: number, key: string, worldX: number, worldZ: number };
export type WorkerRequest = ConfigMessage | GenMessage;

export type GeometryPayload = {
  positions: ArrayBuffer, normals: ArrayBuffer, uvs: ArrayBuffer, layers: ArrayBuffer, indices: ArrayBuffer,
  i16: boolean,   // whether `indices` is a Uint16Array (else Uint32Array) — for reconstruction on the main thread
  colors?: ArrayBuffer,   // plants group only: vec4/vertex (biome tint rgb + wind sway a)
} | null;

export type MeshMessage = {
  type: 'mesh',
  version: number,
  key: string,
  data: ArrayBuffer,
  casters: GeometryPayload,
  nonCasters: GeometryPayload,
  plants: GeometryPayload,   // cross-billboard / carpet / vine foliage
};

let config: ConfigMessage | null = null;
let sampler: WorldSampler | null = null;

function geometryToPayload(g: GeometryArrays | null): { payload: GeometryPayload, transfer: ArrayBuffer[] } {
  if (!g) return { payload: null, transfer: [] };
  const payload: GeometryPayload = {
    positions: g.positions.buffer, normals: g.normals.buffer, uvs: g.uvs.buffer,
    layers: g.layers.buffer, indices: g.indices.buffer, i16: g.indices instanceof Uint16Array,
  };
  const transfer = [g.positions.buffer, g.normals.buffer, g.uvs.buffer, g.layers.buffer, g.indices.buffer];
  if (g.colors) { payload.colors = g.colors.buffer; transfer.push(g.colors.buffer); }
  return { payload, transfer };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'config') {
    config = msg;
    sampler = createWorldSampler(msg.params, msg.size);
    return;
  }

  // gen
  if (!config || !sampler || msg.version !== config.version) return; // stale request
  const cfg = config;
  const sample = sampler;
  const { worldX, worldZ } = msg;

  // Capture the per-column biome during generation so plant tinting is a free
  // array lookup instead of re-sampling columnSurface for every grass-tinted cell.
  const biomeMap = new Uint8Array(cfg.size.width * cfg.size.width);
  const data = generateChunkData(cfg.size, cfg.params, worldX, worldZ, cfg.resources, biomeMap);

  // Apron: neighbour solidity from the deterministic surface height. Memoised
  // per border column so repeated y queries are O(1). Returns any non-air id for
  // solid (only air-vs-solid matters for face culling).
  const heightCache = new Map<number, number>();
  const getOutside = (lx: number, y: number, lz: number) => {
    const key = (lx + 1) * 100000 + (lz + 1);
    let h = heightCache.get(key);
    if (h === undefined) { h = sample(worldX + lx, worldZ + lz).height; heightCache.set(key, h); }
    return y <= h ? BLOCK_IDS.stone : BLOCK_IDS.air;
  };

  // Plant tint reads the biome straight from the precomputed map (in-chunk only).
  const bw = cfg.size.width;
  const getBiome = (lx: number, lz: number) => biomeMap[lx * bw + lz];

  const geometry = buildChunkGeometry(data, cfg.size, getOutside, getBiome);
  const casters = geometryToPayload(geometry.casters);
  const nonCasters = geometryToPayload(geometry.nonCasters);
  const plants = geometryToPayload(geometry.plants);

  // Transfer the block-data buffer directly (no copy): `data` is freshly
  // allocated per gen, the mesher kept no reference to it, and the worker doesn't
  // touch it after posting — so the previous defensive `.slice()` was a wasted
  // 64KB alloc+memcpy per chunk.
  const message: MeshMessage = {
    type: 'mesh', version: cfg.version, key: msg.key,
    data: data.buffer, casters: casters.payload, nonCasters: nonCasters.payload, plants: plants.payload,
  };
  (self as unknown as Worker).postMessage(message,
    [...casters.transfer, ...nonCasters.transfer, ...plants.transfer, data.buffer]);
};
