import { BLOCK_IDS, BLOCK_FACE_LAYERS, NON_SHADOW_CASTER_IDS, PLANTS, PLANT_LOOKUP, CUTOUT_LOOKUP, SHAPED_LOOKUP, FENCE_LOOKUP, BLOCK_SHAPES, EMITTER_LOOKUP } from './blockTypes';
import { ChunkSize, blockIndex, blockMapColor, CAVE_Y_MIN } from './chunkGen';

// Returns the climate grass tint (rgb, 0..1) for a LOCAL chunk column (mapped to
// world by the provider). Baked into grass-tinted plant vertices at mesh build.
export type TintGetter = (localX: number, localZ: number) => readonly [number, number, number];

// Pure greedy mesher: turns a chunk's flat block-id array into renderable
// geometry buffers. Deliberately free of THREE.js and the DOM so it can run in
// the Web Worker (where meshing belongs, off the main/render thread) and also
// be reused on the main thread for instant single-block edits.

// Returns the block id at a coordinate that lies OUTSIDE this chunk's horizontal
// bounds (i.e. in a neighbouring chunk). Local coords are passed; the provider
// maps them to world space. Used to cull faces along shared chunk borders.
export type OutsideBlockGetter = (localX: number, y: number, localZ: number) => number;

// QUANTIZED VERTEX FORMAT (16 B/vertex, was 40): Sodium-style compression —
// the dominant cost at high settings was geometry RAM + GPU vertex bandwidth.
//  • positions/uvs: normalized u16, encode q=(v+8)·64 (1/64-block precision,
//    range −8..1015 covers chunk+LOD+megatile local space). Positions decode
//    via the mesh/instance MATRIX (scale 65535/64, offset −8 baked in) so
//    every material — incl. three's built-in shadow depth — decodes for free;
//    uvs decode in our injected shader code.
//  • layers: u16 = textureLayer | faceId<<12. The 3-bit face id replaces the
//    old 12-byte normal attribute entirely (every face we emit is one of the
//    6 axis directions; plants are always 'up' = face 2). The shader looks the
//    normal up in a 6-entry const table.
export const Q_SCALE = 64;          // quantization steps per block
export const Q_OFFSET = 8;          // blocks of negative range
export function quantize(v: number): number {
  const q = ((v + Q_OFFSET) * Q_SCALE + 0.5) | 0;
  return q < 0 ? 0 : q > 65535 ? 65535 : q;
}

export type GeometryArrays = {
  positions: Uint16Array,   // quantized, normalized attr; decoded by the mesh/instance matrix
  uvs: Uint16Array,         // quantized, normalized attr; decoded in-shader
  layers: Uint16Array,      // textureLayer | faceId<<12 (normalized attr, exact u16 round-trip in f32)
  // Uint16 when the group's vertex count fits (the common case for a single
  // heightmap chunk split into casters/non-casters) — half the index VRAM and
  // upload bandwidth vs Uint32 across thousands of streamed chunks. Falls back to
  // Uint32 for a pathological fully-exposed chunk (> 65535 verts).
  indices: Uint16Array | Uint32Array,
  // vec4 per vertex, packed as NORMALIZED Uint8 (4 bytes, shader reads 0..1).
  // Plants: biome tint rgb + wind sway weight (a). Casters/nonCasters: baked biome
  // tint rgb (white where untinted) + a=1, multiplied in blockArrayMaterial.
  colors?: Uint8Array,
};

export type ChunkGeometry = {
  casters: GeometryArrays | null,     // shadow-casting solid blocks
  nonCasters: GeometryArrays | null,  // leaves / clouds
  plants: GeometryArrays | null,      // cross-billboard / carpet / vine foliage
};

// Face order: [+x, -x, +y, -y, +z, -z].
const FACE_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

// Per-id cell class for the greedy sweep's dead-row skipping. 1 = opaque cube
// (greedy-meshed, occludes every neighbour face); 0 = air / plant / cutout /
// shaped / fence (not cube-meshed, and never fully occludes a cube neighbour —
// mirrors faceVisible exactly: for a cube id, the face is visible iff the
// neighbour is NOT cube-class).
const CUBE_CLASS = new Uint8Array(256);
for (let id = 1; id < 256; id++) {
  if (PLANT_LOOKUP[id] !== 1 && CUTOUT_LOOKUP[id] !== 1 && SHAPED_LOOKUP[id] !== 1 && FENCE_LOOKUP[id] !== 1) CUBE_CLASS[id] = 1;
}

type DirMeta = {
  aAxis: number, sign: number,
  pAxis: number, qAxis: number,
  uAxis: number, vAxis: number,
  face: number,   // 0..5 = +x,-x,+y,-y,+z,-z — packed into the layer word (shader normal LUT)
};
// pAxis × qAxis points outward (sign·aAxis) so a fixed winding gives correct
// normals; uAxis/vAxis keep vertical-face textures upright (V follows world-Y).
const DIR_META: ReadonlyArray<DirMeta> = [
  { aAxis: 0, sign: 1,  pAxis: 1, qAxis: 2, uAxis: 2, vAxis: 1, face: 0 },   // +x
  { aAxis: 0, sign: -1, pAxis: 2, qAxis: 1, uAxis: 2, vAxis: 1, face: 1 },   // -x
  { aAxis: 1, sign: 1,  pAxis: 2, qAxis: 0, uAxis: 0, vAxis: 2, face: 2 },   // +y
  { aAxis: 1, sign: -1, pAxis: 0, qAxis: 2, uAxis: 0, vAxis: 2, face: 3 },   // -y
  { aAxis: 2, sign: 1,  pAxis: 0, qAxis: 1, uAxis: 0, vAxis: 1, face: 4 },   // +z
  { aAxis: 2, sign: -1, pAxis: 1, qAxis: 0, uAxis: 0, vAxis: 1, face: 5 },   // -z
];

