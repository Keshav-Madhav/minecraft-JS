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
} | null;

export type MeshMessage = {
  type: 'mesh',
  version: number,
  key: string,
  data: ArrayBuffer,
  casters: GeometryPayload,
  nonCasters: GeometryPayload,
};

let config: ConfigMessage | null = null;
let sampler: WorldSampler | null = null;

function geometryToPayload(g: GeometryArrays | null): { payload: GeometryPayload, transfer: ArrayBuffer[] } {
  if (!g) return { payload: null, transfer: [] };
  return {
    payload: {
      positions: g.positions.buffer, normals: g.normals.buffer, uvs: g.uvs.buffer,
      layers: g.layers.buffer, indices: g.indices.buffer,
    },
    transfer: [g.positions.buffer, g.normals.buffer, g.uvs.buffer, g.layers.buffer, g.indices.buffer],
  };
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

  const data = generateChunkData(cfg.size, cfg.params, worldX, worldZ, cfg.resources);

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

  const geometry = buildChunkGeometry(data, cfg.size, getOutside);
  const casters = geometryToPayload(geometry.casters);
  const nonCasters = geometryToPayload(geometry.nonCasters);

  const dataCopy = data.slice(); // keep a transferable copy of the block data
  const message: MeshMessage = {
    type: 'mesh', version: cfg.version, key: msg.key,
    data: dataCopy.buffer, casters: casters.payload, nonCasters: nonCasters.payload,
  };
  (self as unknown as Worker).postMessage(message, [...casters.transfer, ...nonCasters.transfer, dataCopy.buffer]);
};
