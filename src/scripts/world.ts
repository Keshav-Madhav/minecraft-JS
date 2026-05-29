import * as Three from 'three';
import { WorldChunk } from './worldChunk';
import { Player } from './player';
import { DataStore } from './dataStore';
import { resources } from './blocks';
import { ChunkParams, generateChunkData, createWorldSampler, WorldSampler } from './chunkGen';
import { ResourceGenInfo, BLOCK_IDS } from './blockTypes';
import { GeometryArrays } from './chunkMesh';
import type { WorkerRequest, MeshMessage, GeometryPayload } from './chunkWorker';

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
  // 256-tall world with sea level at 128 (128 below water, 128 above).
  chunkSize = { width: 16, height: 256 };
  params: ChunkParams = {
    // scale = feature breadth (continents ~3.5x this); magnitude = mountain
    // height; offset = land-height bias above sea (higher => more/larger land).
    // Large scale keeps the world traversible (broad, gentle terrain) instead
    // of a pretty-but-miniature diorama.
    seed: 0,
    terrain: { scale: 260, magnitude: 85, offset: 10, waterOffset: 128 },
    trees: {
      trunk: { minHeight: 4, maxHeight: 7 },
      canopy: { minRadius: 2, maxRadius: 3, density: 0.7 },
      frequency: 0.04
    },
    clouds: { scale: 20, density: 0.2 }
  };
  drawDistance = 10;

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

    document.addEventListener('keydown', (event) => {
      if (event.key === 'n') {
        event.preventDefault();
        this.save();
      } else if (event.key === 'm') {
        event.preventDefault();
        this.load();
      }
    });
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

  // Biome id at a world column (deterministic terrain function). Passed into the
  // local mesher for edit re-meshes so plant tints match the worker's output.
  getBiomeAt = (worldX: number, worldZ: number): number => this.sampler(worldX, worldZ).biome;

  get chunkCount() {
    return this.chunkMap.size;
  }

  update(player: Player) {
    const { chunk: c } = this.worldToChunkCoords(player.position.x, player.position.y, player.position.z);
    // Rescan when the player crossed a chunk boundary OR draw distance changed
    // (e.g. Apply lowered it — otherwise the now-unused chunks would never be
    // removed). While chunks merely stream in, processQueues drains `pending`.
    const rescan = c.x !== this.lastPlayerChunkX || c.z !== this.lastPlayerChunkZ ||
      this.drawDistance !== this.lastDrawDistance;

    if (rescan) {
      this.lastPlayerChunkX = c.x;
      this.lastPlayerChunkZ = c.z;
      this.lastDrawDistance = this.drawDistance;

      const visibleChunks = this.getVisibleChunks(player);
      this.visibleKeys = new Set(visibleChunks.map(({ x, z }) => this.chunkKey(x, z)));
      this.removalPending = this.removeUnusedChunks();
      this.pending = visibleChunks
        .filter(({ x, z }) => !this.chunkMap.has(this.chunkKey(x, z)))
        .sort((a, b) => ((a.x - c.x) ** 2 + (a.z - c.z) ** 2) - ((b.x - c.x) ** 2 + (b.z - c.z) ** 2));
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
      if (this.hasEditsAround(chunk)) chunk.buildMeshes(this.getWorldBlock, this.getBiomeAt);
      else chunk.applyGeometry(payloadToArrays(msg.casters), payloadToArrays(msg.nonCasters), payloadToArrays(msg.plants));
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
        chunk.buildMeshes(this.getWorldBlock, this.getBiomeAt);
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

  getVisibleChunks(player: Player) {
    const visibleChunks: chunkCoords[] = [];
    const coords = this.worldToChunkCoords(player.position.x, player.position.y, player.position.z);
    const { x, z } = coords.chunk;

    for (let i = x - this.drawDistance; i <= x + this.drawDistance; i++) {
      for (let j = z - this.drawDistance; j <= z + this.drawDistance; j++) {
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
    }));
  }

  private onWorkerMessage(msg: MeshMessage) {
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
      chunk.addBlock(coords.block.x, coords.block.y, coords.block.z, id, this.getWorldBlock, this.getBiomeAt);
      this.remeshAround(x, y, z, chunk);
    }
  }

  removeBlock(x: number, y: number, z: number) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk) {
      chunk.removeBlock(coords.block.x, coords.block.y, coords.block.z, this.getWorldBlock, this.getBiomeAt);
      this.remeshAround(x, y, z, chunk);
    }
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
    localStorage.setItem('minecraft_world', JSON.stringify(this.params));
    localStorage.setItem('minecraft_data', JSON.stringify(this.dataStore.data));
    const status = document.getElementById('status');
    if (status) {
      status.innerHTML = 'World saved';
      setTimeout(() => { status.innerHTML = ''; }, 3000);
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