// `col` (vec4/vertex) is filled for ALL groups now: plants carry tint rgb + sway a;
// casters/nonCasters carry the baked biome tint rgb (white where untinted) + a=1.
// Growable TYPED-array accumulator (was five boxed number[] + a per-element
// finalize re-walk — ~150-200k boxed doubles/chunk of worker-GC churn on the
// now worker-bound streaming pipeline). pos/uv/col stay Float32/clamped scratch
// and finalize applies the SAME quantize/clamp as before, so the emitted
// GeometryArrays are byte-identical (mirrors lodMesh.ts's proven Acc). Verified
// against a golden reference (mesh-parity.mjs).
class Acc {
  pos: Float32Array; uv: Float32Array; layer: Uint16Array; col: Float32Array; idx: Uint32Array;
  v = 0; i = 0;   // vertex / index counts
  constructor(vcap = 2048) {
    this.pos = new Float32Array(vcap * 3);
    this.uv = new Float32Array(vcap * 2);
    this.layer = new Uint16Array(vcap);
    this.col = new Float32Array(vcap * 4);
    this.idx = new Uint32Array(vcap + (vcap >> 1));
  }
  private growVerts() {
    const vcap = (this.layer.length * 2) | 0;
    const g = <T extends Float32Array | Uint16Array>(a: T, n: number): T => {
      const b = new (a.constructor as new (n: number) => T)(n); b.set(a as never); return b;
    };
    this.pos = g(this.pos, vcap * 3);
    this.uv = g(this.uv, vcap * 2);
    this.layer = g(this.layer, vcap);
    this.col = g(this.col, vcap * 4);
  }
  // Append one vertex (caller passes the already-packed layer word + raw 0..1 col).
  vert(x: number, y: number, z: number, u: number, vv: number, packedLayer: number, r: number, g: number, b: number, a: number) {
    if (this.v >= this.layer.length) this.growVerts();
    const p = this.v * 3, t = this.v * 2, c = this.v * 4;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
    this.uv[t] = u; this.uv[t + 1] = vv;
    this.layer[this.v] = packedLayer;
    this.col[c] = r; this.col[c + 1] = g; this.col[c + 2] = b; this.col[c + 3] = a;
    this.v++;
  }
  // The 6 indices of a quad whose first corner is vertex `base` (two CCW triangles).
  quadIdx(base: number) {
    if (this.i + 6 > this.idx.length) {
      const icap = Math.max(this.i + 6, (this.idx.length * 2) | 0);
      const b = new Uint32Array(icap); b.set(this.idx); this.idx = b;
    }
    const k = this.i;
    this.idx[k] = base; this.idx[k + 1] = base + 1; this.idx[k + 2] = base + 2;
    this.idx[k + 3] = base; this.idx[k + 4] = base + 2; this.idx[k + 5] = base + 3;
    this.i += 6;
  }
  finalize(): GeometryArrays | null {
    if (this.i === 0) return null;
    const positions = new Uint16Array(this.v * 3);
    for (let k = 0; k < positions.length; k++) positions[k] = quantize(this.pos[k]);
    const uvs = new Uint16Array(this.v * 2);
    for (let k = 0; k < uvs.length; k++) uvs[k] = quantize(this.uv[k]);
    // pack 0..1 tint/sway into normalized bytes (shader reads them back as 0..1)
    const colors = new Uint8Array(this.v * 4);
    for (let k = 0; k < colors.length; k++) { const cv = this.col[k]; colors[k] = cv < 0 ? 0 : cv > 1 ? 255 : (cv * 255 + 0.5) | 0; }
    return {
      positions,
      uvs,
      layers: this.layer.slice(0, this.v),   // already layer|face<<12
      indices: this.v > 65535 ? this.idx.slice(0, this.i) : Uint16Array.from(this.idx.subarray(0, this.i)),
      colors,
    };
  }
}

// Append one plant vertex (explicit world-local position + tint + sway). Plants
// carry face id 2 ('up') so a billboard is lit evenly like the ground it grows
// from (no dark-side flicker as you orbit it).
function pushPlantVert(acc: Acc, x: number, y: number, z: number, u: number, v: number,
  layer: number, r: number, g: number, b: number, sway: number) {
  acc.vert(x, y, z, u, v, layer | (2 << 12), r, g, b, sway);
}

// Append one vertex to `acc` from a quad corner, WITHOUT allocating (the old
// emitQuad built a `corners` array + a `vert[3]` per corner — thousands of
// short-lived arrays per chunk mesh). aAxis/pAxis/qAxis are a permutation of
// {0,1,2}, so each of aCoord/pc/qc maps to exactly one of x/y/z. Module-scope so
// no closure is allocated per quad either.
function pushVert(acc: Acc, meta: DirMeta, aCoord: number, pc: number, qc: number, layer: number,
  r = 1, g = 1, b = 1, emis = 0) {
  let x = 0, y = 0, z = 0;
  switch (meta.aAxis) { case 0: x = aCoord; break; case 1: y = aCoord; break; default: z = aCoord; }
  switch (meta.pAxis) { case 0: x = pc; break; case 1: y = pc; break; default: z = pc; }
  switch (meta.qAxis) { case 0: x = qc; break; case 1: y = qc; break; default: z = qc; }
  // +0.5 aligns texture tile boundaries to block edges; the shader fract()s this
  // so merged quads tile the texture once per block.
  const u = (meta.uAxis === 0 ? x : meta.uAxis === 1 ? y : z) + 0.5;
  const vv = (meta.vAxis === 0 ? x : meta.vAxis === 1 ? y : z) + 0.5;
  // rgb = biome tint (white = untinted); a = emissive amount (0 = none)
  acc.vert(x, y, z, u, vv, layer | (meta.face << 12), r, g, b, emis);
}

