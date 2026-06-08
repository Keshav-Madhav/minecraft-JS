import { generateChunkData, createWorldSampler, createCaveSampler, LAVA_Y, ICE_SURFACE_TEMP, wellShaftRange, biomeWaterHex, climateGrassTint, WorldSampler, ChunkParams, ChunkSize } from './chunkGen';
import { ResourceGenInfo, BLOCK_IDS } from './blockTypes';
import { buildChunkGeometry, buildChunkMapTile, scanEmitters, GeometryArrays } from './chunkMesh';
import { buildLodTile } from './lodMesh';

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
// LOD far-terrain tile: meshed purely from the deterministic sampler (no voxel
// data) at a coarse stride. tileBlocks = tile edge in blocks (a multiple of the
// chunk width, chosen by World); stride = blocks per LOD cell.
type LodMessage = { type: 'lod', version: number, key: string, worldX: number, worldZ: number, tileBlocks: number, stride: number };
// Re-mesh EXISTING chunk data off-thread (a copy of the chunk's block array is
// sent along). Used when a batched far chunk is demoted into the near ring and
// needs individual meshes again — running the full mesher on the main thread
// for every boundary crossing was a profiled multi-ms/frame sink.
type RemeshMessage = { type: 'remesh', version: number, key: string, worldX: number, worldZ: number, data: ArrayBuffer };
export type WorkerRequest = ConfigMessage | GenMessage | LodMessage | RemeshMessage;

// Quantized vertex format (see chunkMesh.ts): positions/uvs are u16, layers is
// u16 (textureLayer | faceId<<12 — face id replaces the old normals buffer).
export type GeometryPayload = {
  positions: ArrayBuffer, uvs: ArrayBuffer, layers: ArrayBuffer, indices: ArrayBuffer,
  i16: boolean,   // whether `indices` is a Uint16Array (else Uint32Array) — for reconstruction on the main thread
  colors?: ArrayBuffer,   // vec4/vertex tint: plants (rgb + sway a) AND cubes (biome tint rgb, white=untinted)
} | null;

export type MeshMessage = {
  type: 'mesh',
  version: number,
  key: string,
  remesh?: boolean,          // reply to a 'remesh' request (chunk already loaded — apply replaces its meshes)
  data: ArrayBuffer,
  casters: GeometryPayload,
  nonCasters: GeometryPayload,
  plants: GeometryPayload,   // cross-billboard / carpet / vine foliage
  emitters: ArrayBuffer,     // light-emitter world positions [wx,wy,wz,id,…] (Float32) for the point-light pool
  mapTile: ArrayBuffer,      // W×W RGBA top-down tile for the in-sync minimap (Uint8)
};

// LOD tile reply. `stride` is echoed so World can reject a stale reply when the
// tile's desired stride changed while this one was in flight (key alone is not
// enough — same tile, different detail level).
export type LodMeshMessage = {
  type: 'lodMesh',
  version: number,
  key: string,
  stride: number,
  terrain: GeometryPayload,   // opaque blocky heightmap (blockArrayMaterial)
  canopy: GeometryPayload,    // statistical leaf boxes (leafArrayMaterial — alpha-cutout)
};
export type WorkerReply = MeshMessage | LodMeshMessage;

let config: ConfigMessage | null = null;
let sampler: WorldSampler | null = null;
let caveSampler: ReturnType<typeof createCaveSampler> | null = null;

