import * as Three from 'three';
import { WorldChunk } from './worldChunk';
import { Player } from './player';
import { DataStore } from './dataStore';
import { resources } from './blocks';
import { ChunkParams, generateChunkData, createWorldSampler, WorldSampler, climateGrassTint } from './chunkGen';
import { ResourceGenInfo, BLOCK_IDS, TOGGLE, DOOR_PART } from './blockTypes';
import { GeometryArrays } from './chunkMesh';
import { blockArrayMaterial, leafArrayMaterial, plantMaterial, cutoutDepthMaterial } from './blockArrayMaterial';
import { BatchPool, BatchHandle } from './batchPool';
import { encodeColumnRLE } from './chunkRle';
import type { WorkerRequest, MeshMessage, LodMeshMessage, WorkerReply, GeometryPayload } from './chunkWorker';

// Frustum-streaming tuning (see World.frustumStreaming):
// 96 (was 40): rescans only fire after ~8.5° of yaw, so anything inside the
// margin must already be resident when it rotates on-screen — 40 units was
// ~1-3° at chunk distances, thin enough that edge-of-screen terrain noticeably
// popped in late ("ghost" gaps at the screen edge, worst for far LOD tiles).
const FRUSTUM_MARGIN = 96;      // world units to fatten the frustum (hysteresis vs rotation churn)
// Chunks within this Chebyshev radius are ALWAYS resident regardless of view — covers
// the minimap (~±6 chunks) + immediate surroundings, so the minimap never goes blank
// and turning never pops in NEARBY terrain. Frustum culling then trims only the FAR
// ring (rings 7..drawDistance), which is where the chunk count (and RAM) explodes at
// high draw distance — so the win scales with draw distance while play stays smooth.
const FRUSTUM_NEAR_KEEP = 6;
const VIEW_YAW_RESCAN = 0.15;   // camera-yaw delta (rad, ~8.5°) that triggers a frustum re-evaluation
// TURN-BACK CACHE: how long an out-of-frustum (but still in-range) chunk stays
// resident before frustum streaming may evict it. Without this, a quick 180°
// turn dumped everything behind the camera and a turn-back re-streamed it all
// through the worker queue — a multi-second "the world is reloading" spike.
const FRUSTUM_EVICT_GRACE_MS = 10_000;

// CHUNK DRAW-CALL COLLAPSE: chunks beyond this Chebyshev radius render through
// BatchedMesh pools (a handful of multi-draw calls) instead of 1-3 meshes each.
// Within the radius they stay INDIVIDUAL meshes: the 4-unit pick ray raycasts
// the 3×3 nearby chunk groups, and local edits re-mesh chunks synchronously —
// both need real per-chunk meshes. 3 covers the pick ray + the edit-neighbour
// remesh ripple with margin.
const NEAR_BATCH_KEEP = 3;

// ---- LOD far-terrain ring (see lodMesh.ts for the mesher) -------------------
// Beyond the full-detail ring, big downsampled heightmap tiles extend the view
// out to `lodDistance` chunks for a fraction of a chunk's cost (no voxel data,
// no physics, 1-2 draw calls per 8×8-chunk tile).
const LOD_TILE_CHUNKS = 8;        // base tile edge in chunks (128 blocks)
// Far ring: 16-chunk (256-block) MEGATILES at stride 16. The render-side cost
// that actually bounds fps is per-OBJECT CPU (matrix uniforms + state checks
// per draw — profiled at ~70% of frame time), so the far ring quarters its
// node/draw count by using one tile where the near ring would use four.
const LOD_MEGA_CHUNKS = 16;
const LOD_MEGA_START = 96;        // chunks: megatiles (stride 16) beyond here
const LOD_NEAR_KEEP = 24;         // chunks: tiles inside stay resident regardless of view (instant turn-around)
const LOD_REMOVAL_GRACE = 3;      // rescans a tile survives outside the desired set (mouse-look hysteresis)
const MAX_LOD_OUTSTANDING = 4;    // in-flight LOD gens (chunk gens always have queue priority)
const LOD_APPLY_VERT_BUDGET = 28000;   // verts uploaded per frame across LOD applies (≥1 tile always)
const MAX_LOD_REMOVALS_PER_FRAME = 16;
const APPLY_TIME_BUDGET_MS = 3;   // chunk-apply drain keeps taking rounds while under this

// One LOD tile's live state. `stride` = detail of the APPLIED meshes (0 = none
// yet); `wantStride` = what the current rescan wants; `inflightStride` = what
// the worker is currently building (-1 = nothing). A reply only applies when
// its echoed stride matches wantStride — that's what arbitrates the in-flight
// race when the player moves across a stride band while a build is queued.
type LodTile = {
  tx: number, tz: number,
  tileChunks: number,     // 8 (near ring) or 16 (far megatile) — tx/tz are in THIS grid's units
  // Batched geometry handles (LOD tiles render through the BatchPool — one
  // draw call per page instead of 1-2 per tile). null = not built yet.
  terrainH: BatchHandle | null,
  canopyH: BatchHandle | null,
  stride: number,
  wantStride: number,
  inflightStride: number,
  queued: boolean,
  near: number,           // Chebyshev chunk-distance (for nearest-first ordering)
  miss: number,           // consecutive rescans outside the desired set (see LOD_REMOVAL_GRACE)
  shown: boolean,         // last visibility decision (coverage cull) — mirrored into setVisibleAt
};

type chunkCoords = { x: number, z: number };

const FACE_NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

// Reconstruct typed-array geometry from the buffers transferred by the worker
// (quantized vertex format — see chunkMesh.ts).
function payloadToArrays(p: GeometryPayload): GeometryArrays | null {
  if (!p) return null;
  return {
    positions: new Uint16Array(p.positions),
    uvs: new Uint16Array(p.uvs),
    layers: new Uint16Array(p.layers),
    indices: p.i16 ? new Uint16Array(p.indices) : new Uint32Array(p.indices),
    colors: p.colors ? new Uint8Array(p.colors) : undefined,
  };
}

export class World extends Three.Group {
  // 320-tall world with sea level at 128 — the extra headroom (vs the old 256) lets
  // mountain RANGES rise to ~280 (≈150 above sea) for genuinely tall, snow-capped
  // peaks without clipping flat against the ceiling. (Taller chunks cost ~25% more
  // gen/mesh/RAM, paid only at high render distances — fine at normal presets.)
  chunkSize = { width: 16, height: 320 };
  params: ChunkParams = {
    // scale = feature breadth (continents ~3.5x this); magnitude = mountain
    // height; offset = land-height bias above sea (higher => more/larger land).
    // Large scale keeps the world traversible (broad, gentle terrain) instead of a
    // pretty-but-miniature diorama. magnitude = the BASE mountain amplitude; a +82
    // RANGE bonus in columnSurface lifts ONLY the cool low-erosion segments of the
    // orogenic spine chains (see the spine field there) to alpine, snow-capped height.
    seed: 0,
    terrain: { scale: 260, magnitude: 60, offset: 10, waterOffset: 128 },
    trees: {
      trunk: { minHeight: 4, maxHeight: 7 },
      canopy: { minRadius: 2, maxRadius: 3, density: 0.7 },
      frequency: 0.04
    },
    clouds: { scale: 20, density: 0.2 }
  };
  drawDistance = 10;

  // Foliage (plant billboards) are alpha-tested overdraw with no shadow
  // contribution, so they're safe to hide beyond a shorter radius than the
  // terrain — a big fill-rate win at distance. `foliageEnabled=false` hides all.
  // Re-evaluated on chunk apply + whenever the player crosses a chunk boundary.
  foliageEnabled = true;
  foliageDistance = 8;   // chunks

  asyncLoading = true;
  // Bumped whenever any chunk's minimap tile is (re)built (stream-in or edit). The
  // minimap reads it to skip its stationary heartbeat repaint when nothing changed.
  mapTileEpoch = 0;
  // Bumped whenever the SHADOW-CASTING mesh set changes (chunk applied/removed/
  // re-meshed after an edit). main.ts uses it to re-render the sun shadow map
  // only when something actually changed instead of every daylight frame.
  meshEpoch = 0;
  // three.js already frustum-culls every chunk mesh automatically AND per-pass
  // (main camera for colour, the sun's shadow camera for shadows), using each
  // mesh's bounding sphere. This toggle just lets you force-disable that culling
  // for debugging; we must never cull by setting chunk.visible=false ourselves,
  // because that also removes the chunk from the shadow pass — so an off-screen
  // mountain behind the player would stop casting its shadow onto the player.
  private _frustumCulling = true;
  get frustumCulling() { return this._frustumCulling; }
  set frustumCulling(v: boolean) {
    this._frustumCulling = v;
    for (const chunk of this.chunkMap.values()) {
      chunk.visible = true;
      for (const child of chunk.children) child.frustumCulled = v;
    }
    // Batches: per-INSTANCE culling is the batched equivalent of the per-mesh
    // frustumCulled flag (page-level frustumCulled must stay false).
    this.lodTerrainPool.setPerObjectFrustumCulled(v);
    this.lodCanopyPool.setPerObjectFrustumCulled(v);
    this.casterPool.setPerObjectFrustumCulled(v);
    this.leafPool.setPerObjectFrustumCulled(v);
    this.plantPool.setPerObjectFrustumCulled(v);
  }

  // ---- LOD far-terrain state ------------------------------------------------
  // 0 = off. Tiles live OUT of chunkMap (so physics/picking/minimap/lights stay
  // structurally blind to them) in their own group, which carries a small
  // downward offset so the overlap ring sits strictly UNDER real terrain.
  lodDistance = 0;
  readonly lodGroup = new Three.Group();
  // LOD render batches: every tile's terrain/canopy lives in a BatchedMesh page
  // (one draw call per page, per-instance frustum culling inside) — at high view
  // distances this collapses ~1000 LOD draws into ~4-8.
  // Cutout (alpha-tested) pools carry renderOrder 1 → they draw AFTER all solid
  // geometry: early-Z kills foliage fragments behind terrain on NVIDIA/AMD, and
  // the discard-draws stop interrupting the opaque HSR stream on Apple/TBDR.
  // Depth-tested either way → pixel-identical image.
  private lodTerrainPool = new BatchPool(this.lodGroup, blockArrayMaterial,
    { pageVerts: 2_000_000, pageInstances: 1024, castShadow: false, colorAttr: 'tintColor' });
  private lodCanopyPool = new BatchPool(this.lodGroup, leafArrayMaterial,
    { pageVerts: 1_000_000, pageInstances: 1024, castShadow: false, colorAttr: 'tintColor', renderOrder: 1 });

