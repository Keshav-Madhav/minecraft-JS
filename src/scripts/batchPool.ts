import * as THREE from 'three';
import type { GeometryArrays } from './chunkMesh';

// DRAW-CALL COLLAPSE: a pool of BatchedMesh "pages" sharing one material. Each
// page renders ALL its sub-geometries in ONE draw call (WEBGL_multi_draw with
// per-instance frustum culling inside three) — the profiled wall was ~6µs of
// CPU per draw call, so collapsing thousands of chunk/LOD meshes into a few
// pages is the single biggest fps lever in the engine.
//
// r184 BatchedMesh mechanics this design leans on (verified in source):
//  • addGeometry copies into the page's big buffers with addUpdateRange —
//    partial GPU uploads, so adding a chunk uploads only its slice.
//  • The allocator is APPEND-ONLY; deleteGeometry frees the id but not the
//    buffer space. optimize() compacts. We track cursor/live/freed per page
//    and compact a page when it can't fit a new geometry but has enough waste.
//  • Geometry ids stay valid across optimize() (ranges move, ids don't).
//  • The FIRST geometry added defines the attribute set (custom attributes
//    incl. normalized Uint8 are honored) — every later add must match it.
//  • Per-instance culling runs in BOTH the colour and shadow passes.

export type BatchHandle = {
  page: number,
  geomId: number,
  instId: number,
  verts: number,
  idx: number,
};

type PoolOpts = {
  pageVerts: number,            // vertex capacity per page (~40 B/vertex of CPU+GPU each)
  pageInstances: number,
  castShadow: boolean,
  colorAttr: 'tintColor' | 'plantColor',
  customDepth?: THREE.Material | null,   // cutout depth material (ultra foliage shadows)
};

type PageState = { batch: THREE.BatchedMesh, cursor: number, idxCursor: number, liveV: number, liveI: number, freedV: number, inst: number };

export class BatchPool {
  private pages: PageState[] = [];

  constructor(
    private parent: THREE.Object3D,
    private material: THREE.Material,
    private opts: PoolOpts,
  ) {}

  get pageCount() { return this.pages.length; }
  get liveVerts() { return this.pages.reduce((a, p) => a + p.liveV, 0); }

  private newPage(): PageState {
    const o = this.opts;
    const batch = new THREE.BatchedMesh(o.pageInstances, o.pageVerts, (o.pageVerts * 1.6) | 0, this.material);
    batch.castShadow = o.castShadow;
    batch.receiveShadow = true;          // matches the chunk meshes sharing this material (program-key uniformity)
    batch.perObjectFrustumCulled = true; // per-instance culling (colour + shadow passes)
    batch.frustumCulled = false;         // page-level bounds are meaningless; instances are culled individually
    batch.sortObjects = false;           // opaque-only content — skip the per-frame instance z-sort
    batch.raycast = () => {};            // picking uses the near-ring individual meshes / voxel data only
    if (o.customDepth) batch.customDepthMaterial = o.customDepth;
    batch.matrixAutoUpdate = false;
    this.parent.add(batch);
    batch.updateMatrixWorld(true);       // the world subtree's matrix traversal is frozen — compose once
    const state: PageState = { batch, cursor: 0, idxCursor: 0, liveV: 0, liveI: 0, freedV: 0, inst: 0 };
    this.pages.push(state);
    return state;
  }

