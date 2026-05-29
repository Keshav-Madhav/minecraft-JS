import { BLOCK_IDS, BLOCK_FACE_LAYERS, NON_SHADOW_CASTER_IDS } from './blockTypes';
import { ChunkSize, blockIndex } from './chunkGen';

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
  indices: Uint32Array,
};

export type ChunkGeometry = {
  casters: GeometryArrays | null,     // shadow-casting blocks
  nonCasters: GeometryArrays | null,  // leaves / clouds
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

type Accumulator = { pos: number[], norm: number[], uv: number[], layer: number[], idx: number[] };
const newAccumulator = (): Accumulator => ({ pos: [], norm: [], uv: [], layer: [], idx: [] });

function finalize(acc: Accumulator): GeometryArrays | null {
  if (acc.idx.length === 0) return null;
  return {
    positions: new Float32Array(acc.pos),
    normals: new Float32Array(acc.norm),
    uvs: new Float32Array(acc.uv),
    layers: new Float32Array(acc.layer),
    indices: new Uint32Array(acc.idx),
  };
}

export function buildChunkGeometry(data: Uint8Array, size: ChunkSize, getOutside: OutsideBlockGetter): ChunkGeometry {
  const W = size.width, H = size.height;
  const dim = [W, H, W];
  const casters = newAccumulator();
  const nonCasters = newAccumulator();

  const idAt = (x: number, y: number, z: number) =>
    data[blockIndex(x, y, z, size)];

  const faceVisible = (x: number, y: number, z: number, dir: number): boolean => {
    const [ox, oy, oz] = FACE_OFFSETS[dir];
    const nx = x + ox, ny = y + oy, nz = z + oz;
    if (ny < 0) return false;          // bedrock floor
    if (ny >= H) return true;          // open sky
    if (nx >= 0 && nx < W && nz >= 0 && nz < W) {
      return idAt(nx, ny, nz) === BLOCK_IDS.air;
    }
    return getOutside(nx, ny, nz) === BLOCK_IDS.air; // neighbouring chunk
  };

  const emitQuad = (dir: number, la: number, p0: number, p1: number, q0: number, q1: number, id: number) => {
    const meta = DIR_META[dir];
    const acc = NON_SHADOW_CASTER_IDS.has(id) ? nonCasters : casters;
    const layer = BLOCK_FACE_LAYERS[id][dir];

    const aCoord = la + meta.sign * 0.5;
    const pLo = p0 - 0.5, pHi = p1 - 0.5;
    const qLo = q0 - 0.5, qHi = q1 - 0.5;
    const corners = [[pLo, qLo], [pHi, qLo], [pHi, qHi], [pLo, qHi]];
    const base = acc.pos.length / 3;
    for (const [pc, qc] of corners) {
      const vert = [0, 0, 0];
      vert[meta.aAxis] = aCoord;
      vert[meta.pAxis] = pc;
      vert[meta.qAxis] = qc;
      acc.pos.push(vert[0], vert[1], vert[2]);
      acc.norm.push(meta.normal[0], meta.normal[1], meta.normal[2]);
      // +0.5 aligns texture tile boundaries to block edges; the shader fract()s
      // this so merged quads tile the texture once per block.
      acc.uv.push(vert[meta.uAxis] + 0.5, vert[meta.vAxis] + 0.5);
      acc.layer.push(layer);
    }
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
      for (let y = H - 1; y >= 0; y--) { if (idAt(x, y, z) !== BLOCK_IDS.air) { top = y; break; } }
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
          mask[p * dimQ + q] = (id !== BLOCK_IDS.air && faceVisible(cell[0], cell[1], cell[2], dir)) ? id + 1 : 0;
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

  return { casters: finalize(casters), nonCasters: finalize(nonCasters) };
}