export function buildChunkGeometry(data: Uint8Array, size: ChunkSize, getOutside: OutsideBlockGetter,
  getTint?: TintGetter): ChunkGeometry {
  const W = size.width, H = size.height;
  const dim = [W, H, W];
  const casters = new Acc();
  const nonCasters = new Acc();
  const plants = new Acc();

  // Climate grass/foliage tint per LOCAL column (cached). Baked into BOTH the
  // plant pass AND tinted cube faces (grass-block tops + the biome-varying leaf
  // species) so the same species greens/olives by biome (MC-style).
  const WHITE: readonly [number, number, number] = [1, 1, 1];
  const FALLBACK: readonly [number, number, number] = [0.45, 0.62, 0.32];
  const tintCache = new Map<number, readonly [number, number, number]>();
  const grassTintAt = (lx: number, lz: number): readonly [number, number, number] => {
    if (!getTint) return FALLBACK;
    const key = lx * W + lz;
    let t = tintCache.get(key);
    if (!t) { t = getTint(lx, lz); tintCache.set(key, t); }
    return t;
  };
  const tintFor = (lx: number, lz: number, mode: 'grass' | 'none') =>
    mode === 'grass' ? grassTintAt(lx, lz) : WHITE;
  // Faces that take the biome tint: the 5 biome-varying leaf species (every face)
  // and the grass block TOP (+y, dir 2). Birch/spruce/cherry leaves are fixed-colour.
  const TINTED_LEAF = new Uint8Array(256);
  for (const id of [BLOCK_IDS.leaves, BLOCK_IDS.jungleLeaves, BLOCK_IDS.acaciaLeaves, BLOCK_IDS.darkOakLeaves, BLOCK_IDS.mangroveLeaves]) TINTED_LEAF[id] = 1;
  const faceTinted = (id: number, dir: number): boolean => TINTED_LEAF[id] === 1 || (id === BLOCK_IDS.grass && dir === 2);
  // quantize a tint to a 12-bit bucket so greedy-merge only fuses equal-tint cells
  const tintBucket = (t: readonly [number, number, number]) =>
    (((t[0] * 15 + 0.5) | 0) << 8) | (((t[1] * 15 + 0.5) | 0) << 4) | ((t[2] * 15 + 0.5) | 0);

  const idAt = (x: number, y: number, z: number) =>
    data[blockIndex(x, y, z, size)];

  // ox/oy/oz are the face offset for `dir`, hoisted by the caller (constant
  // across the per-cell loops) so it isn't re-read from FACE_OFFSETS per cell.
  // Plants (cross billboards / carpets / vines) are NON-OCCLUDING: a face behind
  // a grass tuft must still render, so an in-chunk plant neighbour counts as air.
  // A face of block `id` is drawn unless the neighbour OCCLUDES it: air & plants
  // never occlude; glass (cutout) occludes ONLY other glass (so a glass-glass seam
  // culls but solids stay visible THROUGH glass); opaque solids occlude everything.
  const faceVisible = (id: number, x: number, y: number, z: number, ox: number, oy: number, oz: number): boolean => {
    const nx = x + ox, ny = y + oy, nz = z + oz;
    if (ny < 0) return false;          // bedrock floor
    if (ny >= H) return true;          // open sky
    const nid = (nx >= 0 && nx < W && nz >= 0 && nz < W) ? idAt(nx, ny, nz) : getOutside(nx, ny, nz); // apron = stone/air
    if (nid === BLOCK_IDS.air) return true;
    // plants & PARTIAL blocks (slabs/stairs/fences) never fully cover a face
    if (PLANT_LOOKUP[nid] === 1 || SHAPED_LOOKUP[nid] === 1 || FENCE_LOOKUP[nid] === 1) return true;
    if (CUTOUT_LOOKUP[nid] === 1) return CUTOUT_LOOKUP[id] === 0; // glass hides glass; solids show through it
    return false;                       // opaque solid neighbour
  };

  const emitQuad = (dir: number, la: number, p0: number, p1: number, q0: number, q1: number, id: number) => {
    const faces = BLOCK_FACE_LAYERS[id];
    if (!faces) return; // unmapped/tampered block id — skip rather than crash the (main-thread) remesh
    const meta = DIR_META[dir];
    const acc = NON_SHADOW_CASTER_IDS.has(id) ? nonCasters : casters;
    const layer = faces[dir];

    // biome tint for tinted faces (grass tops / biome-varying leaves), else white.
    // Sample at the quad's ORIGIN column — the tintMask guaranteed every merged
    // cell shares the same quantized tint, so the origin is representative.
    let r = 1, g = 1, b = 1;
    if (faceTinted(id, dir)) {
      let cx = 0, cz = 0;
      if (meta.aAxis === 0) cx = la; else if (meta.aAxis === 2) cz = la;
      if (meta.pAxis === 0) cx = p0; else if (meta.pAxis === 2) cz = p0;
      if (meta.qAxis === 0) cx = q0; else if (meta.qAxis === 2) cz = q0;
      const t = grassTintAt(cx, cz); r = t[0]; g = t[1]; b = t[2];
    }
    const emis = EMITTER_LOOKUP[id];   // 1 → block glows its own texture (glowstone/sea-lantern/magma)

    const aCoord = la + meta.sign * 0.5;
    const pLo = p0 - 0.5, pHi = p1 - 0.5;
    const qLo = q0 - 0.5, qHi = q1 - 0.5;
    const base = acc.v;
    pushVert(acc, meta, aCoord, pLo, qLo, layer, r, g, b, emis);
    pushVert(acc, meta, aCoord, pHi, qLo, layer, r, g, b, emis);
    pushVert(acc, meta, aCoord, pHi, qHi, layer, r, g, b, emis);
    pushVert(acc, meta, aCoord, pLo, qHi, layer, r, g, b, emis);
    acc.quadIdx(base);
  };

  // Vertical band where exposed faces can exist. Above the surface is all-air and
  // the deep column is all-solid EXCEPT the caves carved into it, so we mesh only
  // [bandLow, bandHigh] to skip the bulk of the 320-tall column. bandHigh tracks
  // the surface; bandLow drops to (a) the lowest surface among neighbours (edge
  // walls toward lower/unloaded chunks) AND (b) the deepest exposed cave air — a
  // cave below bandLow would otherwise emit ZERO geometry (invisible terrain you
  // fall through). See the deepest-air scan below.
  let chunkMinTop = H - 1, chunkMaxTop = 0;
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < W; z++) {
      let top = 0;
      // Ignore plants (they sit above the surface) so the cube band tracks only
      // terrain/trees — plants get their own pass with their own y-range.
      // Incremental flat index (cell (x,y,z) = (x*H+y)*W+z, so −W per y step)
      // instead of a blockIndex() call per cell — this scan touches every cell.
      let di = (x * H + H - 1) * W + z;
      for (let y = H - 1; y >= 0; y--, di -= W) { const id = data[di]; if (id !== BLOCK_IDS.air && PLANT_LOOKUP[id] === 0) { top = y; break; } }
      if (top > chunkMaxTop) chunkMaxTop = top;
      if (top < chunkMinTop) chunkMinTop = top;
    }
  }
  const scanNeighbourTop = (lx: number, lz: number) => {
    for (let y = H - 1; y >= 0; y--) if (getOutside(lx, y, lz) !== BLOCK_IDS.air) return y;
    return -1; // unknown / all-air neighbour -> edge wall is fully exposed
  };
  let bandLow = chunkMinTop;
  for (let i = 0; i < W; i++) {
    bandLow = Math.min(bandLow, scanNeighbourTop(-1, i), scanNeighbourTop(W, i), scanNeighbourTop(i, -1), scanNeighbourTop(i, W));
  }
  // Deepest exposed CAVE air, so the band reaches the cave floors/walls. Scan the
  // INTERIOR (cheap idAt array reads) first — that lowers `deepestAir`, which then
  // bounds the BORDER apron scan (getOutside mirrors caves) to only the few levels
  // below it, so a neighbour cave deeper than any of ours is still sealed without a
  // full-column noise scan. Bottom-up, breaking at the first air = the column's
  // lowest air. CAVE_Y_MIN is the floor (bedrock below is never carved).
  let deepestAir = bandLow;
  for (let x = 0; x < W; x++) for (let z = 0; z < W; z++) {
    let di = (x * H + CAVE_Y_MIN) * W + z;
    for (let y = CAVE_Y_MIN; y < deepestAir; y++, di += W) if (data[di] === BLOCK_IDS.air) { deepestAir = y; break; }
  }
  for (let i = 0; i < W; i++) {
    for (let y = CAVE_Y_MIN; y < deepestAir; y++) if (getOutside(-1, y, i) === BLOCK_IDS.air) { deepestAir = y; break; }
    for (let y = CAVE_Y_MIN; y < deepestAir; y++) if (getOutside(W, y, i) === BLOCK_IDS.air) { deepestAir = y; break; }
    for (let y = CAVE_Y_MIN; y < deepestAir; y++) if (getOutside(i, y, -1) === BLOCK_IDS.air) { deepestAir = y; break; }
    for (let y = CAVE_Y_MIN; y < deepestAir; y++) if (getOutside(i, y, W) === BLOCK_IDS.air) { deepestAir = y; break; }
  }
  bandLow = Math.max(0, Math.min(bandLow, deepestAir) - 1);
  const bandHigh = chunkMaxTop;

  // Per-Y occupancy (one linear pass over the band): a mask ROW at level y, for
  // any direction whose neighbour is IN-CHUNK at the same y (±x/±z interior
  // slices), can only hold a visible face if that level has BOTH a cube cell
  // (the face's owner) AND a non-cube cell (the only thing that exposes a cube
  // face). With caves pulling bandLow to ~6, the underground bulk of the
  // 320-tall column is solid rows that fail this test — the greedy sweep below
  // memsets them instead of running idAt+faceVisible per cell. occSpec feeds
  // the plant pass the same way (levels with no plant/shaped/fence/cutout cell
  // are skipped outright). Only provably-empty regions are skipped → output
  // stays byte-identical (mesh-parity.mjs / bench-gen.mjs --compare).
  const occLo = Math.max(0, bandLow - 1);
  const occHi = Math.min(H - 1, bandHigh + 5);
  const occCube = new Uint8Array(H), occNonOcc = new Uint8Array(H), occSpec = new Uint8Array(H);
  for (let x = 0; x < W; x++) {
    let di = (x * H + occLo) * W;
    for (let y = occLo; y <= occHi; y++, di += W) {
      let cube = 0, non = 0, spec = 0;
      for (let z = 0; z < W; z++) {
        const id = data[di + z];
        if (CUBE_CLASS[id] === 1) cube = 1;
        else { non = 1; if (id !== BLOCK_IDS.air) spec = 1; }
      }
      if (cube) occCube[y] = 1;
      if (non) occNonOcc[y] = 1;
      if (spec) occSpec[y] = 1;
    }
  }
  const liveY = new Uint8Array(H);
  for (let y = occLo; y <= occHi; y++) liveY[y] = occCube[y] & occNonOcc[y];

  for (let dir = 0; dir < 6; dir++) {
    const meta = DIR_META[dir];
    const [ox, oy, oz] = FACE_OFFSETS[dir];   // hoisted: constant across the cell loops
    const dimA = dim[meta.aAxis], dimP = dim[meta.pAxis], dimQ = dim[meta.qAxis];
    const mask = new Int32Array(dimP * dimQ);
    const tintMask = new Int32Array(dimP * dimQ);   // per-cell quantized tint (-1 = untinted) so merge only fuses equal tints
    const cell = [0, 0, 0];

    // Restrict whichever axis is vertical (Y, index 1) to the band.
    const aStart = meta.aAxis === 1 ? bandLow : 0, aEnd = meta.aAxis === 1 ? bandHigh + 1 : dimA;
    const pStart = meta.pAxis === 1 ? bandLow : 0, pEnd = meta.pAxis === 1 ? bandHigh + 1 : dimP;
    const qStart = meta.qAxis === 1 ? bandLow : 0, qEnd = meta.qAxis === 1 ? bandHigh + 1 : dimQ;
    // The one slice per horizontal direction whose neighbours are OUTSIDE the
    // chunk (apron) — occupancy says nothing about the apron, so it never skips.
    const outsideLa = meta.aAxis === 1 ? -1 : (meta.sign > 0 ? dimA - 1 : 0);
    const vertIsP = meta.pAxis === 1, vertIsQ = meta.qAxis === 1;

    for (let la = aStart; la < aEnd; la++) {
      if (meta.aAxis === 1) {
        // ±y: the whole slice needs a cube at la and a non-cube at la±1 (or sky).
        const ny = la + meta.sign;
        const live = occCube[la] === 1 && (ny >= H || (ny >= 0 && occNonOcc[ny] === 1));
        if (!live) continue;   // skipped slices never reach the merge, so the stale mask is never read
      }
      const allowSkip = la !== outsideLa;
      for (let p = pStart; p < pEnd; p++) {
        const row = p * dimQ;
        if (vertIsP && allowSkip && liveY[p] !== 1) { mask.fill(0, row + qStart, row + qEnd); continue; }
        for (let q = qStart; q < qEnd; q++) {
          if (vertIsQ && allowSkip && liveY[q] !== 1) { mask[row + q] = 0; continue; }
          cell[meta.aAxis] = la; cell[meta.pAxis] = p; cell[meta.qAxis] = q;
          const id = idAt(cell[0], cell[1], cell[2]);
          // Plants, cutout (glass) and shaped/fence blocks aren't greedy cube-meshed
          // (the plant pass emits them); only full opaque cubes are greedy-merged.
          const vis = id !== BLOCK_IDS.air && PLANT_LOOKUP[id] === 0 && CUTOUT_LOOKUP[id] === 0
            && SHAPED_LOOKUP[id] === 0 && FENCE_LOOKUP[id] === 0
            && faceVisible(id, cell[0], cell[1], cell[2], ox, oy, oz);
          mask[row + q] = vis ? id + 1 : 0;
          tintMask[row + q] = vis && faceTinted(id, dir) ? tintBucket(grassTintAt(cell[0], cell[2])) : -1;
        }
      }

      for (let p = pStart; p < pEnd; p++) {
        let q = qStart;
        while (q < qEnd) {
          const m = mask[p * dimQ + q];
          if (m === 0) { q++; continue; }
          const tm = tintMask[p * dimQ + q];

          let w = 1;
          while (q + w < qEnd && mask[p * dimQ + q + w] === m && tintMask[p * dimQ + q + w] === tm) w++;

          let h = 1;
          let grow = true;
          while (p + h < pEnd && grow) {
            for (let k = 0; k < w; k++) {
              if (mask[(p + h) * dimQ + q + k] !== m || tintMask[(p + h) * dimQ + q + k] !== tm) { grow = false; break; }
            }
            if (grow) h++;
          }

          emitQuad(dir, la, p, p + h, q, q + w, m - 1);

          for (let dp = 0; dp < h; dp++) {
            for (let dq = 0; dq < w; dq++) mask[(p + dp) * dimQ + q + dq] = 0;
          }
          q += w;
        }
      }
    }
  }

  // ===== PLANT PASS =========================================================
  // Plants sit above the terrain surface; scan a tight band around it. Crosses
  // (grass/flowers/fern/dead bush), vines and lily pads are emitted per-cell;
  // carpets (petals/litter/snow) are greedy-merged per (y, blockId) into sheets.
  // A vine clings to any non-air, non-plant cell (terrain / trunk / cliff).
  const solidAt = (x: number, y: number, z: number): boolean => {
    if (y < 0) return true;
    if (y >= H) return false;
    const id = (x >= 0 && x < W && z >= 0 && z < W) ? idAt(x, y, z) : getOutside(x, y, z);
    return id !== BLOCK_IDS.air && PLANT_LOOKUP[id] === 0;
  };

  const INSET = 0.12;   // keep a cross inside its cell so it never overlaps a neighbour
  // swLo/swHi = wind sway weight at the cell's base/top; for a 2-block plant the
  // lower cell is 0..0.5 and the upper 0.5..1 so the stacked plant bends as one.
  const emitCross = (x: number, y: number, z: number, layer: number, r: number, g: number, b: number, swLo: number, swHi: number) => {
    const yB = y - 0.5, yT = y + 0.5, lo = -0.5 + INSET, hi = 0.5 - INSET;
    const quad = (ax: number, az: number, bx: number, bz: number) => {
      const base = plants.v;
      pushPlantVert(plants, x + ax, yB, z + az, 0, 0, layer, r, g, b, swLo);
      pushPlantVert(plants, x + bx, yB, z + bz, 1, 0, layer, r, g, b, swLo);
      pushPlantVert(plants, x + bx, yT, z + bz, 1, 1, layer, r, g, b, swHi);
      pushPlantVert(plants, x + ax, yT, z + az, 0, 1, layer, r, g, b, swHi);
      plants.quadIdx(base);
    };
    quad(lo, lo, hi, hi);   // main diagonal
    quad(lo, hi, hi, lo);   // anti-diagonal
  };

  // Flat horizontal quad over cells [x0..x1]×[z0..z1] at world-Y yTop. The UV
  // counts (nu/nv) tile the texture once per cell (fract() in the shader).
  const emitFlat = (x0: number, x1: number, z0: number, z1: number, yTop: number, layer: number,
    r: number, g: number, b: number) => {
    const xLo = x0 - 0.5, xHi = x1 + 0.5, zLo = z0 - 0.5, zHi = z1 + 0.5;
    const nu = x1 - x0 + 1, nv = z1 - z0 + 1;
    const base = plants.v;
    pushPlantVert(plants, xLo, yTop, zLo, 0, 0, layer, r, g, b, 0);
    pushPlantVert(plants, xHi, yTop, zLo, nu, 0, layer, r, g, b, 0);
    pushPlantVert(plants, xHi, yTop, zHi, nu, nv, layer, r, g, b, 0);
    pushPlantVert(plants, xLo, yTop, zHi, 0, nv, layer, r, g, b, 0);
    plants.quadIdx(base);
  };

  // Vine quad flush against each horizontal face that has a solid backing.
  const emitVine = (x: number, y: number, z: number, layer: number, r: number, g: number, b: number) => {
    const yB = y - 0.5, yT = y + 0.5, e = 0.02;
    const faces: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of faces) {
      if (!solidAt(x + dx, y, z + dz)) continue;
      const base = plants.v;
      if (dx !== 0) {
        const px = x + dx * (0.5 - e);
        pushPlantVert(plants, px, yB, z - 0.5, 0, 0, layer, r, g, b, 0.5);
        pushPlantVert(plants, px, yB, z + 0.5, 1, 0, layer, r, g, b, 0.5);
        pushPlantVert(plants, px, yT, z + 0.5, 1, 1, layer, r, g, b, 0.15);
        pushPlantVert(plants, px, yT, z - 0.5, 0, 1, layer, r, g, b, 0.15);
      } else {
        const pz = z + dz * (0.5 - e);
        pushPlantVert(plants, x - 0.5, yB, pz, 0, 0, layer, r, g, b, 0.5);
        pushPlantVert(plants, x + 0.5, yB, pz, 1, 0, layer, r, g, b, 0.5);
        pushPlantVert(plants, x + 0.5, yT, pz, 1, 1, layer, r, g, b, 0.15);
        pushPlantVert(plants, x - 0.5, yT, pz, 0, 1, layer, r, g, b, 0.15);
      }
      plants.quadIdx(base);
    }
  };

  // Thin SLAB (snow layers): a top quad + short side walls (culled where a same-id
  // slab abuts at the SAME y → flush sheet; exposed → a visible step). Emitted into
  // the CASTERS group with CORRECT per-face normals (via DIR_META/pushVert, exactly
  // like a cube face) — NOT the plant material, whose forced up-normal made the side
  // walls shade view-dependently (they visibly shifted hue as the camera moved while
  // the snow BLOCK stayed stable). Now the sheet shades identically to a snow block.
  const emitSlabFace = (bnd: [number, number][], d: number, layer: number) => {
    const meta = DIR_META[d];
    const aCoord = meta.sign > 0 ? bnd[meta.aAxis][1] : bnd[meta.aAxis][0];
    const p0 = bnd[meta.pAxis][0], p1 = bnd[meta.pAxis][1], q0 = bnd[meta.qAxis][0], q1 = bnd[meta.qAxis][1];
    const base = casters.v;
    pushVert(casters, meta, aCoord, p0, q0, layer, 1, 1, 1, 0);
    pushVert(casters, meta, aCoord, p1, q0, layer, 1, 1, 1, 0);
    pushVert(casters, meta, aCoord, p1, q1, layer, 1, 1, 1, 0);
    pushVert(casters, meta, aCoord, p0, q1, layer, 1, 1, 1, 0);
    casters.quadIdx(base);
  };
  const emitSlab = (x: number, y: number, z: number, id: number, layer: number, off: number) => {
    const bnd: [number, number][] = [[x - 0.5, x + 0.5], [y - 0.5, y - 0.5 + off], [z - 0.5, z + 0.5]];
    emitSlabFace(bnd, 2, layer);   // top (+y) — always visible
    // sides (+x,-x,+z,-z = DIR_META 0,1,4,5) — only where the neighbour isn't a flush
    // same-id slab at the same y; the bottom (-y) sits on the block below, so skip it.
    for (const [d, dx, dz] of [[0, 1, 0], [1, -1, 0], [4, 0, 1], [5, 0, -1]] as const) {
      const nx = x + dx, nz = z + dz;
      if (nx >= 0 && nx < W && nz >= 0 && nz < W && idAt(nx, y, nz) === id) continue; // flush with neighbour
      emitSlabFace(bnd, d, layer);
    }
  };

  // Glass etc.: a SOLID cube rendered see-through via the alpha-tested plant
  // material. Emits each cube face that faceVisible() exposes (glass-glass culls).
  const emitCutoutCube = (x: number, y: number, z: number, id: number, layer: number) => {
    const x0 = x - 0.5, x1 = x + 0.5, y0 = y - 0.5, y1 = y + 0.5, z0 = z - 0.5, z1 = z + 0.5;
    const quad = (ax: number, ay: number, az: number, bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number, dx: number, dy: number, dz: number) => {
      const base = plants.v;
      pushPlantVert(plants, ax, ay, az, 0, 0, layer, 1, 1, 1, 0);
      pushPlantVert(plants, bx, by, bz, 1, 0, layer, 1, 1, 1, 0);
      pushPlantVert(plants, cx, cy, cz, 1, 1, layer, 1, 1, 1, 0);
      pushPlantVert(plants, dx, dy, dz, 0, 1, layer, 1, 1, 1, 0);
      plants.quadIdx(base);
    };
    if (faceVisible(id, x, y, z, 1, 0, 0)) quad(x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0);
    if (faceVisible(id, x, y, z, -1, 0, 0)) quad(x0, y0, z1, x0, y0, z0, x0, y1, z0, x0, y1, z1);
    if (faceVisible(id, x, y, z, 0, 1, 0)) quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1);
    if (faceVisible(id, x, y, z, 0, -1, 0)) quad(x0, y0, z1, x1, y0, z1, x1, y0, z0, x0, y0, z0);
    if (faceVisible(id, x, y, z, 0, 0, 1)) quad(x1, y0, z1, x0, y0, z1, x0, y1, z1, x1, y1, z1);
    if (faceVisible(id, x, y, z, 0, 0, -1)) quad(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0);
  };

  // Shaped solids (slabs/stairs/doors/trapdoors): emit their AABB box(es) as
  // geometry into the CASTERS group (opaque, shadow-casting). World-coord UVs via
  // DIR_META so partial-box textures align to the block grid (MC-style).
  const emitBoxWorld = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, faces: readonly number[], emis = 0) => {
    const bnd: [number, number][] = [[x0, x1], [y0, y1], [z0, z1]];
    for (let d = 0; d < 6; d++) {
      const meta = DIR_META[d];
      const aCoord = meta.sign > 0 ? bnd[meta.aAxis][1] : bnd[meta.aAxis][0];
      const p0 = bnd[meta.pAxis][0], p1 = bnd[meta.pAxis][1], q0 = bnd[meta.qAxis][0], q1 = bnd[meta.qAxis][1];
      const base = casters.v;
      pushVert(casters, meta, aCoord, p0, q0, faces[d], 1, 1, 1, emis);
      pushVert(casters, meta, aCoord, p1, q0, faces[d], 1, 1, 1, emis);
      pushVert(casters, meta, aCoord, p1, q1, faces[d], 1, 1, 1, emis);
      pushVert(casters, meta, aCoord, p0, q1, faces[d], 1, 1, 1, emis);
      casters.quadIdx(base);
    }
  };
  const emitSolidBox = (x: number, y: number, z: number, id: number) => {
    const faces = BLOCK_FACE_LAYERS[id];
    if (!faces) return;
    const emis = EMITTER_LOOKUP[id];   // torch glows
    for (const s of BLOCK_SHAPES[id]) {
      emitBoxWorld(x - 0.5 + s[0], y - 0.5 + s[1], z - 0.5 + s[2], x - 0.5 + s[3], y - 0.5 + s[4], z - 0.5 + s[5], faces, emis);
    }
  };
  // Fence: a centre post + 2 rails reaching toward each connectable neighbour.
  const fenceSolid = (fx: number, fy: number, fz: number): boolean => {
    if (fy < 0) return true; if (fy >= H) return false;
    const nid = (fx >= 0 && fx < W && fz >= 0 && fz < W) ? idAt(fx, fy, fz) : getOutside(fx, fy, fz);
    return nid !== BLOCK_IDS.air && PLANT_LOOKUP[nid] === 0;
  };
  const emitFence = (x: number, y: number, z: number, id: number) => {
    const faces = BLOCK_FACE_LAYERS[id];
    if (!faces) return;
    const cx0 = x - 0.5, cy0 = y - 0.5, cz0 = z - 0.5;
    emitBoxWorld(cx0 + 0.375, cy0, cz0 + 0.375, cx0 + 0.625, cy0 + 1, cz0 + 0.625, faces);   // post
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (!fenceSolid(x + dx, y, z + dz)) continue;
      for (const [ry0, ry1] of [[0.30, 0.46], [0.70, 0.86]] as const) {
        if (dx !== 0) {
          const a = dx > 0 ? cx0 + 0.625 : cx0, b = dx > 0 ? cx0 + 1 : cx0 + 0.375;
          emitBoxWorld(Math.min(a, b), cy0 + ry0, cz0 + 0.4375, Math.max(a, b), cy0 + ry1, cz0 + 0.5625, faces);
        } else {
          const a = dz > 0 ? cz0 + 0.625 : cz0, b = dz > 0 ? cz0 + 1 : cz0 + 0.375;
          emitBoxWorld(cx0 + 0.4375, cy0 + ry0, Math.min(a, b), cx0 + 0.5625, cy0 + ry1, Math.max(a, b), faces);
        }
      }
    }
  };

  // Cover every plant: surface tufts (top+1/+2), carpets, lily pads at sea, seabed
  // seagrass, AND vines that hang BELOW the canopy (so this must reach down past
  // bandLow, not stop at the surface). Bounded by chunk relief, so it's cheap.
  const plantLo = Math.max(0, bandLow - 1);
  const plantHi = Math.min(H - 1, bandHigh + 5);
  const carpetByY = new Map<number, Uint8Array>();   // per y-level carpet masks (keyed by block id)
  for (let y = plantLo; y <= plantHi; y++) {
    if (occSpec[y] !== 1) continue;   // no plant/cutout/shaped/fence cell anywhere at this level
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < W; z++) {
        const id = idAt(x, y, z);
        if (CUTOUT_LOOKUP[id] === 1) { emitCutoutCube(x, y, z, id, BLOCK_FACE_LAYERS[id][0]); continue; }
        if (SHAPED_LOOKUP[id] === 1) { emitSolidBox(x, y, z, id); continue; }
        if (FENCE_LOOKUP[id] === 1) { emitFence(x, y, z, id); continue; }
        if (PLANT_LOOKUP[id] === 0) continue;
        const def = PLANTS[id];
        if (def.kind === 'carpet') {
          let m = carpetByY.get(y);
          if (!m) { m = new Uint8Array(W * W); carpetByY.set(y, m); }
          m[x * W + z] = id;
          continue;
        }
        const [r, g, b] = tintFor(x, z, def.tint);
        if (def.kind === 'cross') emitCross(x, y, z, def.layer, r, g, b, def.swayLo ?? 0, def.swayHi ?? 1);
        else if (def.kind === 'slab') emitSlab(x, y, z, id, def.layer, def.off);
        else if (def.kind === 'pad') emitFlat(x, x, z, z, y - 0.5 + def.off, def.layer, r, g, b);
        else if (def.kind === 'vine') emitVine(x, y, z, def.layer, r, g, b);
      }
    }
  }
  // Greedy-merge each carpet/snow y-level (carpets are untinted, so cells with
  // the same block id merge freely) — a snowfield collapses to a few quads.
  for (const [y, m] of carpetByY) {
    for (let x = 0; x < W; x++) {
      let z = 0;
      while (z < W) {
        const id = m[x * W + z];
        if (id === 0) { z++; continue; }
        let w = 1;
        while (z + w < W && m[x * W + z + w] === id) w++;
        let h = 1, grow = true;
        while (x + h < W && grow) {
          for (let k = 0; k < w; k++) { if (m[(x + h) * W + z + k] !== id) { grow = false; break; } }
          if (grow) h++;
        }
        const def = PLANTS[id];
        emitFlat(x, x + h - 1, z, z + w - 1, y - 0.5 + def.off, def.layer, 1, 1, 1);
        for (let dx = 0; dx < h; dx++) for (let dz = 0; dz < w; dz++) m[(x + dx) * W + z + dz] = 0;
        z += w;
      }
    }
  }

  return { casters: casters.finalize(), nonCasters: nonCasters.finalize(), plants: plants.finalize() };
}

