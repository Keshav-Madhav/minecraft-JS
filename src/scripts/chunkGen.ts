import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js';
import { RNG } from './rng';
import { BLOCK_IDS, ResourceGenInfo } from './blockTypes';

export type ChunkParams = {
  seed: number,
  terrain: {
    scale: number,
    magnitude: number,
    offset: number,
    waterOffset: number
  },
  trees: {
    trunk: {
      minHeight: number,
      maxHeight: number,
    },
    canopy: {
      minRadius: number,
      maxRadius: number,
      density: number,
    },
    frequency: number
  },
  clouds: {
    scale: number,
    density: number
  }
}

export type ChunkSize = { width: number, height: number };

// Flat index into the block-id array. Layout: ((x * height) + y) * width + z
export function blockIndex(x: number, y: number, z: number, size: ChunkSize) {
  return (x * size.height + y) * size.width + z;
}

function inBounds(x: number, y: number, z: number, size: ChunkSize) {
  return x >= 0 && x < size.width &&
         y >= 0 && y < size.height &&
         z >= 0 && z < size.width;
}

/**
 * Generates the raw block-id data for a single chunk. This is intentionally
 * free of any THREE.js mesh objects (and DOM access) so it can run inside a Web
 * Worker and the resulting buffer can be transferred back to the main thread
 * with zero copy.
 *
 * The generation sequence (resources -> terrain -> trees -> clouds) and the way
 * the shared RNG is threaded through each SimplexNoise constructor must stay
 * identical to keep world output deterministic for a given seed.
 */
export function generateChunkData(
  size: ChunkSize,
  params: ChunkParams,
  worldX: number,
  worldZ: number,
  resources: ResourceGenInfo[]
): Uint8Array {
  // Block ids are small (<= 10), so a byte per block halves the data footprint
  // versus Uint16 — meaningful at high draw distances (hundreds of chunks).
  const data = new Uint8Array(size.width * size.height * size.width); // 0 == air everywhere

  const get = (x: number, y: number, z: number) =>
    inBounds(x, y, z, size) ? data[blockIndex(x, y, z, size)] : BLOCK_IDS.air;
  const set = (x: number, y: number, z: number, id: number) => {
    if (inBounds(x, y, z, size)) data[blockIndex(x, y, z, size)] = id;
  };

  // Terrain + biome noise share one RNG seeded ONLY by params.seed so the
  // SimplexNoise permutation table is identical across chunks — that keeps the
  // noise field continuous (no seams) regardless of chunk position.
  const rng = new RNG(params.seed);
  const simplex = new SimplexNoise(rng);

  // Terrain first so ores can be scattered only into solid stone.
  generateTerrain(simplex, params, size, worldX, worldZ, set);
  generateResources(rng, size, worldX, worldZ, resources, get, set);

  // Trees use a SEPARATE per-chunk RNG for placement (reusing the global rng
  // gave every chunk the same sequence -> a repeating grid), but a continuous
  // forest-density field (the shared simplex) so woods/clearings span chunks.
  const treeRng = new RNG(
    (Math.imul(worldX, 73856093) ^ Math.imul(worldZ, 19349663) ^ Math.imul(params.seed, 83492791)) | 0
  );
  generateTrees(treeRng, simplex, params, size, worldX, worldZ, get, set);

  return data;
}

type SetFn = (x: number, y: number, z: number, id: number) => void;
type GetFn = (x: number, y: number, z: number) => number;

const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Fractal (multi-octave) 2D noise in roughly [-1, 1]. Larger `scale` = broader
// features; more `octaves` = finer detail layered on top. Each octave samples a
// SHIFTED region of the field (the offset below) — without that, octaves at
// 1x/2x/4x the same coordinate correlate and produce grid-like artifacts.
function fbm(simplex: SimplexNoise, x: number, z: number, scale: number, octaves: number) {
  let amp = 1, freq = 1 / scale, sum = 0, norm = 0;
  let ox = 0, oz = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex.noise(x * freq + ox, z * freq + oz);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
    ox += 41.7; oz += 53.3; // decorrelate octaves
  }
  return sum / norm;
}