  // Chunk render batches (chunks beyond NEAR_BATCH_KEEP). Casters/leaves cast
  // shadows like their individual counterparts; plants follow the ultra
  // foliage-shadow toggle (refreshFoliageShadows syncs pages + meshes).
  private casterPool = new BatchPool(this, blockArrayMaterial,
    { pageVerts: 1_500_000, pageInstances: 2048, castShadow: true, colorAttr: 'tintColor' });
  private leafPool = new BatchPool(this, leafArrayMaterial,
    { pageVerts: 1_000_000, pageInstances: 2048, castShadow: true, colorAttr: 'tintColor', renderOrder: 1 });
  private plantPool = new BatchPool(this, plantMaterial,
    { pageVerts: 750_000, pageInstances: 2048, castShadow: false, colorAttr: 'plantColor', renderOrder: 1 });
  // chunkKey → batch handles for chunks rendering through the pools
  private batched = new Map<string, { caster: BatchHandle | null, leaf: BatchHandle | null, plant: BatchHandle | null }>();

  get batchedChunkCount() { return this.batched.size; }
  get chunkPageCount() { return this.casterPool.pageCount + this.leafPool.pageCount + this.plantPool.pageCount; }
  private lodMap = new Map<string, LodTile>();
  private lodPending: string[] = [];
  private lodApplyQueue: LodMeshMessage[] = [];
  private lodOutstanding = 0;
  private lodInflightWorker = new Map<string, Worker>();
  private lodDesired = new Set<string>();
  private lodRemovalPending = false;
  private lastLodDistance = NaN;
  // Tiles whose visibility must be re-evaluated (a real chunk over them loaded
  // or unloaded since the last frame). Drained in processQueues.
  private lodDirty = new Set<string>();

  get lodTileCount() { return this.lodMap.size; }
  // Built tiles (have batched geometry) + page (= draw-call) counts, for stats/tests.
  get lodBuiltCount() { let n = 0; for (const t of this.lodMap.values()) if (t.terrainH || t.canopyH) n++; return n; }
  get lodPageCount() { return this.lodTerrainPool.pageCount + this.lodCanopyPool.pageCount; }
  // FAR chunks whose voxel array is RLE-compressed (RAM reclaimed), for stats/tests.
  get compressedChunkCount() { let n = 0; for (const c of this.chunkMap.values()) if (c.dataCompressed) n++; return n; }
  private optimizeTick = 0;

  // Per-frame work budgets keep streaming smooth.
  maxChunkRequestsPerFrame = 6; // sync (no-worker) fallback
  maxMeshBuildsPerFrame = 3;
  // Cap on chunk-gen requests in flight to the worker. Keeping the worker's
  // queue short (instead of dumping the whole draw-distance into a FIFO) means a
  // teleport's new chunks reach the worker almost immediately rather than
  // waiting tens of seconds behind a stale backlog.
  maxOutstanding = 16;
  // Per-frame caps on the MAIN-THREAD work of streaming. Applying a finished
  // chunk (BufferGeometry + GPU upload) and disposing one are the costly bits;
  // doing many in a frame is what dropped FPS to single digits while moving.
  maxAppliesPerFrame = 6;
  maxRemovalsPerFrame = 24;
  private outstanding = 0;

  // Finished worker results waiting to be turned into THREE meshes (budgeted).
  private applyQueue: MeshMessage[] = [];

  // The chunk set only changes when the player crosses a chunk boundary or draw
  // distance changes, so we skip the (thousands-of-entries) visibility rescan
  // otherwise. `visibleKeys` is cached so the removal phase doesn't rebuild it.
  private lastPlayerChunkX = NaN;
  private lastPlayerChunkZ = NaN;
  private lastDrawDistance = NaN;
  // NUMERIC keys (World.numKey) — the old Set<string> allocated a key string per
  // visible cell per rescan (up to ~7k at dd64, and rescans fire on every
  // chunk-cross AND ~8.5° of yaw — real GC pressure while mouse-looking).
  private visibleKeys = new Set<number>();
  // numKey → performance.now() when the chunk left the visible set (turn-back
  // cache bookkeeping; cleared the moment it's visible again — see update()).
  private chunkMissSince = new Map<number, number>();
  private removalPending = false;
  // getVisibleChunks scratch: coord objects pooled in `_visBacking` (grow-only)
  // and re-listed into `_visList` per rescan — zero per-rescan allocation. The
  // returned list (and `pending`, filtered from it) is only consumed until the
  // NEXT rescan, which is also the only thing that overwrites the pool.
  private _visBacking: chunkCoords[] = [];
  private _visList: chunkCoords[] = [];

  // VIEW-FRUSTUM STREAMING: keep only chunks in/near the camera frustum RESIDENT to
  // bound RAM (chunks behind/beside the view UNLOAD; they re-stream on turn). A "fat"
  // frustum (planes pushed out by FRUSTUM_MARGIN) + a NEAR_KEEP always-resident radius
  // give hysteresis so small turns don't thrash; rescans also fire on camera ROTATION
  // (not just chunk-cross). Player edits survive unload (dataStore re-applies on
  // reload). Toggleable; default ON. NOTE: behind-camera chunks won't cast shadows and
  // the minimap shows only the loaded cone — both acceptable for the RAM win.
  frustumStreaming = true;
  activeCamera: Three.Camera | null = null;   // the rendering camera, set by main.ts each frame
  private lastViewYaw = 999;
  private readonly _frustum = new Three.Frustum();
  private readonly _projScreen = new Three.Matrix4();
  private readonly _chunkBox = new Three.Box3();
  private readonly _viewDir = new Three.Vector3();

  dataStore = new DataStore();

  // O(1) chunk lookup keyed by "chunkX,chunkZ".
  private chunkMap = new Map<string, WorldChunk>();
  // Numeric-keyed mirror of chunkMap for the PER-FRAME hot paths (physics block
  // queries run ~50×/frame): `${x},${z}` template keys allocate a string per
  // lookup — ~50 strings + ~100 coord objects/frame of pure GC churn through a
  // path whose comment promised "allocation-free". Key packs ±32k chunk coords.
  private chunkNumMap = new Map<number, WorldChunk>();
  private static numKey(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }
  // Pool of stateless gen+mesh workers (each chunk is independent thanks to the
  // deterministic apron), round-robined. Parallelism lets a high apply budget be
  // fed without the worker becoming the bottleneck.
  private workers: Worker[] = [];
  private nextWorker = 0;
  // Dedicated far-terrain gen thread (see initWorkers); null → LOD falls back
  // to the shared pool behind a backlog gate (and is lazily re-spawned,
  // throttled by lodWorkerRetryTick — see the 2b dispatch block).
  private lodWorker: Worker | null = null;
  private lodWorkerRetryTick = 0;
  // chunkKey -> the worker currently generating it, so a worker that dies can have
  // its in-flight gen slots reclaimed (otherwise `outstanding` saturates and
  // streaming silently stalls). Cleared per key when its result is applied.
  private inflightWorker = new Map<string, Worker>();

  // Optional hook fired at the end of generate() — used to re-point the map worker
  // at the new params (load/regenerate), which the chunk-worker config alone misses.
  onAfterGenerate?: () => void;

  // Chunks that are visible but not yet loaded, rebuilt fresh every update()
  // (nearest first). Rebuilding avoids stale entries accumulating when draw
  // distance changes, which previously caused churn/glitches.
  private pending: chunkCoords[] = [];
  private meshQueue = new Set<WorldChunk>();
  // Incremented on every full regenerate so stale worker results (from a prior
  // seed/params) are discarded instead of corrupting the new world.
  private worldVersion = 0;

  // Snapshot of the generation inputs the current world was built from, so we
  // can tell whether an Apply actually needs a (destructive) rebuild.
  private lastGenSignature = '';

  // Lightweight surface sampler matching this world's terrain, for the map.
  // Rebuilt in generate() whenever seed/params change.
  sampler: WorldSampler;

  constructor(seed = 0) {
    super();
    this.params.seed = seed;
    this.sampler = createWorldSampler(this.params, this.chunkSize);
    this.lodGroup.matrixAutoUpdate = false;
    this.add(this.lodGroup);
    // FREEZE the world subtree's per-frame matrix traversal: three's
    // scene.updateMatrixWorld() recurses into EVERY descendant each render —
    // matrixAutoUpdate=false only skips the math, not the walk. With 10-20k
    // static chunk/LOD nodes that walk is pure per-frame waste (profiled).
    // Anything added under World must compose its own matrixWorld ONCE via
    // updateMatrixWorld(true) at add time (generateChunk, buildLodMesh,
    // WorldChunk.applyGeometry); the world itself never moves.
    this.matrixWorldAutoUpdate = false;
    this.updateMatrixWorld(true);

    this.initWorkers();
    // Save/Load are exposed as menu buttons now (the old 'm'/'n' keybinds were
    // removed — 'm' opens the world map instead, wired in main.ts).
  }

