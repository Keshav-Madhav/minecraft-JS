import { BLOCK_IDS, BLOCK_FACE_LAYERS, NON_SHADOW_CASTER_IDS, PLANTS, PLANT_LOOKUP, CUTOUT_LOOKUP, SHAPED_LOOKUP, FENCE_LOOKUP, BLOCK_SHAPES, EMITTER_LOOKUP } from './blockTypes';
import { ChunkSize, blockIndex, blockMapColor } from './chunkGen';

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

export type GeometryArrays = {
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  layers: Float32Array,
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

type DirMeta = {
  aAxis: number, sign: number,
  pAxis: number, qAxis: number,
  uAxis: number, vAxis: number,
  normal: readonly [number, number, number],
};
// pAxis × qAxis points outward (sign·aAxis) so a fixed winding gives correct
// normals; uAxis/vAxis keep vertical-face textures upright (V follows world-Y).
const DIR_META: ReadonlyArray<DirMeta> = [
  { aAxis: 0, sign: 1,  pAxis: 1, qAxis: 2, uAxis: 2, vAxis: 1, normal: [1, 0, 0] },   // +x
  { aAxis: 0, sign: -1, pAxis: 2, qAxis: 1, uAxis: 2, vAxis: 1, normal: [-1, 0, 0] },  // -x
  { aAxis: 1, sign: 1,  pAxis: 2, qAxis: 0, uAxis: 0, vAxis: 2, normal: [0, 1, 0] },   // +y
  { aAxis: 1, sign: -1, pAxis: 0, qAxis: 2, uAxis: 0, vAxis: 2, normal: [0, -1, 0] },  // -y
  { aAxis: 2, sign: 1,  pAxis: 0, qAxis: 1, uAxis: 0, vAxis: 1, normal: [0, 0, 1] },   // +z
  { aAxis: 2, sign: -1, pAxis: 1, qAxis: 0, uAxis: 0, vAxis: 1, normal: [0, 0, -1] },  // -z
];

// `col` (vec4/vertex) is filled for ALL groups now: plants carry tint rgb + sway a;
// casters/nonCasters carry the baked biome tint rgb (white where untinted) + a=1.
type Accumulator = { pos: number[], norm: number[], uv: number[], layer: number[], col: number[], idx: number[] };
const newAccumulator = (): Accumulator => ({ pos: [], norm: [], uv: [], layer: [], col: [], idx: [] });

function finalize(acc: Accumulator): GeometryArrays | null {
  if (acc.idx.length === 0) return null;
  const vtx = acc.pos.length / 3;
  return {
    positions: new Float32Array(acc.pos),
    normals: new Float32Array(acc.norm),
    uvs: new Float32Array(acc.uv),
    layers: new Float32Array(acc.layer),
    indices: vtx > 65535 ? new Uint32Array(acc.idx) : new Uint16Array(acc.idx),
    // pack 0..1 tint/sway into normalized bytes (shader reads them back as 0..1)
    colors: acc.col.length ? Uint8Array.from(acc.col, (v) => v < 0 ? 0 : v > 1 ? 255 : (v * 255 + 0.5) | 0) : undefined,
  };
}

// Append one plant vertex (explicit world-local position + tint + sway). Plants
// use an UP normal regardless of quad orientation so a billboard is lit evenly
// like the ground it grows from (no dark-side flicker as you orbit it).
function pushPlantVert(acc: Accumulator, x: number, y: number, z: number, u: number, v: number,
  layer: number, r: number, g: number, b: number, sway: number) {
  acc.pos.push(x, y, z);
  acc.norm.push(0, 1, 0);
  acc.uv.push(u, v);
  acc.layer.push(layer);
  acc.col.push(r, g, b, sway);
}

// Append one vertex to `acc` from a quad corner, WITHOUT allocating (the old
// emitQuad built a `corners` array + a `vert[3]` per corner — thousands of
// short-lived arrays per chunk mesh). aAxis/pAxis/qAxis are a permutation of
// {0,1,2}, so each of aCoord/pc/qc maps to exactly one of x/y/z. Module-scope so
// no closure is allocated per quad either.
function pushVert(acc: Accumulator, meta: DirMeta, aCoord: number, pc: number, qc: number, layer: number,
  r = 1, g = 1, b = 1, emis = 0) {
  let x = 0, y = 0, z = 0;
  switch (meta.aAxis) { case 0: x = aCoord; break; case 1: y = aCoord; break; default: z = aCoord; }
  switch (meta.pAxis) { case 0: x = pc; break; case 1: y = pc; break; default: z = pc; }
  switch (meta.qAxis) { case 0: x = qc; break; case 1: y = qc; break; default: z = qc; }
  acc.pos.push(x, y, z);
  acc.norm.push(meta.normal[0], meta.normal[1], meta.normal[2]);
  // +0.5 aligns texture tile boundaries to block edges; the shader fract()s this
  // so merged quads tile the texture once per block.
  acc.uv.push(
    (meta.uAxis === 0 ? x : meta.uAxis === 1 ? y : z) + 0.5,
    (meta.vAxis === 0 ? x : meta.vAxis === 1 ? y : z) + 0.5,
  );
  acc.layer.push(layer);
  acc.col.push(r, g, b, emis);   // rgb = biome tint (white = untinted); a = emissive amount (0 = none)
}

export function buildChunkGeometry(data: Uint8Array, size: ChunkSize, getOutside: OutsideBlockGetter,
  getTint?: TintGetter): ChunkGeometry {
  const W = size.width, H = size.height;
  const dim = [W, H, W];
  const casters = newAccumulator();
  const nonCasters = newAccumulator();
  const plants = newAccumulator();

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
    const base = acc.pos.length / 3;
    pushVert(acc, meta, aCoord, pLo, qLo, layer, r, g, b, emis);
    pushVert(acc, meta, aCoord, pHi, qLo, layer, r, g, b, emis);
    pushVert(acc, meta, aCoord, pHi, qHi, layer, r, g, b, emis);
    pushVert(acc, meta, aCoord, pLo, qHi, layer, r, g, b, emis);
    acc.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // Vertical band where exposed faces can exist. The world is a heightmap (solid
  // below the surface, air above — no caves), so everything outside [bandLow,
  // bandHigh] is either all-solid (no faces) or all-air. Meshing only this band
  // skips the bulk of the 256-tall column — a big speedup for every mesh and
  // every neighbour re-mesh. bandLow also drops to expose edge walls toward
  // lower / not-yet-loaded neighbours, so the result is identical to meshing the
  // full column (verified by area conservation).
  let chunkMinTop = H - 1, chunkMaxTop = 0;
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < W; z++) {
      let top = 0;
      // Ignore plants (they sit above the surface) so the cube band tracks only
      // terrain/trees — plants get their own pass with their own y-range.
      for (let y = H - 1; y >= 0; y--) { const id = idAt(x, y, z); if (id !== BLOCK_IDS.air && PLANT_LOOKUP[id] === 0) { top = y; break; } }
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
  bandLow = Math.max(0, bandLow - 1);
  const bandHigh = chunkMaxTop;

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

    for (let la = aStart; la < aEnd; la++) {
      for (let p = pStart; p < pEnd; p++) {
        for (let q = qStart; q < qEnd; q++) {
          cell[meta.aAxis] = la; cell[meta.pAxis] = p; cell[meta.qAxis] = q;
          const id = idAt(cell[0], cell[1], cell[2]);
          // Plants, cutout (glass) and shaped/fence blocks aren't greedy cube-meshed
          // (the plant pass emits them); only full opaque cubes are greedy-merged.
          const vis = id !== BLOCK_IDS.air && PLANT_LOOKUP[id] === 0 && CUTOUT_LOOKUP[id] === 0
            && SHAPED_LOOKUP[id] === 0 && FENCE_LOOKUP[id] === 0
            && faceVisible(id, cell[0], cell[1], cell[2], ox, oy, oz);
          mask[p * dimQ + q] = vis ? id + 1 : 0;
          tintMask[p * dimQ + q] = vis && faceTinted(id, dir) ? tintBucket(grassTintAt(cell[0], cell[2])) : -1;
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
      const base = plants.pos.length / 3;
      pushPlantVert(plants, x + ax, yB, z + az, 0, 0, layer, r, g, b, swLo);
      pushPlantVert(plants, x + bx, yB, z + bz, 1, 0, layer, r, g, b, swLo);
      pushPlantVert(plants, x + bx, yT, z + bz, 1, 1, layer, r, g, b, swHi);
      pushPlantVert(plants, x + ax, yT, z + az, 0, 1, layer, r, g, b, swHi);
      plants.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
    const base = plants.pos.length / 3;
    pushPlantVert(plants, xLo, yTop, zLo, 0, 0, layer, r, g, b, 0);
    pushPlantVert(plants, xHi, yTop, zLo, nu, 0, layer, r, g, b, 0);
    pushPlantVert(plants, xHi, yTop, zHi, nu, nv, layer, r, g, b, 0);
    pushPlantVert(plants, xLo, yTop, zHi, 0, nv, layer, r, g, b, 0);
    plants.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // Vine quad flush against each horizontal face that has a solid backing.
  const emitVine = (x: number, y: number, z: number, layer: number, r: number, g: number, b: number) => {
    const yB = y - 0.5, yT = y + 0.5, e = 0.02;
    const faces: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of faces) {
      if (!solidAt(x + dx, y, z + dz)) continue;
      const base = plants.pos.length / 3;
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
      plants.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
    const base = casters.pos.length / 3;
    pushVert(casters, meta, aCoord, p0, q0, layer, 1, 1, 1, 0);
    pushVert(casters, meta, aCoord, p1, q0, layer, 1, 1, 1, 0);
    pushVert(casters, meta, aCoord, p1, q1, layer, 1, 1, 1, 0);
    pushVert(casters, meta, aCoord, p0, q1, layer, 1, 1, 1, 0);
    casters.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
      const base = plants.pos.length / 3;
      pushPlantVert(plants, ax, ay, az, 0, 0, layer, 1, 1, 1, 0);
      pushPlantVert(plants, bx, by, bz, 1, 0, layer, 1, 1, 1, 0);
      pushPlantVert(plants, cx, cy, cz, 1, 1, layer, 1, 1, 1, 0);
      pushPlantVert(plants, dx, dy, dz, 0, 1, layer, 1, 1, 1, 0);
      plants.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
      const base = casters.pos.length / 3;
      pushVert(casters, meta, aCoord, p0, q0, faces[d], 1, 1, 1, emis);
      pushVert(casters, meta, aCoord, p1, q0, faces[d], 1, 1, 1, emis);
      pushVert(casters, meta, aCoord, p1, q1, faces[d], 1, 1, 1, emis);
      pushVert(casters, meta, aCoord, p0, q1, faces[d], 1, 1, 1, emis);
      casters.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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

  return { casters: finalize(casters), nonCasters: finalize(nonCasters), plants: finalize(plants) };
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
  else { const f = 0.92 + Math.min(Math.max((height - sea) / 80, 0), 1) * 0.16; r *= f; g *= f; b *= f; }
  const sh = Math.min(Math.max(1 + slope * 0.07, 0.55), 1.45);
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
      for (let y = H - 1; y >= 0; y--) {
        const id = data[blockIndex(lx, y, lz, size)];
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
      const north = topYs[(lz > 0 ? lz - 1 : lz) * W + lx];
      tileShade(y, y - north, sea, r, g, b, out, di);
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
      for (let y = 0; y < H; y++) {
        const id = data[blockIndex(lx, y, lz, size)];
        if (id !== BLOCK_IDS.air && EMITTER_LOOKUP[id] === 1) out.push(worldX + lx, y, worldZ + lz, id);
      }
    }
  }
  return new Float32Array(out);
}