// Piecewise-linear spline: maps an input (e.g. continentalness) through control
// points [[x,y],...] (x ascending). Minecraft uses splines like this so oceans
// and plains stay flat while coasts are steep and mountains dramatic, rather
// than a uniform linear ramp.
function spline(t: number, points: ReadonlyArray<readonly [number, number]>) {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      return lerp(y0, y1, (t - x0) / (x1 - x0));
    }
  }
  return points[points.length - 1][1];
}

// Climate sample for biome selection. Two very-large-scale fields (temperature
// and humidity) drive which biome a column is. The sample coordinates are
// DOMAIN-WARPED by another noise so biome borders are wavy and organic instead
// of the straight iso-contour lines that cut hard across the world. A tiny
// high-frequency dither further breaks up the 1-block boundary so it reads as a
// natural ragged edge rather than a clean seam. Shared by terrain + trees so the
// two always agree on where a biome is.
//
// Scales are multiples of featureScale: temperature is the largest (deserts /
// snowy regions are huge), humidity is large (forests are big).
function climate(simplex: SimplexNoise, wx: number, wz: number, featureScale: number) {
  const warpAmp = featureScale * 0.5;
  const warpX = fbm(simplex, wx + 700, wz + 700, featureScale, 2) * warpAmp;
  const warpZ = fbm(simplex, wx + 1700, wz + 1700, featureScale, 2) * warpAmp;
  const x = wx + warpX, z = wz + warpZ;
  const dither = fbm(simplex, wx + 30000, wz + 30000, 11, 2) * 0.06;
  return {
    temp: fbm(simplex, x + 8000, z + 8000, featureScale * 5, 2) + dither,
    humid: fbm(simplex, x + 13000, z + 13000, featureScale * 3, 2) + dither,
  };
}

// Ore veins are sampled on a coarse grid (one noise3d per 2x2x2 block) rather
// than per cell — buried ore is invisible anyway and per-block sampling was 91%
// of all generation time. Veins become slightly chunkier; mining is unaffected.
const ORE_STEP = 2;

function generateResources(rng: RNG, size: ChunkSize, worldX: number, worldZ: number, resources: ResourceGenInfo[], get: GetFn, set: SetFn) {
  resources.forEach(resource => {
    const simplex = new SimplexNoise(rng); // consumes rng per resource (kept for determinism)
    for (let x = 0; x < size.width; x += ORE_STEP) {
      for (let z = 0; z < size.width; z += ORE_STEP) {
        for (let y = 0; y < size.height; y += ORE_STEP) {
          // Gate the (expensive) noise on the cell being stone — skips air/dirt
          // above the surface entirely.
          if (get(x, y, z) !== BLOCK_IDS.stone) continue;
          const val = simplex.noise3d(
            (worldX + x) / resource.scale.x,
            y / resource.scale.y,
            (worldZ + z) / resource.scale.z
          );
          if (val > resource.scarcity) {
            for (let dx = 0; dx < ORE_STEP; dx++) {
              for (let dy = 0; dy < ORE_STEP; dy++) {
                for (let dz = 0; dz < ORE_STEP; dz++) {
                  if (get(x + dx, y + dy, z + dz) === BLOCK_IDS.stone) set(x + dx, y + dy, z + dz, resource.id);
                }
              }
            }
          }
        }
      }
    }
  });
}

export type ColumnSurface = { height: number, surfaceId: number, subId: number, forest: number };
export type WorldSampler = (worldX: number, worldZ: number) => ColumnSurface;

type SurfaceConfig = {
  sea: number, baseLand: number, mountainAmp: number, featureScale: number, maxY: number,
  contSpline: ReadonlyArray<readonly [number, number]>,
};

