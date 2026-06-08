import {
  WorldSampler, lodSurfaceBlock, climateGrassTint, ICE_SURFACE_TEMP, LOD_CANOPY, BIOME,
  structInfo, structureFitsBiome, STRUCT_CELL, STRUCT_MAX_R,
  ST_TOWER, ST_PYRAMID, ST_HOUSE, ST_VILLAGE, ST_MANSION, ST_OUTPOST, ST_LIGHTHOUSE, ST_MONASTERY,
} from './chunkGen';
import { BLOCK_IDS, BLOCK_FACE_LAYERS } from './blockTypes';
import { quantize } from './chunkMesh';
import type { GeometryArrays } from './chunkMesh';

// LOD FAR-TERRAIN MESHER — builds one big blocky-heightmap tile (default 8×8
// chunks = 128×128 blocks) straight from the deterministic world sampler at a
// coarse stride, with NO voxel data: flat top quads at each sampled column's
// height, vertical walls where neighbouring cells differ, and a statistical
// leaf-box canopy so distant forests read as forests. DOM/THREE-free so it runs
// in the chunk worker (same constraint as chunkMesh). Costs ~(N+2)² sampler
// calls per tile (the sampler is ~40-55 simplex evals — sampling at stride is
// the whole point; never call it per block here).
//
// Conventions shared with chunkMesh so LOD lines up EXACTLY with real chunks:
// block i's faces sit at i±0.5 in tile-local coords (mesh.position = tile world
// origin, a multiple of 16); a column of height h has its top face at h+0.5;
// UVs are local coords +0.5 so the shader's fract() tiles one texture per block.
// Winding matches chunkMesh's DIR_META (CCW front faces, outward normals).

// Terrain walls: the first few blocks under the surface are the column's subId
// (dirt under grass, sandstone under sand); anything deeper reads as stone —
// matching generateTerrain's 4-block subsurface + deep rock.
const SUB_DEPTH = 3;