function geometryToPayload(g: GeometryArrays | null): { payload: GeometryPayload, transfer: ArrayBuffer[] } {
  if (!g) return { payload: null, transfer: [] };
  const payload: GeometryPayload = {
    positions: g.positions.buffer, uvs: g.uvs.buffer,
    layers: g.layers.buffer, indices: g.indices.buffer, i16: g.indices instanceof Uint16Array,
  };
  const transfer = [g.positions.buffer, g.uvs.buffer, g.layers.buffer, g.indices.buffer];
  if (g.colors) { payload.colors = g.colors.buffer; transfer.push(g.colors.buffer); }
  return { payload, transfer };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'config') {
    config = msg;
    sampler = createWorldSampler(msg.params, msg.size);
    caveSampler = createCaveSampler(msg.params);
    return;
  }

  if (!config || !sampler || !caveSampler || msg.version !== config.version) return; // stale request

  if (msg.type === 'lod') {
    // LOD far-terrain tile: pure sampler → mesh, no voxel data. Same stateless
    // determinism as chunk gens (a neighbour tile computes identical borders).
    const geo = buildLodTile(sampler, config.params.terrain.waterOffset, config.size.height - 1,
      msg.worldX, msg.worldZ, msg.tileBlocks, msg.stride, config.params.seed);
    const terrain = geometryToPayload(geo.terrain);
    const canopy = geometryToPayload(geo.canopy);
    const reply: LodMeshMessage = {
      type: 'lodMesh', version: config.version, key: msg.key, stride: msg.stride,
      terrain: terrain.payload, canopy: canopy.payload,
    };
    (self as unknown as Worker).postMessage(reply, [...terrain.transfer, ...canopy.transfer]);
    return;
  }

  // gen | remesh
  const cfg = config;
  const sample = sampler;
  const caveAt = caveSampler;
  const { worldX, worldZ } = msg;

  // Capture the per-column climate grass tint during generation so plant tinting
  // is a free array read instead of re-sampling columnSurface per grass cell.
  const tw = cfg.size.width;
  const tintMap = new Uint8Array(tw * tw * 3);
  let data: Uint8Array;
  if (msg.type === 'remesh') {
    // Existing chunk data shipped with the request — no generation pass, so the
    // tints come straight from the sampler (one call per column, same source).
    data = new Uint8Array(msg.data);
    for (let lx = 0; lx < tw; lx++) {
      for (let lz = 0; lz < tw; lz++) {
        const s = sample(worldX + lx, worldZ + lz);
        const t = climateGrassTint(s.temp, s.humid);
        const i = (lx * tw + lz) * 3;
        tintMap[i] = (t[0] * 255) | 0; tintMap[i + 1] = (t[1] * 255) | 0; tintMap[i + 2] = (t[2] * 255) | 0;
      }
    }
  } else {
    data = generateChunkData(cfg.size, cfg.params, worldX, worldZ, cfg.resources, tintMap);
  }

  // Apron: neighbour solidity from the deterministic surface height. Memoised
  // per border column so repeated y queries are O(1). Returns any non-air id for
  // solid (only air-vs-solid matters for face culling).
  const surfCache = new Map<number, ReturnType<typeof sample>>();
  // A well's centre column is hollow below ground; cache its carved range per
  // border column so a chunk border bisecting a well still seals the shaft wall.
  const carveCache = new Map<number, [number, number] | null>();
  const sea = cfg.params.terrain.waterOffset;
  const getOutside = (lx: number, y: number, lz: number) => {
    const key = (lx + 1) * 100000 + (lz + 1);
    let s = surfCache.get(key);
    if (s === undefined) { s = sample(worldX + lx, worldZ + lz); surfCache.set(key, s); }
    const h = s.height;
    if (y > h) {
      // Frozen ocean/river: a 1-2 block ice cap sits at y=sea / sea-1 on cold
      // submerged columns (placed in generateTerrain above the heightmap). The
      // apron must report it solid or the shared border ice face is double-drawn.
      if (h < sea && (y === sea || y === sea - 1) && s.temp < ICE_SURFACE_TEMP) return BLOCK_IDS.stone;
      return BLOCK_IDS.air;
    }
    let carve = carveCache.get(key);
    if (carve === undefined) { carve = wellShaftRange(cfg.params, sample, worldX + lx, worldZ + lz); carveCache.set(key, carve); }
    if (carve && y >= carve[0] && y <= carve[1]) return BLOCK_IDS.air;
    // Caves: mirror the body's carve so border cave walls aren't culled into holes.
    // Lava-filled cells (y<=LAVA_Y) are opaque solid → report solid (cull); open
    // cave air → report air (draw the wall face). Matches the body's solidity exactly.
    if (caveAt(worldX + lx, y, worldZ + lz, h)) return y <= LAVA_Y ? BLOCK_IDS.stone : BLOCK_IDS.air;
    return BLOCK_IDS.stone;
  };

  // Plant tint reads the precomputed climate grass tint directly (in-chunk only).
  const getTint = (lx: number, lz: number): readonly [number, number, number] => {
    const i = (lx * tw + lz) * 3;
    return [tintMap[i] / 255, tintMap[i + 1] / 255, tintMap[i + 2] / 255];
  };

  const geometry = buildChunkGeometry(data, cfg.size, getOutside, getTint);
  const casters = geometryToPayload(geometry.casters);
  const nonCasters = geometryToPayload(geometry.nonCasters);
  const plants = geometryToPayload(geometry.plants);
  // light-emitter positions for the point-light pool (read `data` before transfer)
  const emitters = scanEmitters(data, cfg.size, worldX, worldZ);
  // Top-down minimap tile from the same real block data the world renders, so the
  // minimap is always in-sync without a separate generation round-trip. Water hue
  // is sampled per submerged column (cheap — only ocean columns hit the sampler).
  // (`sea` is declared once above, reused here for the map tile.)
  const mapTile = buildChunkMapTile(data, cfg.size, sea, getTint,
    (lx, lz) => biomeWaterHex(sample(worldX + lx, worldZ + lz).biome));

  // Transfer the block-data buffer directly (no copy): `data` is freshly
  // allocated per gen, the mesher kept no reference to it, and the worker doesn't
  // touch it after posting — so the previous defensive `.slice()` was a wasted
  // 64KB alloc+memcpy per chunk.
  const message: MeshMessage = {
    type: 'mesh', version: cfg.version, key: msg.key, remesh: msg.type === 'remesh',
    data: data.buffer, casters: casters.payload, nonCasters: nonCasters.payload, plants: plants.payload,
    emitters: emitters.buffer, mapTile: mapTile.buffer,
  };
  (self as unknown as Worker).postMessage(message,
    [...casters.transfer, ...nonCasters.transfer, ...plants.transfer, data.buffer, emitters.buffer, mapTile.buffer]);
};