function makeSurfaceConfig(params: ChunkParams, size: ChunkSize): SurfaceConfig {
  const sea = params.terrain.waterOffset;
  const baseLand = sea + params.terrain.offset;
  // The sea-crossing (where the curve passes through sea level) sets the
  // land/ocean ratio — pushed to fairly negative continentalness so most of the
  // map is land (oceans are big but the minority).
  return {
    sea, baseLand, mountainAmp: params.terrain.magnitude, featureScale: params.terrain.scale, maxY: size.height - 1,
    contSpline: [
      [-1.0, sea - 36],   // deep ocean (flat)
      [-0.50, sea - 18],  // open ocean
      [-0.22, sea - 4],   // continental shelf
      [-0.13, sea + 2],   // coast / beach
      [0.05, baseLand],   // lowland plains
      [0.50, baseLand + 22],
      [1.0, baseLand + 42], // high inland
    ],
  };
}

// Surface height + biome blocks for a single world column. Shared by the chunk
// terrain pass AND the world-map preview, so the map always matches the real
// terrain (same noise field, same biome rules).
function columnSurface(simplex: SimplexNoise, cfg: SurfaceConfig, wx: number, wz: number): ColumnSurface {
  const { sea, mountainAmp, featureScale } = cfg;

  // Broad land/ocean shape, redistributed through the continentalness spline.
  const cont = fbm(simplex, wx, wz, featureScale * 3.5, 4);
  let height = spline(cont, cfg.contSpline);

  // Land mask (0 at/below sea, 1 well inland) so mountains only rise on land.
  const land = clamp((height - sea) / 14, 0, 1);

  // Erosion (large scale): mountains are RARE (only quite-low erosion) and BIG.
  const erosion = fbm(simplex, wx + 9100, wz + 4200, featureScale * 2.4, 3);
  const mountainous = clamp((-0.22 - erosion) / 0.38, 0, 1);

  // Ridged noise -> ridgelines; low exponent keeps slopes broad/climbable.
  const rn = fbm(simplex, wx + 1300, wz + 1300, featureScale, 4);
  const ridge = Math.pow(1 - Math.abs(rn), 1.7);
  const mountain = ridge * mountainAmp * land * mountainous;
  height += mountain;
  height += fbm(simplex, wx + 5200, wz + 5200, 38, 2) * 2.5; // fine detail
  height = Math.floor(clamp(height, 1, cfg.maxY));

  // --- Biome surface selection ---
  const { temp, humid } = climate(simplex, wx, wz, featureScale);
  const aboveSea = height - sea;

  let surfaceId: number, subId: number;
  if (aboveSea <= 3) {
    surfaceId = BLOCK_IDS.sand; subId = BLOCK_IDS.sand;            // seabed + wide beaches
  } else if (mountain > mountainAmp * 0.5) {
    surfaceId = BLOCK_IDS.snow; subId = BLOCK_IDS.stone;           // snow-capped peaks (rare/tall)
  } else if (mountain > mountainAmp * 0.22) {
    surfaceId = BLOCK_IDS.stone; subId = BLOCK_IDS.stone;          // rocky mountainside
  } else if (temp < -0.55) {
    surfaceId = BLOCK_IDS.snow; subId = BLOCK_IDS.dirt;            // tundra / snowy plains (cold, rare)
  } else if (temp > 0.4 && humid < 0.0) {
    surfaceId = BLOCK_IDS.sand; subId = BLOCK_IDS.sand;            // desert (hot + dry, big regions)
  } else {
    surfaceId = BLOCK_IDS.grass; subId = BLOCK_IDS.dirt;           // plains / savanna / forest (dominant)
  }
  // Forest density (matches generateTrees' humidity-driven canopy) so the map
  // can shade wooded areas. Only meaningful on grass.
  const forest = clamp((humid - 0.05) / 0.4, 0, 1);
  return { height, surfaceId, subId, forest };
}

// A standalone surface sampler (its own seeded noise) for the world-map preview.
export function createWorldSampler(params: ChunkParams, size: ChunkSize): WorldSampler {
  const simplex = new SimplexNoise(new RNG(params.seed));
  const cfg = makeSurfaceConfig(params, size);
  return (wx, wz) => columnSurface(simplex, cfg, wx, wz);
}