// hash in [0,1) — pure fn of world coords (canopy is statistical: tree spots
// need to be stable per cell, not to match generateFeatures' RNG ordering).
function hash01(x: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Growable typed-array accumulator. A stride-4 mountain/forest tile emits tens
// of thousands of vertices — number[].push() accumulators (fine for 16×16
// chunks) would churn the worker GC at this scale, so we write into pre-sized
// typed arrays and double on demand.
class Acc {
  pos: Float32Array; uv: Float32Array; layer: Uint16Array;
  col: Uint8Array; idx: Uint32Array;
  v = 0; i = 0;   // vertex / index counts
  constructor(vcap: number) {
    this.pos = new Float32Array(vcap * 3);
    this.uv = new Float32Array(vcap * 2); this.layer = new Uint16Array(vcap);
    this.col = new Uint8Array(vcap * 4); this.idx = new Uint32Array(vcap + (vcap >> 1));
  }
  private grow(minV: number, minI: number) {
    const vcap = Math.max(minV, (this.layer.length * 2) | 0);
    const icap = Math.max(minI, (this.idx.length * 2) | 0);
    const g = <T extends Float32Array | Uint8Array | Uint16Array | Uint32Array>(a: T, n: number): T => {
      const b = new (a.constructor as new (n: number) => T)(n); b.set(a as never); return b;
    };
    if (minV > this.layer.length) {
      this.pos = g(this.pos, vcap * 3);
      this.uv = g(this.uv, vcap * 2); this.layer = g(this.layer, vcap); this.col = g(this.col, vcap * 4);
    }
    if (minI > this.idx.length) this.idx = g(this.idx, icap);
  }
  // One quad: 4 corners (xyz each), a faceId (0..5 → shader normal LUT, packed
  // into the layer word), per-corner uv, one texture layer, one rgb tint
  // (a = emissive, always 0 for LOD).
  quad(c: Float32Array, face: number, uvs: Float32Array,
    layer: number, r: number, g: number, b: number) {
    if (this.v + 4 > this.layer.length || this.i + 6 > this.idx.length) this.grow(this.v + 4, this.i + 6);
    const v0 = this.v;
    const packed = layer | (face << 12);
    for (let k = 0; k < 4; k++) {
      const p = (v0 + k) * 3, t = (v0 + k) * 2, c4 = (v0 + k) * 4;
      this.pos[p] = c[k * 3]; this.pos[p + 1] = c[k * 3 + 1]; this.pos[p + 2] = c[k * 3 + 2];
      this.uv[t] = uvs[k * 2]; this.uv[t + 1] = uvs[k * 2 + 1];
      this.layer[v0 + k] = packed;
      this.col[c4] = r; this.col[c4 + 1] = g; this.col[c4 + 2] = b; this.col[c4 + 3] = 0;
    }
    this.v += 4;
    const ix = this.i;
    this.idx[ix] = v0; this.idx[ix + 1] = v0 + 1; this.idx[ix + 2] = v0 + 2;
    this.idx[ix + 3] = v0; this.idx[ix + 4] = v0 + 2; this.idx[ix + 5] = v0 + 3;
    this.i += 6;
  }
  finalize(): GeometryArrays | null {
    if (this.i === 0) return null;
    const positions = new Uint16Array(this.v * 3);
    for (let k = 0; k < positions.length; k++) positions[k] = quantize(this.pos[k]);
    const uvs = new Uint16Array(this.v * 2);
    for (let k = 0; k < uvs.length; k++) uvs[k] = quantize(this.uv[k]);
    return {
      positions,
      uvs,
      layers: this.layer.slice(0, this.v),
      indices: this.v > 65535 ? this.idx.slice(0, this.i) : Uint16Array.from(this.idx.subarray(0, this.i)),
      colors: this.col.slice(0, this.v * 4),
    };
  }
}

// scratch buffers reused across quads (no per-quad allocation)
const _c = new Float32Array(12);
const _uv = new Float32Array(8);

// Corner/uv layouts mirror chunkMesh DIR_META windings (verified CCW per face).
// Face ids: 0..5 = +x,-x,+y,-y,+z,-z (the shader's normal LUT).
function topQuad(acc: Acc, x0: number, x1: number, z0: number, z1: number, y: number,
  layer: number, r: number, g: number, b: number) {
  _c.set([x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0]);
  _uv.set([x0 + .5, z0 + .5, x0 + .5, z1 + .5, x1 + .5, z1 + .5, x1 + .5, z0 + .5]);
  acc.quad(_c, 2, _uv, layer, r, g, b);
}
// Smooth-terrain variant: per-corner heights (far tiles render as a smooth
// heightfield — see the smooth branch in buildLodTile). Up-facing normal is an
// approximation on slopes; at the distances smooth mode runs, it's invisible.
function topQuadH(acc: Acc, x0: number, x1: number, z0: number, z1: number,
  y00: number, y01: number, y11: number, y10: number,
  layer: number, r: number, g: number, b: number) {
  _c.set([x0, y00, z0, x0, y01, z1, x1, y11, z1, x1, y10, z0]);
  _uv.set([x0 + .5, z0 + .5, x0 + .5, z1 + .5, x1 + .5, z1 + .5, x1 + .5, z0 + .5]);
  acc.quad(_c, 2, _uv, layer, r, g, b);
}
function bottomQuad(acc: Acc, x0: number, x1: number, z0: number, z1: number, y: number,
  layer: number, r: number, g: number, b: number) {
  _c.set([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1]);
  _uv.set([x0 + .5, z0 + .5, x1 + .5, z0 + .5, x1 + .5, z1 + .5, x0 + .5, z1 + .5]);
  acc.quad(_c, 3, _uv, layer, r, g, b);
}
function xWall(acc: Acc, x: number, y0: number, y1: number, z0: number, z1: number, sign: number,
  layer: number, r: number, g: number, b: number) {
  if (sign > 0) _c.set([x, y0, z0, x, y1, z0, x, y1, z1, x, y0, z1]);
  else _c.set([x, y0, z0, x, y0, z1, x, y1, z1, x, y1, z0]);
  if (sign > 0) _uv.set([z0 + .5, y0 + .5, z0 + .5, y1 + .5, z1 + .5, y1 + .5, z1 + .5, y0 + .5]);
  else _uv.set([z0 + .5, y0 + .5, z1 + .5, y0 + .5, z1 + .5, y1 + .5, z0 + .5, y1 + .5]);
  acc.quad(_c, sign > 0 ? 0 : 1, _uv, layer, r, g, b);
}
function zWall(acc: Acc, z: number, y0: number, y1: number, x0: number, x1: number, sign: number,
  layer: number, r: number, g: number, b: number) {
  if (sign > 0) _c.set([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]);
  else _c.set([x0, y0, z, x0, y1, z, x1, y1, z, x1, y0, z]);
  if (sign > 0) _uv.set([x0 + .5, y0 + .5, x1 + .5, y0 + .5, x1 + .5, y1 + .5, x0 + .5, y1 + .5]);
  else _uv.set([x0 + .5, y0 + .5, x0 + .5, y1 + .5, x1 + .5, y1 + .5, x1 + .5, y0 + .5]);
  acc.quad(_c, sign > 0 ? 4 : 5, _uv, layer, r, g, b);
}

export type LodTileGeometry = { terrain: GeometryArrays | null, canopy: GeometryArrays | null };

export function buildLodTile(
  sample: WorldSampler, sea: number, maxY: number,
  worldX: number, worldZ: number, tileBlocks: number, stride: number,
  seed: number,
): LodTileGeometry {
  const N = (tileBlocks / stride) | 0;   // cells per side
  const G = N + 2;                       // sampled grid incl. a 1-cell ring from neighbour tiles
  // per-grid-cell column data (ring included so tile-border walls + canopy
  // culling are seamless — the sampler is global, so neighbours agree exactly)
  const hgt = new Int16Array(G * G);
  const top = new Uint8Array(G * G);     // block id at the surface (ids ≤ 255)
  const sub = new Uint8Array(G * G);
  const biom = new Uint8Array(G * G);
  const wet = new Uint8Array(G * G);     // 1 = submerged (incl. frozen-over) → no canopy
  const tint = new Uint8Array(G * G * 3);

  for (let gz = 0; gz < G; gz++) {
    for (let gx = 0; gx < G; gx++) {
      const cs = sample(worldX + (gx - 1) * stride, worldZ + (gz - 1) * stride);
      const o = gz * G + gx;
      let h = cs.height, t = lodSurfaceBlock(cs, sea), s = cs.subId;
      if (h < sea) {
        wet[o] = 1;
        // frozen ocean/river: the walkable ice sheet caps the column at sea level
        if (cs.temp < ICE_SURFACE_TEMP) { h = sea; t = BLOCK_IDS.ice; s = BLOCK_IDS.ice; }
      }
      hgt[o] = h; top[o] = t; sub[o] = s; biom[o] = cs.biome;
      if (wet[o]) {
        // Submerged: bake a depth-darkening into the seabed tint (mirrors the
        // minimap's shade curve). Without it, bright sand glows through the
        // semi-transparent water plane across the whole far ocean — before LOD
        // the plane blended over sky back there, so deep water read dark; a
        // uniformly bright floor made all far water look washed-out/shallow.
        const f = 1 - 0.5 * Math.min((sea - h) / 40, 1);   // h=sea (ice) → 1, deep → 0.5
        const v = (f * 255) | 0;
        tint[o * 3] = v; tint[o * 3 + 1] = v; tint[o * 3 + 2] = v;
      } else {
        const gt = climateGrassTint(cs.temp, cs.humid);
        tint[o * 3] = (gt[0] * 255) | 0; tint[o * 3 + 1] = (gt[1] * 255) | 0; tint[o * 3 + 2] = (gt[2] * 255) | 0;
      }
    }
  }

  const terrain = new Acc(N * N * 4 + 256);
  const STONE_SIDE = BLOCK_FACE_LAYERS[BLOCK_IDS.stone][0];

  // ---- SMOOTH MODE (stride ≥ 8): far tiles render as a smooth heightfield --
  // At ≥700m a blocky staircase costs a wall quad per height step that the eye
  // can't resolve anyway (the same sub-pixel argument that drops trunks out
  // there). Instead: per-cell quads with CORNER heights averaged from the 4
  // surrounding cells — no walls at all (~40-60% fewer far-ring triangles) and
  // distant hills read smooth, which is perceptually MORE correct than 16-block
  // stair treads. Corner heights only use the deterministic sampled grid (ring
  // included), so adjacent tiles agree exactly — no cracks between smooth tiles.
  if (stride >= 8) {
    const cornerH = (gx: number, gz: number) =>   // corner between cells (gx-1,gz-1)..(gx,gz), grid indices
      (hgt[(gz - 1) * G + (gx - 1)] + hgt[(gz - 1) * G + gx] + hgt[gz * G + (gx - 1)] + hgt[gz * G + gx]) / 4;
    for (let cz = 0; cz < N; cz++) {
      for (let cx = 0; cx < N; cx++) {
        const o = (cz + 1) * G + (cx + 1);
        const layer = (BLOCK_FACE_LAYERS[top[o]] ?? BLOCK_FACE_LAYERS[BLOCK_IDS.stone])[2];
        let r = 255, g = 255, b = 255;
        if (top[o] === BLOCK_IDS.grass || wet[o]) { r = tint[o * 3]; g = tint[o * 3 + 1]; b = tint[o * 3 + 2]; }
        const x0 = cx * stride - 0.5, x1 = x0 + stride;
        const z0 = cz * stride - 0.5, z1 = z0 + stride;
        topQuadH(terrain, x0, x1, z0, z1,
          cornerH(cx + 1, cz + 1) + 0.5, cornerH(cx + 1, cz + 2) + 0.5,
          cornerH(cx + 2, cz + 2) + 0.5, cornerH(cx + 2, cz + 1) + 0.5,
          layer, r, g, b);
      }
    }
  }

  if (stride < 8) {
  // ---- TOP QUADS, greedy-merged per (height, layer, tint) ------------------
  // key packs height(0..319)·layer(0..255)·tint12 into an int32; tint only
  // differentiates grass tops (everything else merges freely on height+layer).
  const tintBucket = (o: number) =>
    ((tint[o * 3] >> 4) << 8) | ((tint[o * 3 + 1] >> 4) << 4) | (tint[o * 3 + 2] >> 4);
  const mask = new Int32Array(N * N);
  for (let cz = 0; cz < N; cz++) {
    for (let cx = 0; cx < N; cx++) {
      const o = (cz + 1) * G + (cx + 1);
      const layer = (BLOCK_FACE_LAYERS[top[o]] ?? BLOCK_FACE_LAYERS[BLOCK_IDS.stone])[2];
      // tint participates in the merge key for grass (climate tint) AND
      // submerged cells (depth shade) so merged quads stay colour-uniform
      const tb = top[o] === BLOCK_IDS.grass || wet[o] ? tintBucket(o) : 0;
      mask[cz * N + cx] = ((hgt[o] * 256 + layer) * 4096 + tb) | 0;
    }
  }
  for (let cz = 0; cz < N; cz++) {
    let cx = 0;
    while (cx < N) {
      const m = mask[cz * N + cx];
      if (m === 0) { cx++; continue; }
      let w = 1;
      while (cx + w < N && mask[cz * N + cx + w] === m) w++;
      let d = 1, grow = true;
      while (cz + d < N && grow) {
        for (let k = 0; k < w; k++) if (mask[(cz + d) * N + cx + k] !== m) { grow = false; break; }
        if (grow) d++;
      }
      const o = (cz + 1) * G + (cx + 1);
      const h = hgt[o], layer = (m / 4096 | 0) % 256;
      let r = 255, g = 255, b = 255;
      if (top[o] === BLOCK_IDS.grass || wet[o]) { r = tint[o * 3]; g = tint[o * 3 + 1]; b = tint[o * 3 + 2]; }
      topQuad(terrain,
        cx * stride - 0.5, (cx + w) * stride - 0.5,
        cz * stride - 0.5, (cz + d) * stride - 0.5,
        h + 0.5, layer, r, g, b);
      for (let dz = 0; dz < d; dz++) for (let k = 0; k < w; k++) mask[(cz + dz) * N + cx + k] = 0;
      cx += w;
    }
  }

  // ---- WALLS between cells of different height ------------------------------
  // Emitted when EITHER side is an interior cell, so tile-boundary slopes are
  // gap-free without needing the neighbour tile (when both tiles are resident
  // the boundary wall is emitted twice with identical world geometry — benign).
  // Wall = the exposed side of the HIGHER column, faced toward the lower one;
  // top SUB_DEPTH blocks use the higher column's subId, the rest reads stone.
  const wall = (
    emit: (y0: number, y1: number, layer: number) => void,
    oHi: number, lo: number, hi: number, sideDir: number,   // sideDir: BLOCK_FACE_LAYERS index (0/1 = ±x, 4/5 = ±z)
  ) => {
    const subTop = Math.max(lo, hi - SUB_DEPTH);
    const sideLayers = BLOCK_FACE_LAYERS[sub[oHi]] ?? BLOCK_FACE_LAYERS[BLOCK_IDS.dirt];
    if (subTop > lo) emit(lo + 0.5, subTop + 0.5, STONE_SIDE);
    emit(subTop + 0.5, hi + 0.5, sideLayers[sideDir]);
  };
  for (let gz = 1; gz <= N; gz++) {        // interior cell rows (grid index)
    for (let gx = 0; gx <= N; gx++) {      // x-borders: between grid cols gx and gx+1 (every border touches ≥1 interior cell)
      const a = gz * G + gx, b2 = a + 1;
      const ha = hgt[a], hb = hgt[b2];
      if (ha === hb) continue;
      const x = gx * stride - 0.5;                   // border plane (cell 0's west face sits at -0.5)
      const z0 = (gz - 1) * stride - 0.5, z1 = gz * stride - 0.5;
      if (ha > hb) wall((y0, y1, l) => xWall(terrain, x, y0, y1, z0, z1, 1, l, 255, 255, 255), a, hb, ha, 0);
      else wall((y0, y1, l) => xWall(terrain, x, y0, y1, z0, z1, -1, l, 255, 255, 255), b2, ha, hb, 1);
    }
  }
  for (let gx = 1; gx <= N; gx++) {
    for (let gz = 0; gz <= N; gz++) {      // z-borders
      const a = gz * G + gx, b2 = a + G;
      const ha = hgt[a], hb = hgt[b2];
      if (ha === hb) continue;
      const z = gz * stride - 0.5;
      const x0 = (gx - 1) * stride - 0.5, x1 = gx * stride - 0.5;
      if (ha > hb) wall((y0, y1, l) => zWall(terrain, z, y0, y1, x0, x1, 1, l, 255, 255, 255), a, hb, ha, 4);
      else wall((y0, y1, l) => zWall(terrain, z, y0, y1, x0, x1, -1, l, 255, 255, 255), b2, ha, hb, 5);
    }
  }
  }   // end of blocky (stride < 8) path

  // ---- STATISTICAL TREES ----------------------------------------------------
  // Exact tree positions are unreachable (generateFeatures' RNG consumption
  // order), so distant forests are reproduced statistically — but on a WORLD-
  // FIXED 4-block grid, the same cell size generateFeatures uses (CELL=4, one
  // tree pick per cell): tree positions are a pure function of world coords,
  // so they are IDENTICAL at every stride. When a tile re-meshes at a new
  // detail level the forest stays put (no reshuffle pop), density matches the
  // real worldgen 1:1 (prob is per-cell, no scaling), and a tree near a tile
  // border is owned by exactly one tile (its blob may poke past the boundary —
  // harmless, the bounding sphere covers it).
  // Blobs are 3-5 blocks with a log trunk; canopy goes in a SEPARATE geometry
  // (leaf textures are alpha-cutout with BLACK hole texels → they need the
  // alpha-tested leaf material). Trunks are opaque → the terrain mesh.
  const canopy = new Acc(1024);
  const CGRID = 4;
  const cgN = (tileBlocks / CGRID) | 0;
  for (let cgz = 0; cgz < cgN; cgz++) {
    for (let cgx = 0; cgx < cgN; cgx++) {
      const wx = worldX + cgx * CGRID, wz = worldZ + cgz * CGRID;
      const h2 = hash01(wx + 31337, wz - 7331);     // size/height jitter
      const h3 = hash01(wx - 911, wz + 577);        // X placement
      const h4 = hash01(wx + 247, wz + 131);        // Z placement
      // nearest sampled column AT THE JITTERED TREE SPOT (not the cell centre —
      // on a stride-1 slope a 2-block offset is several blocks of height, and
      // a trunk anchored to the wrong column floats above / buries into the
      // terrain top drawn at its real column)
      const jx = cgx * CGRID + ((h3 * CGRID) | 0), jz = cgz * CGRID + ((h4 * CGRID) | 0);
      const gx = Math.min(N, Math.max(1, Math.round(jx / stride) + 1));
      const gz = Math.min(N, Math.max(1, Math.round(jz / stride) + 1));
      const o = gz * G + gx;
      if (wet[o]) continue;
      const c = LOD_CANOPY[biom[o]];
      if (!c) continue;
      if (hash01(wx, wz) >= c.prob) continue;       // per-4×4-cell chance, same as generateFeatures
      // alpine treeline blend — same 38..60 thinning band generateFeatures
      // applies (statistical mirror; the canopy never matches tree-for-tree)
      const tl = (hgt[o] - sea - 38) / 22;
      if (tl > 0 && hash01(wx + 137, wz + 593) < Math.min(1, tl)) continue;
      const blobW = 3 + ((h2 * 3) | 0);             // 3..5 blocks
      const ground = hgt[o];
      const y0 = ground + c.base;
      const y1 = Math.min(maxY, y0 + c.height + ((h2 * 3) | 0));
      if (y1 <= y0) continue;
      const L = BLOCK_FACE_LAYERS[c.leafId] ?? BLOCK_FACE_LAYERS[BLOCK_IDS.leaves];
      let r = 255, g = 255, b = 255;
      if (c.tinted) { r = tint[o * 3]; g = tint[o * 3 + 1]; b = tint[o * 3 + 2]; }
      // blob centred on the jittered spot (same column the ground was sampled at)
      const x0 = jx - blobW / 2, x1 = x0 + blobW;
      const z0 = jz - blobW / 2, z1 = z0 + blobW;
      // Snow-capped trees: generateFeatures snow-caps conifers in the COLD
      // biomes (taiga / snowy / mountain range — even over grass/podzol
      // ground) and anywhere the surface itself is snow. Mirror both with a
      // snow TOP face (untinted white) so distant cold forests match the
      // near ones — bald green LOD conifers next to real snow-capped ones
      // was a visibly wrong tree style.
      const coldBiome = biom[o] === BIOME.taiga || biom[o] === BIOME.snowy || biom[o] === BIOME.mountains;
      if (coldBiome || top[o] === BLOCK_IDS.snow) {
        topQuad(canopy, x0, x1, z0, z1, y1, BLOCK_FACE_LAYERS[BLOCK_IDS.snow][2], 255, 255, 255);
      } else {
        topQuad(canopy, x0, x1, z0, z1, y1, L[2], r, g, b);
      }
      bottomQuad(canopy, x0, x1, z0, z1, y0, L[3], r, g, b);
      xWall(canopy, x1, y0, y1, z0, z1, 1, L[0], r, g, b);
      xWall(canopy, x0, y0, y1, z0, z1, -1, L[1], r, g, b);
      zWall(canopy, z1, y0, y1, x0, x1, 1, L[4], r, g, b);
      zWall(canopy, z0, y0, y1, x0, x1, -1, L[5], r, g, b);
      // Trunk: a 1-block log column from the surface to the canopy bottom,
      // centred under the blob — grounds the tree (no more floating slabs).
      // Skipped at coarse strides: a 1-block post at 700m+ is sub-pixel.
      if (stride > 4) continue;
      const TL = BLOCK_FACE_LAYERS[c.trunkId] ?? BLOCK_FACE_LAYERS[BLOCK_IDS.tree];
      const tcx = (x0 + x1) / 2, tcz = (z0 + z1) / 2;
      const tx0 = tcx - 0.5, tx1 = tcx + 0.5, tz0 = tcz - 0.5, tz1 = tcz + 0.5;
      const ty0 = ground + 0.5, ty1 = y0;
      if (ty1 > ty0) {
        xWall(terrain, tx1, ty0, ty1, tz0, tz1, 1, TL[0], 255, 255, 255);
        xWall(terrain, tx0, ty0, ty1, tz0, tz1, -1, TL[1], 255, 255, 255);
        zWall(terrain, tz1, ty0, ty1, tx0, tx1, 1, TL[4], 255, 255, 255);
        zWall(terrain, tz0, ty0, ty1, tx0, tx1, -1, TL[5], 255, 255, 255);
      }
    }
  }

  // ---- STRUCTURE PROXIES ----------------------------------------------------
  // Structures used to exist only as real chunk voxels, so a tower/pyramid/
  // village POPPED OUT of the world beyond the chunk ring. Emit coarse opaque
  // boxes for the visible-at-distance kinds straight into the terrain Acc —
  // they then inherit the tile's hide-when-chunks-cover rule for free (never a
  // double-render in steady state; during streaming the proxies are inset a
  // block inside the real builds, so no coplanar z-fighting either).
  emitStructureProxies(terrain, sample, sea, worldX, worldZ, tileBlocks, stride, seed);

  return { terrain: terrain.finalize(), canopy: canopy.finalize() };
}

// One proxy box, world coords in BLOCK indices (inclusive), clipped to the
// tile: a structure can straddle a tile border (origins up to STRUCT_MAX_R
// outside still overlap), and tile-local quantization only supports ≥ -8 —
// each overlapping tile emits its clipped piece, and the pieces union into the
// closed box (the cut planes are interior, never visible). Walls are emitted
// only where the box's real edge lies inside this tile.
function proxyBox(acc: Acc, worldX: number, worldZ: number, tileBlocks: number,
  wx0: number, wz0: number, wx1: number, wz1: number, y0: number, y1: number,
  L: ArrayLike<number>) {
  const tx0 = -0.5, tx1 = tileBlocks - 0.5;
  const x0 = wx0 - worldX - 0.5, x1 = wx1 - worldX + 0.5;
  const z0 = wz0 - worldZ - 0.5, z1 = wz1 - worldZ + 0.5;
  const cx0 = Math.max(x0, tx0), cx1 = Math.min(x1, tx1);
  const cz0 = Math.max(z0, tx0), cz1 = Math.min(z1, tx1);
  if (cx0 >= cx1 || cz0 >= cz1 || y1 < y0) return;
  const ya = y0 - 0.5, yb = y1 + 0.5;
  topQuad(acc, cx0, cx1, cz0, cz1, yb, L[2], 255, 255, 255);
  if (x1 <= tx1) xWall(acc, cx1, ya, yb, cz0, cz1, 1, L[0], 255, 255, 255);
  if (x0 >= tx0) xWall(acc, cx0, ya, yb, cz0, cz1, -1, L[1], 255, 255, 255);
  if (z1 <= tx1) zWall(acc, cz1, ya, yb, cx0, cx1, 1, L[4], 255, 255, 255);
  if (z0 >= tx0) zWall(acc, cz0, ya, yb, cx0, cx1, -1, L[5], 255, 255, 255);
}

function emitStructureProxies(terrain: Acc, sample: WorldSampler, sea: number,
  worldX: number, worldZ: number, tileBlocks: number, stride: number, seed: number) {
  // Approximate the builder's platform(): max ground over the footprint with
  // the same null rule (water / too steep → the real builder skipped the site,
  // so no proxy either). Sampled on a coarse sub-grid — the real scan is every
  // column, but viable sites are ≤7 blocks of spread, so a stride-2/4 max is
  // within a block or two; invisible at LOD range, and the proxy never renders
  // beside the real build (the tile hides once its chunks load).
  const baseAt = (ox: number, oz: number, r: number, maxSpread = 7): number | null => {
    let hi = 0, lo = 1e9;
    const st = r <= 4 ? 2 : 4;
    for (let dx = -r; dx <= r; dx += st) for (let dz = -r; dz <= r; dz += st) {
      const h = sample(ox + dx, oz + dz).height;
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
    return (hi <= sea || hi - lo > maxSpread) ? null : hi;
  };
  const SB = BLOCK_FACE_LAYERS[BLOCK_IDS.stoneBricks];
  const SS = BLOCK_FACE_LAYERS[BLOCK_IDS.sandstone];
  const DO = BLOCK_FACE_LAYERS[BLOCK_IDS.darkOakPlanks];
  const OP = BLOCK_FACE_LAYERS[BLOCK_IDS.oakPlanks];
  const CB = BLOCK_FACE_LAYERS[BLOCK_IDS.cobblestone];
  const WR = BLOCK_FACE_LAYERS[BLOCK_IDS.woolRed];
  const QZ = BLOCK_FACE_LAYERS[BLOCK_IDS.quartzBlock];
  const box = (wx0: number, wz0: number, wx1: number, wz1: number, y0: number, y1: number, L: ArrayLike<number>) =>
    proxyBox(terrain, worldX, worldZ, tileBlocks, wx0, wz0, wx1, wz1, y0, y1, L);
  // Tower height mirrors the builder's elevation curve (the rng spread isn't
  // reproducible from cell+seed — a fixed mid-spread value reads right at range).
  const towerBox = (ox: number, oz: number, base: number) => {
    const elev = Math.min(1, Math.max(0, (base - sea) / 70));
    const h = Math.round(22 - 12 * elev) + 4;
    box(ox - 2, oz - 2, ox + 2, oz + 2, base + 1, base + h, SB);
  };

  const cx0 = Math.floor((worldX - STRUCT_MAX_R) / STRUCT_CELL), cx1 = Math.floor((worldX + tileBlocks + STRUCT_MAX_R) / STRUCT_CELL);
  const cz0 = Math.floor((worldZ - STRUCT_MAX_R) / STRUCT_CELL), cz1 = Math.floor((worldZ + tileBlocks + STRUCT_MAX_R) / STRUCT_CELL);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const s = structInfo(cx, cz, seed);
      if (!s) continue;
      if (s.ox + STRUCT_MAX_R < worldX || s.ox - STRUCT_MAX_R >= worldX + tileBlocks) continue;
      if (s.oz + STRUCT_MAX_R < worldZ || s.oz - STRUCT_MAX_R >= worldZ + tileBlocks) continue;
      if (!structureFitsBiome(s.kind, sample(s.ox, s.oz).biome)) continue;
      // Megatiles (stride 16, ≥1.5km out) keep only the BIG silhouettes; the
      // small kinds are sub-pixel there and the per-house ground scans aren't
      // worth paying that far out.
      const bigOnly = stride >= 16;
      switch (s.kind) {
        case ST_TOWER: {
          const base = baseAt(s.ox, s.oz, 4);
          if (base !== null) towerBox(s.ox, s.oz, base);
          break;
        }
        case ST_PYRAMID: {
          const base = baseAt(s.ox, s.oz, 14);
          if (base === null) break;
          // plinth + 3 merged step tiers ≈ the 29×29 foundation + 11 1-block steps
          box(s.ox - 13, s.oz - 13, s.ox + 13, s.oz + 13, base + 1, base + 5, SS);
          box(s.ox - 11, s.oz - 11, s.ox + 11, s.oz + 11, base + 6, base + 9, SS);
          box(s.ox - 7, s.oz - 7, s.ox + 7, s.oz + 7, base + 10, base + 13, SS);
          box(s.ox - 3, s.oz - 3, s.ox + 3, s.oz + 3, base + 14, base + 17, SS);
          break;
        }
        case ST_MANSION: {
          const base = baseAt(s.ox, s.oz, 18);
          if (base === null) break;
          box(s.ox - 13, s.oz - 10, s.ox + 13, s.oz + 15, base + 1, base + 17, DO);
          box(s.ox - 9, s.oz - 6, s.ox + 9, s.oz + 11, base + 18, base + 20, DO);  // roof mass
          break;
        }
        case ST_LIGHTHOUSE: {
          const base = baseAt(s.ox, s.oz, 3);
          if (base === null) break;
          box(s.ox - 1, s.oz - 1, s.ox + 1, s.oz + 1, base + 1, base + 16, WR);   // striped shaft reads red at range
          box(s.ox - 1, s.oz - 1, s.ox + 1, s.oz + 1, base + 17, base + 19, QZ);  // lantern room
          break;
        }
        case ST_HOUSE: {
          if (bigOnly) break;
          const base = baseAt(s.ox, s.oz, 4);
          if (base === null) break;
          // mirror the builder's tower-on-mountain bias (height-gated, rng 80% —
          // emit the dominant variant)
          if (base > sea + 42) towerBox(s.ox, s.oz, base);
          else box(s.ox - 3, s.oz - 2, s.ox + 3, s.oz + 2, base + 1, base + 6, OP);
          break;
        }
        case ST_OUTPOST: {
          if (bigOnly) break;
          const base = baseAt(s.ox, s.oz, 3);
          if (base !== null) box(s.ox - 1, s.oz - 1, s.ox + 1, s.oz + 1, base + 1, base + 12, CB);
          break;
        }
        case ST_MONASTERY: {
          if (bigOnly) break;
          // mirror the builder's gates: high ground (sea+18) + crag-tolerant
          // spread 10 — a valley cell builds nothing, so no proxy either
          const base = baseAt(s.ox, s.oz, 6, 10);
          if (base === null || base < sea + 18) break;
          box(s.ox - 5, s.oz - 3, s.ox + 5, s.oz + 3, base + 1, base + 8, SB);    // hall
          box(s.ox + 3, s.oz + 1, s.ox + 5, s.oz + 3, base + 9, base + 13, SB);   // bell tower above the roofline
          break;
        }
        case ST_VILLAGE: {
          if (bigOnly) break;
          // The real layout is rng-driven (not reproducible from cell+seed) —
          // a STATISTICAL hamlet, same philosophy as the canopy: hash-scattered
          // house boxes on their own ground + the watchtower silhouette. Reads
          // as "a village there" from afar; the real one swaps in on approach.
          const wtAng = hash01(s.ox + 5, s.oz + 9) * Math.PI * 2;
          const wtBase = baseAt(s.ox + Math.round(Math.cos(wtAng) * 42), s.oz + Math.round(Math.sin(wtAng) * 42), 4);
          if (wtBase !== null) towerBox(s.ox + Math.round(Math.cos(wtAng) * 42), s.oz + Math.round(Math.sin(wtAng) * 42), wtBase);
          for (let i = 0; i < 7; i++) {
            const ang = hash01(s.ox + i * 7, s.oz + i * 13) * Math.PI * 2;
            const dist = 13 + hash01(s.ox + i * 29, s.oz + i * 17) * 26;
            const hx = s.ox + Math.round(Math.cos(ang) * dist);
            const hz = s.oz + Math.round(Math.sin(ang) * dist);
            const hb = baseAt(hx, hz, 4);
            if (hb !== null) box(hx - 3, hz - 2, hx + 3, hz + 2, hb + 1, hb + 5, OP);
          }
          break;
        }
      }
    }
  }
}
