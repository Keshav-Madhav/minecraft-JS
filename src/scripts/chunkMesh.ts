import { BLOCK_IDS, BLOCK_FACE_LAYERS, NON_SHADOW_CASTER_IDS, PLANTS, PLANT_LOOKUP } from './blockTypes';
import { ChunkSize, blockIndex, foliageGrassTint } from './chunkGen';

// Returns the biome id at a LOCAL chunk coordinate (mapped to world by the
// provider). Used only to bake the per-column grass tint into plant vertices.
export type BiomeGetter = (localX: number, localZ: number) => number;

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
  // Only the plants group carries this: vec4 per vertex = biome tint rgb + wind
  // sway weight (a), packed as NORMALIZED Uint8 (4 bytes/vertex, not 16) — the
  // shader reads it back as 0..1. Undefined for casters/nonCasters.
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

// `col` (vec4/vertex: biome tint rgb + sway weight a) is only ever filled for the
// plants accumulator; casters/nonCasters leave it empty and finalize() omits it.
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
function pushVert(acc: Accumulator, meta: DirMeta, aCoord: number, pc: number, qc: number, layer: number) {
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
}

export function buildChunkGeometry(data: Uint8Array, size: ChunkSize, getOutside: OutsideBlockGetter,
  getBiome?: BiomeGetter): ChunkGeometry {
  const W = size.width, H = size.height;
  const dim = [W, H, W];
  const casters = newAccumulator();
  const nonCasters = newAccumulator();
  const plants = newAccumulator();

  const idAt = (x: number, y: number, z: number) =>
    data[blockIndex(x, y, z, size)];

  // ox/oy/oz are the face offset for `dir`, hoisted by the caller (constant
  // across the per-cell loops) so it isn't re-read from FACE_OFFSETS per cell.
  // Plants (cross billboards / carpets / vines) are NON-OCCLUDING: a face behind
  // a grass tuft must still render, so an in-chunk plant neighbour counts as air.
  const faceVisible = (x: number, y: number, z: number, ox: number, oy: number, oz: number): boolean => {
    const nx = x + ox, ny = y + oy, nz = z + oz;
    if (ny < 0) return false;          // bedrock floor
    if (ny >= H) return true;          // open sky
    if (nx >= 0 && nx < W && nz >= 0 && nz < W) {
      const nid = idAt(nx, ny, nz);
      return nid === BLOCK_IDS.air || PLANT_LOOKUP[nid] === 1;
    }
    return getOutside(nx, ny, nz) === BLOCK_IDS.air; // neighbouring chunk (apron is solid/air only)
  };

  const emitQuad = (dir: number, la: number, p0: number, p1: number, q0: number, q1: number, id: number) => {
    const faces = BLOCK_FACE_LAYERS[id];
    if (!faces) return; // unmapped/tampered block id — skip rather than crash the (main-thread) remesh
    const meta = DIR_META[dir];
    const acc = NON_SHADOW_CASTER_IDS.has(id) ? nonCasters : casters;
    const layer = faces[dir];

    const aCoord = la + meta.sign * 0.5;
    const pLo = p0 - 0.5, pHi = p1 - 0.5;
    const qLo = q0 - 0.5, qHi = q1 - 0.5;
    const base = acc.pos.length / 3;
    pushVert(acc, meta, aCoord, pLo, qLo, layer);
    pushVert(acc, meta, aCoord, pHi, qLo, layer);
    pushVert(acc, meta, aCoord, pHi, qHi, layer);
    pushVert(acc, meta, aCoord, pLo, qHi, layer);
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
          // Plants aren't cube-meshed (handled by the plant pass below).
          mask[p * dimQ + q] = (id !== BLOCK_IDS.air && PLANT_LOOKUP[id] === 0 && faceVisible(cell[0], cell[1], cell[2], ox, oy, oz)) ? id + 1 : 0;
        }
      }

      for (let p = pStart; p < pEnd; p++) {
        let q = qStart;
        while (q < qEnd) {
          const m = mask[p * dimQ + q];
          if (m === 0) { q++; continue; }

          let w = 1;
          while (q + w < qEnd && mask[p * dimQ + q + w] === m) w++;

          let h = 1;
          let grow = true;
          while (p + h < pEnd && grow) {
            for (let k = 0; k < w; k++) {
              if (mask[(p + h) * dimQ + q + k] !== m) { grow = false; break; }
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
  const WHITE: readonly [number, number, number] = [1, 1, 1];
  // The grass tint depends only on the biome (a handful per chunk), so cache by
  // biome id — not per column. getBiome is itself a cheap precomputed-map lookup.
  const tintByBiome = new Map<number, readonly [number, number, number]>();
  const grassTintAt = (lx: number, lz: number): readonly [number, number, number] => {
    const biome = getBiome ? getBiome(lx, lz) : -1;
    let t = tintByBiome.get(biome);
    if (!t) { t = foliageGrassTint(biome); tintByBiome.set(biome, t); }
    return t;
  };
  const tintFor = (lx: number, lz: number, mode: 'grass' | 'none') =>
    mode === 'grass' ? grassTintAt(lx, lz) : WHITE;

  // A vine clings to any non-air, non-plant cell (terrain / trunk / cliff).
  const solidAt = (x: number, y: number, z: number): boolean => {
    if (y < 0) return true;
    if (y >= H) return false;
    const id = (x >= 0 && x < W && z >= 0 && z < W) ? idAt(x, y, z) : getOutside(x, y, z);
    return id !== BLOCK_IDS.air && PLANT_LOOKUP[id] === 0;
  };

  const INSET = 0.12;   // keep a cross inside its cell so it never overlaps a neighbour
  const emitCross = (x: number, y: number, z: number, layer: number, r: number, g: number, b: number) => {
    const yB = y - 0.5, yT = y + 0.5, lo = -0.5 + INSET, hi = 0.5 - INSET;
    const quad = (ax: number, az: number, bx: number, bz: number) => {
      const base = plants.pos.length / 3;
      pushPlantVert(plants, x + ax, yB, z + az, 0, 0, layer, r, g, b, 0);
      pushPlantVert(plants, x + bx, yB, z + bz, 1, 0, layer, r, g, b, 0);
      pushPlantVert(plants, x + bx, yT, z + bz, 1, 1, layer, r, g, b, 1);
      pushPlantVert(plants, x + ax, yT, z + az, 0, 1, layer, r, g, b, 1);
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
        if (PLANT_LOOKUP[id] === 0) continue;
        const def = PLANTS[id];
        if (def.kind === 'carpet') {
          let m = carpetByY.get(y);
          if (!m) { m = new Uint8Array(W * W); carpetByY.set(y, m); }
          m[x * W + z] = id;
          continue;
        }
        const [r, g, b] = tintFor(x, z, def.tint);
        if (def.kind === 'cross') emitCross(x, y, z, def.layer, r, g, b);
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