function generateTerrain(simplex: SimplexNoise, params: ChunkParams, size: ChunkSize, worldX: number, worldZ: number, set: SetFn) {
  const cfg = makeSurfaceConfig(params, size);
  for (let x = 0; x < size.width; x++) {
    for (let z = 0; z < size.width; z++) {
      const { height, surfaceId, subId } = columnSurface(simplex, cfg, worldX + x, worldZ + z);
      for (let y = 0; y <= height; y++) {
        if (y === height) set(x, y, z, surfaceId);
        else if (y > height - 4) set(x, y, z, subId);
        else set(x, y, z, BLOCK_IDS.stone);
      }
      // Cells above `height` stay air (data is zero-initialised).
    }
  }
}

function generateTrees(rng: RNG, simplex: SimplexNoise, params: ChunkParams, size: ChunkSize, worldX: number, worldZ: number, get: GetFn, set: SetFn) {
  const generateTreeTrunk = (x: number, z: number) => {
    const minH = params.trees.trunk.minHeight;
    const maxH = params.trees.trunk.maxHeight;
    const h = Math.round(minH + (maxH - minH) * rng.random());

    for (let y = size.height - 1; y >= 0; y--) {
      if (get(x, y, z) === BLOCK_IDS.grass) {
        for (let treeY = y + 1; treeY <= y + h; treeY++) {
          set(x, treeY, z, BLOCK_IDS.tree);
        }
        generateTreeCanopy(x, y + h, z);
        break;
      }
    }
  };

  const generateTreeCanopy = (x: number, y: number, z: number) => {
    const minR = params.trees.canopy.minRadius;
    const maxR = params.trees.canopy.maxRadius;
    const r = Math.round(minR + (maxR - minR) * rng.random());
    const density = params.trees.canopy.density;

    for (let i = -maxR; i <= maxR; i++) {
      for (let j = -maxR; j <= maxR; j++) {
        for (let k = -maxR; k <= maxR; k++) {
          const n = rng.random();
          if ((i * i + j * j + k * k) > r * r) continue;
          if (get(i + x, j + y, k + z) !== BLOCK_IDS.air) continue;
          if (n < density) {
            set(x + i, y + j, z + k, BLOCK_IDS.leaves);
          }
        }
      }
    }
  };

  // Jittered-grid (blue-noise) placement: at most one candidate tree per CELL,
  // placed at a random spot within it — spaces trees naturally instead of the
  // clumping/overlap pure per-column random produces. Density is driven by the
  // same climate as the biomes, so trees match the biome they sit in:
  //   humid temperate -> forest;  very humid pockets -> dense forest (small);
  //   dry/hot grass -> savanna (sparse);  cool dry grass -> plains (sparse).
  // (Trunks only root on grass, so deserts/snow/mountains stay treeless.)
  const featureScale = params.terrain.scale;
  const CELL = 6;
  for (let gx = 0; gx < size.width; gx += CELL) {
    for (let gz = 0; gz < size.width; gz += CELL) {
      const x = gx + Math.floor(rng.random() * CELL);
      const z = gz + Math.floor(rng.random() * CELL);
      if (x < 1 || x >= size.width - 1 || z < 1 || z >= size.width - 1) continue;

      const wx = worldX + x, wz = worldZ + z;
      const { humid } = climate(simplex, wx, wz, featureScale);

      // Base canopy from humidity (big forests), plus a small-scale boost for
      // dense-forest pockets.
      let forest = clamp((humid - 0.05) / 0.4, 0, 1);
      const densePatch = (simplex.noise((wx + 41000) / 70, (wz + 41000) / 70) + 1) * 0.5;
      if (densePatch > 0.7) forest = Math.min(1, forest + 0.5);

      const prob = forest * params.trees.frequency * 22;
      if (rng.random() < prob) {
        generateTreeTrunk(x, z);
      }
    }
  }
}
