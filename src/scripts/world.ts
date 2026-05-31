import * as Three from 'three';
import { WorldChunk } from './worldChunk';
import { Player } from './player';
import { DataStore } from './dataStore';
import { resources } from './blocks';
import { ChunkParams, generateChunkData, createWorldSampler, WorldSampler, climateGrassTint } from './chunkGen';
import { ResourceGenInfo, BLOCK_IDS, TOGGLE, DOOR_PART } from './blockTypes';
import { GeometryArrays } from './chunkMesh';
import type { WorkerRequest, MeshMessage, GeometryPayload } from './chunkWorker';

// Frustum-streaming tuning (see World.frustumStreaming):
const FRUSTUM_MARGIN = 40;      // world units to fatten the frustum (hysteresis vs rotation churn)
// Chunks within this Chebyshev radius are ALWAYS resident regardless of view — covers
// the minimap (~±6 chunks) + immediate surroundings, so the minimap never goes blank
// and turning never pops in NEARBY terrain. Frustum culling then trims only the FAR
// ring (rings 7..drawDistance), which is where the chunk count (and RAM) explodes at
// high draw distance — so the win scales with draw distance while play stays smooth.
const FRUSTUM_NEAR_KEEP = 6;
const VIEW_YAW_RESCAN = 0.15;   // camera-yaw delta (rad, ~8.5°) that triggers a frustum re-evaluation

type chunkCoords = { x: number, z: number };

const FACE_NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