// ===========================================================================
//  PER-CHUNK MINIMAP TILE  (DOM-free, shared by the chunk worker AND the local
//  edit re-mesh path). Produces a W×W RGBA tile from the REAL generated/edited
//  block data — the same source the world renders — so the minimap is always in
//  sync with zero extra generation: it just blits these cached chunk tiles.
//  Pixel (col = local x, row = local z) → world (worldX + x, worldZ + z).
//  This replaces the old map-worker round-trip for the close-in "detailed view".
// ---------------------------------------------------------------------------
export type WaterHexGetter = (localX: number, localZ: number) => number;
const DEFAULT_WATER_HEX = 0x2f6aa6;

// Top-down shade: darken submerged columns with depth, lighten highlands, and a
// cheap N–S slope term so relief reads. Mirrors the map worker's `shade`.
function tileShade(height: number, slope: number, sea: number, r: number, g: number, b: number, out: Uint8Array, di: number) {
  if (height < sea) { const f = 1 - 0.45 * Math.min(Math.max((sea - height) / 40, 0), 1); r *= f; g *= f; b *= f; }
  // Hypsometric brightness scaled to the POST-OROGENY world (peaks ~+170, not
  // +80): 0.84 at sea → 1.30 on the summits, so elevation reads at a glance.
  else { const f = 0.84 + Math.min(Math.max((height - sea) / 170, 0), 1) * 0.46; r *= f; g *= f; b *= f; }
  // Hillshade strengthened to match (steeper ranges deserve real relief shading).
  const sh = Math.min(Math.max(1 + slope * 0.12, 0.45), 1.6);
  out[di] = Math.min(r * sh, 255); out[di + 1] = Math.min(g * sh, 255); out[di + 2] = Math.min(b * sh, 255); out[di + 3] = 255;
}