  private initWorkers() {
    // Leave a couple of cores for the main/render thread. Cap at 8: beyond
    // that the main-thread apply path is the bottleneck, and the per-worker
    // module/sampler RAM stops paying for itself. (The old cap of 4 left most
    // of a modern machine idle during streaming bursts.)
    const count = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < count; i++) {
      const w = this.spawnWorker();
      if (w) this.workers.push(w);
    }
    // More in-flight with more workers so each stays fed; still bounded.
    this.maxOutstanding = Math.max(16, this.workers.length * 8);
    // DEDICATED LOD worker: far-terrain gen gets its own thread so the chunk
    // backlog can never starve it. Without this, sustained movement kept the
    // chunk pipeline saturated and LOD ahead of the player simply never built
    // (postMessage FIFOs can't be reprioritised, so sharing the pool forced an
    // all-or-nothing gate). One extra thread on top of `count` is fine — the
    // cores-2 budget was conservative, and LOD jobs are bursty, not constant.
    this.lodWorker = this.spawnWorker();
  }

  private spawnWorker(): Worker | null {
    try {
      const w = new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (event: MessageEvent<WorkerReply>) => this.onWorkerMessage(event.data);
      w.onerror = (e) => this.handleWorkerDeath(w, e);
      return w;
    } catch { return null; /* fall back to fewer / no workers */ }
  }

  // Least-loaded dispatch (vs blind round-robin): the per-worker gen/remesh queue
  // is a non-reprioritisable postMessage FIFO, so a cost-skewed chunk (a tall
  // mountain column runs far more caveAt noise per cell) head-of-line-blocks one
  // lane while others idle — evening it out shaves burst-drain tail latency on
  // teleport / draw-distance changes. Workers are stateless+deterministic so any
  // lane is correct. Tracked per-Worker in a Map (NOT an index array — handleWorker-
  // Death filters the workers array, which would misalign positional indices).
  private workerLoad = new Map<Worker, number>();
  private leastLoadedWorker(): Worker {
    let best = this.workers[0], bestLoad = this.workerLoad.get(best) ?? 0;
    for (let i = 1; i < this.workers.length; i++) {
      const l = this.workerLoad.get(this.workers[i]) ?? 0;
      if (l < bestLoad) { best = this.workers[i]; bestLoad = l; }
    }
    this.workerLoad.set(best, bestLoad + 1);
    return best;
  }
  private freeWorker(w: Worker | undefined) {
    if (!w) return;
    const l = this.workerLoad.get(w);
    if (l !== undefined && l > 0) this.workerLoad.set(w, l - 1);
  }

  // A worker died (e.g. crashed mid-gen). Drop it AND reclaim its in-flight gen
  // slots, or `outstanding` stays permanently inflated and async streaming halts.
  // Orphaned (data-less) chunks it was generating are removed and re-requested via
  // a forced rescan; if every worker dies, processQueues falls back to sync gen.
  private handleWorkerDeath(w: Worker, e?: unknown) {
    console.error('chunk worker died, dropping it and reclaiming its work', e);
    this.workers = this.workers.filter(x => x !== w);
    this.workerLoad.delete(w);   // its in-flight jobs are reclaimed below; drop its load with it
    let reclaimed = false;
    for (const [key, worker] of this.inflightWorker) {
      if (worker !== w) continue;
      this.inflightWorker.delete(key);
      this.outstanding = Math.max(0, this.outstanding - 1);
      const chunk = this.chunkMap.get(key);
      if (chunk && !chunk.hasData) {
        chunk.disposeInstance(); this.remove(chunk); this.chunkMap.delete(key);
        const c = chunk.userData as chunkCoords;
        this.chunkNumMap.delete(World.numKey(c.x, c.z));
        reclaimed = true;
      }
    }
    // LOD gens in flight on the dead worker: free their slots (or lodOutstanding
    // saturates and LOD streaming silently stalls forever) and re-queue the tiles.
    for (const [key, worker] of this.lodInflightWorker) {
      if (worker !== w) continue;
      this.lodInflightWorker.delete(key);
      this.lodOutstanding = Math.max(0, this.lodOutstanding - 1);
      const t = this.lodMap.get(key);
      if (t) {
        t.inflightStride = -1;
        if (!t.queued && t.wantStride !== t.stride) { t.queued = true; this.lodPending.push(key); }
      }
    }
    // The dedicated LOD thread died → respawn it once (with the current config,
    // which it missed) so far-terrain streaming recovers without a regenerate.
    if (w === this.lodWorker) {
      this.lodWorker = this.spawnWorker();
      this.lodWorker?.postMessage(this.buildWorkerConfig());
    }
    if (reclaimed) this.lastPlayerChunkX = NaN; // force a rescan → re-request the orphaned chunks
  }

  // Push the current generation config to every worker. Sent on each regenerate.
  private buildWorkerConfig(): WorkerRequest {
    return {
      type: 'config',
      version: this.worldVersion,
      size: this.chunkSize,
      params: this.params,
      resources: this.resourcePayload(),
    };
  }
  private sendWorkerConfig() {
    const message = this.buildWorkerConfig();
    for (const w of this.workers) w.postMessage(message);
    this.lodWorker?.postMessage(message);
  }

  private chunkKey(x: number, z: number) {
    return `${x},${z}`;
  }

  // Block id at a world coordinate, or air when the owning chunk has no data
  // yet. Passed into chunk meshing so faces can be culled across chunk seams.
  getWorldBlock = (worldX: number, worldY: number, worldZ: number): number => {
    const coords = this.worldToChunkCoords(worldX, worldY, worldZ);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);
    if (chunk && chunk.hasData) {
      return chunk.getBlockId(coords.block.x, coords.block.y, coords.block.z);
    }
    return BLOCK_IDS.air;
  };

  // Climate grass tint at a world column (deterministic). Passed into the local
  // mesher for edit re-meshes so plant tints match the worker's output exactly.
  getGrassTint = (worldX: number, worldZ: number): readonly [number, number, number] => {
    const s = this.sampler(worldX, worldZ);
    return climateGrassTint(s.temp, s.humid);
  };

  get chunkCount() {
    return this.chunkMap.size;
  }

  update(player: Player) {
    const { chunk: c } = this.worldToChunkCoords(player.position.x, player.position.y, player.position.z);
    // Rescan when the player crossed a chunk boundary OR draw distance changed
    // (e.g. Apply lowered it — otherwise the now-unused chunks would never be
    // removed). While chunks merely stream in, processQueues drains `pending`.
    // With frustum streaming, the visible set ALSO changes as the camera rotates —
    // rescan when the view yaw turns past VIEW_YAW_RESCAN (not every frame).
    let viewYaw = this.lastViewYaw;
    if (this.frustumStreaming && this.activeCamera) {
      this.activeCamera.getWorldDirection(this._viewDir);
      viewYaw = Math.atan2(this._viewDir.x, this._viewDir.z);
    }
    const yawTurned = this.frustumStreaming && this.activeCamera &&
      Math.abs(((viewYaw - this.lastViewYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > VIEW_YAW_RESCAN;
    const rescan = c.x !== this.lastPlayerChunkX || c.z !== this.lastPlayerChunkZ ||
      this.drawDistance !== this.lastDrawDistance || yawTurned ||
      this.lodDistance !== this.lastLodDistance;

    if (rescan) {
      this.lastPlayerChunkX = c.x;
      this.lastPlayerChunkZ = c.z;
      this.lastDrawDistance = this.drawDistance;
      this.lastLodDistance = this.lodDistance;
      this.lastViewYaw = viewYaw;

      const visibleChunks = this.getVisibleChunks(player);
      this.visibleKeys.clear();
      for (const vc of visibleChunks) this.visibleKeys.add(World.numKey(vc.x, vc.z));
      // Turn-back cache: stamp when a resident chunk leaves the visible set;
      // clear the stamp the moment it's visible again.
      const now = performance.now();
      for (const chunk of this.chunkMap.values()) {
        const cc = chunk.userData as chunkCoords;
        const nk = World.numKey(cc.x, cc.z);
        if (this.visibleKeys.has(nk)) this.chunkMissSince.delete(nk);
        else if (!this.chunkMissSince.has(nk)) this.chunkMissSince.set(nk, now);
      }
      this.removalPending = this.removeUnusedChunks();
      this.pending = visibleChunks
        .filter(({ x, z }) => !this.chunkNumMap.has(World.numKey(x, z)))
        .sort((a, b) => ((a.x - c.x) ** 2 + (a.z - c.z) ** 2) - ((b.x - c.x) ** 2 + (b.z - c.z) ** 2));
      // Player crossed a chunk boundary → re-evaluate which chunks show foliage
      // and swap render representations across the near-batch boundary.
      this.refreshFoliageVisibility();
      this.rebalanceBatchBoundary(c.x, c.z);
      // LOD ring: re-evaluate tile membership + detail bands. The down-offset
      // (which keeps overlapped LOD strictly under real terrain, no z-fight)
      // scales with drawDistance because depth-buffer precision worsens with
      // distance — at dd64 the overlap reaches ~1.4km where 0.25 isn't enough.
      const lodDrop = -Math.max(0.3, this.drawDistance * 0.016);
      if (this.lodGroup.position.y !== lodDrop) {
        this.lodGroup.position.y = lodDrop;
        this.lodGroup.updateMatrix();
        // frozen subtree: recompose the LOD meshes' world matrices (dd changes only)
        this.lodGroup.updateMatrixWorld(true);
      }
      this.updateLodTiles(c.x, c.z);
      this.lodRemovalPending = this.removeUnusedLodTiles();
    } else {
      if (this.removalPending) {
        // Keep removing (capped per frame) using the cached visible set — no need
        // to rebuild the visible list / pending every frame during removal.
        this.removalPending = this.removeUnusedChunks();
      }
      if (this.lodRemovalPending) this.lodRemovalPending = this.removeUnusedLodTiles();
    }
  }

  // ---- LOD ring management ---------------------------------------------------
  // Recompute which LOD tiles should exist (annulus from the always-loaded core
  // out to lodDistance, frustum-trimmed beyond LOD_NEAR_KEEP) and what stride
  // each wants. Runs only on rescan — tile membership changes every 8 chunks of
  // movement, so this is far rarer than the chunk rescan it piggybacks on.
  // DETAIL LADDER, modelled on Distant Horizons' geometric drop-off (detail =
  // floor(log2(dist/unit)) — each band is TWICE as wide as the previous, so the
  // detail falloff reads smooth instead of stepping from blocks straight to
  // coarse cells) + Voxy's screen-space rule (don't pay for sub-pixel detail:
  // absolute caps keep cell size ~proportional to distance). Bands start at the
  // VISIBLE edge (drawDistance): the first 6 chunks of LOD are FULL 1-block
  // resolution — that's what makes the chunk→LOD seam nearly invisible (DH's
  // default keeps block-res LOD out to 384 blocks for the same reason). Tiles
  // deep inside the chunk ring are pure turn-around fill (hidden whenever the
  // camera looks at them) and stay cheap.
  private lodStrideFor(near: number): number {
    const dd = this.drawDistance;
    if (near < dd - 2) return 8;            // interior turn-fill — only ever glimpsed while chunks restream
    const d = near - (dd - 2);              // chunks past the visible edge
    let s = d < 6 ? 1 : d < 18 ? 2 : d < 42 ? 4 : d < 90 ? 8 : 16;   // geometric bands: 6, 12, 24, 48 wide
    // Voxy-style absolute caps: at long range a fine cell is sub-pixel — waste.
    // Thresholds sit ABOVE the deepest seam each stride can serve (the seam is
    // at near ≈ dd-2, dd ≤ 64): a cap that ignored dd silently deleted the
    // whole stride-1 band at dd ≥ 35, putting stride-2+ right against full-
    // detail chunks — the exact "abrupt high→low def" pop this ladder exists
    // to prevent. 1-block cells stay until ~800m, where they're sub-pixel.
    if (s === 1 && near > 48) s = 2;
    if (s === 2 && near > 80) s = 4;
    if (s === 4 && near > 144) s = 8;
    return s;
  }

  private updateLodTiles(pcx: number, pcz: number) {
    this.lodDesired.clear();
    // lodPending is rebuilt from scratch — clear every tile's queued flag too,
    // or a tile queued before this rescan (and dropped here) could never
    // re-queue (the !queued check would block it forever).
    this.lodPending.length = 0;
    for (const t of this.lodMap.values()) t.queued = false;
    if (this.lodDistance <= 0) return;   // off → removeUnusedLodTiles drains everything

    const T = LOD_TILE_CHUNKS, M = LOD_MEGA_CHUNKS;
    // Inner edge: hug the always-resident chunk core so behind-camera ground
    // (which frustum streaming unloads) is LOD-covered the instant you turn.
    const lodStart = Math.min(FRUSTUM_NEAR_KEEP, Math.max(1, this.drawDistance - 1));
    const useFrustum = this.frustumStreaming && !!this.activeCamera;
    if (useFrustum) {
      const cam = this.activeCamera!;
      cam.updateMatrixWorld();
      this._projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(this._projScreen);
      for (const p of this._frustum.planes) p.constant += FRUSTUM_MARGIN;
    }
    const W = this.chunkSize.width, H = this.chunkSize.height;

    // Rect helpers in chunk units (rectangle [cx0..cx1]×[cz0..cz1] vs player).
    const rectNear = (cx0: number, cx1: number, cz0: number, cz1: number) =>
      Math.max(Math.max(cx0 - pcx, pcx - cx1, 0), Math.max(cz0 - pcz, pcz - cz1, 0));
    const rectFar = (cx0: number, cx1: number, cz0: number, cz1: number) => Math.max(
      Math.max(Math.abs(cx0 - pcx), Math.abs(cx1 - pcx)),
      Math.max(Math.abs(cz0 - pcz), Math.abs(cz1 - pcz)));
    // Residency test with a DISTANCE-SCALED inflation: the global margin is a
    // fixed world-unit fattening, which shrinks to a fraction of a degree at
    // far-tile distances — a megatile 2km out could leave the frustum on a
    // small turn and only return a rescan later (ghost gap at the screen
    // edge). Inflating the test box ~10% of its distance keeps a constant
    // ANGULAR margin instead, so far tiles stay resident through small turns.
    const frustumHit = (cx0: number, cx1: number, cz0: number, cz1: number, near: number) => {
      const inflate = near * W * 0.10;
      this._chunkBox.min.set(cx0 * W - inflate, 0, cz0 * W - inflate);
      this._chunkBox.max.set((cx1 + 1) * W + inflate, H, (cz1 + 1) * W + inflate);
      return this._frustum.intersectsBox(this._chunkBox);
    };
    const desire = (key: string, tx: number, tz: number, tileChunks: number, near: number, stride: number) => {
      this.lodDesired.add(key);
      let t = this.lodMap.get(key);
      if (!t) {
        t = { tx, tz, tileChunks, terrainH: null, canopyH: null, stride: 0, wantStride: stride, inflightStride: -1, queued: false, near, miss: 0, shown: true };
        this.lodMap.set(key, t);
      }
      // Stride hysteresis: if the tile's APPLIED stride would still be chosen
      // 2 chunks to either side, it's sitting near a band edge — keep it.
      // Without this, walking back and forth across a band boundary re-meshes
      // the whole tile every chunk-cross (worker + GPU-upload churn for zero
      // visible change). Held only within ONE band step (≤2× apart): a tile
      // crossing from interior fill (8) into the stride-1 seam band must
      // re-mesh immediately — holding it would park a 8× coarser patch right
      // against full-detail chunks. Megatiles are exempt (fixed stride 16).
      if (t.stride > 0 && t.stride !== stride && tileChunks === LOD_TILE_CHUNKS &&
        t.stride <= stride * 2 && stride <= t.stride * 2 &&
        (t.stride === this.lodStrideFor(near - 2) || t.stride === this.lodStrideFor(near + 2))) {
        stride = t.stride;
      }
      t.near = near;
      t.miss = 0;
      t.wantStride = stride;
      if (t.stride !== stride && t.inflightStride !== stride && !t.queued) {
        t.queued = true;
        this.lodPending.push(key);
      }
      // visibleKeys just changed with this rescan → re-evaluate hiding for
      // every tile that can overlap loaded chunks (the rest are plain visible).
      if (t.terrainH || t.canopyH) this.refreshLodVisibility(t);
    };

    // Iterate the 16-chunk PARENT grid: a parent fully beyond LOD_MEGA_START
    // becomes one stride-16 megatile; otherwise its four 8-chunk children are
    // evaluated individually — a perfect partition, so the two grids can never
    // gap or double-cover at the band boundary.
    const m0x = Math.floor((pcx - this.lodDistance) / M), m1x = Math.floor((pcx + this.lodDistance) / M);
    const m0z = Math.floor((pcz - this.lodDistance) / M), m1z = Math.floor((pcz + this.lodDistance) / M);
    for (let mx = m0x; mx <= m1x; mx++) {
      for (let mz = m0z; mz <= m1z; mz++) {
        const mx0 = mx * M, mx1 = mx0 + M - 1, mz0 = mz * M, mz1 = mz0 + M - 1;
        const mNear = rectNear(mx0, mx1, mz0, mz1);
        if (mNear > this.lodDistance) continue;
        if (mNear > LOD_MEGA_START) {
          if (useFrustum && !frustumHit(mx0, mx1, mz0, mz1, mNear)) continue;
          desire(`M${mx},${mz}`, mx, mz, M, mNear, 16);
          continue;
        }
        for (let cx = 0; cx < 2; cx++) {
          for (let cz = 0; cz < 2; cz++) {
            const tx = mx * 2 + cx, tz = mz * 2 + cz;
            const cx0 = tx * T, cx1 = cx0 + T - 1, cz0 = tz * T, cz1 = cz0 + T - 1;
            const near = rectNear(cx0, cx1, cz0, cz1);
            if (near > this.lodDistance) continue;
            if (rectFar(cx0, cx1, cz0, cz1) < lodStart) continue;   // fully inside the always-loaded core
            if (useFrustum && near > LOD_NEAR_KEEP && !frustumHit(cx0, cx1, cz0, cz1, near)) continue;
            desire(`${tx},${tz}`, tx, tz, T, near, this.lodStrideFor(near));
          }
        }
      }
    }
    this.lodPending.sort((a, b) => (this.lodMap.get(a)?.near ?? 0) - (this.lodMap.get(b)?.near ?? 0));
    // Hysteresis bookkeeping: runs exactly once per RESCAN (this function),
    // never per frame — removeUnusedLodTiles is re-called every frame during a
    // capped removal burst and must not age tiles at frame rate.
    for (const [key, t] of this.lodMap) {
      if (!this.lodDesired.has(key)) t.miss++;
    }
  }

  // Capped LOD-tile removal (mirrors removeUnusedChunks). Returns true if more remain.
  // Tiles get LOD_REMOVAL_GRACE rescans of hysteresis before disposal: a quick
  // look-away-and-back must NOT dispose + re-generate a whole frustum's worth
  // of tiles (that churn was a real worker-time sink while mouse-looking).
  private removeUnusedLodTiles(): boolean {
    let removed = 0;
    for (const [key, t] of this.lodMap) {
      if (removed >= MAX_LOD_REMOVALS_PER_FRAME) return true;
      if (!this.lodDesired.has(key)) {
        // Grace counts RESCANS — a stationary player produces none, so with
        // LOD turned off entirely the tiles would otherwise linger forever.
        if (this.lodDistance > 0 && t.miss < LOD_REMOVAL_GRACE) continue;
        // Reclaim the tile's in-flight slot too: a tile recreated at this key
        // later must start from a clean single-in-flight state, or the orphan
        // request's slot becomes unreclaimable when its worker dies. The orphan
        // reply is harmless (apply path: key no longer in lodInflightWorker →
        // no double-decrement; tile gone → discarded).
        if (this.lodInflightWorker.delete(key)) this.lodOutstanding = Math.max(0, this.lodOutstanding - 1);
        this.disposeLodTile(t);
        this.lodMap.delete(key);
        removed++;
      }
    }
    return false;
  }

  private disposeLodTile(t: LodTile) {
    this.lodTerrainPool.remove(t.terrainH);
    this.lodCanopyPool.remove(t.canopyH);
    t.terrainH = t.canopyH = null;
  }

  // ---- LOD visibility -------------------------------------------------------
  // A tile hides as soon as every chunk of it the CAMERA CAN SEE is loaded:
  //   • loaded chunk            → covered (real terrain draws on top)
  //   • within dd, ∉visibleKeys → the chunk system deliberately skipped it for
  //                               VIEW reasons (frustum-trimmed) → off-screen,
  //                               doesn't block hiding
  //   • beyond dd / wanted-but-unloaded → genuinely visible → tile must show.
  // This is what kills "LOD right next to the player": in view, the tile
  // disappears the moment real chunks cover its on-screen part — while a tile
  // BEHIND the camera (all chunks frustum-skipped) stays resident+visible, so
  // turning around shows ground instantly. The old all-64-loaded rule almost
  // never fired under frustum streaming (behind-camera chunks never load).
  private noteChunkOverTile(chunk: WorldChunk) {
    this.meshEpoch++;   // caster set changed → the shadow map needs one re-render
    const { x, z } = chunk.userData as chunkCoords;
    this.lodDirty.add(`${Math.floor(x / LOD_TILE_CHUNKS)},${Math.floor(z / LOD_TILE_CHUNKS)}`);
    // The megatile owner too: inert today (megatiles start beyond the deepest
    // possible chunk at dd 64), but if LOD_MEGA_START or the dd cap ever move,
    // a covered megatile must still get its visibility re-evaluated.
    this.lodDirty.add(`M${Math.floor(x / LOD_MEGA_CHUNKS)},${Math.floor(z / LOD_MEGA_CHUNKS)}`);
  }
  private refreshLodVisibility(t: LodTile) {
    const T = t.tileChunks, dd = this.drawDistance;
    const pcx = this.lastPlayerChunkX, pcz = this.lastPlayerChunkZ;
    let anyLoaded = false, hide = true;
    if (t.near > dd + 1) {
      hide = false;   // no chunk of it can be loaded — skip the 64-cell scan
    } else {
      scan: for (let cx = t.tx * T; cx < t.tx * T + T; cx++) {
        for (let cz = t.tz * T; cz < t.tz * T + T; cz++) {
          const nk = World.numKey(cx, cz);   // numeric key: no string alloc per scanned cell
          if (this.chunkNumMap.get(nk)?.loaded) { anyLoaded = true; continue; }
          const offscreen = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) <= dd && !this.visibleKeys.has(nk);
          if (!offscreen) { hide = false; break scan; }   // someone can see this uncovered spot
        }
      }
    }
    const visible = !(hide && anyLoaded);
    t.shown = visible;
    this.lodTerrainPool.setVisible(t.terrainH, visible);
    this.lodCanopyPool.setVisible(t.canopyH, visible);
  }

  // Drain a bounded slice of the work each frame so the world streams in
  // without a main-thread burst (which used to freeze/crash at high distances).
  processQueues() {
    // 1) Turn finished worker results into meshes. This is the main-thread cost
    // (BufferGeometry + GPU upload); budgeting it keeps the frame short while
    // chunks stream in. `outstanding` (gen slots) is freed here on apply, so
    // generation is naturally throttled to the apply rate.
    // Budget = ROUNDS of maxAppliesPerFrame under a small TIME box: the fixed
    // 6/frame was tuned when every apply built individual 40B/vertex meshes —
    // far applies are now a memcpy into a batch page (bounds pre-set), so burst
    // backlogs (teleport, distance change) drain several× faster while a heavy
    // frame still exits after one round.
    // Two passes per round so a round is internally consistent: adopt ALL the
    // round's block data FIRST, then mesh. An edit-driven local rebuild
    // (hasEditsAround) reads neighbour chunks; if a neighbour was applied later
    // in the same round it would otherwise be read as air → an exposed seam
    // never re-fixed in the async path. (Across rounds the ordering hazard is
    // the same as the pre-existing across-frames one.)
    const applyT0 = performance.now();
    let appliedAny = false;
    do {
      const batch: { chunk: WorldChunk, msg: MeshMessage }[] = [];
      let applied = 0;
      while (applied < this.maxAppliesPerFrame && this.applyQueue.length > 0) {
        const msg = this.applyQueue.shift()!;
        this.outstanding = Math.max(0, this.outstanding - 1);
        this.freeWorker(this.inflightWorker.get(msg.key));   // its lane has a slot free again
        this.inflightWorker.delete(msg.key);
        const chunk = this.chunkMap.get(msg.key);
        if (!chunk) continue;        // unloaded before we got to it
        // Duplicate/stale gen reply for a chunk re-created at the same coords —
        // but a REMESH reply targets an already-loaded chunk by design.
        if (chunk.loaded && !msg.remesh) continue;
        if (!msg.remesh) chunk.setData(new Uint8Array(msg.data));   // remesh = same data, keep the existing array
        batch.push({ chunk, msg });
        applied++;
      }
      for (const { chunk, msg } of batch) {
        // Isolate per-chunk apply: a single bad geometry payload skips ONE chunk
        // (logged) instead of throwing out of the per-frame loop and freezing the game.
        try {
          const c = chunk.userData as chunkCoords;
          const cheb = Math.max(Math.abs(c.x - this.lastPlayerChunkX), Math.abs(c.z - this.lastPlayerChunkZ));
          if (msg.remesh) {
            // Demotion re-mesh, built OFF-THREAD: adopt the individual meshes
            // and drop the batch copy (in that order — never a hole).
            chunk.applyGeometry(payloadToArrays(msg.casters), payloadToArrays(msg.nonCasters), payloadToArrays(msg.plants));
            chunk.setEmitters(new Float32Array(msg.emitters));
            chunk.setMapTile(new Uint8Array(msg.mapTile));
            this.unbatchChunk(chunk);
          }
          else if (this.hasEditsAround(chunk)) chunk.buildMeshes(this.getWorldBlock, this.getGrassTint);  // also rescans emitters + rebuilds the map tile
          else if (cheb > NEAR_BATCH_KEEP) {
            // FAR chunk → straight into the render batches (no per-chunk meshes,
            // no per-chunk draw calls). Emitters/map tile adopt as usual.
            this.batchChunk(chunk,
              payloadToArrays(msg.casters), payloadToArrays(msg.nonCasters), payloadToArrays(msg.plants));
            chunk.setEmitters(new Float32Array(msg.emitters));
            chunk.setMapTile(new Uint8Array(msg.mapTile));
            this.compressFarData(chunk);   // far chunk renders from the batch slice → free its idle voxel array
          } else {
            chunk.applyGeometry(payloadToArrays(msg.casters), payloadToArrays(msg.nonCasters), payloadToArrays(msg.plants));
            chunk.setEmitters(new Float32Array(msg.emitters));
            chunk.setMapTile(new Uint8Array(msg.mapTile));
          }
          this.applyFoliageVisibility(chunk);
          this.noteChunkOverTile(chunk);   // re-evaluate the covering LOD tile's visibility
        } catch (e) {
          console.error('chunk apply failed, skipping', msg.key, e);
        }
      }
      appliedAny = appliedAny || batch.length > 0;
    } while (this.applyQueue.length > 0 && performance.now() - applyT0 < APPLY_TIME_BUDGET_MS);
    if (appliedAny) this.mapTileEpoch++;   // new tiles → let the minimap repaint once

    // 1b) LOD tile applies, budgeted by VERTEX COUNT (not tile count): a far
    // stride-8 tile is a few thousand verts but a stride-2 mountain tile can be
    // ~50k — counting tiles would let two of those burst a frame with multi-MB
    // GPU uploads. Always at least one tile per frame so the queue can't stall.
    let lodApplied = 0, lodVertsApplied = 0;
    while ((lodApplied === 0 || lodVertsApplied < LOD_APPLY_VERT_BUDGET) && this.lodApplyQueue.length > 0) {
      const msg = this.lodApplyQueue.shift()!;
      // Slot ownership = lodInflightWorker membership (exactly one request per
      // tile). If the key is already gone the slot was reclaimed elsewhere
      // (tile removal / worker death) — decrementing again would let the
      // in-flight count drift below reality and overshoot the cap.
      if (this.lodInflightWorker.delete(msg.key)) this.lodOutstanding = Math.max(0, this.lodOutstanding - 1);
      const t = this.lodMap.get(msg.key);
      if (!t) continue;                                  // tile removed before its build landed
      if (msg.stride === t.inflightStride) t.inflightStride = -1;
      // Tile in its removal-grace window (no longer desired, kept only as
      // look-back hysteresis): don't build OR re-queue — its wantStride is
      // stale, and rebuilding a tile that dies within ≤2 rescans is exactly
      // the mouse-look churn the grace window exists to kill.
      if (!this.lodDesired.has(msg.key)) continue;
      if (msg.stride !== t.wantStride) {
        // Stale detail level (band changed mid-flight). The tile was popped
        // from lodPending when this request was dispatched, so re-queue it for
        // the stride it wants now — nothing else would until the next rescan.
        if (t.wantStride !== t.stride && !t.queued) { t.queued = true; this.lodPending.push(msg.key); }
        continue;
      }
      if (msg.stride === t.stride && t.terrainH) continue; // duplicate reply
      try {
        this.disposeLodTile(t);
        const tileBlocks = t.tileChunks * this.chunkSize.width;
        const terr = payloadToArrays(msg.terrain);
        const can = payloadToArrays(msg.canopy);
        if (terr && terr.indices.length) t.terrainH = this.lodTerrainPool.add(terr, t.tx * tileBlocks, 0, t.tz * tileBlocks);
        if (can && can.indices.length) t.canopyH = this.lodCanopyPool.add(can, t.tx * tileBlocks, 0, t.tz * tileBlocks);
        t.stride = msg.stride;
        this.refreshLodVisibility(t);
        lodApplied++;
        lodVertsApplied += ((msg.terrain?.positions.byteLength ?? 0) + (msg.canopy?.positions.byteLength ?? 0)) / 6;   // u16×3 per vertex
      } catch (e) {
        console.error('lod tile apply failed, skipping', msg.key, e);
      }
    }

    // 1c) Re-evaluate LOD tile visibility where real chunks (un)loaded this
    // frame — a handful of 64-cell scans at most, far cheaper than it reads.
    if (this.lodDirty.size) {
      for (const key of this.lodDirty) {
        const t = this.lodMap.get(key);
        if (t) this.refreshLodVisibility(t);
      }
      this.lodDirty.clear();
    }

    // 1c2) Deferred demotions: retried once the chunk backlog lightens, so a
    // player who stopped moving still gets pickable near-ring meshes.
    if (this.demotionsDeferred && this.outstanding < this.maxOutstanding / 2 &&
      Number.isFinite(this.lastPlayerChunkX)) {
      this.rebalanceBatchBoundary(this.lastPlayerChunkX, this.lastPlayerChunkZ);
    }

    // 1d) Batch-page compaction, low frequency: deleted tile/chunk geometry
    // leaves holes in the append-only page buffers; compact at most one page
    // per pool every ~2s of frames (optimize() is O(pageVerts) — never per
    // frame, and only when a page is ≥25% waste).
    if ((this.optimizeTick++ & 127) === 0) {
      this.lodTerrainPool.maybeOptimize();
      this.lodCanopyPool.maybeOptimize();
      this.casterPool.maybeOptimize();
      this.leafPool.maybeOptimize();
      this.plantPool.maybeOptimize();
    }

    // 2) Request more generation (gated by in-flight = sent-but-not-applied).
    if (this.asyncLoading && this.workers.length > 0) {
      while (this.outstanding < this.maxOutstanding && this.pending.length > 0) {
        const { x, z } = this.pending.shift()!;
        if (!this.chunkMap.has(this.chunkKey(x, z))) this.generateChunk(x, z);
      }
    } else {
      let requests = 0;
      while (requests < this.maxChunkRequestsPerFrame && this.pending.length > 0) {
        const { x, z } = this.pending.shift()!;
        if (!this.chunkMap.has(this.chunkKey(x, z))) {
          this.generateChunk(x, z);
          requests++;
        }
      }
    }

    // 2b) LOD tile gens — on the DEDICATED LOD thread, fully decoupled from
    // chunk streaming (sustained movement keeps the chunk pipeline saturated
    // forever; anything gated on it starves — the player would outrun the far
    // terrain and see only chunks ahead). Deliberately OUTSIDE the chunk-pool
    // branch above: a healthy lodWorker must keep dispatching even if every
    // chunk worker has died (the pools are independent). Fallback without the
    // dedicated worker: share the pool, but only while the chunk backlog is
    // light. A lodWorker lost to a spawn failure is lazily retried here
    // (throttled) — worker death can only respawn a worker that still exists.
    if (this.asyncLoading && this.lodPending.length > 0) {
      if (!this.lodWorker && (this.lodWorkerRetryTick++ & 127) === 0) {
        this.lodWorker = this.spawnWorker();
        this.lodWorker?.postMessage(this.buildWorkerConfig());
      }
      if (this.lodWorker || (this.workers.length > 0 && this.outstanding < this.maxOutstanding / 2)) {
        while (this.lodOutstanding < MAX_LOD_OUTSTANDING && this.lodPending.length > 0) {
          const key = this.lodPending.shift()!;
          const t = this.lodMap.get(key);
          if (!t) continue;
          t.queued = false;
          if (t.wantStride === t.stride) continue;       // resolved meanwhile
          // At most ONE in-flight request per tile — a second concurrent one
          // would break the key→worker slot accounting (the map can only track
          // one, so a worker death could leak the untracked slot forever). If
          // the in-flight build is for a stale stride, the apply path re-queues
          // this tile the moment that reply lands.
          if (t.inflightStride !== -1) continue;
          const tileBlocks = t.tileChunks * this.chunkSize.width;
          const request: WorkerRequest = {
            type: 'lod', version: this.worldVersion, key,
            worldX: t.tx * tileBlocks, worldZ: t.tz * tileBlocks,
            tileBlocks, stride: t.wantStride,
          };
          const w = this.lodWorker ?? this.workers[this.nextWorker++ % this.workers.length];
          w.postMessage(request);
          t.inflightStride = t.wantStride;
          this.lodOutstanding++;
          this.lodInflightWorker.set(key, w);
        }
      }
    }

    let builds = 0;
    for (const chunk of this.meshQueue) {
      if (builds >= this.maxMeshBuildsPerFrame) break;
      this.meshQueue.delete(chunk);
      if (chunk.hasData && chunk.parent === this) {
        chunk.buildMeshes(this.getWorldBlock, this.getGrassTint);
        this.unbatchChunk(chunk);   // it now has individual meshes — drop any batch copy (demotion / far edit)
        this.applyFoliageVisibility(chunk);
        this.noteChunkOverTile(chunk);   // first build via the sync/no-worker path affects LOD visibility too
        this.mapTileEpoch++;   // rebuilt tile (edit/neighbour remesh) → minimap repaint
        builds++;
      }
    }
  }

  // (LOD geometry renders through lodTerrainPool/lodCanopyPool BatchedMesh
  // pages — one draw call per page with per-instance frustum culling, instead
  // of 1-2 meshes per tile. Pages: castShadow=false, raycast-inert, static.)

  // ---- chunk batching --------------------------------------------------------
  // Far chunks render through the caster/leaf/plant pools. The chunk keeps its
  // DATA (physics/edits/emitters/map tile all unaffected) — only the render
  // representation moves out of the scene graph.
  private batchChunk(chunk: WorldChunk, casters: GeometryArrays | null, leaves: GeometryArrays | null, plants: GeometryArrays | null) {
    const { x, z } = chunk.userData as chunkCoords;
    const key = this.chunkKey(x, z);
    this.unbatchChunk(chunk);   // defensive: never double-add
    const px = chunk.position.x, pz = chunk.position.z;
    const entry = {
      caster: casters && casters.indices.length ? this.casterPool.add(casters, px, 0, pz) : null,
      leaf: leaves && leaves.indices.length ? this.leafPool.add(leaves, px, 0, pz) : null,
      plant: plants && plants.indices.length ? this.plantPool.add(plants, px, 0, pz) : null,
    };
    this.batched.set(key, entry);
    chunk.batchEntry = entry;   // mirrored on the chunk for allocation-free hot-path reads
    chunk.loaded = true;   // render representation exists (batched); physics may stand on it
  }

  // Remove a chunk's batched geometry (stream-out, or it re-meshed into
  // individual meshes — demotion into the near ring / an edit landed on it).
  private unbatchChunk(chunk: WorldChunk) {
    const { x, z } = chunk.userData as chunkCoords;
    const key = this.chunkKey(x, z);
    const e = this.batched.get(key);
    chunk.batchEntry = null;
    if (!e) return;
    this.casterPool.remove(e.caster);
    this.leafPool.remove(e.leaf);
    this.plantPool.remove(e.plant);
    this.batched.delete(key);
  }

  // Promotion: an individual near-ring chunk drifted beyond NEAR_BATCH_KEEP →
  // move its EXISTING geometry into the pools (pure memcpy, no re-mesh) and
  // drop the per-chunk meshes. Inverse runs through the meshQueue (buildMeshes
  // re-creates individual meshes, then unbatchChunk removes the batch copy).
  private promoteChunkToBatch(chunk: WorldChunk) {
    if (!chunk.loaded || chunk.children.length === 0) return;
    const grab = (material: Three.Material): GeometryArrays | null => {
      for (const child of chunk.children) {
        const mesh = child as Three.Mesh;
        if (mesh.material !== material || !mesh.geometry) continue;
        const g = mesh.geometry;
        const col = (g.getAttribute('tintColor') ?? g.getAttribute('plantColor')) as Three.BufferAttribute | undefined;
        return {
          positions: g.getAttribute('position').array as Uint16Array,
          uvs: g.getAttribute('tileUv').array as Uint16Array,
          layers: g.getAttribute('layerIndex').array as Uint16Array,
          indices: g.getIndex()!.array as Uint16Array | Uint32Array,
          colors: col?.array as Uint8Array | undefined,
        };
      }
      return null;
    };
    const casters = grab(blockArrayMaterial), leaves = grab(leafArrayMaterial), plants = grab(plantMaterial);
    if (!casters && !leaves && !plants) return;
    this.batchChunk(chunk, casters, leaves, plants);
    chunk.clearMeshes();
    chunk.loaded = true;   // clearMeshes resets it; the batch copy IS the render representation
    this.compressFarData(chunk);
  }

  // A batched chunk renders entirely from its BatchPool slice; its ~80KB voxel
  // array is then idle (read only by the demotion remesh + a seam backstop). RLE-
  // compress it to reclaim RAM — decoded back synchronously on demand
  // (WorldChunk.ensureFlat). Only fires WELL outside the near ring: the
  // >=NEAR_BATCH_KEEP+2 Chebyshev margin keeps every chunk a boundary edit could
  // pull (a cheb==K edit's neighbour-remesh reaches cheb==K+1) in flat form, so
  // the getBlockId/buildMeshes/setBlockId decode shims are a correctness backstop,
  // never a per-edit re-alloc next to the player. Edited chunks are left flat
  // (they may demote/remesh) — cheap insurance, a handful of chunks.
  private compressFarData(chunk: WorldChunk) {
    if (chunk.dataCompressed || !chunk.hasData || this.hasEditsAround(chunk)) return;
    const { x, z } = chunk.userData as chunkCoords;
    const cheb = Math.max(Math.abs(x - this.lastPlayerChunkX), Math.abs(z - this.lastPlayerChunkZ));
    if (cheb < NEAR_BATCH_KEEP + 2) return;   // LOAD-BEARING freeze margin (>=5) — do not lower
    chunk.compress(encodeColumnRLE(chunk.data, chunk.size));
  }

  // Set when a demotion was deferred behind a heavy chunk backlog — retried
  // from processQueues so a player who STOPS moving (no further rescans) still
  // gets the near ring demoted to pickable individual meshes.
  private demotionsDeferred = false;

  // On rescan: chunks crossing the near-keep boundary swap representations.
  // Only the boundary band is scanned (O(keep²), not O(chunkMap)).
  private rebalanceBatchBoundary(pcx: number, pcz: number) {
    this.demotionsDeferred = false;
    const K = NEAR_BATCH_KEEP;
    for (let dx = -K - 2; dx <= K + 2; dx++) {
      for (let dz = -K - 2; dz <= K + 2; dz++) {
        const chunk = this.getChunk(pcx + dx, pcz + dz);
        if (!chunk || !chunk.loaded) continue;
        const cheb = Math.max(Math.abs(dx), Math.abs(dz));
        const key = this.chunkKey(pcx + dx, pcz + dz);
        const isBatched = chunk.batchEntry !== null;
        if (cheb <= K && isBatched) {
          // demote: rebuild individual meshes OFF-THREAD (a worker 'remesh' of
          // the existing data — running the full mesher on the main thread for
          // every boundary crossing was a profiled multi-ms/frame cost). The
          // batch copy keeps rendering until the reply applies (no hole).
          // Deferred while the chunk-gen backlog is heavy: remeshes are pure
          // cosmetics (the batch copy is identical), so fresh chunks win the
          // worker slots; the still-batched entry retries on a later rescan.
          if (this.workers.length > 0 && !this.inflightWorker.has(key) && this.outstanding < this.maxOutstanding / 2) {
            chunk.ensureFlat();   // decode the (possibly compressed) far chunk in the SAME tick as the slice below — never defer to the async reply (would slice an empty array → render hole)
            const request: WorkerRequest = {
              type: 'remesh', version: this.worldVersion, key,
              worldX: chunk.position.x, worldZ: chunk.position.z,
              data: chunk.data.slice().buffer,   // copy — the live array stays with physics
            };
            const w = this.leastLoadedWorker();
            w.postMessage(request, [request.data]);
            this.outstanding++;
            this.inflightWorker.set(key, w);
          } else if (this.workers.length === 0) {
            this.meshQueue.add(chunk);   // no-worker fallback: budgeted local rebuild
          } else {
            this.demotionsDeferred = true;   // backlog heavy — retried from processQueues
          }
        } else if (cheb > K && !isBatched && chunk.children.length > 0 && !this.hasEditsAround(chunk)) {
          this.promoteChunkToBatch(chunk);
        }
      }
    }
  }

  // Called once when a chunk first receives data: already-built neighbours drew
  // their shared border as exposed (this chunk was still air to them), so they
  // need one rebuild to cull it. Not triggered on later rebuilds, which would
  // otherwise ripple endlessly between neighbours.
  private enqueueNeighbourRemesh(chunk: WorldChunk) {
    const { x, z } = chunk.userData as chunkCoords;
    for (const [dx, , dz] of FACE_NEIGHBOURS) {
      if (dx === 0 && dz === 0) continue;
      const neighbour = this.getChunk(x + dx, z + dz);
      if (neighbour && neighbour !== chunk && neighbour.hasData && neighbour.loaded) {
        this.meshQueue.add(neighbour);
      }
    }
  }

  // ---- foliage distance culling -------------------------------------------
  // Toggle a chunk's plant mesh by distance from the player's chunk. Plants cast
  // no shadow, so hiding them never affects the shadow pass (unlike terrain).
  private applyFoliageVisibility(chunk: WorldChunk) {
    // Runs for EVERY resident chunk on EVERY rescan (refreshFoliageVisibility) —
    // chunk.batchEntry keeps it free of the old per-chunk key-string + Map.get.
    const { x, z } = chunk.userData as chunkCoords;
    const cheb = Math.max(Math.abs(x - this.lastPlayerChunkX), Math.abs(z - this.lastPlayerChunkZ));
    const vis = this.foliageEnabled && cheb <= this.foliageDistance;
    const e = chunk.batchEntry;
    if (e) { this.plantPool.setVisible(e.plant, vis); return; }
    const mesh = chunk.plantMesh;
    if (mesh) mesh.visible = vis;
  }
  refreshFoliageVisibility() {
    for (const chunk of this.chunkMap.values()) this.applyFoliageVisibility(chunk);
  }
  // Toggle ultra foliage/leaf cutout shadows on every loaded chunk (no rebuild).
  refreshFoliageShadows(on: boolean) {
    for (const chunk of this.chunkMap.values()) chunk.applyFoliageShadows(on);
    this.plantPool.setShadows(on, on ? cutoutDepthMaterial : null);
    this.leafPool.setShadows(true, on ? cutoutDepthMaterial : null);
  }
  setFoliage(enabled: boolean, distance: number) {
    this.foliageEnabled = enabled;
    this.foliageDistance = distance;
    this.refreshFoliageVisibility();
  }

  // The cached top-down canvas for a loaded chunk (for the in-sync minimap blit).
  getChunkMapTileCanvas(cx: number, cz: number, build = true): HTMLCanvasElement | null {
    const chunk = this.chunkMap.get(this.chunkKey(cx, cz));
    return chunk && chunk.loaded ? chunk.getMapTileCanvas(build) : null;
  }

  // Force the next update() to re-evaluate the visible set (e.g. after toggling
  // frustum streaming, so loaded chunks immediately cull/restore without waiting
  // for the player to cross a chunk or turn).
  forceRescan() { this.lastPlayerChunkX = NaN; this.lastViewYaw = 999; }

  getVisibleChunks(player: Player) {
    // Pooled output (see _visBacking/_visList): valid until the next rescan.
    const visibleChunks = this._visList;
    visibleChunks.length = 0;
    let poolN = 0;
    const coords = this.worldToChunkCoords(player.position.x, player.position.y, player.position.z);
    const { x, z } = coords.chunk;
    const dd = this.drawDistance;

    // Build the fat view frustum once (when frustum streaming is on + a camera is set).
    const useFrustum = this.frustumStreaming && !!this.activeCamera;
    if (useFrustum) {
      const cam = this.activeCamera!;
      cam.updateMatrixWorld();
      this._projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(this._projScreen);
      for (const p of this._frustum.planes) p.constant += FRUSTUM_MARGIN;   // fatten → hysteresis
    }
    const W = this.chunkSize.width, H = this.chunkSize.height;

    for (let i = x - dd; i <= x + dd; i++) {
      for (let j = z - dd; j <= z + dd; j++) {
        if (useFrustum && Math.max(Math.abs(i - x), Math.abs(j - z)) > FRUSTUM_NEAR_KEEP) {
          // keep ONLY chunks whose full-height column intersects the fat frustum
          // (near chunks above are always kept for physics / instant turn-around).
          this._chunkBox.min.set(i * W, 0, j * W);
          this._chunkBox.max.set(i * W + W, H, j * W + W);
          if (!this._frustum.intersectsBox(this._chunkBox)) continue;
        }
        let o = this._visBacking[poolN];
        if (!o) { o = { x: 0, z: 0 }; this._visBacking[poolN] = o; }
        o.x = i; o.z = j;
        visibleChunks.push(o);
        poolN++;
      }
    }

    return visibleChunks;
  }

  // Removes unloaded-but-out-of-view chunks using the cached `visibleKeys`.
  // Returns true if it hit the per-frame cap (more may remain to remove next frame).
  removeUnusedChunks(): boolean {
    // Cap removals per frame so a teleport (which makes the entire old
    // draw-distance unused at once) doesn't hitch disposing thousands of
    // geometries in a single frame. Off-screen leftovers are frustum-culled.
    let removed = 0;
    let deferred = false;
    const now = performance.now();
    const px = this.lastPlayerChunkX, pz = this.lastPlayerChunkZ;
    for (const [key, chunk] of this.chunkMap) {
      if (removed >= this.maxRemovalsPerFrame) break;
      const cc = chunk.userData as chunkCoords;
      const nk = World.numKey(cc.x, cc.z);
      if (this.visibleKeys.has(nk)) continue;
      // TURN-BACK CACHE: a chunk that's merely outside the view frustum (still
      // within draw range) stays resident for a grace window, so a quick 180°
      // look-back finds everything still loaded instead of restreaming it all.
      // Out-of-RANGE chunks (the player moved away) still evict immediately —
      // the LOD ring covers them and RAM reclaim shouldn't lag travel.
      const inRange = Math.max(Math.abs(cc.x - px), Math.abs(cc.z - pz)) <= this.drawDistance;
      if (inRange && now - (this.chunkMissSince.get(nk) ?? now) < FRUSTUM_EVICT_GRACE_MS) {
        deferred = true;   // keep the removal pass alive so it evicts once the grace expires
        continue;
      }
      this.meshQueue.delete(chunk);
      this.unbatchChunk(chunk);        // free its batch-page slice (if batched)
      this.noteChunkOverTile(chunk);   // LOD tile over it may need to show again
      chunk.disposeInstance();
      this.remove(chunk);
      this.chunkMap.delete(key);
      this.chunkNumMap.delete(nk);
      this.chunkMissSince.delete(nk);
      removed++;
    }
    // No worker eviction needed — the worker is stateless (no chunk cache).
    return removed >= this.maxRemovalsPerFrame || deferred;
  }

  generateChunk(x: number, z: number) {
    const chunk = new WorldChunk(this.chunkSize, this.params, this.dataStore);
    chunk.position.set(x * this.chunkSize.width, 0, z * this.chunkSize.width);
    chunk.userData = { x, z };
    // Chunks never move once placed — compute the matrix once instead of every
    // frame (at high draw distance that's thousands of needless matrix updates).
    chunk.matrixAutoUpdate = false;
    chunk.updateMatrix();

    this.add(chunk);
    chunk.updateMatrixWorld(true);   // world subtree is frozen — compose once at add
    this.chunkMap.set(this.chunkKey(x, z), chunk);
    this.chunkNumMap.set(World.numKey(x, z), chunk);

    if (this.asyncLoading && this.workers.length > 0) {
      // The worker generates AND meshes off-thread, then posts back geometry.
      const request: WorkerRequest = {
        type: 'gen',
        version: this.worldVersion,
        key: this.chunkKey(x, z),
        worldX: chunk.position.x,
        worldZ: chunk.position.z,
      };
      const w = this.leastLoadedWorker();
      w.postMessage(request);
      this.outstanding++;
      this.inflightWorker.set(this.chunkKey(x, z), w); // track for worker-death reclaim

    } else {
      // Synchronous fallback: generate data now, defer (local) meshing to the
      // budgeted queue so a no-worker environment doesn't freeze either.
      chunk.setData(generateChunkData(this.chunkSize, this.params, chunk.position.x, chunk.position.z, this.resourcePayload()));
      this.meshQueue.add(chunk);
      this.enqueueNeighbourRemesh(chunk);
    }
  }

  // A fingerprint of everything that affects generated terrain. If it's
  // unchanged since the last generate(), an Apply only needs to adjust draw
  // distance — no destructive rebuild, existing chunks are kept.
  private genSignature(): string {
    return JSON.stringify({ p: this.params, r: this.resourcePayload() });
  }

  needsRegen(): boolean {
    return this.genSignature() !== this.lastGenSignature;
  }

  // Plain-data snapshot of the (GUI-editable) ore generation settings, safe to
  // structured-clone across to the worker.
  private resourcePayload(): ResourceGenInfo[] {
    return resources.map(r => ({
      id: r.id,
      scale: { x: r.scale.x, y: r.scale.y, z: r.scale.z },
      scarcity: r.scarcity,
      minY: r.minY,
      maxY: r.maxY,
    }));
  }

  private onWorkerMessage(msg: WorkerReply) {
    // Shape-guard the reply: a malformed message would otherwise throw deep inside
    // processQueues (per-frame) and escape animate() → permanent freeze.
    if (!msg || typeof msg.version !== 'number') return;
    if (msg.version !== this.worldVersion) return; // stale (outstanding already reset on regenerate)
    // Defer the (costly) mesh creation to processQueues so a fast worker can't
    // flood a single frame. The in-flight slot is freed when it's applied.
    if (msg.type === 'lodMesh' && typeof msg.key === 'string') { this.lodApplyQueue.push(msg); return; }
    if (msg.type !== 'mesh' || !(msg.data instanceof ArrayBuffer)) return;
    this.applyQueue.push(msg);
  }

  // Whether this chunk or any of its 4 neighbours has player edits (which the
  // worker's deterministic apron doesn't know about).
  private hasEditsAround(chunk: WorldChunk): boolean {
    const px = chunk.position.x, pz = chunk.position.z, w = this.chunkSize.width;
    return this.dataStore.hasChunkEdits(px, pz) ||
      this.dataStore.hasChunkEdits(px + w, pz) || this.dataStore.hasChunkEdits(px - w, pz) ||
      this.dataStore.hasChunkEdits(px, pz + w) || this.dataStore.hasChunkEdits(px, pz - w);
  }

  // Chunks within `radius` chunks of a world position — used to restrict
  // raycasting to the player's vicinity instead of the whole world (the block
  // pick ray is only 4 units long).
  // Returns a SHARED scratch array (no per-call allocation) — this runs every frame
  // (raycast radius 1) and every light gather (radius 3). Both callers consume the
  // result synchronously before the other runs, so reuse is safe; do NOT retain the
  // returned array across another getNearbyChunks call.
  private _nearby: WorldChunk[] = [];
  getNearbyChunks(position: Three.Vector3, radius = 1): WorldChunk[] {
    const { chunk } = this.worldToChunkCoords(position.x, position.y, position.z);
    const result = this._nearby;
    result.length = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const c = this.getChunk(chunk.x + dx, chunk.z + dz);
        if (c) result.push(c);
      }
    }
    return result;
  }

  generate(clearCache: boolean = false) {
    if (clearCache) {
      this.dataStore.clear();
    }
    // Invalidate any in-flight worker results from the previous world.
    this.worldVersion++;
    this.disposeChunks();
    // LOD teardown BEFORE this.clear(): dispose the batch pages explicitly
    // (Group.clear() only detaches — the GPU buffers would leak on every
    // regenerate/load/host-init) and reset all LOD queues/accounting. Pages
    // are recreated lazily by the pools as the new world's tiles stream in.
    this.lodTerrainPool.disposeAll();
    this.lodCanopyPool.disposeAll();
    for (const t of this.lodMap.values()) { t.terrainH = t.canopyH = null; }
    this.lodMap.clear();
    // Chunk batches: dispose the pages outright (recreated lazily as the new
    // world streams) and forget every handle.
    this.casterPool.disposeAll();
    this.leafPool.disposeAll();
    this.plantPool.disposeAll();
    this.batched.clear();
    this.lodPending.length = 0;
    this.lodApplyQueue.length = 0;
    this.lodOutstanding = 0;
    this.lodInflightWorker.clear();
    this.lodDesired.clear();
    this.lodDirty.clear();
    this.clear();
    this.add(this.lodGroup);   // this.clear() detached the (now empty) LOD group — re-adopt it
    this.chunkMap.clear();
    this.chunkNumMap.clear();
    this.chunkMissSince.clear();
    this.pending = [];
    this.meshQueue.clear();
    this.applyQueue.length = 0;
    this.outstanding = 0; // in-flight results from the old world are version-rejected
    this.inflightWorker.clear(); // their (now version-stale) replies won't reach processQueues
    this.workerLoad.clear(); // …so their freeWorker() never fires — drop the stranded load with them, else least-loaded dispatch skews across regenerates
    this.lastPlayerChunkX = NaN; // force a visibility rescan next update()
    this.demotionsDeferred = false; // stale deferral from the OLD world must not gate the new one's first demotions
    this.lodWorkerRetryTick = 0;
    this.sampler = createWorldSampler(this.params, this.chunkSize);
    this.lastGenSignature = this.genSignature();
    // Push fresh config (and reset the worker's chunk cache) for this version.
    // Chunks then stream back in via update()/processQueues().
    this.sendWorkerConfig();
    // Re-point dependents (e.g. the map worker) at the new params/seed.
    this.onAfterGenerate?.();
  }

  getBlock(x: number, y: number, z: number) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk && chunk.loaded) {
      return chunk.getBlock(coords.block.x, coords.block.y, coords.block.z);
    }
    return null;
  }

  // Is the chunk containing this world column loaded? Physics uses this to avoid
  // falling through terrain that hasn't streamed in yet (e.g. after a teleport).
  // Allocation-free (numeric chunk key) — runs every physics step.
  isLoadedAt(worldX: number, worldZ: number): boolean {
    const W = this.chunkSize.width;
    const chunk = this.chunkNumMap.get(World.numKey(Math.floor(worldX / W), Math.floor(worldZ / W)));
    return !!chunk && chunk.loaded;
  }

  // TRULY allocation-free block id at a world coordinate (air if not loaded).
  // Used by the physics broad phase (~50 queries/frame at 200 Hz substeps) —
  // the old path allocated two coord objects + a template-string key per call
  // through worldToChunkCoords/chunkKey, ~150 short-lived allocations a frame.
  getBlockId(x: number, y: number, z: number): number {
    const W = this.chunkSize.width;
    const cx = Math.floor(x / W), cz = Math.floor(z / W);
    const chunk = this.chunkNumMap.get(World.numKey(cx, cz));
    if (chunk && chunk.loaded) {
      return chunk.getBlockId(x - cx * W, y, z - cz * W);
    }
    return BLOCK_IDS.air;
  }

  worldToChunkCoords(x: number, y: number, z: number) {
    const chunkCoords = {
      x: Math.floor(x / this.chunkSize.width),
      z: Math.floor(z / this.chunkSize.width)
    };

    const blockCoords = {
      x: x - this.chunkSize.width * chunkCoords.x,
      y,
      z: z - this.chunkSize.width * chunkCoords.z
    };

    return { chunk: chunkCoords, block: blockCoords };
  }

  getChunk(x: number, z: number) {
    return this.chunkMap.get(this.chunkKey(x, z));
  }

  // MULTIPLAYER hook: fired with the FINAL world-space result of every LOCAL
  // edit (place / remove / door-toggle) — exactly what a peer must replay to
  // converge. Fired only when the block actually CHANGED (a refused add — e.g.
  // target not air — must not broadcast), and muted while applying edits that
  // arrived FROM the network so they can't echo back.
  onEdit?: (x: number, y: number, z: number, id: number) => void;
  private muteEditEvents = false;
  private emitEdit(x: number, y: number, z: number, id: number) {
    if (!this.muteEditEvents) this.onEdit?.(x, y, z, id);
  }

  setBlock(x: number, y: number, z: number, id: number) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk) {
      const before = chunk.getBlockId(coords.block.x, coords.block.y, coords.block.z);
      chunk.addBlock(coords.block.x, coords.block.y, coords.block.z, id, this.getWorldBlock, this.getGrassTint);
      this.remeshAround(x, y, z, chunk);
      const after = chunk.getBlockId(coords.block.x, coords.block.y, coords.block.z);
      if (after !== before) this.emitEdit(x, y, z, after);
    }
  }

  removeBlock(x: number, y: number, z: number) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk) {
      const before = chunk.getBlockId(coords.block.x, coords.block.y, coords.block.z);
      chunk.removeBlock(coords.block.x, coords.block.y, coords.block.z, this.getWorldBlock, this.getGrassTint);
      this.remeshAround(x, y, z, chunk);
      if (before !== BLOCK_IDS.air) this.emitEdit(x, y, z, BLOCK_IDS.air);
    }
  }

  // Apply a block edit that arrived FROM a peer. Overwrite semantics
  // (last-write-wins — the remote already validated its own action). If the
  // chunk isn't resident here (different draw distance / frustum streaming),
  // persist straight to the dataStore: loadPlayerChanges() re-applies it when
  // the chunk streams in — same mechanism that makes local edits survive unload.
  applyRemoteEdit(x: number, y: number, z: number, id: number) {
    this.muteEditEvents = true;   // a replayed edit must not re-broadcast
    try {
      const coords = this.worldToChunkCoords(x, y, z);
      const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);
      if (chunk && chunk.loaded) {
        chunk.setBlockEdit(coords.block.x, coords.block.y, coords.block.z, id, this.getWorldBlock, this.getGrassTint);
        // A remote edit can land on a BATCHED far chunk: setBlockEdit just
        // rebuilt its individual meshes, so drop the (now stale) batch copy.
        this.unbatchChunk(chunk);
        this.remeshAround(x, y, z, chunk);
      } else {
        this.dataStore.set({
          chunkX: coords.chunk.x, chunkZ: coords.chunk.z,
          blockX: coords.block.x, blockY: coords.block.y, blockZ: coords.block.z,
          blockID: id,
        });
      }
    } finally {
      this.muteEditEvents = false;
    }
  }

  // Right-click "use": toggle a door/trapdoor (and a door's paired half). Returns
  // true if the block was interactive (so the caller skips block-pick/place).
  interactBlock(x: number, y: number, z: number): boolean {
    const id = this.getBlockId(x, y, z);
    const toggled = TOGGLE[id];
    if (toggled === undefined) return false;
    const setOne = (wx: number, wy: number, wz: number, nid: number) => {
      const c = this.worldToChunkCoords(wx, wy, wz);
      const chunk = this.getChunk(c.chunk.x, c.chunk.z);
      if (chunk) {
        chunk.setBlockEdit(c.block.x, c.block.y, c.block.z, nid, this.getWorldBlock, this.getGrassTint);
        this.remeshAround(wx, wy, wz, chunk);
        this.emitEdit(wx, wy, wz, nid);   // peers replay the RESULTING id (no double-toggle)
      }
    };
    setOne(x, y, z, toggled);
    if (DOOR_PART[id] === 1) {                       // doors are 2-tall — toggle the other half too
      const above = this.getBlockId(x, y + 1, z), below = this.getBlockId(x, y - 1, z);
      if (DOOR_PART[above] === 1 && TOGGLE[above] !== undefined) setOne(x, y + 1, z, TOGGLE[above]);
      else if (DOOR_PART[below] === 1 && TOGGLE[below] !== undefined) setOne(x, y - 1, z, TOGGLE[below]);
    }
    return true;
  }

  // After a single-block edit, re-mesh any neighbouring chunk that borders the
  // edited block so its border faces are revealed/hidden correctly. The edited
  // chunk itself was rebuilt synchronously (instant-edit feel) by addBlock/
  // removeBlock; neighbours are routed through the budgeted meshQueue so rapid
  // seam-digging can't hitch the click thread with several rebuilds at once (the
  // momentarily-stale border self-heals within a frame or two).
  private remeshAround(x: number, y: number, z: number, edited: WorldChunk) {
    this.meshEpoch++;   // the edited chunk re-meshed synchronously → shadow map re-render
    for (const [dx, dy, dz] of FACE_NEIGHBOURS) {
      const coords = this.worldToChunkCoords(x + dx, y + dy, z + dz);
      const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);
      if (chunk && chunk !== edited && chunk.loaded) {
        this.meshQueue.add(chunk);
      }
    }
  }

  disposeChunks() {
    for (const chunk of this.chunkMap.values()) {
      chunk.disposeInstance();
    }
  }

  save() {
    const status = document.getElementById('status');
    const flash = (msg: string) => { if (status) { status.innerHTML = msg; setTimeout(() => { status.innerHTML = ''; }, 3000); } };
    try {
      // Write DATA first, then params: if the data write throws (QuotaExceeded),
      // params isn't left pointing at a half-written save that load() desyncs on.
      localStorage.setItem('minecraft_data', JSON.stringify(this.dataStore.data));
      localStorage.setItem('minecraft_world', JSON.stringify(this.params));
      flash('World saved');
    } catch (e) {
      console.error('world save failed', e);
      flash('SAVE FAILED (storage full?)');
    }
  }

  load() {
    const status = document.getElementById('status');
    const flash = (msg: string) => { if (status) { status.innerHTML = msg; setTimeout(() => { status.innerHTML = ''; }, 3000); } };
    const rawParams = localStorage.getItem('minecraft_world');
    if (!rawParams) { flash('No saved world'); return; }
    try {
      // Validate BEFORE committing: a corrupt/edited save must not half-mutate
      // params (a NaN waterOffset would then corrupt the render loop every frame).
      const params = JSON.parse(rawParams) as ChunkParams;
      const t = params?.terrain;
      const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
      if (!t || !finite(t.scale) || !finite(t.magnitude) || !finite(t.offset) || !finite(t.waterOffset)) {
        throw new Error('invalid terrain params');
      }
      const rawData = localStorage.getItem('minecraft_data');
      const data = rawData ? JSON.parse(rawData) : {};
      // A corrupt blob like "[1,2,3]" or "42" parses fine but rebuildIndex would
      // produce garbage edits — require a plain object.
      if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid data blob');
      // Commit only after both parse+validate succeed.
      this.params = params;
      this.dataStore.data = data;
      this.dataStore.rebuildIndex(); // data was assigned directly (bypassing set()) — resync the edit index
    } catch (e) {
      console.error('world load failed (bad save)', e);
      flash('LOAD FAILED (bad save)');
      return;
    }
    flash('WORLD LOADED');
    this.generate();
  }
}