// Reconstruct typed-array geometry from the buffers transferred by the worker.
function payloadToArrays(p: GeometryPayload): GeometryArrays | null {
  if (!p) return null;
  return {
    positions: new Float32Array(p.positions),
    normals: new Float32Array(p.normals),
    uvs: new Float32Array(p.uvs),
    layers: new Float32Array(p.layers),
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
    // pretty-but-miniature diorama. magnitude = the BASE mountain amplitude (modest,
    // normal mounds/peaks); a +110 RANGE bonus in columnSurface lifts ONLY the cold
    // very-low-erosion mountain RANGES to their extreme, snow-capped height.
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
  }

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
  private visibleKeys = new Set<string>();
  private removalPending = false;

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
  // Pool of stateless gen+mesh workers (each chunk is independent thanks to the
  // deterministic apron), round-robined. Parallelism lets a high apply budget be
  // fed without the worker becoming the bottleneck.
  private workers: Worker[] = [];
  private nextWorker = 0;
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

    this.initWorkers();
    // Save/Load are exposed as menu buttons now (the old 'm'/'n' keybinds were
    // removed — 'm' opens the world map instead, wired in main.ts).
  }

  private initWorkers() {
    // Leave a couple of cores for the main/render thread.
    const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < count; i++) {
      try {
        const w = new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (event: MessageEvent<MeshMessage>) => this.onWorkerMessage(event.data);
        w.onerror = (e) => this.handleWorkerDeath(w, e);
        this.workers.push(w);
      } catch { /* fall back to fewer / no workers */ }
    }
    // More in-flight with more workers so each stays fed; still bounded.
    this.maxOutstanding = Math.max(16, this.workers.length * 8);
  }

  // A worker died (e.g. crashed mid-gen). Drop it AND reclaim its in-flight gen
  // slots, or `outstanding` stays permanently inflated and async streaming halts.
  // Orphaned (data-less) chunks it was generating are removed and re-requested via
  // a forced rescan; if every worker dies, processQueues falls back to sync gen.
  private handleWorkerDeath(w: Worker, e?: unknown) {
    console.error('chunk worker died, dropping it and reclaiming its work', e);
    this.workers = this.workers.filter(x => x !== w);
    let reclaimed = false;
    for (const [key, worker] of this.inflightWorker) {
      if (worker !== w) continue;
      this.inflightWorker.delete(key);
      this.outstanding = Math.max(0, this.outstanding - 1);
      const chunk = this.chunkMap.get(key);
      if (chunk && !chunk.hasData) { chunk.disposeInstance(); this.remove(chunk); this.chunkMap.delete(key); reclaimed = true; }
    }
    if (reclaimed) this.lastPlayerChunkX = NaN; // force a rescan → re-request the orphaned chunks
  }

  // Push the current generation config to every worker. Sent on each regenerate.
  private sendWorkerConfig() {
    const message: WorkerRequest = {
      type: 'config',
      version: this.worldVersion,
      size: this.chunkSize,
      params: this.params,
      resources: this.resourcePayload(),
    };
    for (const w of this.workers) w.postMessage(message);
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
      this.drawDistance !== this.lastDrawDistance || yawTurned;

    if (rescan) {
      this.lastPlayerChunkX = c.x;
      this.lastPlayerChunkZ = c.z;
      this.lastDrawDistance = this.drawDistance;
      this.lastViewYaw = viewYaw;

      const visibleChunks = this.getVisibleChunks(player);
      this.visibleKeys = new Set(visibleChunks.map(({ x, z }) => this.chunkKey(x, z)));
      this.removalPending = this.removeUnusedChunks();
      this.pending = visibleChunks
        .filter(({ x, z }) => !this.chunkMap.has(this.chunkKey(x, z)))
        .sort((a, b) => ((a.x - c.x) ** 2 + (a.z - c.z) ** 2) - ((b.x - c.x) ** 2 + (b.z - c.z) ** 2));
      // Player crossed a chunk boundary → re-evaluate which chunks show foliage.
      this.refreshFoliageVisibility();
    } else if (this.removalPending) {
      // Keep removing (capped per frame) using the cached visible set — no need
      // to rebuild the visible list / pending every frame during removal.
      this.removalPending = this.removeUnusedChunks();
    }
  }

  // Drain a bounded slice of the work each frame so the world streams in
  // without a main-thread burst (which used to freeze/crash at high distances).
  processQueues() {
    // 1) Turn a bounded number of finished worker results into meshes. This is
    // the main-thread cost (BufferGeometry + GPU upload); budgeting it keeps the
    // frame short while chunks stream in. `outstanding` (gen slots) is freed here
    // on apply, so generation is naturally throttled to the apply rate.
    // Two passes so a batch is internally consistent: adopt ALL the batch's block
    // data FIRST, then mesh. An edit-driven local rebuild (hasEditsAround) reads
    // neighbour chunks; if a neighbour was applied later in the same batch it would
    // otherwise be read as air → an exposed seam never re-fixed in the async path.
    const batch: { chunk: WorldChunk, msg: MeshMessage }[] = [];
    let applied = 0;
    while (applied < this.maxAppliesPerFrame && this.applyQueue.length > 0) {
      const msg = this.applyQueue.shift()!;
      this.outstanding = Math.max(0, this.outstanding - 1);
      this.inflightWorker.delete(msg.key);
      const chunk = this.chunkMap.get(msg.key);
      if (!chunk) continue;        // unloaded before we got to it
      if (chunk.loaded) continue;  // duplicate/stale reply for a chunk re-created at the same coords
      chunk.setData(new Uint8Array(msg.data));
      batch.push({ chunk, msg });
      applied++;
    }
    for (const { chunk, msg } of batch) {
      // Isolate per-chunk apply: a single bad geometry payload skips ONE chunk
      // (logged) instead of throwing out of the per-frame loop and freezing the game.
      try {
        if (this.hasEditsAround(chunk)) chunk.buildMeshes(this.getWorldBlock, this.getGrassTint);  // also rescans emitters + rebuilds the map tile
        else {
          chunk.applyGeometry(payloadToArrays(msg.casters), payloadToArrays(msg.nonCasters), payloadToArrays(msg.plants));
          chunk.setEmitters(new Float32Array(msg.emitters));
          chunk.setMapTile(new Uint8Array(msg.mapTile));
        }
        this.applyFoliageVisibility(chunk);
      } catch (e) {
        console.error('chunk apply failed, skipping', msg.key, e);
      }
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

    let builds = 0;
    for (const chunk of this.meshQueue) {
      if (builds >= this.maxMeshBuildsPerFrame) break;
      this.meshQueue.delete(chunk);
      if (chunk.hasData && chunk.parent === this) {
        chunk.buildMeshes(this.getWorldBlock, this.getGrassTint);
        this.applyFoliageVisibility(chunk);
        builds++;
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
    const mesh = chunk.plantMesh;
    if (!mesh) return;
    if (!this.foliageEnabled) { mesh.visible = false; return; }
    const { x, z } = chunk.userData as chunkCoords;
    const cheb = Math.max(Math.abs(x - this.lastPlayerChunkX), Math.abs(z - this.lastPlayerChunkZ));
    mesh.visible = cheb <= this.foliageDistance;
  }
  refreshFoliageVisibility() {
    for (const chunk of this.chunkMap.values()) this.applyFoliageVisibility(chunk);
  }
  // Toggle ultra foliage/leaf cutout shadows on every loaded chunk (no rebuild).
  refreshFoliageShadows(on: boolean) {
    for (const chunk of this.chunkMap.values()) chunk.applyFoliageShadows(on);
  }
  setFoliage(enabled: boolean, distance: number) {
    this.foliageEnabled = enabled;
    this.foliageDistance = distance;
    this.refreshFoliageVisibility();
  }

  // The cached top-down canvas for a loaded chunk (for the in-sync minimap blit).
  getChunkMapTileCanvas(cx: number, cz: number): HTMLCanvasElement | null {
    const chunk = this.chunkMap.get(this.chunkKey(cx, cz));
    return chunk && chunk.loaded ? chunk.getMapTileCanvas() : null;
  }

  // Force the next update() to re-evaluate the visible set (e.g. after toggling
  // frustum streaming, so loaded chunks immediately cull/restore without waiting
  // for the player to cross a chunk or turn).
  forceRescan() { this.lastPlayerChunkX = NaN; this.lastViewYaw = 999; }

  getVisibleChunks(player: Player) {
    const visibleChunks: chunkCoords[] = [];
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
        visibleChunks.push({ x: i, z: j });
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
    for (const [key, chunk] of this.chunkMap) {
      if (removed >= this.maxRemovalsPerFrame) break;
      if (!this.visibleKeys.has(key)) {
        this.meshQueue.delete(chunk);
        chunk.disposeInstance();
        this.remove(chunk);
        this.chunkMap.delete(key);
        removed++;
      }
    }
    // No worker eviction needed — the worker is stateless (no chunk cache).
    return removed >= this.maxRemovalsPerFrame;
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
    this.chunkMap.set(this.chunkKey(x, z), chunk);

    if (this.asyncLoading && this.workers.length > 0) {
      // The worker generates AND meshes off-thread, then posts back geometry.
      const request: WorkerRequest = {
        type: 'gen',
        version: this.worldVersion,
        key: this.chunkKey(x, z),
        worldX: chunk.position.x,
        worldZ: chunk.position.z,
      };
      const w = this.workers[this.nextWorker++ % this.workers.length];
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

  private onWorkerMessage(msg: MeshMessage) {
    // Shape-guard the reply: a malformed message would otherwise throw deep inside
    // processQueues (per-frame) and escape animate() → permanent freeze.
    if (!msg || msg.type !== 'mesh' || typeof msg.version !== 'number' || !(msg.data instanceof ArrayBuffer)) return;
    if (msg.version !== this.worldVersion) return; // stale (outstanding already reset on regenerate)
    // Defer the (costly) mesh creation to processQueues so a fast worker can't
    // flood a single frame. The in-flight slot is freed when it's applied.
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
  getNearbyChunks(position: Three.Vector3, radius = 1): WorldChunk[] {
    const { chunk } = this.worldToChunkCoords(position.x, position.y, position.z);
    const result: WorldChunk[] = [];
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
    this.clear();
    this.chunkMap.clear();
    this.pending = [];
    this.meshQueue.clear();
    this.applyQueue.length = 0;
    this.outstanding = 0; // in-flight results from the old world are version-rejected
    this.inflightWorker.clear(); // their (now version-stale) replies won't reach processQueues
    this.lastPlayerChunkX = NaN; // force a visibility rescan next update()
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
  isLoadedAt(worldX: number, worldZ: number): boolean {
    const coords = this.worldToChunkCoords(worldX, 0, worldZ);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);
    return !!chunk && chunk.loaded;
  }

  // Allocation-free block id at a world coordinate (air if not loaded). Used by
  // the physics broad phase, which queries dozens of cells every fixed step.
  getBlockId(x: number, y: number, z: number): number {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);
    if (chunk && chunk.loaded) {
      return chunk.getBlockId(coords.block.x, coords.block.y, coords.block.z);
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

  setBlock(x: number, y: number, z: number, id: number) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk) {
      chunk.addBlock(coords.block.x, coords.block.y, coords.block.z, id, this.getWorldBlock, this.getGrassTint);
      this.remeshAround(x, y, z, chunk);
    }
  }

  removeBlock(x: number, y: number, z: number) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk) {
      chunk.removeBlock(coords.block.x, coords.block.y, coords.block.z, this.getWorldBlock, this.getGrassTint);
      this.remeshAround(x, y, z, chunk);
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
      if (chunk) { chunk.setBlockEdit(c.block.x, c.block.y, c.block.z, nid, this.getWorldBlock, this.getGrassTint); this.remeshAround(wx, wy, wz, chunk); }
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