export function buildChunkMapTile(data: Uint8Array, size: ChunkSize, sea: number,
  grassTintAt?: TintGetter, waterHexAt?: WaterHexGetter): Uint8Array {
  const W = size.width, H = size.height;
  const out = new Uint8Array(W * W * 4);
  // First pass: resolve top non-plant block id + its height for every column.
  // Full top-down scan — a heightmap-bounded start was tried but the terrain
  // heightmap excludes above-surface solids (frozen-water ice, ice spikes, snow
  // layers, structures), so bounding the scan dropped them from the map. The scan
  // is not the map's bottleneck (columnSurface noise dominates) so it stays full.
  const topIds = new Int32Array(W * W), topYs = new Int16Array(W * W);
  for (let lz = 0; lz < W; lz++) {
    for (let lx = 0; lx < W; lx++) {
      let topY = 0, topId = 0;
      let di = (lx * H + H - 1) * W + lz;   // incremental flat index (−W per y step)
      for (let y = H - 1; y >= 0; y--, di -= W) {
        const id = data[di];
        if (id !== BLOCK_IDS.air && PLANT_LOOKUP[id] === 0) { topY = y; topId = id; break; }
      }
      topIds[lz * W + lx] = topId; topYs[lz * W + lx] = topY;
    }
  }
  // Second pass: colour + hillshade (north neighbour within the chunk; clamp at edge).
  for (let lz = 0; lz < W; lz++) {
    for (let lx = 0; lx < W; lx++) {
      const o = lz * W + lx, di = o * 4, id = topIds[o], y = topYs[o];
      let r: number, g: number, b: number;
      if (y < sea) {                                  // submerged → water hue + depth shade
        const hex = waterHexAt ? waterHexAt(lx, lz) : DEFAULT_WATER_HEX;
        r = (hex >> 16) & 255; g = (hex >> 8) & 255; b = hex & 255;
      } else if (id === BLOCK_IDS.grass && grassTintAt) {
        const t = grassTintAt(lx, lz); r = t[0] * 255; g = t[1] * 255; b = t[2] * 255;
      } else {
        const mc = blockMapColor(id); r = mc[0]; g = mc[1]; b = mc[2];
      }
      // NW light (classic cartographic): combine the north + west gradients.
      const north = topYs[(lz > 0 ? lz - 1 : lz) * W + lx];
      const west = topYs[lz * W + (lx > 0 ? lx - 1 : lx)];
      tileShade(y, ((y - north) + (y - west)) * 0.6, sea, r, g, b, out, di);
    }
  }
  return out;
}

// Scan a chunk's blocks for light-emitter cells, returning WORLD positions packed
// as [wx, wy, wz, id, …] (Float32). Used by the worker (per generated chunk) and
// the local edit-remesh path so a pool of point lights can snap to nearby emitters.
// Off-thread in the worker / edit-time only on the main thread → fine to scan all.
export function scanEmitters(data: Uint8Array, size: ChunkSize, worldX: number, worldZ: number): Float32Array {
  const W = size.width, H = size.height;
  const out: number[] = [];
  for (let lx = 0; lx < W; lx++) {
    for (let lz = 0; lz < W; lz++) {
      let di = lx * H * W + lz;   // incremental flat index (+W per y) — same scan order, no per-cell index math
      for (let y = 0; y < H; y++, di += W) {
        const id = data[di];
        if (id !== BLOCK_IDS.air && EMITTER_LOOKUP[id] === 1) out.push(worldX + lx, y, worldZ + lz, id);
      }
    }
  }
  return new Float32Array(out);
}