  // Build the throwaway BufferGeometry addGeometry copies from (never uploaded
  // itself — its arrays are memcpy'd into the page buffers, then disposed).
  // Quantized format (chunkMesh.ts): positions/uvs/layers are normalized u16;
  // positions decode via the INSTANCE matrix (descale baked into setMatrixAt).
  private tempGeometry(a: GeometryArrays): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a.positions, 3, true));
    g.setAttribute('tileUv', new THREE.BufferAttribute(a.uvs, 2, true));
    g.setAttribute('layerIndex', new THREE.BufferAttribute(a.layers, 1, true));
    // colors are ALWAYS present on worker-meshed geometry; the attribute set
    // must be identical for every add (the first add defines the page layout)
    g.setAttribute(this.opts.colorAttr, new THREE.BufferAttribute(a.colors!, 4, true));
    g.setIndex(new THREE.BufferAttribute(a.indices, 1));
    setQuantizedBounds(g, a.positions);   // adopted by setGeometryAt → no lazy denormalize scan
    return g;
  }

  // Add one geometry at a world offset. Returns null only when genuinely out
  // of capacity everywhere (caller may retry later — e.g. tile re-queues).
  add(arrays: GeometryArrays, x: number, y: number, z: number): BatchHandle | null {
    const verts = (arrays.positions.length / 3) | 0;
    const idx = arrays.indices.length;
    // Allocation policy: append into an existing page → open a NEW page →
    // only as a last resort (page cap reached) compact the wasteland page and
    // retry. The earlier policy preferred optimize() over a new page, which
    // turned streaming churn into 10-30ms compaction storms inside the apply
    // path (every delete made the next non-fitting add repack a whole page).
    // Steady-state waste is reclaimed by maybeOptimize() in the background.
    const pageIdxCap = (this.opts.pageVerts * 1.6) | 0;
    let pageIdx = this.pages.findIndex((p) =>
      p.cursor + verts <= this.opts.pageVerts &&
      p.idxCursor + idx <= pageIdxCap &&
      p.inst < this.opts.pageInstances);
    if (pageIdx < 0 && this.pages.length < MAX_PAGES) {
      this.newPage();
      pageIdx = this.pages.length - 1;
    }
    if (pageIdx < 0) {
      let best = -1, bestFreed = 0;
      for (let i = 0; i < this.pages.length; i++) {
        const p = this.pages[i];
        if (p.freedV > bestFreed && p.liveV + verts <= this.opts.pageVerts && p.inst < this.opts.pageInstances) { best = i; bestFreed = p.freedV; }
      }
      if (best < 0) { console.error('BatchPool: out of capacity'); return null; }
      const p = this.pages[best];
      p.batch.optimize();              // compacts; geometry ids stay valid
      p.cursor = p.liveV; p.idxCursor = p.liveI; p.freedV = 0;
      pageIdx = best;
    }
    const p = this.pages[pageIdx];
    const g = this.tempGeometry(arrays);
    let geomId: number;
    try {
      geomId = p.batch.addGeometry(g);
    } catch (e) {
      g.dispose();
      console.error('BatchPool.add failed', e);
      return null;
    }
    const instId = p.batch.addInstance(geomId);
    // Instance matrix = world offset COMPOSED with the quantization descale
    // (local = norm·(65535/64) − 8): scale on the diagonal, translation column
    // carries (offset − 8 per axis). Shadows/raycast/culling all decode free.
    _m.makeScale(QK, QK, QK).setPosition(x - 8, y - 8, z - 8);
    p.batch.setMatrixAt(instId, _m);
    g.dispose();
    p.cursor += verts; p.idxCursor += idx;
    p.liveV += verts; p.liveI += idx;
    p.inst++;
    return { page: pageIdx, geomId, instId, verts, idx };
  }

  remove(h: BatchHandle | null | undefined) {
    if (!h) return;
    const p = this.pages[h.page];
    if (!p) return;
    p.batch.deleteGeometry(h.geomId);    // deletes its instance too
    p.liveV -= h.verts; p.liveI -= h.idx;
    p.freedV += h.verts;
    p.inst--;
  }

  setVisible(h: BatchHandle | null | undefined, v: boolean) {
    if (!h) return;
    this.pages[h.page]?.batch.setVisibleAt(h.instId, v);
  }

  // Background compaction: at most one page per call (optimize is O(liveVerts)
  // memcpy + re-upload) — and among waste-heavy pages, repack the one with the
  // LEAST live data first (cheapest call, frees the same append room).
  maybeOptimize() {
    let pick: PageState | null = null;
    for (const p of this.pages) {
      if (p.freedV > this.opts.pageVerts * 0.25 && (!pick || p.liveV < pick.liveV)) pick = p;
    }
    if (pick) {
      pick.batch.optimize();
      pick.cursor = pick.liveV; pick.idxCursor = pick.liveI; pick.freedV = 0;
    }
  }

  // Toggle shadow casting + cutout depth on every page (ultra foliage toggle).
  setShadows(cast: boolean, customDepth: THREE.Material | null) {
    this.opts.castShadow = cast;
    this.opts.customDepth = customDepth;
    for (const p of this.pages) {
      p.batch.castShadow = cast;
      p.batch.customDepthMaterial = (customDepth ?? undefined) as THREE.Material;
    }
  }

  setPerObjectFrustumCulled(v: boolean) {
    for (const p of this.pages) p.batch.perObjectFrustumCulled = v;
  }

  disposeAll() {
    for (const p of this.pages) {
      p.batch.dispose();
      this.parent.remove(p.batch);
    }
    this.pages.length = 0;
  }
}

const _m = new THREE.Matrix4();
const QK = 65535 / 64;   // quantized-normalized → block-space scale (see chunkMesh.ts)
const MAX_PAGES = 24;    // per pool; each page = 1 draw call, so even maxed out this stays cheap

// Bounds straight from the quantized u16 positions (raw integer scan). Without
// this, three computes bounds lazily by iterating the NORMALIZED attribute
// through per-component denormalize() calls — profiled at ~9% of frame time
// during streaming (every new chunk/tile geometry pays it once at first cull).
// BatchedMesh.setGeometryAt clones a source geometry's pre-set bounds, and
// plain Meshes cull off geometry.boundingSphere — so pre-setting both kills
// the lazy path entirely. Sphere = the box's circumsphere (conservative ≥
// exact → culling stays correct, marginally looser).
export function setQuantizedBounds(g: THREE.BufferGeometry, pos: Uint16Array) {
  let minX = 65535, minY = 65535, minZ = 65535, maxX = 0, maxY = 0, maxZ = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const s = 1 / 65535;
  const box = new THREE.Box3();
  box.min.set(minX * s, minY * s, minZ * s);
  box.max.set(maxX * s, maxY * s, maxZ * s);
  const sphere = new THREE.Sphere();
  box.getCenter(sphere.center);
  sphere.radius = box.min.distanceTo(box.max) / 2;
  g.boundingBox = box;
  g.boundingSphere = sphere;
}
