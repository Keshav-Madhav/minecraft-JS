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
    trunk: { minHeight: number, maxHeight: number },
    canopy: { minRadius: number, maxRadius: number, density: number },
    frequency: number
  },
  clouds: { scale: number, density: number }
}

export type ChunkSize = { width: number, height: number };

// Flat index into the block-id array. Layout: ((x * height) + y) * width + z
export function blockIndex(x: number, y: number, z: number, size: ChunkSize) {
  return (x * size.height + y) * size.width + z;
}

function inBounds(x: number, y: number, z: number, size: ChunkSize) {
  return x >= 0 && x < size.width && y >= 0 && y < size.height && z >= 0 && z < size.width;
}

/**
 * Generates the raw block-id data for a single chunk. Free of THREE.js/DOM so it
 * runs inside the Web Worker and the buffer transfers back zero-copy. The
 * sequence (terrain -> resources -> features) and the RNG threading must stay
 * identical to keep output deterministic for a given seed.
 */
export function generateChunkData(
  size: ChunkSize, params: ChunkParams, worldX: number, worldZ: number, resources: ResourceGenInfo[],
  outTint?: Uint8Array,   // optional: filled with the per-column climate grass tint (rgb*255, index
                          // (x*width+z)*3) so the worker can tint plants without re-sampling columnSurface
  opts?: { skipFoliage?: boolean }   // the map only reads top NON-plant blocks, so it skips the whole
                                     // foliage pass (a big, fully-wasted cost for the voxel minimap)
): Uint8Array {
  const data = new Uint8Array(size.width * size.height * size.width); // 0 == air

  const get = (x: number, y: number, z: number) =>
    inBounds(x, y, z, size) ? data[blockIndex(x, y, z, size)] : BLOCK_IDS.air;
  const set = (x: number, y: number, z: number, id: number) => {
    if (inBounds(x, y, z, size)) data[blockIndex(x, y, z, size)] = id;
  };

  // One RNG seeded ONLY by params.seed → identical SimplexNoise permutation
  // across chunks → continuous (seamless) noise field regardless of chunk pos.
  const rng = new RNG(params.seed);
  const simplex = new SimplexNoise(rng);

  // Per-column surface height + biome + top-block, filled by generateTerrain and
  // reused by generateFeatures + generateFoliage (so neither re-runs columnSurface
  // for in-chunk columns — the heavy noise cost). 16×16.
  const heightMap = new Int16Array(size.width * size.width);
  const biomeMap = new Uint8Array(size.width * size.width);
  const surfaceMap = new Uint8Array(size.width * size.width);

  generateTerrain(simplex, params, size, worldX, worldZ, set, heightMap, biomeMap, outTint, surfaceMap);
  generateResources(rng, size, worldX, worldZ, resources, get, set, biomeMap);

  // Features (trees + ground decorations). generateFeatures re-seeds its own
  // per-WORLD-CELL RNG internally (so placement is identical in every chunk that a
  // tree overhangs → seamless borders); we pass the shared simplex for the
  // continuous biome/density fields. The chunk seed below is just a placeholder.
  const treeRng = new RNG((Math.imul(worldX, 73856093) ^ Math.imul(worldZ, 19349663) ^ Math.imul(params.seed, 83492791)) | 0);
  generateFeatures(treeRng, simplex, params, size, worldX, worldZ, get, set, heightMap, biomeMap, surfaceMap);

  // Foliage runs LAST (so it never overwrites a trunk/canopy) and is placed by a
  // PURE function of world (x,z) — hashes + the shared simplex, no per-chunk RNG —
  // so dense ground cover is identical from whichever chunk samples a column
  // (seamless borders) and doesn't perturb the feature RNG sequence. The map skips
  // it: it reads only top NON-plant blocks, so foliage gen is pure wasted work and
  // skipping it doesn't change any map result (structures below are unaffected).
  if (!opts?.skipFoliage) generateFoliage(simplex, params, size, worldX, worldZ, heightMap, biomeMap, get, set);

  // Structures run LAST: they clear (air) and overwrite their footprint, so any
  // foliage/trees inside a building are removed. Multi-chunk via a deterministic
  // grid — see generateStructures.
  generateStructures(simplex, params, size, worldX, worldZ, set);

  return data;
}

type SetFn = (x: number, y: number, z: number, id: number) => void;
type GetFn = (x: number, y: number, z: number) => number;

const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// smoothstep that also ramps "downhill" (a > b → returns 1 below b, 0 above a),
// so a single helper expresses both "rises with x" and "falls with x" gates.
function sm(x: number, a: number, b: number) {
  if (a === b) return x < a ? 0 : 1;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// Stable per-column hash in [0,1) for dithered surface transitions (e.g. the
// sand↔grass scrub belt). Deterministic in (wx, wz) → apron-safe.
function hash01(wx: number, wz: number) {
  let h = Math.imul((wx | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((wz | 0) ^ 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Fractal (multi-octave) 2D noise in ~[-1,1]. Each octave samples a SHIFTED
// region so 1x/2x/4x don't correlate into grid artifacts.
function fbm(simplex: SimplexNoise, x: number, z: number, scale: number, octaves: number) {
  let amp = 1, freq = 1 / scale, sum = 0, norm = 0, ox = 0, oz = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex.noise(x * freq + ox, z * freq + oz);
    norm += amp; amp *= 0.5; freq *= 2; ox += 41.7; oz += 53.3;
  }
  return sum / norm;
}

// Piecewise-linear spline mapping continentalness → height (flat oceans/plains,
// steep coasts) the way Minecraft's terrain splines do.
function spline(t: number, points: ReadonlyArray<readonly [number, number]>) {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i][0]) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      return lerp(y0, y1, (t - x0) / (x1 - x0));
    }
  }
  return points[points.length - 1][1];
}

// ===========================================================================
//  CLIMATE  — broad noise fields shared by terrain, biome selection, the map.
// ===========================================================================
// Every field is a pure function of (wx, wz, seed): no chunk-local state, so the
// stateless worker apron (which samples neighbour height across chunk borders)
// reproduces identical results → seamless borders.
type Climate = {
  cont: number,    // continentalness  [-1,1]   ocean→inland
  erosion: number, // erosion          [-1,1]   low = mountainous
  weird: number,   // weirdness        [-1,1]   variant selector (badlands shells)
  temp: number,    // base temperature [~-0.7,0.7]
  humid: number,   // humidity         [~-0.7,0.7]
};

// Climate is sampled at VERY low frequency (one wavelength = many chunks) so
// biome regions are large with clean contours — matching Minecraft, whose
// temperature field has a ~4 km wavelength. `CLIMATE_SCALE` is the single tuning
// knob; everything else is a multiple of it. The previous version used `fs*5`
// (6× too high-frequency), a half-wavelength domain warp that FOLDED the field,
// and a high-frequency ±0.06 dither added straight into temp/humid — together
// they flipped the biome block-to-block (the "messy" mottled borders).
const CLIMATE_SCALE_MULT = 16;
function sampleClimate(simplex: SimplexNoise, fs: number, wx: number, wz: number): Climate {
  const CS = fs * CLIMATE_SCALE_MULT;        // ≈ 4160 blocks (MC temperature wavelength)
  // Domain warp at LOW frequency (the warp itself varies over ~CS blocks), so it
  // bends border contours into organic wiggles instead of shredding the field.
  const warpAmp = fs * 1.5;
  const warpX = fbm(simplex, wx + 700, wz + 700, CS, 2) * warpAmp;
  const warpZ = fbm(simplex, wx + 1700, wz + 1700, CS, 2) * warpAmp;
  // A second, SMALL, medium-frequency warp roughens biome BORDERS at the tens-of-
  // blocks scale (so edges are ragged, not clean contours) — without the per-block
  // SPECKLE the old value-dither caused. It's a COORDINATE warp (bends the border),
  // and its amplitude×frequency stays < 1 so it never folds the field (no flip-flop).
  // LOW-frequency warp (~650b wavelength): bends the whole border contour in big
  // organic curves, moving runs of columns across together — instead of a 130b
  // warp that re-crossed the boundary every ~60-130b (a value-dither in disguise
  // that mottled biome edges). Coherent ragged edge, no stipple.
  const jAmp = fs * 0.12;                                     // ≈ 31 blocks of slow wander
  const jx = fbm(simplex, wx + 330, wz + 330, fs * 2.5, 2) * jAmp;
  const jz = fbm(simplex, wx + 930, wz + 930, fs * 2.5, 2) * jAmp;
  const x = wx + warpX + jx, z = wz + warpZ + jz;
  // CONTINENTALNESS = a very-low-frequency MACRO field (3 octaves → features at
  // ~10k / 5k / 2.5k blocks: massive, huge, big landmasses & oceans) blended with
  // the original coast-scale detail. This is what gives the size HIERARCHY the
  // world needs: vast deep oceans where macro is deeply negative, huge expansive
  // continents (far-inland, rivers/lakes but no big seas) where it's high, and
  // normal-sized coasts from the detail term near the crossing. MC continentalness
  // is similarly very low frequency (continents span thousands of blocks).
  // Detail is COARSER (fs*5 ≈ 1300b) and 2-octave (was fs*3.5, 3-oct): the old fine
  // ~227b octave chattered `cont` across the STEEP coast knee of contSpline →
  // chopped/noisy coastlines. Keep the macro field (3-oct) and the detail WEIGHT
  // (0.35) so the cont VARIANCE — i.e. the land/ocean ratio (~35% ocean) — is
  // unchanged; only the fine coastline chatter is removed.
  const contMacro = fbm(simplex, wx + 41000, wz + 41000, fs * 40, 3);
  const contDetail = fbm(simplex, wx, wz, fs * 5, 2);
  return {
    cont: clamp(contMacro * 0.8 + contDetail * 0.35, -1, 1),
    erosion: fbm(simplex, wx + 9100, wz + 4200, fs * 2.4, 3),
    weird: fbm(simplex, wx + 51000, wz + 51000, CS * 0.5, 2),   // ~2080b, 2 oct (variant regions)
    temp: fbm(simplex, x + 8000, z + 8000, CS, 2),              // ~4160b, 2 oct
    humid: fbm(simplex, x + 13000, z + 13000, CS * 0.5, 2),     // ~2080b, 2 oct
  };
}

// Temperature drops with altitude (lapse rate). The biome is scored on this
// EFFECTIVE temperature, so a warm-based mountain walks up through the colder
// rows of the climate table (savanna→plains→forest) — the natural slope
// gradient. Kept MODERATE so it doesn't cold-shift the whole world (snow caps
// are handled by a separate, stronger overlay keyed on absolute height).
const LAPSE = 0.6, HSCALE = 80;
const tempLapse = (temp: number, height: number, sea: number) =>
  temp - LAPSE * Math.max(0, height - (sea + 8)) / HSCALE;

// ===========================================================================
//  BIOME REGISTRY  — data-driven for CLIMATE biomes: adding one = a BIOME id +
//  a BIOMES entry with a Voronoi `center`; selection, tint and map colour then
//  auto-derive. A SPECIAL biome (gated, e.g. badlands/swamp) additionally needs a
//  membership calc + a gate in columnSurface's priority chain, and optionally a
//  feathered height delta and/or a per-Y `band`. New BLOCK ids/textures are
//  registered separately in blockTypes.ts + blockArrayMaterial.ts.
// ===========================================================================
export const BIOME = {
  ocean: 0, beach: 1, snowy: 2, coldPlains: 3, taiga: 4, plains: 5, forest: 6,
  savanna: 7, scrub: 8, desert: 9, warmForest: 10,
  badlands: 11, redDesert: 12, cherry: 13, swamp: 14, mushroom: 15,
  // water bodies (all flooded by the single global sea plane via height-carving)
  river: 16, frozenRiver: 17, lake: 18,
  // temperature-typed oceans (ocean=0 is the normal/temperate one)
  frozenOcean: 19, coldOcean: 20, lukewarmOcean: 21, warmOcean: 22,
  iceSpikes: 23,   // rare very-cold special: snow surface studded with packed-ice spires
  // --- expansion: distinct-wood forests + varied vegetation (existing wood palette) ---
  jungle: 24,        // hot+wet: tall jungle trees (some giant), vines, dense ferns
  darkForest: 25,    // temperate+wet: thick 2×2 dark-oak, dim, mushrooms + roses
  birchForest: 26,   // temperate: slender birch, tall grass, alliums
  flowerForest: 27,  // weird forest variant: oak/birch + dense mixed flowers
  meadow: 28,        // cool grassland: flowers + tall grass, very sparse trees
  redwoodForest: 29, // cold+wet old-growth: GIANT spruce (redwood) + spruce, podzol floor
  mangroveSwamp: 30, // warm swamp: mangrove trees with prop roots
  mountains: 31,     // snow-capped rocky mountain RANGE (very-low-erosion high non-hot terrain)
} as const;

type SurfCtx = { aboveSea: number, tempEff: number, humid: number, erosion: number, wx: number, wz: number };
type Tint = { sky: number, ground: number, clear: number, bright: number };
// Declarative feature recipe — generateFeatures reads this; no per-biome code.
// Each tree key maps to a distinct generator (conical spruce, giant redwood,
// jungle, 2×2 dark-oak, slanted acacia, slender birch, mangrove-on-stilts).
type FeatureSpec = {
  oak?: number, cactus?: number, cherry?: number, giantMushroom?: number, swampOak?: number, iceSpike?: number,
  spruce?: number, redwood?: number, jungleTree?: number, darkOak?: number, acacia?: number, birch?: number, mangrove?: number,
  // decorations (ground scatter) — bushes, fallen logs, mossy boulders, dark-forest huge mushrooms
  bush?: number, fallenLog?: number, boulder?: number, hugeMushroom?: number,
  flowers?: number,   // dense-flower flag (0..1) read by the foliage pass for this biome
};

type BiomeDef = {
  name: string,
  surface: (c: SurfCtx) => { surfaceId: number, subId: number },
  band?: (y: number, height: number, sea: number) => number, // per-Y subsurface (badlands)
  features?: FeatureSpec,
  mapColor: readonly [number, number, number],
  tint: Tint,
};

// Horizontal terracotta colour bands for badlands (≈2 blocks thick, keyed to
// ABSOLUTE Y so they line up across cliffs/columns → clean mesa striping). Order
// follows the documented natural sequence (orange-dominant, interleaved with
// red/yellow/white/light-gray/brown). Kept a PURE function of y (no per-column
// noise shift) so the map worker can reproduce the exact top-band colour.
const TERRA_BANDS = [
  BLOCK_IDS.terracottaOrange, BLOCK_IDS.terracottaOrange, BLOCK_IDS.terracottaRed,
  BLOCK_IDS.terracottaOrange, BLOCK_IDS.terracottaYellow, BLOCK_IDS.terracottaOrange,
  BLOCK_IDS.terracottaWhite, BLOCK_IDS.terracottaOrange, BLOCK_IDS.terracottaLightGray,
  BLOCK_IDS.terracottaOrange, BLOCK_IDS.terracottaBrown, BLOCK_IDS.terracottaOrange,
];
const terracottaBand = (y: number) => TERRA_BANDS[Math.floor(y / 2) % TERRA_BANDS.length];

const grassSurf = () => ({ surfaceId: BLOCK_IDS.grass, subId: BLOCK_IDS.dirt });
const sandSurf = () => ({ surfaceId: BLOCK_IDS.sand, subId: BLOCK_IDS.sand });
const snowSurf = () => ({ surfaceId: BLOCK_IDS.snow, subId: BLOCK_IDS.dirt });

// Indexed by BIOME id. Climate biomes carry a Voronoi center; ocean/beach and
// the gated specials don't. Surfaces, features, map colour and ambient tint all
// live here so ONE entry fully defines a biome.
const BIOMES: BiomeDef[] = [];
BIOMES[BIOME.ocean] = {
  name: 'ocean', surface: () => ({ surfaceId: BLOCK_IDS.sand, subId: BLOCK_IDS.sand }),
  mapColor: [40, 90, 160], tint: { sky: 0xbcd6ff, ground: 0x5a6a7a, clear: 0xa8c6ee, bright: 1.12 },
};
BIOMES[BIOME.beach] = {
  // sandy beach / snowy beach (cold) / stony shore (mountainous low-erosion coast).
  name: 'beach', surface: (c) => {
    if (sm(c.erosion, -0.05, -0.35) > 0.5) {                      // stony shore at mountain coasts
      return hash01(c.wx, c.wz) < 0.3 ? { surfaceId: BLOCK_IDS.sand, subId: BLOCK_IDS.stone }
                                      : { surfaceId: BLOCK_IDS.stone, subId: BLOCK_IDS.stone };
    }
    return c.tempEff < -0.5 ? snowSurf() : sandSurf();
  },
  mapColor: [214, 203, 146], tint: { sky: 0xd8e0ee, ground: 0x9a9070, clear: 0xa8c0e2, bright: 1.05 },
};
// Climate biomes — selected by the discrete MC-style temp×humid grid (see
// selectClimate). surface/features/mapColor/tint live here; no Voronoi centers.
BIOMES[BIOME.snowy] = {
  name: 'snowy', surface: snowSurf,
  mapColor: [236, 240, 246], tint: { sky: 0xd2e2ff, ground: 0xa6bad6, clear: 0xc4d8f4, bright: 1.22 },
};
BIOMES[BIOME.coldPlains] = {
  name: 'coldPlains', surface: grassSurf, features: { oak: 0.06 },
  mapColor: [150, 170, 120], tint: { sky: 0xc6d6ec, ground: 0x6a7558, clear: 0x9fb6da, bright: 1.05 },
};
BIOMES[BIOME.taiga] = {
  // pine forest: conical spruce trees, grass with smooth podzol patches.
  name: 'taiga', surface: grassSurf, features: { spruce: 0.5, boulder: 0.02, fallenLog: 0.02 },
  mapColor: [70, 96, 68], tint: { sky: 0xaec6dc, ground: 0x3f4f38, clear: 0x86a2c2, bright: 0.94 },
};
BIOMES[BIOME.plains] = {
  name: 'plains', surface: grassSurf, features: { oak: 0.1, bush: 0.04 },
  mapColor: [120, 154, 80], tint: { sky: 0xbcd6ff, ground: 0x4d4233, clear: 0x80a0e0, bright: 1.0 },
};
BIOMES[BIOME.forest] = {
  name: 'forest', surface: grassSurf, features: { oak: 0.6, bush: 0.05, fallenLog: 0.02 },
  mapColor: [56, 96, 54], tint: { sky: 0xb0cdea, ground: 0x35452a, clear: 0x7796c4, bright: 0.9 },
};
BIOMES[BIOME.savanna] = {
  name: 'savanna', surface: grassSurf, features: { acacia: 0.07, cactus: 0.02 },
  mapColor: [170, 158, 96], tint: { sky: 0xe6e0bc, ground: 0x8a7a40, clear: 0xc4c29a, bright: 1.08 },
};
BIOMES[BIOME.scrub] = {
  // Desert↔grassland fringe: dithers sand↔grass by humidity so desert never
  // hard-borders grass. Applied as an edge feather in selectClimate, not a cell.
  name: 'scrub',
  surface: (c) => hash01(c.wx, c.wz) < sm(c.humid, -0.05, 0.18) ? grassSurf() : sandSurf(),
  features: { oak: 0.02, cactus: 0.02 },
  mapColor: [184, 172, 118], tint: { sky: 0xe0dcc0, ground: 0x80764a, clear: 0xc0c098, bright: 1.05 },
};
BIOMES[BIOME.desert] = {
  // sand over SANDSTONE (so digging/pyramids expose sandstone, MC-style).
  name: 'desert', surface: () => ({ surfaceId: BLOCK_IDS.sand, subId: BLOCK_IDS.sandstone }), features: { cactus: 0.05 },
  mapColor: [214, 203, 146], tint: { sky: 0xffe7c2, ground: 0xb59055, clear: 0xcdc6ac, bright: 1.08 },
};
BIOMES[BIOME.warmForest] = {
  name: 'warmForest', surface: grassSurf, features: { oak: 0.55, bush: 0.06 },
  mapColor: [60, 110, 72], tint: { sky: 0xb6d2c0, ground: 0x2e4226, clear: 0x84aa8c, bright: 0.95 },
};
BIOMES[BIOME.badlands] = {
  name: 'badlands', surface: () => ({ surfaceId: BLOCK_IDS.redSand, subId: BLOCK_IDS.terracottaOrange }),
  band: (y, height, sea) => {
    if (height <= sea + 5) {                       // valley floor: red sand over terracotta
      if (y > height - 2) return BLOCK_IDS.redSand;
      return y > sea - 6 ? terracottaBand(y) : BLOCK_IDS.stone;
    }
    return y > sea - 6 ? terracottaBand(y) : BLOCK_IDS.stone; // plateau: banded top-to-bottom
  },
  features: { cactus: 0.04 },
  mapColor: [196, 104, 52], tint: { sky: 0xffc98c, ground: 0x8a4a24, clear: 0xe0a866, bright: 1.10 },
};
BIOMES[BIOME.redDesert] = {
  name: 'redDesert', surface: () => ({ surfaceId: BLOCK_IDS.redSand, subId: BLOCK_IDS.redSand }),
  features: { cactus: 0.05 },
  mapColor: [188, 92, 58], tint: { sky: 0xffcf9a, ground: 0x9a5630, clear: 0xe8a866, bright: 1.08 },
};
BIOMES[BIOME.cherry] = {
  name: 'cherry', surface: grassSurf, features: { cherry: 0.5 },
  mapColor: [222, 154, 192], tint: { sky: 0xf6c9e0, ground: 0x6a5560, clear: 0xe7b6cf, bright: 1.06 },
};
BIOMES[BIOME.swamp] = {
  name: 'swamp',
  surface: (c) => hash01(c.wx, c.wz) < 0.3 ? grassSurf() : { surfaceId: BLOCK_IDS.mud, subId: BLOCK_IDS.dirt },
  features: { swampOak: 0.16 },
  mapColor: [92, 116, 96], tint: { sky: 0x9fb08a, ground: 0x37402a, clear: 0x6e7a5a, bright: 0.82 },
};
BIOMES[BIOME.mushroom] = {
  name: 'mushroom',
  surface: (c) => c.aboveSea > 0 ? { surfaceId: BLOCK_IDS.mycelium, subId: BLOCK_IDS.stone }
                                  : { surfaceId: BLOCK_IDS.stone, subId: BLOCK_IDS.stone },
  features: { giantMushroom: 0.4 },
  mapColor: [128, 112, 134], tint: { sky: 0xc8b6cf, ground: 0x4a4252, clear: 0x9a86a6, bright: 0.92 },
};
// --- water bodies (carved trenches/basins flooded by the global sea plane) ---
const sandyBed = () => ({ surfaceId: BLOCK_IDS.sand, subId: BLOCK_IDS.dirt });
const rockyBed = () => ({ surfaceId: BLOCK_IDS.stone, subId: BLOCK_IDS.stone });
BIOMES[BIOME.river] = {
  name: 'river', surface: sandyBed,
  mapColor: [58, 110, 180], tint: { sky: 0xbcd6ff, ground: 0x5a6a7a, clear: 0xa8c6ee, bright: 1.10 },
};
BIOMES[BIOME.frozenRiver] = {
  name: 'frozenRiver', surface: () => ({ surfaceId: BLOCK_IDS.snow, subId: BLOCK_IDS.sand }),
  mapColor: [196, 214, 232], tint: { sky: 0xd2e2ff, ground: 0xa6bad6, clear: 0xc4d8f4, bright: 1.18 },
};
BIOMES[BIOME.lake] = {
  name: 'lake', surface: sandyBed,
  mapColor: [48, 96, 150], tint: { sky: 0xbcd6ff, ground: 0x5a6a7a, clear: 0xa8c6ee, bright: 1.08 },
};
// Temperature-typed oceans (warm/lukewarm sand floors; cold/frozen/normal rocky).
BIOMES[BIOME.frozenOcean] = {
  name: 'frozenOcean', surface: rockyBed,
  mapColor: [74, 95, 176], tint: { sky: 0xd2e2ff, ground: 0x7a86a6, clear: 0xb8caee, bright: 1.12 },
};
BIOMES[BIOME.coldOcean] = {
  name: 'coldOcean', surface: rockyBed,
  mapColor: [53, 90, 154], tint: { sky: 0xbcd0ee, ground: 0x5a6a7a, clear: 0xa0bce6, bright: 1.10 },
};
BIOMES[BIOME.lukewarmOcean] = {
  name: 'lukewarmOcean', surface: sandyBed,
  mapColor: [58, 147, 200], tint: { sky: 0xc0e2f0, ground: 0x6a8a8a, clear: 0xa8d2ec, bright: 1.12 },
};
BIOMES[BIOME.warmOcean] = {
  name: 'warmOcean', surface: sandyBed,
  mapColor: [47, 179, 196], tint: { sky: 0xc8f0f0, ground: 0x6aa8a8, clear: 0xaceaec, bright: 1.14 },
};
BIOMES[BIOME.iceSpikes] = {
  name: 'iceSpikes', surface: snowSurf, features: { iceSpike: 0.6 },
  mapColor: [200, 220, 240], tint: { sky: 0xd6e8ff, ground: 0xa6bad6, clear: 0xcfe4fb, bright: 1.24 },
};
BIOMES[BIOME.mountains] = {
  // Snow-capped rocky RANGE: bare-stone flanks (the elevation overlay snow-caps the
  // upper reaches via the lapse line), sparse alpine spruce + the odd packed-ice
  // formation ("frozen cascade"), and a mossy boulder here and there.
  name: 'mountains', surface: () => ({ surfaceId: BLOCK_IDS.stone, subId: BLOCK_IDS.stone }),
  features: { spruce: 0.05, boulder: 0.03, iceSpike: 0.02 },
  mapColor: [156, 158, 164], tint: { sky: 0xcdd9ec, ground: 0x74787e, clear: 0xa6bcd8, bright: 1.08 },
};
// --- expansion biomes (distinct wood + vegetation; selected by the grid/gates) ---
BIOMES[BIOME.jungle] = {
  // dense canopy: tall jungle trees (some giant 2×2) + leafy bushes + vines + ferns.
  name: 'jungle', surface: grassSurf, features: { jungleTree: 0.82, bush: 0.12 },
  mapColor: [44, 110, 40], tint: { sky: 0xb8d8b0, ground: 0x274d22, clear: 0x86b48c, bright: 0.9 },
};
BIOMES[BIOME.darkForest] = {
  // roofed forest: very dense 2×2 dark-oak (overlapping canopies) + huge mushrooms,
  // bushes, fallen logs; mushroom + rose-bush + leaf-litter floor (foliage pass).
  name: 'darkForest', surface: grassSurf, features: { darkOak: 0.5, hugeMushroom: 0.04, bush: 0.05, fallenLog: 0.03 },
  mapColor: [40, 74, 38], tint: { sky: 0xa6bcc4, ground: 0x283820, clear: 0x6e8478, bright: 0.8 },
};
BIOMES[BIOME.birchForest] = {
  name: 'birchForest', surface: grassSurf, features: { birch: 0.55, bush: 0.05, fallenLog: 0.02, flowers: 0.04 },
  mapColor: [104, 148, 78], tint: { sky: 0xc8dce6, ground: 0x4a5a36, clear: 0x9fb6c8, bright: 0.98 },
};
BIOMES[BIOME.flowerForest] = {
  // wooded WITH flowers — denser tree cover than before so it reads as a forest,
  // not just a flowery field (the foliage pass lays the dense flower patches).
  name: 'flowerForest', surface: grassSurf, features: { oak: 0.06, birch: 0.04, bush: 0.06, flowers: 0.42 },
  mapColor: [96, 150, 72], tint: { sky: 0xc6dcf0, ground: 0x44542e, clear: 0x96b6dc, bright: 1.0 },
};
BIOMES[BIOME.meadow] = {
  // open grassland: very rare lone tree, wildflower gradients (foliage pass).
  name: 'meadow', surface: grassSurf, features: { oak: 0.012, bush: 0.02, flowers: 0.22 },
  mapColor: [128, 172, 96], tint: { sky: 0xc8e0f4, ground: 0x5a6a3e, clear: 0x9ec0e8, bright: 1.06 },
};
BIOMES[BIOME.redwoodForest] = {
  // old-growth: giant spruce (redwood) + regular spruce over a podzol floor, with
  // mossy-cobble boulders + fallen logs. One feature per cell, but the cumulative
  // dispatch means BOTH redwood (0.3) and spruce (0.42) appear across the biome at
  // their declared rates (the old elif-chain starved the second one).
  name: 'redwoodForest', surface: grassSurf, features: { redwood: 0.3, spruce: 0.42, boulder: 0.05, fallenLog: 0.04 },
  mapColor: [62, 84, 54], tint: { sky: 0xa4c0c0, ground: 0x2c3a28, clear: 0x7a9690, bright: 0.86 },
};
BIOMES[BIOME.mangroveSwamp] = {
  name: 'mangroveSwamp',
  surface: (c) => hash01(c.wx, c.wz) < 0.4 ? { surfaceId: BLOCK_IDS.mud, subId: BLOCK_IDS.dirt } : grassSurf(),
  features: { mangrove: 0.5, bush: 0.05 },
  mapColor: [70, 102, 74], tint: { sky: 0x9fb89a, ground: 0x35422c, clear: 0x6e8268, bright: 0.86 },
};

// --- Minecraft-style discrete climate grid -------------------------------
// Bucket temperature & humidity into 5 levels each (verbatim MC 1.18 boundaries)
// and look up a 5×5 table. Adjacent cells differ by ONE step, so transitions are
// clean and "true"; with the low-frequency climate fields the level boundaries
// are smooth contours (no per-pixel speckle). Variants flip on weirdness sign.
// Boundaries calibrated to OUR 2-octave fbm distribution (measured: temp/humid
// bulk in [-0.5,0.5], med ~0) so each of the 5 levels is meaningfully occupied —
// MC's verbatim boundaries assume a wider-spread noise and left T0/T4 nearly
// empty. The 5×5 grid LAYOUT (below) is the faithful part; the cut points are
// just where our noise lands. temp T4≈top 13% (deserts/badlands), humid kept ~MC.
const tempLevel = (t: number) => t < -0.42 ? 0 : t < -0.16 ? 1 : t < 0.15 ? 2 : t < 0.40 ? 3 : 4;
const humidLevel = (h: number) => h < -0.35 ? 0 : h < -0.1 ? 1 : h < 0.1 ? 2 : h < 0.3 ? 3 : 4;

// Per-column dither added to temp/humid ONLY for grid bucketing: it's a tiny
// uncorrelated jitter, so it can only flip a column that's ALREADY within this
// much of a level boundary → a stippled few-blocks-wide transition band where
// the two neighbour biomes interleave (MC-style edge blend), while interior
// columns (far from any boundary) never flip. Bigger = wider/messier band.
const BORDER_DITHER = 0.022;
// The badlands/red-desert/desert shells dither their TAG field so the borders
// stipple a little. Kept modest — a big value made the red↔yellow-desert / badlands
// edges look too noisy. (Scaled by `flatness` at the call site so it also fades
// where a mountain meets the edge.)
const SHELL_DITHER = 0.03;

const _S = BIOME;
// MIDDLE[tempLevel][humidLevel] → biome id. Now uses the full wood palette for
// distinct forests: cold→snowy/taiga(spruce)/redwoodForest(giant spruce);
// cool/temperate→meadow/birchForest/forest/darkForest(dark-oak); warm→savanna
// (acacia)/warmForest/jungle; hot→desert/jungle. Weird flips add flowerForest
// (rare) and meadow variants; the swamp gate splits cold→swamp / warm→mangrove.
const MIDDLE: number[][] = [
  /*T0 cold */ [_S.snowy,      _S.snowy,   _S.snowy,       _S.taiga,      _S.redwoodForest],
  /*T1      */ [_S.coldPlains, _S.meadow,  _S.birchForest, _S.taiga,      _S.redwoodForest],
  /*T2 temp */ [_S.plains,     _S.meadow,  _S.birchForest, _S.forest,     _S.darkForest],
  /*T3 warm */ [_S.savanna,    _S.savanna, _S.plains,      _S.warmForest, _S.jungle],
  /*T4 hot  */ [_S.desert,     _S.desert,  _S.savanna,     _S.jungle,     _S.jungle],
];

// Ocean biome by temperature level (reuses tempLevel — MC types oceans by the
// same temperature field as land). Index 2 (temperate) is the normal `ocean`.
const OCEAN_BY_LEVEL = [BIOME.frozenOcean, BIOME.coldOcean, BIOME.ocean, BIOME.lukewarmOcean, BIOME.warmOcean];

function selectClimate(temp: number, humid: number, weird: number): number {
  const tl = tempLevel(temp), hl = humidLevel(humid);
  let id = MIDDLE[tl][hl];
  // Weirdness variants for extra variety (rare positive-weird tail, ~top 13%):
  // a forest/birch becomes a flower-forest; flat plains occasionally a meadow.
  if ((id === _S.forest || id === _S.birchForest) && weird > 0.5) id = _S.flowerForest;
  else if (id === _S.plains && weird > 0.58) id = _S.meadow;
  // Desert edge feather → scrub (sand↔grass dither) so desert dissolves into
  // grassland rather than hard-cutting. A THIN fringe only: just inside the cool
  // (T4 starts 0.40) or wet (H2 top 0.10) edge — NOT the cell interior.
  if (id === _S.desert && (temp < 0.44 || humid > 0.07)) id = _S.scrub;
  return id;
}

// Public accessor so main.ts (ambient tint) stays data-driven. (Map colour goes
// through surfaceMapColor below, which reflects the actual rendered top block.)
export const biomeTint = (id: number): Tint => BIOMES[id].tint;
export const BIOME_COUNT = BIOMES.length;

// Global water-plane colour to lerp toward when the player is over a given biome
// (oceans typed by temperature; rivers/lakes freshwater; land → the normal hue).
const WATER_HEX: Record<number, number> = {
  [BIOME.frozenOcean]: 0x4a5fb0, [BIOME.coldOcean]: 0x355a9a, [BIOME.ocean]: 0x2f6aa6,
  [BIOME.lukewarmOcean]: 0x3a93c8, [BIOME.warmOcean]: 0x2fb3c4,
  [BIOME.river]: 0x356f9e, [BIOME.frozenRiver]: 0x4a5fb0, [BIOME.lake]: 0x356f9e,
};
export const biomeWaterHex = (id: number): number => WATER_HEX[id] ?? 0x2f6aa6;

// --- Map colour from the ACTUAL rendered top block -----------------------
// The minimap/world-map must show what you'd see from above: the real top block,
// not a flat per-biome colour. Climate biomes already bake their snow-cap/rock
// overlay into `surfaceId`, so colouring by surfaceId reflects it; grass is tinted
// per-biome (plains vs forest vs savanna…), and badlands columns reproduce the
// terracotta band. Single source of truth, lives next to the surface logic.
const GRASS_TINT: Record<number, readonly [number, number, number]> = {
  [BIOME.plains]: [120, 154, 80], [BIOME.coldPlains]: [150, 170, 120],
  [BIOME.forest]: [56, 96, 54], [BIOME.warmForest]: [60, 110, 72],
  [BIOME.taiga]: [70, 96, 68], [BIOME.savanna]: [170, 158, 96],
  [BIOME.scrub]: [150, 160, 96], [BIOME.cherry]: [196, 150, 186], [BIOME.swamp]: [90, 116, 86],
  // expansion biomes
  [BIOME.jungle]: [44, 122, 40], [BIOME.darkForest]: [40, 78, 38],
  [BIOME.birchForest]: [108, 152, 78], [BIOME.flowerForest]: [96, 150, 72],
  [BIOME.meadow]: [128, 172, 96], [BIOME.redwoodForest]: [62, 88, 54],
  [BIOME.mangroveSwamp]: [78, 110, 78],
};
// Per-biome grass tint for FOLIAGE, normalised to 0..1 (and lifted a touch so the
// near-grayscale plant textures read as lush vegetation that matches the ground,
// not a dark olive). Defaults to plains for non-grassy biomes / unknown ids. The
// mesher bakes this into plant vertices, so a new biome's foliage colour comes
// from its GRASS_TINT entry with no extra wiring. MC-style grayscale × biome tint.
export function foliageGrassTint(biome: number): readonly [number, number, number] {
  const c = GRASS_TINT[biome] ?? GRASS_TINT[BIOME.plains];
  const k = 1.55 / 255;
  return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
}

const TERRA_COLOR: Record<number, readonly [number, number, number]> = {
  [BLOCK_IDS.terracottaOrange]: [196, 104, 52], [BLOCK_IDS.terracottaRed]: [152, 62, 42],
  [BLOCK_IDS.terracottaYellow]: [200, 158, 72], [BLOCK_IDS.terracottaWhite]: [210, 188, 168],
  [BLOCK_IDS.terracottaLightGray]: [140, 124, 112], [BLOCK_IDS.terracottaBrown]: [110, 78, 56],
};
export function surfaceMapColor(surfaceId: number, biome: number, height: number, sea: number): readonly [number, number, number] {
  // Water bodies: the map should show WATER (blue) from above, not the bed block.
  // Per-biome water hues so the minimap distinguishes ocean temperature + rivers.
  switch (biome) {
    case BIOME.river: return [58, 110, 180];
    case BIOME.frozenRiver: return [196, 214, 232];
    case BIOME.lake: return [48, 96, 150];
    case BIOME.frozenOcean: return [74, 95, 176];
    case BIOME.coldOcean: return [53, 90, 154];
    case BIOME.ocean: return [40, 90, 160];
    case BIOME.lukewarmOcean: return [58, 147, 200];
    case BIOME.warmOcean: return [47, 179, 196];
  }
  // Badlands: the rendered top is band-driven (redSand cap on valley floors,
  // terracotta on plateaus), not the nominal surfaceId.
  if (biome === BIOME.badlands) {
    return height <= sea + 8 ? [188, 92, 58] : (TERRA_COLOR[terracottaBand(height)] ?? [196, 104, 52]);
  }
  switch (surfaceId) {
    case BLOCK_IDS.snow: return [236, 240, 246];
    case BLOCK_IDS.stone: return [128, 128, 130];
    case BLOCK_IDS.sand: return [214, 203, 146];
    case BLOCK_IDS.redSand: return [188, 92, 58];
    case BLOCK_IDS.mud: return [74, 62, 46];
    case BLOCK_IDS.mycelium: return [128, 112, 134];
    case BLOCK_IDS.podzol: return [78, 58, 40];
    case BLOCK_IDS.gravel: return [124, 120, 114];
    case BLOCK_IDS.clay: return [160, 166, 178];
    case BLOCK_IDS.sandstone: return [226, 214, 168];
    case BLOCK_IDS.dirt: return [120, 100, 78];
    default: return GRASS_TINT[biome] ?? [120, 154, 80]; // grass
  }
}

// Top-down map colour for ANY block id — used by the VOXEL-accurate map, which
// reads the real top block of each generated column (so structures, ice spikes,
// terrain changes all show with no separate map logic to maintain). Grass is
// tinted by the caller (climate tint); everything else has a fixed colour here.
const B = BLOCK_IDS;
const BLOCK_MAP_COLOR: Record<number, readonly [number, number, number]> = {
  [B.grass]: [110, 150, 80], [B.dirt]: [120, 100, 78], [B.stone]: [128, 128, 130],
  [B.coalOre]: [60, 60, 64], [B.ironOre]: [150, 130, 116], [B.sand]: [214, 203, 146],
  [B.snow]: [236, 240, 246], [B.tree]: [104, 78, 48], [B.leaves]: [54, 92, 52],
  [B.cherryLog]: [120, 86, 92], [B.cherryLeaves]: [222, 154, 192],
  [B.mycelium]: [128, 112, 134], [B.redSand]: [188, 92, 58],
  [B.terracottaOrange]: [196, 104, 52], [B.terracottaWhite]: [210, 188, 168], [B.terracottaYellow]: [200, 158, 72],
  [B.terracottaRed]: [152, 62, 42], [B.terracottaBrown]: [110, 78, 56], [B.terracottaLightGray]: [140, 124, 112],
  [B.mud]: [74, 62, 46], [B.cactus]: [90, 126, 60], [B.mushroomRed]: [196, 56, 52],
  [B.mushroomBrown]: [150, 112, 84], [B.mushroomStem]: [200, 192, 180],
  [B.ice]: [156, 196, 238], [B.packedIce]: [190, 216, 242], [B.podzol]: [88, 66, 42],
  [B.cobblestone]: [128, 128, 132], [B.oakPlanks]: [176, 138, 82], [B.birchPlanks]: [214, 198, 154],
  [B.darkOakPlanks]: [79, 58, 34], [B.junglePlanks]: [169, 116, 75], [B.strippedOakLog]: [184, 150, 90],
  [B.birchLog]: [216, 210, 196], [B.darkOakLog]: [74, 58, 40], [B.jungleLog]: [93, 74, 46],
  [B.birchLeaves]: [127, 174, 74], [B.darkOakLeaves]: [51, 92, 38], [B.jungleLeaves]: [63, 142, 42],
  [B.gravel]: [124, 120, 114], [B.clay]: [160, 166, 178], [B.sandstone]: [226, 214, 168], [B.glass]: [196, 224, 236],
};
// shaped + decorative blocks → map colour by material (slabs/stairs/fences/doors)
const _MC_WOOD: readonly [number, number, number] = [176, 138, 82];
const _MC_COB: readonly [number, number, number] = [128, 128, 132];
const _MC_STN: readonly [number, number, number] = [128, 128, 130];
const _MC_SND: readonly [number, number, number] = [226, 214, 168];
for (const id of [B.oakSlab, B.oakStairsPX, B.oakStairsNX, B.oakStairsPZ, B.oakStairsNZ, B.oakFence,
  B.oakDoorLowerClosed, B.oakDoorUpperClosed, B.oakDoorLowerOpen, B.oakDoorUpperOpen, B.oakTrapdoorClosed, B.oakTrapdoorOpen]) BLOCK_MAP_COLOR[id] = _MC_WOOD;
for (const id of [B.cobbleSlab, B.cobbleStairsPX, B.cobbleStairsNX, B.cobbleStairsPZ, B.cobbleStairsNZ, B.cobbleFence]) BLOCK_MAP_COLOR[id] = _MC_COB;
for (const id of [B.stoneSlab, B.stoneStairsPX, B.stoneStairsNX, B.stoneStairsPZ, B.stoneStairsNZ]) BLOCK_MAP_COLOR[id] = _MC_STN;
for (const id of [B.sandstoneSlab, B.sandstoneStairsPX, B.sandstoneStairsNX, B.sandstoneStairsPZ, B.sandstoneStairsNZ]) BLOCK_MAP_COLOR[id] = _MC_SND;
BLOCK_MAP_COLOR[B.stoneBricks] = [142, 142, 146]; BLOCK_MAP_COLOR[B.bricks] = [156, 74, 54];
BLOCK_MAP_COLOR[B.mossyCobblestone] = [104, 118, 92]; BLOCK_MAP_COLOR[B.smoothStone] = [166, 166, 170];
BLOCK_MAP_COLOR[B.bookshelf] = [150, 108, 64]; BLOCK_MAP_COLOR[B.glowstone] = [216, 176, 90];
// expansion set → map colours (≈ each texture's base tone)
for (const [id, col] of [
  [B.andesite, [138, 138, 142]], [B.diorite, [206, 206, 208]], [B.granite, [169, 119, 106]],
  [B.polishedAndesite, [132, 132, 138]], [B.polishedDiorite, [204, 204, 205]], [B.polishedGranite, [166, 119, 106]],
  [B.deepslate, [72, 72, 80]], [B.tuff, [110, 112, 102]], [B.calcite, [220, 220, 216]],
  [B.basalt, [74, 74, 80]], [B.blackstone, [44, 42, 48]], [B.netherrack, [106, 40, 40]], [B.endStone, [218, 216, 168]],
  [B.obsidian, [26, 22, 40]], [B.magma, [120, 60, 30]], [B.quartzBlock, [230, 226, 218]], [B.quartzPillar, [222, 218, 210]],
  [B.netherBricks, [62, 34, 38]], [B.prismarine, [74, 138, 130]], [B.prismarineBricks, [82, 151, 142]], [B.seaLantern, [212, 236, 228]],
  [B.crackedStoneBricks, [128, 128, 132]], [B.chiseledStoneBricks, [138, 138, 142]], [B.mossyStoneBricks, [110, 124, 98]],
  [B.cutSandstone, [222, 210, 162]], [B.smoothSandstone, [224, 212, 164]], [B.chiseledSandstone, [220, 208, 160]],
  [B.redSandstone, [174, 87, 34]], [B.cutRedSandstone, [170, 85, 33]],
  [B.goldOre, [180, 160, 90]], [B.diamondOre, [120, 190, 190]], [B.emeraldOre, [80, 150, 90]],
  [B.lapisOre, [70, 90, 150]], [B.redstoneOre, [150, 70, 70]], [B.copperOre, [160, 110, 90]],
  [B.goldBlock, [233, 195, 58]], [B.diamondBlock, [95, 224, 216]], [B.emeraldBlock, [46, 168, 78]], [B.ironBlock, [216, 216, 218]],
  [B.lapisBlock, [42, 76, 154]], [B.redstoneBlock, [160, 24, 24]], [B.copperBlock, [192, 106, 72]], [B.coalBlock, [28, 28, 32]],
  [B.acaciaPlanks, [176, 92, 52]], [B.sprucePlanks, [107, 79, 48]], [B.mangrovePlanks, [138, 63, 58]], [B.cherryPlanks, [224, 176, 176]],
  [B.acaciaLog, [111, 111, 99]], [B.spruceLog, [62, 47, 28]], [B.mangroveLog, [90, 51, 48]],
  [B.acaciaLeaves, [111, 143, 58]], [B.spruceLeaves, [58, 90, 62]], [B.mangroveLeaves, [79, 138, 58]], [B.hayBale, [184, 154, 48]],
  [B.woolWhite, [233, 236, 236]], [B.woolOrange, [240, 118, 19]], [B.woolMagenta, [189, 68, 179]], [B.woolLightBlue, [58, 175, 217]],
  [B.woolYellow, [248, 198, 39]], [B.woolLime, [112, 185, 25]], [B.woolPink, [237, 141, 172]], [B.woolGray, [62, 68, 71]],
  [B.woolLightGray, [142, 142, 134]], [B.woolCyan, [21, 137, 145]], [B.woolPurple, [121, 42, 172]], [B.woolBlue, [53, 57, 157]],
  [B.woolBrown, [114, 71, 40]], [B.woolGreen, [84, 109, 27]], [B.woolRed, [161, 39, 34]], [B.woolBlack, [20, 21, 25]],
  [B.lantern, [232, 196, 110]], [B.torch, [228, 176, 86]], [B.campfire, [198, 96, 44]], [B.jackOLantern, [222, 132, 42]],
  [B.furnace, [96, 96, 100]], [B.furnaceLit, [150, 96, 50]], [B.craftingTable, [150, 116, 70]],
  [B.chest, [150, 108, 58]], [B.bedFoot, [176, 46, 44]], [B.bedHead, [200, 90, 86]], [B.barrel, [128, 98, 58]],
] as const) {
  BLOCK_MAP_COLOR[id] = col;
}
export function blockMapColor(id: number): readonly [number, number, number] {
  return BLOCK_MAP_COLOR[id] ?? [120, 154, 80];
}

export type ColumnSurface = {
  height: number, surfaceId: number, subId: number, biome: number,
  temp: number, humid: number,   // elevation-adjusted temperature + humidity (for climate grass tint)
};
export type WorldSampler = (worldX: number, worldZ: number) => ColumnSurface;

type SurfaceConfig = {
  sea: number, baseLand: number, mountainAmp: number, featureScale: number, maxY: number,
  contSpline: ReadonlyArray<readonly [number, number]>,
};

function makeSurfaceConfig(params: ChunkParams, size: ChunkSize): SurfaceConfig {
  const sea = params.terrain.waterOffset;
  const baseLand = sea + params.terrain.offset;
  return {
    sea, baseLand, mountainAmp: params.terrain.magnitude, featureScale: params.terrain.scale, maxY: size.height - 1,
    // Two-terrace ocean basin: a deep plateau offshore and a shallow shelf hugging
    // the coast, with a steep shelf-slope between — so oceans read as basins with a
    // continental shelf, not a flat noise dip. Land segments (cont≥0.05) unchanged.
    contSpline: [
      [-1.0, sea - 64],    // deep-ocean floor
      [-0.60, sea - 52],   // deep plateau (near-flat)
      [-0.455, sea - 40],  // deep→shallow knee
      [-0.30, sea - 16],   // continental shelf (near-flat)
      [-0.19, sea - 6],    // coast lip
      [-0.13, sea + 2],    // waterline crossing (unchanged → land/ocean ratio preserved)
      [0.05, baseLand], [0.50, baseLand + 18], [1.0, baseLand + 32],  // headroom for tall mountain ranges
    ],
  };
}

// ===========================================================================
//  COLUMN SURFACE  — the heart: climate → height (with feathered special
//  transforms) → biome (specials by gate, else climate Voronoi) → surface.
// ===========================================================================
function columnSurface(simplex: SimplexNoise, cfg: SurfaceConfig, wx: number, wz: number): ColumnSurface {
  const { sea, mountainAmp, featureScale: fs } = cfg;
  const c = sampleClimate(simplex, fs, wx, wz);

  // --- base relief (float; floored ONCE at the end so there are no 1-block steps) ---
  let baseH = spline(c.cont, cfg.contSpline);
  const land = clamp((baseH - sea) / 14, 0, 1);
  // Mountain RANGES, not pervasive lumps. The previous form averaged ~0.56 ridge
  // (1-|fbm| clusters near 0.73 → pow 1.9 ≈ 0.56) over a mask covering ~44% of land
  // ×1.25 → most land got tens of blocks of DC uplift ("everywhere is bumpy"). Fix:
  //  • narrower mask (onset -0.20, squared) → ranges in ~25% of land, clustered;
  //  • pow(...,3) + a -0.12 FLOOR → ground BETWEEN ridgelines sits at 0 (flat),
  //    only the |n|≈0 ridgelines rise → genuine connected ranges;
  //  • drop the ×1.25 and the fine octaves (the jagged spines).
  const mountainous = sm(c.erosion, -0.20, -0.55);
  // RANGE gate: ONLY the strongest (very-low-erosion) COOL terrain becomes an
  // extreme, snow-capped mountain RANGE. Everywhere else, low-erosion terrain gets
  // just the modest BASE amplitude (mountainAmp) → normal mounds / small peaks, so a
  // random mountain between desert & forest no longer spikes to world height. The
  // EXTRA height is added only where rangeGate is high (and that same gate tags the
  // `mountains` biome below, so the tall ranges and the snowy biome coincide).
  const rangeGate = sm(c.erosion, -0.32, -0.62) * (1 - sm(c.temp, 0.0, 0.20));
  const rA = fbm(simplex, wx + 1300, wz + 1300, fs * 2.2, 3);    // big primary ridgelines (~570b)
  const rB = fbm(simplex, wx + 4300, wz + 2300, fs * 1.3, 2);    // coarse secondary ridges
  let ridge = Math.pow(1 - Math.abs(rA), 3) * 0.85 + Math.pow(1 - Math.abs(rB), 3) * 0.15;
  ridge = Math.max(0, ridge - 0.12);                            // flat between ridgelines
  // Range bonus capped at 90 (not higher) so the worst case — spline ceiling
  // (baseLand+32 ≈ 170) + ridge(0.88)·(60+90) + ripple ≈ 304 — stays safely under
  // maxY (319), i.e. no FLAT-TOPPED peaks clipped against the world ceiling.
  const relief = ridge * land * (mountainous * mountainous) * (mountainAmp + 90 * rangeGate);
  baseH += relief;
  // Fine ground ripple, gated to land (×land) so plains/coast stay smooth (it used
  // to ripple every column incl. beaches → ragged shorelines).
  baseH += fbm(simplex, wx + 5200, wz + 5200, 48, 2) * 1.5 * land;

  // Biome-border dither fades out where there's mountain RELIEF: a slope/mountain
  // meeting a biome edge should be a clean line (the height change defines the
  // border), not a stippled mess. Full dither on flat ground, ~0 on mountains.
  const flatness = 1 - sm(relief, 6, 28);

  // Seabed relief: roughen ONLY the deep ocean floor (dunes/trenches), ramped in by
  // depth so the coast lip and shelf stay clean. Pure per-column → apron-safe.
  const submerge = sm(baseH, sea, sea - 10);                       // 0 at coast → 1 deep
  if (submerge > 0) {
    baseH += fbm(simplex, wx + 81000, wz + 81000, fs * 0.8, 3) * 4.5 * submerge;
  }

  // --- special-biome memberships (smooth 0..1) and FEATHERED height deltas ---
  // Every per-biome height change is delta*membership, so it vanishes
  // continuously at the niche edge — no terrain cliffs at biome borders.
  let height = baseH;

  // BADLANDS NEST — big, rare, and RINGED. Driven by ONE dedicated very-low-freq
  // "massif" field (wider than the climate fields → each occurrence is a large
  // contiguous region), gated to hot+dry land. Concentric thresholds on the SAME
  // monotone field give nested shells that are spatially ordered by construction:
  //   massif high → badlands core → red-desert ring → desert ring → (savanna…).
  // BADLANDS as a SINGLE continuous `mesaField` = the big "massif" noise pushed
  // DOWN by how non-arid the climate is. Peaks only rise where the land is warm &
  // dry (so badlands sit in hot-dry land), and because every shell is a threshold
  // on this ONE field, they are concentric BY CONSTRUCTION — core → red-desert →
  // desert, outward — regardless of climate-field orientation (the previous bug:
  // massif × independent arid let peaks straddle the arid edge so the ring died).
  const hot = sm(c.temp, 0.12, 0.30);          // warm-ish (T3+)
  const dry = 1 - sm(c.humid, 0.10, 0.32);     // not-wet
  const arid = hot * dry * land;               // 0..1 smooth climate aridity
  let badlandsMem = 0, redDesertMem = 0, desertRing = 0;
  {
    const massif = fbm(simplex, wx + 61000, wz + 61000, fs * 22, 2);   // ≈5700b → huge regions
    const mesaField = massif - (1 - arid) * 1.3;   // CLEAN field — drives the (smooth) mesa height

    // Mesa UPLIFT from the CLEAN field, and 0 at the badlands tag boundary (0.54)
    // so the mesa rises only inside the core (red-desert ring stays flat) and the
    // surface has no dither-induced roughness.
    const badCore = sm(mesaField, 0.54, 0.64);
    if (badCore > 0) {
      const lowEro = 1 - sm(c.erosion, -0.30, 0.20);                  // steep mesa at low erosion
      const mesaN = fbm(simplex, wx + 62000, wz + 62000, fs * 4, 3);  // big rolling plateau
      const plateau = clamp((mesaN + 0.2) * 1.2, 0, 1);              // SMOOTH (no quantization)
      height += badCore * (10 + plateau * 55 * lowEro);
    }

    // Biome TAGS from a DITHERED copy of the field → the shell borders stipple/
    // interleave (esp. the wide red-desert ↔ desert edge) instead of clean rings.
    // Dithering only the TAGS (not the height field above) keeps the mesa smooth.
    // Shell dither is small + NOT flatness-scaled (flatness tracks mountain relief,
    // which is unrelated to the mesa — the scaling was arbitrary). Thin ragged ring.
    const mfd = mesaField + (hash01(wx + 777, wz + 777) - 0.5) * SHELL_DITHER;
    badlandsMem = sm(mfd, 0.54, 0.62);
    // Red-desert ring WIDENED (mesaField ~0.30..0.56 → ≈250-block-thick band) per
    // request, so it's a substantial apron around the mesa, not a thin line.
    redDesertMem = sm(mfd, 0.24, 0.36) * (1 - sm(mfd, 0.54, 0.62));
    desertRing = sm(mfd, 0.10, 0.20) * (1 - sm(mfd, 0.24, 0.36));
  }

  // Swamp — MC drives it off high EROSION near sea level (flat, wet lowland), not
  // a temperature band. Flatten toward sea so the global sea plane floods shallow
  // ponds between muddy banks; `swampCore` (0 at the tag edge) keeps it feathered.
  const contLowland = sm(c.cont, -0.08, 0.06) * (1 - sm(c.cont, 0.42, 0.60));
  const swampMem = sm(c.erosion, 0.30, 0.55) * contLowland
    * sm(c.temp, -0.45, -0.25) * (1 - sm(c.temp, 0.30, 0.45)) * sm(c.humid, 0.05, 0.25);
  const swampCore = sm(swampMem, 0.5, 0.75);
  if (swampCore > 0) {
    const wob = fbm(simplex, wx + 71000, wz + 71000, 26, 2) * 2;  // target sea-2 .. sea+2 (shallow ponds + banks)
    height += swampCore * ((sea + wob) - baseH);
  }

  // RIVERS — winding valleys along the ZERO-CROSSING of a dedicated river field
  // (MC's river = weirdness≈0). To stay CONTINUOUS (not break/end every time the
  // land rises a little) the river is a WIDE VALLEY (broad gentle lowering toward
  // sea) with a narrow CHANNEL carved below sea at the centre — so it threads
  // through lowland and rolling hills as a natural valley, only fully stopping at
  // genuine TALL MOUNTAINS (which it routes around). No swamp/badlands carving.
  const riverW = fbm(simplex, wx + 91000, wz + 91000, fs * 6, 2);  // smoother → longer continuous channels
  const channelBand = 1 - sm(Math.abs(riverW), 0.012, 0.034);     // narrow water channel
  const valleyBand = 1 - sm(Math.abs(riverW), 0.03, 0.09);        // gentler, ~half-width dale
  const onLand = sm(baseH, sea - 1, sea + 4);
  const mtn = sm(baseH, sea + 50, sea + 88);                      // ONLY tall mountains suppress
  const rgate = onLand * (1 - mtn) * (1 - badlandsMem) * (1 - swampCore);
  // Gentle DALE first (toward sea+4, only ×0.5, and NOT into mountain flanks via
  // (1-sm(relief,...))) — a soft valley, not a deep wide gouge that channelized
  // terrain and bloomed beach inland ...
  const valleyMem = valleyBand * rgate * (1 - sm(relief, 4, 16));
  if (valleyMem > 0) height += valleyMem * ((sea + 4) - baseH) * 0.5;
  // ... then the narrow channel carves the floor to sea-2 (continuous water). The
  // channel uses its OWN coast gate (NOT onLand): onLand faded to 0 at baseH=sea-1,
  // so the carve stopped ~1 block above sea and left the beach band (aboveSea 0..3)
  // as an unbroken SAND BAR that dammed every river mouth. The channel gate instead
  // stays full strength inland and only fades once already in genuine ocean
  // (baseH ≤ ~sea-4) — so the channel punches THROUGH the beach to meet the sea
  // (no open-ocean trenches, since it's 0 in deep water).
  const channelGate = (1 - mtn) * (1 - badlandsMem) * (1 - swampCore) * sm(baseH, sea - 4, sea + 2);
  const riverMem = channelBand * channelGate;
  if (riverMem > 0) height += riverMem * ((sea - 2) - height);    // from the post-valley floor

  // LAKES — rare lowland basins carved to sea-3 so the plane floods them. Confined
  // to flat near-sea land (not ocean, not hillside → no dry above-sea pit).
  const lakeN = fbm(simplex, wx + 64500, wz + 64500, fs * 6, 3);
  const lakeBasin = sm(lakeN, 0.62, 0.74);                        // rare: only the field's high tail
  const lakeLowland = sm(baseH, sea + 1, sea + 8) * (1 - sm(baseH, sea + 16, sea + 30));
  const lakeMem = lakeBasin * lakeLowland * (1 - badlandsMem) * (1 - riverMem);
  if (lakeMem > 0) height += lakeMem * ((sea - 3) - baseH);
  // A partial-membership rim could land just ABOVE sea (a dry moat around the lake
  // that the global water plane never floods). Force any strong-lake column under
  // the waterline so the whole basin floods to a clean shore.
  if (lakeMem > 0.5) height = Math.min(height, sea - 1);

  // Mushroom island — RARE but BIG (now that oceans are large). Low-frequency,
  // smooth, high-threshold field in DEEP water; dome ADDED to the seabed so it
  // slopes smoothly up (no pillar) and is ringed by open ocean.
  let islandMem = 0;
  if (baseH < sea - 6) {
    const deep = sm(baseH, sea - 10, sea - 22);                  // 1 in genuinely deep water
    const isle = fbm(simplex, wx + 21000, wz + 21000, fs * 6, 2); // ≈1560b, smooth → big islands
    islandMem = deep * sm(isle, 0.70, 0.80);                     // RARE: only the extreme high tail
    height += islandMem * 52;
  }

  height = Math.floor(clamp(height, 1, cfg.maxY));
  const aboveSea = height - sea;
  const tempEff = tempLapse(c.temp, height, sea);

  // Cherry: mild climate on a lower-mountain SLOPE (absolute-height band so it
  // survives a magnitude change). A narrow elevation+climate window keeps it the
  // rare (~1%) mountain-slope grove it was before.
  const cherryMem = sm(aboveSea, 14, 22) * (1 - sm(aboveSea, 36, 48))
    * sm(c.temp, 0.04, 0.14) * (1 - sm(c.temp, 0.30, 0.42))
    * sm(c.humid, 0.06, 0.16) * (1 - sm(c.humid, 0.36, 0.48));

  // Ice spikes — a rare, very-cold special (gated like badlands): a dedicated
  // low-freq field, only where the lapse-cooled temperature is deeply freezing.
  const iceSpikesMem = sm(tempEff, -0.30, -0.52)
    * sm(fbm(simplex, wx + 44000, wz + 44000, fs * 4, 2), 0.40, 0.58);

  // MOUNTAIN-RANGE biome: tagged by the SAME rangeGate that gives the extreme height
  // (so the tall ranges and the snowy biome coincide), once the column is actually
  // high. Smooth borders (all-continuous gates). Hot regions keep their desert/savanna
  // identity (rangeGate≈0 there → bare-rock tops, no snow) so the range only appears
  // where snow makes sense.
  const mountainsMem = rangeGate * sm(aboveSea, 40, 72);

  // --- biome selection: specials (by gate, priority order) → water bands → grid ---
  // The badlands shells (core → red-desert → desert) are checked before the grid
  // so the nest is guaranteed concentric. The climate grid uses RAW temp (MC
  // places biomes on the horizontal field; elevation cooling is a surface concern
  // via the snow/rock overlay below, not a biome reassignment).
  let biome: number;
  if (islandMem > 0.3 && aboveSea > 1) biome = BIOME.mushroom;   // only the dome that breaches the sea (no submerged giant mushrooms)
  else if (swampMem > 0.5) biome = c.temp > 0.20 ? BIOME.mangroveSwamp : BIOME.swamp;   // warm swamp → mangrove
  // Badlands shells only ABOVE sea — so a river/coast that carved one of these
  // columns below sea reads as water, not red sand bleeding into the river/ocean.
  else if (badlandsMem > 0.5 && aboveSea > 0) biome = BIOME.badlands;
  else if (redDesertMem > 0.5 && aboveSea > 0) biome = BIOME.redDesert;
  else if (desertRing > 0.5 && aboveSea > 0) biome = BIOME.desert;  // outer sand ring around the mesa
  else if (cherryMem > 0.5) biome = BIOME.cherry;
  else if (iceSpikesMem > 0.5 && aboveSea > 3) biome = BIOME.iceSpikes;
  else if (riverMem > 0.55 && aboveSea <= 1)            // carved river channel
    biome = tempEff < -0.46 ? BIOME.frozenRiver : BIOME.river;
  else if (lakeMem > 0.5 && aboveSea <= 0) biome = BIOME.lake;
  else if (height < sea) biome = OCEAN_BY_LEVEL[tempLevel(c.temp)]; // temperature-typed ocean
  else if (aboveSea <= 3) biome = BIOME.beach;
  else if (mountainsMem > 0.5) biome = BIOME.mountains;            // snow-capped rocky range
  else {
    // Dither temp/humid (grid bucketing only — the gates above keep raw smooth
    // values) so biome borders stipple/interleave instead of being a clean line.
    const dT = (hash01(wx, wz) - 0.5) * BORDER_DITHER * flatness;
    const dH = (hash01(wx + 99991, wz + 57331) - 0.5) * BORDER_DITHER * flatness;
    // RIVERS AS BIOME SEPARATORS: near a river, nudge the climate sample by which
    // BANK you're on (sign of the river field) so biome borders tend to fall ALONG
    // the river — a river separates two biomes, MC-style. Pure fn of (wx,wz) → apron-
    // safe. Subtle (0.16 < a temp-level width) so it only flips columns already near a
    // boundary. `riverW` is the same field the river carve uses (computed above).
    const bankBias = Math.sign(riverW) * (1 - sm(Math.abs(riverW), 0.02, 0.10)) * 0.16 * flatness;
    biome = selectClimate(c.temp + dT + bankBias, c.humid + dH, c.weird);
  }

  const ctx: SurfCtx = { aboveSea, tempEff, humid: c.humid, erosion: c.erosion, wx, wz };
  let { surfaceId, subId } = BIOMES[biome].surface(ctx);

  // Elevation overlay: bare rock on the high mountainside, snow on the alpine
  // summit (or wherever the lapse-cooled temp is freezing). Applied to climate
  // biomes AND grass-based specials (cherry), but NOT the deliberately-coloured
  // specials (badlands terracotta / red desert / mycelium / swamp mud) — they keep
  // their identity at any altitude. Thresholds are high so mountainsides stay
  // vegetated (a desert peak shows desert→savanna→… grass well up the slope before
  // rock), and so cherry (which caps ~aboveSea 42) never reaches the rock line —
  // killing the old grass-vs-stone seam. Keyed on ABSOLUTE height so caps survive
  // any climate; tempEff lets cold regions get snow lower down (a wavy snowline).
  const coloured = biome === BIOME.badlands || biome === BIOME.redDesert
    || biome === BIOME.mushroom || biome === BIOME.swamp || biome === BIOME.mangroveSwamp;
  if (!coloured && biome !== BIOME.ocean && biome !== BIOME.beach) {
    // CLIMATE-AWARE: HOT climates (deserts/savanna/warm) NEVER snow — even on tall
    // peaks they get bare exposed rock instead ("no snow in deserts"). Cold/temperate
    // peaks snow (alpine height OR a lapse-cooled freezing summit). The snowy
    // mountain-range biome ALWAYS snow-caps above the line (it's defined as snowy).
    const arid = c.temp > 0.20 || c.humid < -0.15;   // hot OR dry → bare rock, no snow
    // Wobble the rock/snow contour with a broad low-freq field so the lines snake
    // up and down the slopes instead of ringing every peak at a dead-flat altitude
    // (the old topographic-map look). Pure fn of (wx,wz) → apron-safe.
    const lineWob = fbm(simplex, wx + 33000, wz + 33000, fs * 0.6, 2) * 11;
    if (aboveSea > 48 + lineWob) { surfaceId = BLOCK_IDS.stone; subId = BLOCK_IDS.stone; }   // exposed rock (any climate)
    if ((biome === BIOME.mountains || !arid) && (aboveSea > 66 + lineWob || tempEff < -0.46)) surfaceId = BLOCK_IDS.snow;
  }

  // Taiga floor: smooth podzol patches (low-freq noise — coherent blobs, not the
  // per-column speckle the old hash dither produced). The old-growth redwood
  // forest is mostly podzol (lower threshold → near-full coverage).
  if (surfaceId === BLOCK_IDS.grass) {
    const pf = fbm(simplex, wx + 8800, wz + 8800, 18, 2);
    if ((biome === BIOME.taiga && pf > 0.34) || (biome === BIOME.redwoodForest && pf > -0.15)) {
      surfaceId = BLOCK_IDS.podzol; subId = BLOCK_IDS.dirt;
    }
  }
  // Seabed / riverbed variety: break the sandy/rocky bed up with clay, gravel,
  // dirt and exposed stone patches (low-freq noise). Underwater only.
  if (aboveSea < 0 && (surfaceId === BLOCK_IDS.sand || surfaceId === BLOCK_IDS.stone)) {
    const v = fbm(simplex, wx + 12300, wz + 12300, 18, 2);
    if (v > 0.45) surfaceId = BLOCK_IDS.gravel;
    else if (v > 0.20) surfaceId = BLOCK_IDS.clay;
    else if (v < -0.50) surfaceId = BLOCK_IDS.stone;
    else if (v < -0.22) surfaceId = BLOCK_IDS.dirt;
  }

  return { height, surfaceId, subId, biome, temp: tempEff, humid: c.humid };
}

// Climate-driven grass tint (rgb 0..1), MC-style: smoothly shades the (grayscale)
// plant textures by elevation-adjusted temperature + humidity — lush green where
// warm & wet, olive/tan where cold or dry, so e.g. cherry/temperate grass reads
// green and savanna olive. Bilinear blend of four climate-corner tints.
const _GT_DRY_COLD: readonly [number, number, number] = [0.62, 0.66, 0.40];  // olive
const _GT_WET_COLD: readonly [number, number, number] = [0.46, 0.68, 0.44];  // bluish green
const _GT_DRY_WARM: readonly [number, number, number] = [0.74, 0.74, 0.30];  // yellow-green
const _GT_WET_WARM: readonly [number, number, number] = [0.40, 0.82, 0.32];  // lush green
export function climateGrassTint(temp: number, humid: number): readonly [number, number, number] {
  const t = clamp(temp + 0.5, 0, 1);   // 0 cold .. 1 hot
  const h = clamp(humid + 0.5, 0, 1);  // 0 dry .. 1 wet
  const ch = (i: number) => {
    const cold = _GT_DRY_COLD[i] + (_GT_WET_COLD[i] - _GT_DRY_COLD[i]) * h;   // cold row, dry→wet
    const warm = _GT_DRY_WARM[i] + (_GT_WET_WARM[i] - _GT_DRY_WARM[i]) * h;   // warm row, dry→wet
    return cold + (warm - cold) * t;                                          // cold→warm
  };
  return [ch(0), ch(1), ch(2)];
}

export function createWorldSampler(params: ChunkParams, size: ChunkSize): WorldSampler {
  const simplex = new SimplexNoise(new RNG(params.seed));
  const cfg = makeSurfaceConfig(params, size);
  return (wx, wz) => columnSurface(simplex, cfg, wx, wz);
}

// ===========================================================================
//  RESOURCES (ore + stone variants) — coarse-grid noise that replaces host rock
//  (stone OR deepslate) with the resource block. Each resource may declare a
//  [minY,maxY] depth window so the sweep is both cheaper (fewer cells) and lets
//  ores/variants layer by depth (diamond deep, copper shallow, …).
// ===========================================================================
const ORE_STEP = 2;
const isHostRock = (id: number) => id === BLOCK_IDS.stone || id === BLOCK_IDS.deepslate;
function generateResources(rng: RNG, size: ChunkSize, worldX: number, worldZ: number, resources: ResourceGenInfo[], get: GetFn, set: SetFn, biomeMap: Uint8Array) {
  const W = size.width;
  resources.forEach(resource => {
    const simplex = new SimplexNoise(rng);
    const y0 = Math.max(0, resource.minY ?? 0);
    const y1 = Math.min(size.height - 1, resource.maxY ?? size.height - 1);
    const peak = (y0 + y1) * 0.5, halfSpan = Math.max(1, (y1 - y0) * 0.5);
    const mountainOnly = resource.id === BLOCK_IDS.emeraldOre;   // emerald → mountains only (MC)
    for (let x = 0; x < W; x += ORE_STEP)
      for (let z = 0; z < W; z += ORE_STEP) {
        if (mountainOnly && biomeMap[x * W + z] !== BIOME.mountains) continue;
        for (let y = y0; y <= y1; y += ORE_STEP) {
          if (!isHostRock(get(x, y, z))) continue;
          // Vertical TRIANGLE: lowest threshold (most ore) at the window midpoint,
          // rising to the edges → each ore clusters at its characteristic depth.
          const tent = 1 - Math.abs(y - peak) / halfSpan;
          const thr = resource.scarcity + (1 - tent) * 0.10;
          const val = simplex.noise3d((worldX + x) / resource.scale.x, y / resource.scale.y, (worldZ + z) / resource.scale.z);
          if (val > thr) {
            for (let dx = 0; dx < ORE_STEP; dx++)
              for (let dy = 0; dy < ORE_STEP; dy++)
                for (let dz = 0; dz < ORE_STEP; dz++) {
                  // Per-block jitter breaks the 2×2×2 cell into an irregular blob.
                  if (hash01(worldX + x + dx + (y + dy) * 131, worldZ + z + dz + (y + dy) * 57) < 0.2) continue;
                  if (isHostRock(get(x + dx, y + dy, z + dz))) set(x + dx, y + dy, z + dz, resource.id);
                }
          }
        }
      }
  });
}

// ===========================================================================
//  TERRAIN  — fill each column; badlands columns use their per-Y band override.
// ===========================================================================
// Cold water freezes to a walkable ice sheet at the surface (matches the snow /
// frozen-river threshold). Pure fn of climate → apron stays valid (ice sits above
// the heightmap like a tree, so borders only get hidden overdraw, never holes).
export const ICE_SURFACE_TEMP = -0.30;   // more cold water freezes over (was -0.45, too rare)

// Lower-world rock. The old code put deepslate below an ABSOLUTE Y in [7,13], so on
// a sea=128 world it was a 7-13-block sliver at the floor under ~125 blocks of plain
// stone. Now deepslate fills the whole deep band below a per-column wobbled boundary
// (~half the underground) with stone above — a real lower-rock layer. Pure fn of
// (wx,wz,y): deepslate & stone are both solid, so the apron (which only tracks
// solidity) needs no mirror. Shared by the normal fill AND the badlands `band` so
// mesas get deepslate at depth too (previously they were stone all the way down).
const DEEPSLATE_TOP = 56;   // deepslate everywhere below ~this Y (±4 jagged per-column wobble)
function deepRock(wx: number, wz: number, y: number): number {
  const top = DEEPSLATE_TOP + (hash01(wx + 17, wz + 31) - 0.5) * 8;
  return y < top ? BLOCK_IDS.deepslate : BLOCK_IDS.stone;
}

// ===========================================================================
//  CAVES — deterministic, apron-safe sub-surface air. SPAGHETTI tunnels (the
//  intersection of two low-freq simplex iso-sheets |n|<eps, which meet in a 1-D
//  curve → a tube) OR'd with sparse CHEESE rooms (a single iso-band gated by a
//  coarse rarity field). A PURE fn of (wx,wy,wz) on the seed-only simplex, so the
//  stateless border apron (getOutside) evaluates the IDENTICAL predicate at the
//  neighbour column → cave wall faces at chunk borders are never culled (no holes).
//  Carved only well below the surface (a depth fade pinches tube mouths shut so
//  surface entrances are rare) and never into the bedrock band. Carved air at/below
//  LAVA_Y becomes a lava sea — realised in the fill, not a separate pass.
// ===========================================================================
const CAVE_Y_MIN = 6;            // keep caves out of the bedrock floor band
const CAVE_SURFACE_MARGIN = 7;   // never carve at/above (surfaceHeight - this)
const CAVE_FADE = 16;            // tubes pinch shut over this many blocks below the margin
export const LAVA_Y = 11;        // carved air at/below this Y fills with lava (deep lava sea)
const CAVE_S_XZ = 68, CAVE_S_Y = 46, CAVE_EPS_S = 0.044;   // spaghetti tube thickness
const CAVE_C_XZ = 112, CAVE_C_Y = 56, CAVE_EPS_C = 0.050;  // cheese room iso-band
const CAVE_B_OFF = 9173;         // decorrelates the 2nd spaghetti field from the 1st
function caveAir(simplex: SimplexNoise, wx: number, wy: number, wz: number, surfaceH: number): boolean {
  if (wy < CAVE_Y_MIN) return false;
  const depth = (surfaceH - wy) - CAVE_SURFACE_MARGIN;
  if (depth <= 0) return false;
  const fade = depth >= CAVE_FADE ? 1 : depth / CAVE_FADE;   // 0 near the margin → 1 deep
  // Spaghetti: the 1st iso-sheet short-circuits the 2nd, so most cells pay 1 noise.
  const a = simplex.noise3d(wx / CAVE_S_XZ, wy / CAVE_S_Y, wz / CAVE_S_XZ);
  if (a < CAVE_EPS_S && a > -CAVE_EPS_S && Math.abs(a) < CAVE_EPS_S * fade) {
    const b = simplex.noise3d((wx + CAVE_B_OFF) / CAVE_S_XZ, wy / CAVE_S_Y, (wz + CAVE_B_OFF) / CAVE_S_XZ);
    if (Math.abs(b) < CAVE_EPS_S * fade) return true;
  }
  // Cheese: sparse big caverns, gated by a coarse rarity field so they don't dominate.
  const gate = simplex.noise3d(wx / 240, wy / 170, wz / 240);
  if (gate > 0.36) {
    const c = simplex.noise3d((wx + 5300) / CAVE_C_XZ, wy / CAVE_C_Y, (wz + 5300) / CAVE_C_XZ);
    if (Math.abs(c) < CAVE_EPS_C * fade) return true;
  }
  return false;
}
// One deep cell: bedrock floor (rough y0-4, always at y0), else cave air/lava, else
// the deepslate/stone layer. Shared by the normal fill AND the badlands band's deep
// stone so every biome gets the same caves + bedrock + deep-rock layering.
function deepCell(simplex: SimplexNoise, wx: number, wz: number, y: number, surfaceH: number): number {
  if (y === 0) return BLOCK_IDS.bedrock;
  if (y <= 4 && hash01(wx + y * 9973, wz + y * 131) < (5 - y) / 5) return BLOCK_IDS.bedrock;
  if (caveAir(simplex, wx, y, wz, surfaceH)) return y <= LAVA_Y ? BLOCK_IDS.lava : BLOCK_IDS.air;
  return deepRock(wx, wz, y);
}

// Standalone cave predicate for the stateless APRON (getOutside): its own seed-only
// simplex has the identical permutation to the generator's, so it returns the exact
// same carve decision at any world cell → border cave walls mesh seamlessly.
export function createCaveSampler(params: ChunkParams) {
  const simplex = new SimplexNoise(new RNG(params.seed));
  return (wx: number, wy: number, wz: number, surfaceH: number) => caveAir(simplex, wx, wy, wz, surfaceH);
}

function generateTerrain(simplex: SimplexNoise, params: ChunkParams, size: ChunkSize, worldX: number, worldZ: number,
  set: SetFn, outHeight: Int16Array, outBiome: Uint8Array, outTint?: Uint8Array, outSurface?: Uint8Array) {
  const cfg = makeSurfaceConfig(params, size);
  const W = size.width;
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < W; z++) {
      const cs = columnSurface(simplex, cfg, worldX + x, worldZ + z);
      const idx = x * W + z;
      outHeight[idx] = cs.height;
      outBiome[idx] = cs.biome;
      // The ACTUAL top block placed at y=cs.height — for `band` biomes (badlands)
      // that's band(height) (terracotta on a plateau), NOT cs.surfaceId (redSand).
      // generateFeatures reuses this (avoids re-running columnSurface for in-chunk
      // columns + roots features on the real surface).
      if (outSurface) outSurface[idx] = BIOMES[cs.biome].band ? BIOMES[cs.biome].band!(cs.height, cs.height, cfg.sea) : cs.surfaceId;
      if (outTint) {
        const [tr, tg, tb] = climateGrassTint(cs.temp, cs.humid);
        outTint[idx * 3] = (tr * 255 + 0.5) | 0;
        outTint[idx * 3 + 1] = (tg * 255 + 0.5) | 0;
        outTint[idx * 3 + 2] = (tb * 255 + 0.5) | 0;
      }
      const band = BIOMES[cs.biome].band;
      const wx = worldX + x, wz = worldZ + z;
      for (let y = 0; y <= cs.height; y++) {
        if (band) {
          // Keep the biome's banded subsurface (badlands terracotta), but route its
          // DEEP plain-stone fill through deepCell so mesas get deepslate, bedrock
          // and caves at depth too.
          const b = band(y, cs.height, cfg.sea);
          set(x, y, z, b === BLOCK_IDS.stone ? deepCell(simplex, wx, wz, y, cs.height) : b);
        }
        else if (y === cs.height) set(x, y, z, cs.surfaceId);
        else if (y > cs.height - 4) set(x, y, z, cs.subId);
        else set(x, y, z, deepCell(simplex, wx, wz, y, cs.height));
      }
      if (cs.height < cfg.sea && cs.temp < ICE_SURFACE_TEMP) {
        set(x, cfg.sea, z, BLOCK_IDS.ice);                                 // walkable frozen surface
        if (cfg.sea - 1 > cs.height) set(x, cfg.sea - 1, z, BLOCK_IDS.ice); // 2-block cap = solid feel
      }
    }
  }
}

// ===========================================================================
//  FEATURES  — jittered grid; each biome's declarative FeatureSpec decides what
//  grows. Adding features to a biome = edit its `features` in the registry.
// ===========================================================================
const GRASS_ROOT = [BLOCK_IDS.grass] as const;
const SWAMP_ROOT = [BLOCK_IDS.mud, BLOCK_IDS.grass] as const;
const SANDY_ROOT = [BLOCK_IDS.sand, BLOCK_IDS.redSand] as const;
const MYC_ROOT = [BLOCK_IDS.mycelium] as const;
const SNOW_ROOT = [BLOCK_IDS.snow] as const;
// spruce / redwood floor — INCLUDES snow + dirt so cold (snow-capped) taiga still
// grows its spruce forest instead of being bald (snow overlay replaces the grass).
const CONIFER_ROOT = [BLOCK_IDS.grass, BLOCK_IDS.podzol, BLOCK_IDS.snow, BLOCK_IDS.dirt] as const;
const MANGROVE_ROOT = [BLOCK_IDS.mud, BLOCK_IDS.grass, BLOCK_IDS.dirt] as const;

function generateFeatures(treeRng: RNG, simplex: SimplexNoise, params: ChunkParams, size: ChunkSize, worldX: number, worldZ: number, get: GetFn, set: SetFn,
  heightMap: Int16Array, biomeMap: Uint8Array, surfaceMap: Uint8Array) {
  const cfg = makeSurfaceConfig(params, size);
  const W = size.width;
  // `rng` is reassigned to a per-CELL deterministic RNG inside the feature loop so
  // tree placement is a PURE function of the WORLD cell (see the loop below) — the
  // builder closures all reference this binding.
  let rng = treeRng;
  // Root-surface lookup. For IN-CHUNK columns reuse generateTerrain's per-column
  // maps (height/biome/top-block) — NO columnSurface re-sample (the heavy noise) and
  // the REAL placed top block (fixes band biomes: a badlands plateau is terracotta,
  // not redSand). For APRON columns (outside this chunk — a tree rooted in a
  // neighbour whose canopy overhangs in) compute columnSurface (memoised). This is
  // what makes cross-border trees seamless without re-noising the whole chunk.
  const colMemoF = new Map<string, ColumnSurface>();
  const colF = (wx: number, wz: number): ColumnSurface => {
    const lx = wx - worldX, lz = wz - worldZ;
    if (lx >= 0 && lx < W && lz >= 0 && lz < W) {
      const idx = lx * W + lz;
      return { height: heightMap[idx], surfaceId: surfaceMap[idx], subId: surfaceMap[idx], biome: biomeMap[idx], temp: 0, humid: 0 };
    }
    const key = wx + ',' + wz;
    let v = colMemoF.get(key);
    if (!v) { v = columnSurface(simplex, cfg, wx, wz); colMemoF.set(key, v); }
    return v;
  };
  const surfaceYOf = (x: number, z: number, roots: readonly number[]): number => {
    const cs = colF(worldX + x, worldZ + z);
    return roots.includes(cs.surfaceId) ? cs.height : -1;
  };
  const setIfAir = (x: number, y: number, z: number, id: number) => {
    if (get(x, y, z) === BLOCK_IDS.air) set(x, y, z, id);
  };
  const buildCanopy = (x: number, y: number, z: number, r: number, density: number, leafId: number) => {
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
      if (i * i + j * j + k * k > r * r) continue;
      if (rng.random() < density) setIfAir(x + i, y + j, z + k, leafId);
    }
  };
  const buildTree = (x: number, z: number, roots: readonly number[], logId: number, leafId: number,
    minH: number, maxH: number, minR: number, maxR: number, density: number, vineChance = 0) => {
    const y0 = surfaceYOf(x, z, roots);
    if (y0 < 0) return;
    const h = Math.round(minH + (maxH - minH) * rng.random());
    for (let ty = y0 + 1; ty <= y0 + h; ty++) set(x, ty, z, logId);
    buildCanopy(x, y0 + h, z, Math.round(minR + (maxR - minR) * rng.random()), density, leafId);
    // Hang vines down the trunk (jungle/swamp). Each side independently; a vine
    // clings to the trunk face and the mesher renders it as a vertical billboard.
    if (vineChance > 0) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (rng.random() > vineChance) continue;
        const len = 2 + Math.floor(rng.random() * Math.max(1, h - 1));
        for (let i = 0; i < len; i++) {
          const ty = y0 + h - 1 - i;
          if (ty <= y0) break;
          setIfAir(x + dx, ty, z + dz, BLOCK_IDS.vine);
        }
      }
    }
  };
  const buildCactus = (x: number, z: number) => {
    const y0 = surfaceYOf(x, z, SANDY_ROOT);
    if (y0 < 0) return;
    const h = 2 + Math.floor(rng.random() * 3);
    for (let i = 1; i <= h; i++) { if (get(x, y0 + i, z) !== BLOCK_IDS.air) break; set(x, y0 + i, z, BLOCK_IDS.cactus); }
  };
  const buildGiantMushroom = (x: number, z: number, roots: readonly number[] = MYC_ROOT) => {
    const y0 = surfaceYOf(x, z, roots);
    if (y0 < 0) return;
    const h = 4 + Math.floor(rng.random() * 3);
    for (let i = 1; i <= h; i++) set(x, y0 + i, z, BLOCK_IDS.mushroomStem);
    const capId = rng.random() < 0.5 ? BLOCK_IDS.mushroomRed : BLOCK_IDS.mushroomBrown;
    const cy = y0 + h + 1;
    for (let i = -2; i <= 2; i++) for (let k = -2; k <= 2; k++) {
      if (Math.abs(i) === 2 && Math.abs(k) === 2) continue;
      setIfAir(x + i, cy, z + k, capId);
      if (Math.abs(i) === 2 || Math.abs(k) === 2) setIfAir(x + i, cy - 1, z + k, capId);
    }
  };
  const oak = (x: number, z: number, roots: readonly number[], density = 0.7, vineChance = 0,
    logId: number = BLOCK_IDS.tree, leafId: number = BLOCK_IDS.leaves) =>
    buildTree(x, z, roots, logId, leafId,
      params.trees.trunk.minHeight, params.trees.trunk.maxHeight,
      params.trees.canopy.minRadius, params.trees.canopy.maxRadius, density, vineChance);

  // Packed-ice spire: a tall tapering column with a small base bulge.
  const buildIceSpike = (x: number, z: number) => {
    const y0 = surfaceYOf(x, z, SNOW_ROOT);
    if (y0 < 0) return;
    const h = 4 + Math.floor(rng.random() * 9);            // 4..12 tall
    for (let i = 1; i <= h; i++) set(x, y0 + i, z, BLOCK_IDS.packedIce);
    const baseH = 1 + Math.floor(h / 3);                   // wider lower third
    for (let i = 1; i <= baseH; i++) {
      setIfAir(x + 1, y0 + i, z, BLOCK_IDS.packedIce);
      setIfAir(x - 1, y0 + i, z, BLOCK_IDS.packedIce);
      setIfAir(x, y0 + i, z + 1, BLOCK_IDS.packedIce);
      setIfAir(x, y0 + i, z - 1, BLOCK_IDS.packedIce);
    }
  };

  // --- distinct tree shapes (use the existing biome wood palette) -----------
  // Conical conifer: straight trunk + diamond leaf rings widening downward from a
  // pointed tip → reads as a pine/spruce, not a round oak blob.
  // Dust a snow SHEET on the TOP of a leaf canopy (taiga / snowy conifers) so the
  // forest reads as "it snowed". For each column in the crown footprint, finds the
  // highest leaf with air above and lays a snowLayer on it. Uses get()/set() (the
  // in-chunk data), so apron conifers rooted in a neighbour cap only their in-chunk
  // leaves — the neighbour chunk caps the rest identically → seamless.
  const snowCapCanopy = (cx: number, cz: number, r: number, topY: number, leafId: number) => {
    for (let i = -r; i <= r + 1; i++) for (let k = -r; k <= r + 1; k++) {
      for (let yy = topY + 1; yy > topY - 8 && yy > 0; yy--) {
        if (get(cx + i, yy, cz + k) === leafId && get(cx + i, yy + 1, cz + k) === BLOCK_IDS.air) {
          set(cx + i, yy + 1, cz + k, BLOCK_IDS.snowLayer);
          break;                                                     // only the topmost leaf of this column
        }
      }
    }
  };
  const conifer = (x: number, z: number, roots: readonly number[], logId: number, leafId: number, minH: number, maxH: number, snowy = false) => {
    const y0 = surfaceYOf(x, z, roots);
    if (y0 < 0) return;
    const h = Math.round(minH + (maxH - minH) * rng.random());
    for (let ty = y0 + 1; ty <= y0 + h; ty++) set(x, ty, z, logId);
    const top = y0 + h;
    let ring = 0;
    for (let ty = top + 1; ty >= y0 + Math.floor(h * 0.45); ty--) {
      const r = Math.min(3, Math.floor(ring / 2));
      for (let i = -r; i <= r; i++) for (let k = -r; k <= r; k++) {
        if (Math.abs(i) + Math.abs(k) > r) continue;                 // diamond ring
        setIfAir(x + i, ty, z + k, leafId);
      }
      ring++;
    }
    if (snowy) snowCapCanopy(x, z, 3, top + 1, leafId);
  };
  const spruce = (x: number, z: number, snowy = false) => conifer(x, z, CONIFER_ROOT, BLOCK_IDS.spruceLog, BLOCK_IDS.spruceLeaves, 6, 11, snowy);

  // GIANT redwood: 2×2 spruce trunk, podzol skirt, big conical crown. The
  // centrepiece of the redwood forest.
  const redwood = (x: number, z: number) => {
    // The feature loop now iterates an apron of neighbour cells with a per-CELL
    // deterministic RNG, so a giant rooted near (or past) the border is drawn IN
    // FULL by every chunk it touches — no edge fallback / clipped crown needed.
    const y0 = surfaceYOf(x, z, CONIFER_ROOT);
    if (y0 < 0) return;
    const h = 14 + Math.floor(rng.random() * 11);                    // 14..24 tall
    const QUAD = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
    for (let ty = y0 + 1; ty <= y0 + h; ty++) for (const [dx, dz] of QUAD) set(x + dx, ty, z + dz, BLOCK_IDS.spruceLog);
    for (let i = -2; i <= 3; i++) for (let k = -2; k <= 3; k++) {     // podzol skirt at the roots
      const py = surfaceYOf(x + i, z + k, CONIFER_ROOT);
      if (py >= 0 && get(x + i, py, z + k) === BLOCK_IDS.grass) set(x + i, py, z + k, BLOCK_IDS.podzol);
    }
    const top = y0 + h;
    let ring = 0;
    for (let ty = top + 2; ty >= y0 + Math.floor(h * 0.5); ty--) {    // conical crown on the 2×2
      const r = Math.min(4, 1 + Math.floor(ring / 2));
      for (let i = -r; i <= r + 1; i++) for (let k = -r; k <= r + 1; k++) {
        const di = Math.min(Math.abs(i), Math.abs(i - 1)), dk = Math.min(Math.abs(k), Math.abs(k - 1));
        if (di + dk > r) continue;
        setIfAir(x + i, ty, z + k, BLOCK_IDS.spruceLeaves);
      }
      ring++;
    }
  };

  // Jungle: tall vine-draped trees, ~18% giant 2×2 with a layered crown. The giant
  // form only spawns with room for its big crown (else a small jungle tree fills
  // the spot) so chunk-edge crowns aren't clipped to a flat half.
  const jungleTree = (x: number, z: number) => {
    const giant = rng.random() < 0.18;   // apron + per-cell RNG → giants draw in full at borders
    if (giant) {
      const y0 = surfaceYOf(x, z, GRASS_ROOT);
      if (y0 < 0) return;
      const h = 12 + Math.floor(rng.random() * 8);                   // 12..19
      const QUAD = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
      for (let ty = y0 + 1; ty <= y0 + h; ty++) for (const [dx, dz] of QUAD) set(x + dx, ty, z + dz, BLOCK_IDS.jungleLog);
      buildCanopy(x, y0 + h + 1, z, 4, 0.7, BLOCK_IDS.jungleLeaves);
      buildCanopy(x + 1, y0 + h - 1, z + 1, 3, 0.6, BLOCK_IDS.jungleLeaves);
      for (const [dx, dz] of [[-1, 0], [2, 1], [1, -1], [0, 2]] as const) {     // vines off the trunk faces
        const len = 3 + Math.floor(rng.random() * Math.max(1, h - 4));
        for (let i = 0; i < len; i++) { const ty = y0 + h - 2 - i; if (ty <= y0) break; setIfAir(x + dx, ty, z + dz, BLOCK_IDS.vine); }
      }
    } else {
      buildTree(x, z, GRASS_ROOT, BLOCK_IDS.jungleLog, BLOCK_IDS.jungleLeaves, 8, 14, 2, 3, 0.62, 0.6);
    }
  };

  // Dark oak: thick 2×2 trunk + a wide, flat 2-thick canopy (dim roofed forest).
  const darkOak = (x: number, z: number) => {
    const y0 = surfaceYOf(x, z, GRASS_ROOT);
    if (y0 < 0) return;
    const h = 5 + Math.floor(rng.random() * 4);                      // 5..8
    const QUAD = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
    for (let ty = y0 + 1; ty <= y0 + h; ty++) for (const [dx, dz] of QUAD) set(x + dx, ty, z + dz, BLOCK_IDS.darkOakLog);
    for (let layer = 0; layer < 2; layer++) {
      const r = layer === 0 ? 3 : 2, cy = y0 + h + layer;
      for (let i = -r; i <= r + 1; i++) for (let k = -r; k <= r + 1; k++) {
        const di = Math.min(Math.abs(i), Math.abs(i - 1)), dk = Math.min(Math.abs(k), Math.abs(k - 1));
        if (di * di + dk * dk > (r + 0.5) * (r + 0.5)) continue;
        setIfAir(x + i, cy, z + k, BLOCK_IDS.darkOakLeaves);
      }
    }
  };

  // Acacia: a short trunk that kinks diagonally, topped by a flat umbrella canopy.
  const acacia = (x: number, z: number) => {
    const y0 = surfaceYOf(x, z, GRASS_ROOT);
    if (y0 < 0) return;
    const lower = 2 + Math.floor(rng.random() * 2);                  // 2..3 straight
    let cx = x, cz = z, ty = y0 + 1;
    for (let i = 0; i < lower; i++, ty++) set(cx, ty, cz, BLOCK_IDS.acaciaLog);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const [dx, dz] = dirs[Math.floor(rng.random() * 4)];
    const slant = 2 + Math.floor(rng.random() * 2);
    // Walk the kink freely — the apron draws the umbrella in full even when the
    // anchor lands in (or past) a neighbour chunk, so no edge clamp is needed.
    for (let i = 0; i < slant; i++) {
      cx += dx; cz += dz; set(cx, ty, cz, BLOCK_IDS.acaciaLog); ty++;
    }
    for (let i = -3; i <= 3; i++) for (let k = -3; k <= 3; k++) {     // flat umbrella
      const d2 = i * i + k * k;
      if (d2 > 9) continue;
      setIfAir(cx + i, ty, cz + k, BLOCK_IDS.acaciaLeaves);
      if (d2 <= 4) setIfAir(cx + i, ty - 1, cz + k, BLOCK_IDS.acaciaLeaves);
    }
  };
  const birch = (x: number, z: number) => buildTree(x, z, GRASS_ROOT, BLOCK_IDS.birchLog, BLOCK_IDS.birchLeaves, 6, 9, 2, 3, 0.7);

  // Mangrove: trunk RAISED on splaying prop-roots (you can walk under it), with a
  // round canopy and hanging vines/propagules — for warm swamps.
  const mangrove = (x: number, z: number) => {
    const y0 = surfaceYOf(x, z, MANGROVE_ROOT);
    if (y0 < 0) return;
    const LIFT = 2;                                                  // trunk lifted onto stilts
    // 4 arching prop-roots: ground (y0) → up to the raised trunk base (y0+LIFT).
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      setIfAir(x + dx, y0, z + dz, BLOCK_IDS.mangroveLog);
      setIfAir(x + dx, y0 + 1, z + dz, BLOCK_IDS.mangroveLog);
      setIfAir(x + dx, y0 + LIFT, z + dz, BLOCK_IDS.mangroveLog);    // ties into the trunk base
    }
    const h = 6 + Math.floor(rng.random() * 5);                      // 6..10 above the lift
    for (let ty = y0 + LIFT; ty <= y0 + LIFT + h; ty++) set(x, ty, z, BLOCK_IDS.mangroveLog);
    const top = y0 + LIFT + h;
    buildCanopy(x, top, z, 3, 0.72, BLOCK_IDS.mangroveLeaves);
    // hanging propagules/vines from the canopy underside + trunk
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1]] as const) {
      if (rng.random() > 0.55) continue;
      const len = 2 + Math.floor(rng.random() * 4);
      for (let i = 0; i < len; i++) { const ty = top - 1 - i; if (ty <= y0 + LIFT) break; setIfAir(x + dx, ty, z + dz, BLOCK_IDS.vine); }
    }
  };

  // --- ground decorations (bushes, fallen logs, mossy boulders) -------------
  const DECO_ROOT = [BLOCK_IDS.grass, BLOCK_IDS.podzol, BLOCK_IDS.dirt, BLOCK_IDS.mud] as const;
  const ROCK_ROOT = [BLOCK_IDS.grass, BLOCK_IDS.podzol, BLOCK_IDS.dirt, BLOCK_IDS.stone, BLOCK_IDS.gravel] as const;

  // Small leafy bush: a low dome of (biome-tinted) leaves, no trunk.
  const bush = (x: number, z: number, leafId: number) => {
    const y0 = surfaceYOf(x, z, DECO_ROOT);
    if (y0 < 0) return;
    setIfAir(x, y0 + 1, z, leafId);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
      if (rng.random() < 0.7) setIfAir(x + dx, y0 + 1, z + dz, leafId);
    if (rng.random() < 0.45) setIfAir(x, y0 + 2, z, leafId);
  };

  // Fallen log: upright stump + a short horizontal trunk on the ground, sometimes
  // mossed with small mushrooms. Each segment follows its own surface height.
  const fallenLog = (x: number, z: number, logId: number) => {
    const y0 = surfaceYOf(x, z, DECO_ROOT);
    if (y0 < 0) return;
    setIfAir(x, y0 + 1, z, logId);                                   // stump
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const [dx, dz] = dirs[Math.floor(rng.random() * 4)];
    const len = 3 + Math.floor(rng.random() * 3);                    // 3..5
    for (let i = 1; i <= len; i++) {
      const lx = x + dx * i, lz = z + dz * i;
      const ly = surfaceYOf(lx, lz, DECO_ROOT);
      if (ly < 0) break;
      setIfAir(lx, ly + 1, lz, logId);
      if (rng.random() < 0.22) setIfAir(lx, ly + 2, lz, rng.random() < 0.5 ? BLOCK_IDS.smallMushroomRed : BLOCK_IDS.smallMushroomBrown);
    }
  };

  // Mossy-cobble boulder: a small blob sitting on the ground (taiga / old-growth).
  const mossyBoulder = (x: number, z: number) => {
    const y0 = surfaceYOf(x, z, ROCK_ROOT);
    if (y0 < 0) return;
    const r = rng.random() < 0.4 ? 2 : 1;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = 1; dy <= r + 1; dy++) {
      if (dx * dx + dz * dz + (dy - 1) * (dy - 1) > (r + 0.4) * (r + 0.4)) continue;
      setIfAir(x + dx, y0 + dy, z + dz, rng.random() < 0.55 ? BLOCK_IDS.mossyCobblestone : BLOCK_IDS.cobblestone);
    }
  };

  // CELL 4 → ~16 feature cells per chunk, so dense biomes (forest, jungle, dark/
  // redwood forest) reach MC-like tree counts (forest ≈ oak0.6×16 ≈ 10/chunk).
  const CELL = 4;
  // APRON-ITERATED, WORLD-CELL-SEEDED placement (fixes trees clipped at chunk
  // borders — the visible grid + half-trees). The OLD loop iterated this chunk's
  // local cells with the per-CHUNK rng, so a tree rooted near the edge had its
  // overhang dropped and the neighbour chunk (different rng) never redrew it.
  // NOW: iterate every WORLD cell that overlaps this chunk PLUS a MARGIN ring, seed
  // a fresh RNG from the cell's WORLD coords, and let set()/setIfAir() clip to this
  // chunk. Every chunk a tree touches computes the byte-identical tree (same cell
  // seed, same columnSurface root) and draws only its own slice → seamless canopies,
  // no grid. MARGIN ≥ the widest canopy reach (giant 2×2 + radius-4 crown ≈ 7).
  const MARGIN = 8;
  const cgx0 = Math.floor((worldX - MARGIN) / CELL), cgx1 = Math.floor((worldX + W + MARGIN) / CELL);
  const cgz0 = Math.floor((worldZ - MARGIN) / CELL), cgz1 = Math.floor((worldZ + W + MARGIN) / CELL);
  for (let cgx = cgx0; cgx <= cgx1; cgx++) {
    for (let cgz = cgz0; cgz <= cgz1; cgz++) {
      // per-CELL deterministic RNG (pure fn of world cell + seed) → the builder
      // closures (which all reference `rng`) produce identical output everywhere.
      rng = new RNG((Math.imul(cgx, 73856093) ^ Math.imul(cgz, 19349663) ^ Math.imul(params.seed, 83492791)) | 0);
      const wx = cgx * CELL + Math.floor(rng.random() * CELL);
      const wz = cgz * CELL + Math.floor(rng.random() * CELL);
      const x = wx - worldX, z = wz - worldZ;          // local (may be <0 or ≥W; set() drops OOB)
      // skip cells whose tree can't possibly reach this chunk
      if (x <= -MARGIN || x >= W + MARGIN || z <= -MARGIN || z >= W + MARGIN) continue;

      const cs = colF(wx, wz);
      const biome = cs.biome;
      const f = BIOMES[biome].features;
      if (!f) continue;
      // RIVERS AS SEPARATORS: skip trees/decorations hugging a lowland river channel
      // so forests don't bleed across the water (deterministic — same river field the
      // carve uses). Only near sea level (where rivers actually run), so mountain
      // ranges that the river field happens to cross aren't thinned.
      if (cs.height - cfg.sea < 14) {
        const riverW = fbm(simplex, wx + 91000, wz + 91000, cfg.featureScale * 6, 2);
        if (1 - sm(Math.abs(riverW), 0.02, 0.055) > 0.4) continue;
      }
      // snow-cap conifers in cold biomes (taiga / snowy / the new snowy mountains)
      const cold = biome === BIOME.taiga || biome === BIOME.snowy || biome === BIOME.mountains;
      // CUMULATIVE single-pick dispatch: each feature's probability is a slice of
      // [0,1); we walk the list subtracting slices so a biome with two features
      // (e.g. redwoodForest redwood0.3 + spruce0.42) gets BOTH at their declared
      // rates (the old elif-chain compared each against the SAME r, so the later
      // feature could never reach its full share → biomes were under-forested).
      // Exactly one feature lands per cell (no overlapping trunks); `flowers` is
      // NOT here — it's a foliage-pass flag.
      let r = rng.random();
      const pick = (prob: number | undefined, place: () => void): boolean => {
        if (prob === undefined) return false;
        if (r < prob) { place(); return true; }
        r -= prob; return false;
      };
      void (
        pick(f.cherry, () => buildTree(x, z, GRASS_ROOT, BLOCK_IDS.cherryLog, BLOCK_IDS.cherryLeaves, 4, 6, 2, 3, 0.72)) ||
        pick(f.giantMushroom, () => buildGiantMushroom(x, z)) ||
        pick(f.redwood, () => redwood(x, z)) ||
        pick(f.spruce, () => spruce(x, z, cold)) ||
        pick(f.jungleTree, () => jungleTree(x, z)) ||
        pick(f.darkOak, () => darkOak(x, z)) ||
        pick(f.acacia, () => acacia(x, z)) ||
        pick(f.birch, () => birch(x, z)) ||
        pick(f.mangrove, () => mangrove(x, z)) ||
        pick(f.swampOak, () => oak(x, z, SWAMP_ROOT, 0.65, 0.6)) ||
        pick(f.oak, () => {
          // plain oak, with a light birch mix in temperate forest for variety.
          const useBirch = biome === BIOME.forest && hash01(worldX + x, worldZ + z) < 0.22;
          oak(x, z, GRASS_ROOT, params.trees.canopy.density, 0,
            useBirch ? BLOCK_IDS.birchLog : BLOCK_IDS.tree,
            useBirch ? BLOCK_IDS.birchLeaves : BLOCK_IDS.leaves);
        }) ||
        pick(f.hugeMushroom, () => buildGiantMushroom(x, z, GRASS_ROOT)) ||
        pick(f.bush, () => bush(x, z, biome === BIOME.jungle ? BLOCK_IDS.jungleLeaves : BLOCK_IDS.leaves)) ||
        pick(f.fallenLog, () => fallenLog(x, z, biome === BIOME.redwoodForest || biome === BIOME.taiga ? BLOCK_IDS.spruceLog
          : biome === BIOME.birchForest ? BLOCK_IDS.birchLog
          : biome === BIOME.darkForest ? BLOCK_IDS.darkOakLog : BLOCK_IDS.tree)) ||
        pick(f.boulder, () => mossyBoulder(x, z)) ||
        pick(f.cactus, () => buildCactus(x, z)) ||
        pick(f.iceSpike, () => buildIceSpike(x, z))
      );
    }
  }
}

// ===========================================================================
//  FOLIAGE  — dense ground cover (grass, ferns, tall grass, flowers, dead bush,
//  lily pads, leaf-litter / cherry-petal carpets, snow sheets). Placed by a PURE
//  function of world (x,z): hashes + the shared simplex, NO per-chunk RNG — so a
//  column grows identical foliage whichever chunk samples it (seamless borders)
//  and the feature RNG sequence is untouched. Low-frequency patch fields cluster
//  grass into meadows and flowers into single-species fields (MC-style), instead
//  of a uniform sprinkle. These are non-cube "plant" blocks the mesher renders as
//  billboards / carpets / pads, and physics treats as non-colliding.
// ===========================================================================
const FLOWERS = [
  BLOCK_IDS.flowerDandelion, BLOCK_IDS.flowerPoppy, BLOCK_IDS.flowerCornflower,
  BLOCK_IDS.flowerOxeye, BLOCK_IDS.flowerAllium, BLOCK_IDS.flowerTulip,
];

function generateFoliage(simplex: SimplexNoise, params: ChunkParams, size: ChunkSize, worldX: number, worldZ: number,
  heightMap: Int16Array, biomeMap: Uint8Array, get: GetFn, set: SetFn) {
  const cfg = makeSurfaceConfig(params, size);
  const sea = cfg.sea;
  const W = size.width;
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < W; z++) {
      const wx = worldX + x, wz = worldZ + z;
      const idx = x * W + z;
      const biome = biomeMap[idx];
      const h = heightMap[idx];

      // --- submerged columns: lily pads (lakes/swamps) + seabed seagrass -----
      if (h < sea) {
        const depth = sea - h;
        let placed = false;
        // Lily pads only on shallow LAKE / SWAMP water (rivers excluded per request).
        if ((biome === BIOME.lake || biome === BIOME.swamp || biome === BIOME.mangroveSwamp) && depth <= 5 && get(x, sea, z) === BLOCK_IDS.air
            && fbm(simplex, wx + 33000, wz + 33000, 22, 2) > 0.34 && hash01(wx + 5, wz + 9) < 0.55) {
          set(x, sea, z, BLOCK_IDS.lilyPad);
          placed = true;
        }
        // Kelp: tall swaying columns in cold/normal/lukewarm oceans (NOT warm/frozen,
        // matching MC). A stack of kelp crosses from the seabed toward the surface,
        // capped by a leafier kelp tip; pure fn of (wx,wz) → seamless across borders.
        if (!placed && (biome === BIOME.ocean || biome === BIOME.coldOcean || biome === BIOME.lukewarmOcean)
            && depth >= 3 && get(x, h + 1, z) === BLOCK_IDS.air
            && fbm(simplex, wx + 51000, wz + 51000, 24, 2) > 0.42 && hash01(wx + 7, wz + 31) < 0.20) {
          const topY = Math.min(h + 2 + Math.floor(hash01(wx + 3, wz + 13) * (depth - 1)), sea - 2);
          for (let yy = h + 1; yy <= topY; yy++) set(x, yy, z, BLOCK_IDS.kelp);
          if (topY >= h + 1) set(x, topY, z, BLOCK_IDS.kelpTop);
          placed = true;
        }
        // Sea pickles: small warm-ocean seabed clusters (warm-ocean identity).
        if (!placed && biome === BIOME.warmOcean && depth >= 1 && depth <= 14 && get(x, h + 1, z) === BLOCK_IDS.air
            && fbm(simplex, wx + 52000, wz + 52000, 12, 2) > 0.4 && hash01(wx + 11, wz + 5) < 0.35) {
          set(x, h + 1, z, BLOCK_IDS.seaPickle); placed = true;
        }
        // Seagrass / tall seagrass carpet the seabed in shallow-to-mid water of any
        // kind (oceans, lakes, rivers); the deep abyss stays bare (depth cap + perf).
        if (!placed && depth >= 1 && depth <= 16 && get(x, h + 1, z) === BLOCK_IDS.air) {
          const sr = hash01(wx + 17, wz + 23);
          if (fbm(simplex, wx + 24000, wz + 24000, 20, 2) > 0.25 && sr < 0.5) {
            if (sr < 0.14 && h + 2 < sea && get(x, h + 2, z) === BLOCK_IDS.air) {
              set(x, h + 1, z, BLOCK_IDS.tallSeagrassLower);
              set(x, h + 2, z, BLOCK_IDS.tallSeagrassUpper);
            } else {
              set(x, h + 1, z, BLOCK_IDS.seagrass);
            }
          }
        }
        continue;                                  // submerged column — nothing else grows
      }
      if (h <= sea) continue;                      // exact waterline / beach lip — leave bare
      if (get(x, h + 1, z) !== BLOCK_IDS.air) continue;   // a trunk/canopy already occupies it

      const top = get(x, h, z);
      const r = hash01(wx, wz);

      // --- multi-layered snow on snowy ground & alpine caps -----------------
      if (top === BLOCK_IDS.snow) {
        const sf = fbm(simplex, wx + 12000, wz + 12000, 22, 2);     // snow-depth field
        const snowy = biome === BIOME.snowy || biome === BIOME.iceSpikes;
        const cover = clamp((snowy ? 0.85 : 0.5) + sf * 0.4, 0, 1);
        if (r < cover) {
          // stack 0-2 solid snow blocks (deep drifts), then a thin top layer
          const depth = snowy ? (sf > 0.4 ? 2 : sf > 0.1 ? 1 : 0) : (sf > 0.45 ? 1 : 0);
          let t2 = h;
          for (let d = 1; d <= depth && h + d < size.height; d++) { set(x, h + d, z, BLOCK_IDS.snow); t2 = h + d; }
          if (t2 + 1 < size.height && get(x, t2 + 1, z) === BLOCK_IDS.air) set(x, t2 + 1, z, BLOCK_IDS.snowLayer);
        }
        continue;
      }

      // --- sugar cane on a waterside bank (grass/sand right next to water) ---
      if ((top === BLOCK_IDS.grass || top === BLOCK_IDS.sand) && h - sea <= 3) {
        // waterside if any neighbour column is below sea. Off-chunk neighbours sample
        // the REAL deterministic surface (was faked as h-1, which is >= sea for a bank
        // at h>=sea+1 → the <sea test never fired off-chunk, leaving a ~16-block gap in
        // cane along every chunk-border shoreline). columnSurface is pure → seamless.
        const wAt = (nx: number, nz: number) =>
          (nx >= 0 && nx < W && nz >= 0 && nz < W) ? heightMap[nx * W + nz] : columnSurface(simplex, cfg, worldX + nx, worldZ + nz).height;
        const waterside = wAt(x - 1, z) < sea || wAt(x + 1, z) < sea || wAt(x, z - 1) < sea || wAt(x, z + 1) < sea;
        if (waterside && fbm(simplex, wx + 5500, wz + 5500, 16, 2) > -0.1 && r < 0.7) {
          const ch = 1 + (hash01(wx + 3, wz + 8) < 0.55 ? 1 : 0) + (hash01(wx + 5, wz + 2) < 0.25 ? 1 : 0);  // 1-3 tall
          for (let i = 1; i <= ch && h + i < size.height; i++) set(x, h + i, z, BLOCK_IDS.sugarCane);
          continue;
        }
      }

      // --- Wave-4 land vegetation (claim the cell, like the other ground cover) ---
      // Sweet berry bushes: taiga / redwood, on grass or podzol (patchy).
      if ((biome === BIOME.taiga || biome === BIOME.redwoodForest) && (top === BLOCK_IDS.grass || top === BLOCK_IDS.podzol)
          && fbm(simplex, wx + 47000, wz + 47000, 14, 2) > 0.45 && r < 0.10) {
        set(x, h + 1, z, BLOCK_IDS.sweetBerryBush); continue;
      }
      // Bamboo: sparse 4-9-tall canes (stacked cross billboards) in jungle.
      if (biome === BIOME.jungle && top === BLOCK_IDS.grass
          && fbm(simplex, wx + 48000, wz + 48000, 18, 2) > 0.35 && r < 0.10) {
        const bh = 4 + Math.floor(hash01(wx + 19, wz + 7) * 6);
        for (let i = 1; i <= bh && h + i < size.height && get(x, h + i, z) === BLOCK_IDS.air; i++) set(x, h + i, z, BLOCK_IDS.bamboo);
        continue;
      }
      // Pumpkin: rare lone gourd (a solid cube) on any grassy biome.
      if (top === BLOCK_IDS.grass && hash01(wx + 311, wz + 733) < 0.006 && fbm(simplex, wx + 49000, wz + 49000, 10, 1) > 0.2) {
        set(x, h + 1, z, BLOCK_IDS.pumpkin); continue;
      }
      // Tall (2-block) flowers — sunflower / lilac / rose bush / peony — a rare
      // highlight in flower-rich + plains/forest biomes; single-species patches.
      if (top === BLOCK_IDS.grass && (h + 2) < size.height && get(x, h + 2, z) === BLOCK_IDS.air
          && (biome === BIOME.flowerForest || biome === BIOME.meadow || biome === BIOME.plains
              || biome === BIOME.forest || biome === BIOME.birchForest || biome === BIOME.warmForest)
          && fbm(simplex, wx + 50000, wz + 50000, 20, 2) > 0.4 && r < (biome === BIOME.flowerForest ? 0.10 : 0.03)) {
        const k = Math.abs(Math.floor(fbm(simplex, wx + 95000, wz + 95000, 50, 1) * 7)) % 4;
        const lower = [BLOCK_IDS.sunflowerLower, BLOCK_IDS.lilacLower, BLOCK_IDS.roseBushLower, BLOCK_IDS.peonyLower][k];
        const upper = [BLOCK_IDS.sunflowerUpper, BLOCK_IDS.lilacUpper, BLOCK_IDS.roseBushUpper, BLOCK_IDS.peonyUpper][k];
        set(x, h + 1, z, lower); set(x, h + 2, z, upper); continue;
      }

      // --- dead bush on hot, dry sand --------------------------------------
      if (top === BLOCK_IDS.sand || top === BLOCK_IDS.redSand) {
        if (biome === BIOME.desert || biome === BIOME.redDesert || biome === BIOME.badlands
            || biome === BIOME.savanna || biome === BIOME.scrub) {
          const df = fbm(simplex, wx + 8000, wz + 8000, 30, 2);
          if (df > 0.2 && r < 0.06) set(x, h + 1, z, BLOCK_IDS.deadBush);
        }
        continue;
      }

      // --- small mushrooms on mycelium / podzol ----------------------------
      if (top === BLOCK_IDS.mycelium || top === BLOCK_IDS.podzol) {
        if (fbm(simplex, wx + 6200, wz + 6200, 18, 2) > 0.2 && r < 0.1) {
          set(x, h + 1, z, hash01(wx + 9, wz + 4) < 0.5 ? BLOCK_IDS.smallMushroomRed : BLOCK_IDS.smallMushroomBrown);
        }
        continue;
      }

      if (top !== BLOCK_IDS.grass) continue;       // mud/dirt/stone → no ground cover

      // --- dark forest: dim undergrowth — clustered mushrooms + heavy litter ---
      if (biome === BIOME.darkForest) {
        if (r < 0.09) { set(x, h + 1, z, hash01(wx + 9, wz + 4) < 0.5 ? BLOCK_IDS.smallMushroomRed : BLOCK_IDS.smallMushroomBrown); continue; }
        if (fbm(simplex, wx + 4000, wz + 4000, 20, 2) > 0.1 && hash01(wx + 13, wz + 91) < 0.6) { set(x, h + 1, z, BLOCK_IDS.leafLitter); continue; }
      }

      // --- forest litter & cherry petals (carpets) — claim the cell first ---
      if (biome === BIOME.cherry && hash01(wx + 71, wz + 17) < 0.6) {   // denser blossom carpet
        set(x, h + 1, z, BLOCK_IDS.cherryPetals); continue;
      }
      if ((biome === BIOME.forest || biome === BIOME.warmForest || biome === BIOME.taiga
           || biome === BIOME.redwoodForest || biome === BIOME.birchForest || biome === BIOME.jungle)
          && fbm(simplex, wx + 4000, wz + 4000, 20, 2) > 0.35 && hash01(wx + 13, wz + 91) < 0.5) {
        set(x, h + 1, z, BLOCK_IDS.leafLitter); continue;
      }

      // --- flower-heavy biomes (flower forest / meadow / birch): flowers FIRST,
      //     densely, so the ground reads as a wildflower field -----------------
      const flowerBoost = BIOMES[biome].features?.flowers ?? 0;
      if (flowerBoost > 0) {
        const ff0 = fbm(simplex, wx + 60000, wz + 60000, 16, 2);
        const fp = clamp((ff0 + 0.25) * flowerBoost, 0, flowerBoost);
        if (hash01(wx + 7, wz + 3) < fp) {
          const sp = (Math.abs(Math.floor(fbm(simplex, wx + 90000, wz + 90000, 40, 1) * 11))) % FLOWERS.length;
          set(x, h + 1, z, FLOWERS[sp]); continue;
        }
      }

      // --- grass / fern / tall grass (patchy meadows; lush in jungle/redwood) --
      const dens = fbm(simplex, wx + 200, wz + 200, 30, 2);
      const lush = biome === BIOME.jungle || biome === BIOME.redwoodForest;
      let grassProb = clamp(0.34 + dens * 0.55, 0.05, 0.9);
      if (lush) grassProb = clamp(grassProb + 0.35, 0.05, 0.96);
      if (r < grassProb) {
        const r2 = hash01(wx + 41, wz + 67);
        const wooded = biome === BIOME.taiga || biome === BIOME.forest || biome === BIOME.warmForest
          || biome === BIOME.jungle || biome === BIOME.redwoodForest || biome === BIOME.darkForest
          || biome === BIOME.birchForest || biome === BIOME.mangroveSwamp;
        const tallOk = biome === BIOME.plains || biome === BIOME.savanna || biome === BIOME.warmForest
          || biome === BIOME.meadow || biome === BIOME.flowerForest || biome === BIOME.birchForest
          || biome === BIOME.jungle || dens > 0.3;
        const twoCell = h + 2 < size.height && get(x, h + 2, z) === BLOCK_IDS.air;
        if (r2 < (lush ? 0.28 : 0.16) && twoCell && tallOk) {
          set(x, h + 1, z, BLOCK_IDS.tallGrassLower);
          set(x, h + 2, z, BLOCK_IDS.tallGrassUpper);
        } else if (r2 < (lush ? 0.55 : 0.24) && twoCell && wooded) {
          set(x, h + 1, z, BLOCK_IDS.largeFernLower);   // 2-block fern in woods
          set(x, h + 2, z, BLOCK_IDS.largeFernUpper);
        } else if (r2 < (lush ? 0.72 : 0.34) && wooded) {
          set(x, h + 1, z, BLOCK_IDS.fern);
        } else {
          set(x, h + 1, z, BLOCK_IDS.shortGrass);
        }
        continue;
      }

      // --- flowers — sparse, clustered into single-species patches ----------
      const ff = fbm(simplex, wx + 60000, wz + 60000, 16, 2);
      const flowerProb = clamp((ff - 0.1) * 0.5, 0, 0.22);
      if (hash01(wx + 7, wz + 3) < flowerProb) {
        const species = (Math.abs(Math.floor(fbm(simplex, wx + 90000, wz + 90000, 40, 1) * 11))) % FLOWERS.length;
        set(x, h + 1, z, (biome === BIOME.swamp || biome === BIOME.mangroveSwamp) ? BLOCK_IDS.flowerBlueOrchid : FLOWERS[species]);
      }
    }
  }
}

// ===========================================================================
//  STRUCTURES — multi-chunk procedural buildings on a deterministic region grid
//  (MC-style: each STRUCT_CELL region may hold one structure at a seeded jittered
//  origin; EVERY chunk overlapping the footprint writes the slice within its
//  bounds, so a building spans chunks seamlessly). Buildings are laid on a flat
//  platform built UP to the footprint's max ground height (foundation fills the
//  gap; never digs below the surface) → apron-safe like trees: borders only get
//  hidden overdraw, never holes. Pure fn of (cell, seed) → deterministic.
//
//  Sub-surface carves (well shafts) have an apron-aware report (wellShaftRange)
//  so a chunk border bisecting a hollow column still seals correctly. Anything
//  *above* a column's natural surface is air-by-default in the apron and needs
//  no extra reporting — so e.g. a pyramid's "basement" is built INSIDE an
//  ELEVATED stone foundation (above max ground), keeping the whole structure
//  apron-safe with no special-case reporting.
// ===========================================================================
export const STRUCT_CELL = 144;    // one potential structure per region (~half as dense as before)
const STRUCT_INSET = 48;    // origin jitter stays ≥48 from the cell edge (no cross-cell overlap)
const STRUCT_MAX_R = 56;    // largest footprint half-extent (mansion / village spread) — chunk overlap scan range
export const ST_WELL = 1, ST_TOWER = 2, ST_PYRAMID = 3, ST_HOUSE = 4, ST_VILLAGE = 5, ST_MANSION = 6, ST_IGLOO = 7;
// Extras: bring more variety. Each fits a niche biome via structureFitsBiome.
export const ST_CAMPSITE = 8, ST_RUINS = 9, ST_OUTPOST = 10, ST_LIGHTHOUSE = 11, ST_WITCH_HUT = 12;
const WELL_SHAFT = 8;       // a well's centre column is carved this many blocks below ground

// Does a structure of `kind` build in `biome`? Shared by the generator AND the map
// (so map markers only appear where a structure actually generates).
const structGrassy = (b: number) => b === BIOME.plains || b === BIOME.forest || b === BIOME.savanna
  || b === BIOME.coldPlains || b === BIOME.warmForest || b === BIOME.taiga || b === BIOME.cherry || b === BIOME.scrub
  || b === BIOME.meadow || b === BIOME.birchForest || b === BIOME.flowerForest;
const structCold = (b: number) => b === BIOME.snowy || b === BIOME.iceSpikes || b === BIOME.coldPlains
  || b === BIOME.taiga || b === BIOME.redwoodForest || b === BIOME.mountains;
const structDryLand = (b: number) => b === BIOME.plains || b === BIOME.savanna || b === BIOME.scrub
  || b === BIOME.coldPlains || b === BIOME.desert || b === BIOME.redDesert;
const structAnyLand = (b: number) => b !== BIOME.ocean && b !== BIOME.frozenOcean && b !== BIOME.coldOcean
  && b !== BIOME.lukewarmOcean && b !== BIOME.warmOcean
  && b !== BIOME.river && b !== BIOME.frozenRiver && b !== BIOME.lake;
export function structureFitsBiome(kind: number, biome: number): boolean {
  switch (kind) {
    case ST_PYRAMID: return biome === BIOME.desert || biome === BIOME.redDesert;
    case ST_VILLAGE: case ST_HOUSE: return structGrassy(biome);
    case ST_MANSION: return biome === BIOME.darkForest;   // woodland mansion is dark-forest-exclusive (MC)
    case ST_IGLOO: return structCold(biome);
    case ST_CAMPSITE: return structGrassy(biome) || structCold(biome);
    case ST_RUINS: return structAnyLand(biome) && biome !== BIOME.mushroom && biome !== BIOME.beach;
    case ST_OUTPOST: return structDryLand(biome);
    case ST_LIGHTHOUSE: return biome === BIOME.beach;
    case ST_WITCH_HUT: return biome === BIOME.swamp || biome === BIOME.mangroveSwamp;
    default: return true;   // well / tower on any land (platform null-check excludes water)
  }
}

export type StructInfo = { kind: number, ox: number, oz: number, seed: number };
export function structInfo(cellX: number, cellZ: number, seed: number): StructInfo | null {
  if (hash01(cellX * 1013 + (seed & 1023) * 7 + 1, cellZ * 1013 + (seed & 1023) * 13 + 5) > 0.46) return null; // ~46% of cells
  const span = STRUCT_CELL - 2 * STRUCT_INSET;
  const ox = cellX * STRUCT_CELL + STRUCT_INSET + Math.floor(hash01(cellX * 263 + 1, cellZ * 263 + 9) * span);
  const oz = cellZ * STRUCT_CELL + STRUCT_INSET + Math.floor(hash01(cellX * 263 + 5, cellZ * 263 + 7) * span);
  // Distribution favours the small "found-in-the-wild" structures (campsite/ruins/
  // outpost) so the world has scattered points of interest, with rarer big sets.
  const k = hash01(cellX * 617 + 3, cellZ * 617 + 11);
  const kind =
    k < 0.14 ? ST_VILLAGE :
    k < 0.22 ? ST_TOWER :
    k < 0.30 ? ST_HOUSE :
    k < 0.38 ? ST_WELL :
    k < 0.46 ? ST_PYRAMID :
    k < 0.52 ? ST_IGLOO :
    k < 0.55 ? ST_MANSION :
    k < 0.66 ? ST_CAMPSITE :
    k < 0.76 ? ST_RUINS :
    k < 0.84 ? ST_OUTPOST :
    k < 0.92 ? ST_LIGHTHOUSE :
    ST_WITCH_HUT;
  const sseed = (Math.imul(cellX, 374761393) ^ Math.imul(cellZ, 668265263) ^ Math.imul(seed | 0, 2246822519)) | 0;
  return { kind, ox, oz, seed: sseed };
}

// --- deep-well apron hook -------------------------------------------------
// A well (standalone OR a village's central well) carves an AIR shaft straight
// down its centre column — the ONE place a structure digs BELOW the surface. So
// the stateless worker apron (which otherwise assumes everything below the
// deterministic surface is solid) must know this column is hollow, or a chunk
// border bisecting a well would leave the shaft's inner wall unsealed (an x-ray
// gap). `wellShaftRange` reports that carved [yLo,yHi] for the centre column —
// and ONLY the literal centre column does real work, so it's cheap per border.
function wellBaseAt(sample: WorldSampler, sea: number, wx: number, wz: number): number | null {
  let base = 0, lo = 1e9;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const hh = sample(wx + dx, wz + dz).height;
    if (hh > base) base = hh;
    if (hh < lo) lo = hh;
  }
  return (base <= sea || base - lo > 7) ? null : base;   // identical site-check to platform(r=2)
}
export function wellShaftRange(params: ChunkParams, sample: WorldSampler, wx: number, wz: number): [number, number] | null {
  const cellX = Math.floor(wx / STRUCT_CELL), cellZ = Math.floor(wz / STRUCT_CELL);
  const s = structInfo(cellX, cellZ, params.seed);
  if (!s || s.ox !== wx || s.oz !== wz) return null;           // not a structure origin column
  if (s.kind !== ST_WELL && s.kind !== ST_VILLAGE) return null; // only wells dig a shaft (village → central well)
  if (!structureFitsBiome(s.kind, sample(wx, wz).biome)) return null;
  const base = wellBaseAt(sample, params.terrain.waterOffset, wx, wz);
  return base === null ? null : [base - WELL_SHAFT + 1, base];
}

function generateStructures(simplex: SimplexNoise, params: ChunkParams, size: ChunkSize, worldX: number, worldZ: number, set: SetFn) {
  const cfg = makeSurfaceConfig(params, size);
  const W = size.width, H = size.height, sea = cfg.sea, B = BLOCK_IDS;
  const colMemo = new Map<string, ColumnSurface>();
  const colAt = (wx: number, wz: number): ColumnSurface => {
    const key = wx + ',' + wz;
    let v = colMemo.get(key);
    if (!v) { v = columnSurface(simplex, cfg, wx, wz); colMemo.set(key, v); }
    return v;
  };
  // Write a block at WORLD coords; set() bounds-checks, so out-of-chunk writes no-op.
  const place = (wx: number, wy: number, wz: number, id: number) => { if (wy >= 0 && wy < H) set(wx - worldX, wy, wz - worldZ, id); };

  // Flat platform: base = max ground height over the footprint. null if in water
  // or too steep (so buildings sit on flat-ish, dry land — MC-style site check).
  const platform = (ox: number, oz: number, r: number): number | null => {
    // sample EVERY column (not a coarse grid) so `base` is the TRUE max — a missed
    // 1-block spike would otherwise let the air-clear below dig under it (a hole).
    let base = 0, lo = 1e9;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const hh = colAt(ox + dx, oz + dz).height;
      if (hh > base) base = hh;
      if (hh < lo) lo = hh;
    }
    return (base <= sea || base - lo > 7) ? null : base;
  };
  // Foundation fill up to `base` (above each column's surface) + clear building air.
  // Clearing starts ABOVE max(base, column surface) so it NEVER digs below a
  // column's terrain → apron-safe (borders get overdraw, never holes).
  const lay = (ox: number, oz: number, r: number, base: number, foundId: number, clearH: number) => {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const wx = ox + dx, wz = oz + dz, sh = colAt(wx, wz).height;
      for (let wy = sh + 1; wy <= base; wy++) place(wx, wy, wz, foundId);
      for (let wy = Math.max(base, sh) + 1; wy <= base + clearH; wy++) place(wx, wy, wz, B.air);
    }
  };
  const fillRect = (x0: number, z0: number, x1: number, z1: number, y: number, id: number) => {
    for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++) place(wx, y, wz, id);
  };
  const walls = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, id: number) => {
    for (let wy = y0; wy <= y1; wy++) for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++)
      if (wx === x0 || wx === x1 || wz === z0 || wz === z1) place(wx, wy, wz, id);
  };
  const fillBox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number) => {
    for (let wy = y0; wy <= y1; wy++) for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++) place(wx, wy, wz, id);
  };
  // The travel-direction → stair-id helper (PX = tall step on +x, etc.), and a
  // 1-wide staircase flight that rises one block per cell AND punches the air
  // above each step up through the ceiling — so the stairwell is open and the
  // top step emerges onto the floor above. Climbable via the 0.6 auto-step.
  const stairFor = (set4: readonly [number, number, number, number], dxs: number, dzs: number) =>
    dxs > 0 ? set4[0] : dxs < 0 ? set4[1] : dzs > 0 ? set4[2] : set4[3];
  type StairSet = readonly [number, number, number, number];
  // Stair sets: indices [PX(-x edge), NX(+x edge), PZ(-z edge), NZ(+z edge)] —
  // i.e. set[i] is the stair to use AT the i-th edge (tall back faces inward).
  const OAK_ST: StairSet = [B.oakStairsPX, B.oakStairsNX, B.oakStairsPZ, B.oakStairsNZ];
  const COB_ST: StairSet = [B.cobbleStairsPX, B.cobbleStairsNX, B.cobbleStairsPZ, B.cobbleStairsNZ];
  const STN_ST: StairSet = [B.stoneStairsPX, B.stoneStairsNX, B.stoneStairsPZ, B.stoneStairsNZ];
  const SS_ST: StairSet = [B.sandstoneStairsPX, B.sandstoneStairsNX, B.sandstoneStairsPZ, B.sandstoneStairsNZ];
  const flight = (sx: number, sz: number, dxs: number, dzs: number, y0: number, count: number, stairId: number, ceilY: number) => {
    for (let i = 0; i < count; i++) {
      const x = sx + dxs * i, z = sz + dzs * i, y = y0 + i;
      place(x, y, z, stairId);
      for (let hy = y + 1; hy <= ceilY + 1; hy++) place(x, hy, z, B.air);   // headroom + open the floor above
    }
  };

  // ===========================================================================
  //  WALL & ROOF DETAIL HELPERS — community-style "weathered" mixed-block walls
  //  and proper sloped roofs built out of stairs (with slab caps) so structures
  //  read as real medieval/fantasy builds rather than uniform cube boxes.
  // ===========================================================================

  // Per-cell weathered block selector: a deterministic hash dithers the SAME
  // base material across mossy / cracked / standard variants so big stone
  // surfaces (tower, ruins, mansion foundation) read as aged masonry instead of
  // a uniform single-tone wall. Values picked to roughly match community
  // tutorials' guidance: ~10% mossy, ~8% cracked, rest plain.
  const weatheredStoneBricks = (wx: number, wy: number, wz: number) => {
    const h = hash01(wx * 13 + wy * 7, wz * 17 + wy * 5);
    return h < 0.10 ? B.mossyStoneBricks : h < 0.18 ? B.crackedStoneBricks : B.stoneBricks;
  };
  const weatheredCobble = (wx: number, wy: number, wz: number) => {
    const h = hash01(wx * 11 + wy * 3, wz * 19 + wy * 7);
    return h < 0.16 ? B.mossyCobblestone : B.cobblestone;
  };
  // Hip roof (pyramid-shape): inset 1 block per row, edge stairs face inward
  // so the slope reads correctly. fillId fills the apex ridge / centre.
  const hipRoof = (x0: number, z0: number, x1: number, z1: number, y0: number, stairs: StairSet, fillId: number) => {
    let lx = x0, hx = x1, lz = z0, hz = z1, y = y0;
    while (lx < hx && lz < hz) {
      for (let wx = lx; wx <= hx; wx++) { place(wx, y, lz, stairs[2]); place(wx, y, hz, stairs[3]); }
      for (let wz = lz; wz <= hz; wz++) { place(lx, y, wz, stairs[0]); place(hx, y, wz, stairs[1]); }
      lx++; hx--; lz++; hz--; y++;
    }
    if (lx === hx && lz === hz) place(lx, y, lz, fillId);
    else if (lx === hx) for (let wz = lz; wz <= hz; wz++) place(lx, y, wz, fillId);
    else if (lz === hz) for (let wx = lx; wx <= hx; wx++) place(wx, y, lz, fillId);
  };
  // Gable roof (saddle): two slopes meeting at a ridge along the longer axis.
  // Adds a 1-block overhang on the eaves for a proper medieval silhouette.
  const gableRoof = (x0: number, z0: number, x1: number, z1: number, y0: number, stairs: StairSet, capSlab: number) => {
    const dx = x1 - x0 + 1, dz = z1 - z0 + 1;
    if (dx >= dz) {
      const rows = Math.ceil(dz / 2);
      for (let i = 0; i < rows; i++) {
        const y = y0 + i, za = z0 + i, zb = z1 - i;
        if (za > zb) break;
        if (za === zb) for (let wx = x0; wx <= x1; wx++) place(wx, y, za, capSlab);
        else for (let wx = x0; wx <= x1; wx++) { place(wx, y, za, stairs[2]); place(wx, y, zb, stairs[3]); }
      }
    } else {
      const rows = Math.ceil(dx / 2);
      for (let i = 0; i < rows; i++) {
        const y = y0 + i, xa = x0 + i, xb = x1 - i;
        if (xa > xb) break;
        if (xa === xb) for (let wz = z0; wz <= z1; wz++) place(xa, y, wz, capSlab);
        else for (let wz = z0; wz <= z1; wz++) { place(xa, y, wz, stairs[0]); place(xb, y, wz, stairs[1]); }
      }
    }
  };

  // Lamppost: a 1-block-thick log column with a fence cap and a glowstone lantern.
  // Sits at the column surface so it reads as a real street light, not a floater.
  const lampPost = (wx: number, wz: number, baseY: number, postId = B.darkOakLog) => {
    place(wx, baseY + 1, wz, postId);
    place(wx, baseY + 2, wz, postId);
    place(wx, baseY + 3, wz, postId);
    place(wx, baseY + 4, wz, B.oakFence);
    place(wx, baseY + 5, wz, B.lantern);   // a lantern atop the post — glows + lights the area
  };

  // Stone chimney: thin 1×1 column with a lantern "ember" capped by a cobble
  // pot — pokes through the gable roof to read as a wood-burning fireplace.
  // Uses a lantern (warm ember light) instead of glowstone — overworld-appropriate.
  const chimney = (wx: number, wz: number, baseY: number, topY: number) => {
    for (let wy = baseY; wy <= topY - 2; wy++) place(wx, wy, wz, weatheredCobble(wx, wy, wz));
    place(wx, topY - 1, wz, B.lantern);
    place(wx, topY, wz, B.cobbleSlab);
  };

  // Surface-aware path drawer: lays one path block at each step along a winding
  // simplex-jittered route from (ax,az) to (bx,bz). Each block sits at the
  // column's own surface (height unchanged → apron-safe). Skips water/ice and
  // any tile inside an `avoid` rectangle (so paths route AROUND buildings
  // instead of through them, per the user's request).
  const onSurfaceAllowed = (top: number) =>
    top === B.grass || top === B.dirt || top === B.sand || top === B.redSand
    || top === B.podzol || top === B.gravel || top === B.snow || top === B.mud
    || top === B.mycelium;
  const drawWindingPath = (
    ax: number, az: number, bx: number, bz: number,
    width: number, mainBlock: number, accentBlock: number,
    avoidBoxes: ReadonlyArray<readonly [number, number, number, number]> = [],
  ) => {
    const inAvoid = (wx: number, wz: number) => {
      for (const [x0, z0, x1, z1] of avoidBoxes)
        if (wx >= x0 && wx <= x1 && wz >= z0 && wz <= z1) return true;
      return false;
    };
    const lay1 = (wx: number, wz: number) => {
      if (inAvoid(wx, wz)) return;
      const c = colAt(wx, wz);
      if (c.height <= sea) return;
      if (!onSurfaceAllowed(c.surfaceId)) return;
      const block = hash01(wx * 13 + 7, wz * 17 + 11) < 0.18 ? accentBlock : mainBlock;
      place(wx, c.height, wz, block);
    };
    const dxv = bx - ax, dzv = bz - az;
    const dist = Math.max(1, Math.hypot(dxv, dzv));
    const steps = Math.ceil(dist * 1.4);
    const ux = -dzv / dist, uz = dxv / dist;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const off = simplex.noise(ax * 0.05 + t * 5, az * 0.05 + t * 5) * dist * 0.10
                + simplex.noise(ax * 0.20 + t * 11, az * 0.20 + t * 11) * dist * 0.04;
      const cx = ax + dxv * t + ux * off;
      const cz = az + dzv * t + uz * off;
      const w = width;
      for (let dx2 = -w; dx2 <= w; dx2++) for (let dz2 = -w; dz2 <= w; dz2++) {
        if (Math.hypot(dx2, dz2) > w + 0.4) continue;
        lay1(Math.round(cx + dx2), Math.round(cz + dz2));
      }
    }
  };
  // Trail path: leaves a structure heading roughly outward, twisting via a
  // simplex angle field; thins out (gaps + narrowing) the further it goes so
  // the world reads as having been TRAVELLED FROM, not built. Pure fn of seed.
  const drawTrailPath = (sx: number, sz: number, len: number, dirRad: number) => {
    let cx = sx + 0.5, cz = sz + 0.5, ang = dirRad;
    for (let s = 0; s < len; s++) {
      ang += simplex.noise(cx * 0.06 + 1000, cz * 0.06 + 1000) * 0.6;
      cx += Math.cos(ang); cz += Math.sin(ang);
      const t = s / len;
      const w = 2 - t * 1.7;     // 2 → ~0.3 over the trail
      const fade = t * 0.65;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        if (Math.hypot(dx, dz) > w) continue;
        const wx = Math.round(cx + dx), wz = Math.round(cz + dz);
        if (hash01(wx * 13, wz * 17) < fade) continue;
        const c = colAt(wx, wz);
        if (c.height <= sea || !onSurfaceAllowed(c.surfaceId)) continue;
        const r2 = hash01(wx + 99, wz + 31);
        place(wx, c.height, wz, r2 < 0.6 ? B.gravel : r2 < 0.88 ? B.dirt : B.cobblestone);
      }
    }
  };

  // --- building recipes (all in WORLD coords; place() filters to this chunk) ---
  // Cabin (9×7, one storey). Mossy/cracked stone-brick lower trim + log corners
  // + plank infill + gable roof of oak stairs with eave overhang and a stone
  // chimney through the ridge. Front entrance has a stair "step up" to the
  // door, log header above, and trapdoor shutters next to the front window —
  // the bread-and-butter village house.
  const cabin = (ox: number, oz: number, logId: number, plankId: number) => {
    const rx = 4, rz = 3;
    const base = platform(ox, oz, Math.max(rx, rz));
    if (base === null) return;
    lay(ox, oz, Math.max(rx, rz) + 1, base, B.cobblestone, 9);
    const x0 = ox - rx, x1 = ox + rx, z0 = oz - rz, z1 = oz + rz;
    // STONE FOUNDATION (base+1): weathered cobble strip — grounds the build.
    for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++) {
      if (wx === x0 || wx === x1 || wz === z0 || wz === z1)
        place(wx, base + 1, wz, weatheredCobble(wx, base + 1, wz));
    }
    // FLOOR: oak/birch planks (depending on palette) one block above ground
    fillRect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, base + 1, plankId);
    // PLANK WALLS (level 2-4)
    walls(x0, z0, x1, z1, base + 2, base + 4, plankId);
    // LOG CORNER POSTS (full height incl. ridge anchor)
    for (let wy = base + 1; wy <= base + 5; wy++) {
      place(x0, wy, z0, logId); place(x1, wy, z0, logId); place(x0, wy, z1, logId); place(x1, wy, z1, logId);
    }
    // TOP PLATE: log
    walls(x0, z0, x1, z1, base + 5, base + 5, logId);
    // GABLE ROOF (with 1-block eave overhang) — ridge runs along x (longer side)
    gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, base + 6, OAK_ST, B.oakSlab);
    // CHIMNEY through the ridge on the +x gable
    chimney(x1 - 1, z1 - 1, base + 1, base + 9);
    // FRONT DOOR + step up + log lintel
    place(ox, base + 2, z0, B.oakDoorLowerClosed); place(ox, base + 3, z0, B.oakDoorUpperClosed);
    place(ox, base + 4, z0, logId);
    place(ox, base + 1, z0 - 1, OAK_ST[2]);   // PZ stair: step up to door from -z
    // FRONT WINDOW (next to door) + trapdoor shutter accents
    place(ox + 2, base + 3, z0, B.glass);
    place(ox + 2, base + 4, z0, OAK_ST[3]);   // overhang lintel (NZ stair)
    // SIDE / BACK WINDOWS
    place(x0, base + 3, oz, B.glass); place(x1, base + 3, oz, B.glass);
    place(ox, base + 3, z1, B.glass); place(ox - 2, base + 3, z1, B.glass);
    // BED (real bed block) in the back corner + a chest, a crafting table, a small
    // bookshelf and a potted flower — a furnished one-room cabin.
    place(x0 + 1, base + 2, z1 - 1, B.bedHead); place(x0 + 1, base + 2, z1 - 2, B.bedFoot);
    place(x0 + 2, base + 2, z1 - 1, B.chest);
    place(x1 - 1, base + 2, z1 - 1, B.craftingTable); place(x1 - 1, base + 2, z1 - 2, B.bookshelf);
    place(x1 - 1, base + 2, oz, B.furnace);
    place(x0 + 1, base + 2, oz, B.barrel); place(x0 + 1, base + 3, oz, B.flowerPot);
    // FENCE-SUPPORTED FRONT PORCH AWNING: 2 fence posts + a roof slab plate
    place(ox - 2, base + 2, z0 - 1, B.oakFence);
    place(ox + 2, base + 2, z0 - 1, B.oakFence);
    place(ox - 2, base + 3, z0 - 1, B.oakSlab);
    place(ox - 1, base + 3, z0 - 1, B.oakSlab);
    place(ox, base + 3, z0 - 1, B.oakSlab);
    place(ox + 1, base + 3, z0 - 1, B.oakSlab);
    place(ox + 2, base + 3, z0 - 1, B.oakSlab);
    // INTERIOR LIGHT (hung from ridge): lantern reads as a warm hearth lamp.
    // Glowstone is a Nether block — overworld houses use lanterns / torches.
    place(ox, base + 5, oz, B.lantern);
  };
  // Two-storey house (9×9). Mossy stone foundation, log corner trim, plank
  // walls with cross-beam log accents, a porch awning over the front door,
  // proper gable roof with overhanging eaves, fireplace + chimney, interior
  // stair with stone-brick stairwell wall, two upstairs bedrooms, side
  // balcony with fence rail. Corner trim follows community medieval-style
  // rules: vertical logs every 4 blocks of wall.
  const bigHouse = (ox: number, oz: number, logId: number, plankId: number) => {
    const r = 4, base = platform(ox, oz, r);
    if (base === null) return;
    lay(ox, oz, r + 1, base, B.cobblestone, 14);
    const x0 = ox - r, x1 = ox + r, z0 = oz - r, z1 = oz + r;
    // STONE FOUNDATION (base+1): weathered cobble strip
    for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++) {
      if (wx === x0 || wx === x1 || wz === z0 || wz === z1)
        place(wx, base + 1, wz, weatheredCobble(wx, base + 1, wz));
    }
    // GROUND FLOOR (planks)
    fillRect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, base + 1, plankId);
    // WALLS storey 1 (level 2-4) and storey 2 (level 6-8)
    walls(x0, z0, x1, z1, base + 2, base + 4, plankId);
    walls(x0, z0, x1, z1, base + 6, base + 8, plankId);
    // LOG MID-FLOOR PLATE (level 5)
    walls(x0, z0, x1, z1, base + 5, base + 5, logId);
    // LOG CORNER POSTS full height
    for (let wy = base + 1; wy <= base + 9; wy++) {
      place(x0, wy, z0, logId); place(x1, wy, z0, logId); place(x0, wy, z1, logId); place(x1, wy, z1, logId);
    }
    // CROSS-BEAM LOG ACCENTS on walls (community-style timber framing)
    for (const wy of [base + 5, base + 9]) {
      for (let wx = x0; wx <= x1; wx++) { place(wx, wy, z0, logId); place(wx, wy, z1, logId); }
      for (let wz = z0; wz <= z1; wz++) { place(x0, wy, wz, logId); place(x1, wy, wz, logId); }
    }
    // UPPER FLOOR (planks) + roof plate
    fillRect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, base + 5, plankId);
    fillRect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, base + 9, plankId);
    // GABLE ROOF with overhang
    gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, base + 10, OAK_ST, B.oakSlab);
    // CHIMNEY through the +x gable
    chimney(x1 - 1, z1 - 1, base + 1, base + 13);
    // FRONT DOOR + porch awning supported by fence posts
    place(ox, base + 2, z0, B.oakDoorLowerClosed); place(ox, base + 3, z0, B.oakDoorUpperClosed);
    place(ox, base + 4, z0, logId);
    place(ox, base + 1, z0 - 1, OAK_ST[2]);   // step up
    place(ox - 2, base + 2, z0 - 1, B.oakFence);
    place(ox + 2, base + 2, z0 - 1, B.oakFence);
    for (let dx = -2; dx <= 2; dx++) place(ox + dx, base + 3, z0 - 1, B.oakSlab);
    // WINDOWS (2 storeys, all sides)
    for (const fy of [base + 3, base + 7]) {
      place(x0, fy, oz, B.glass); place(x1, fy, oz, B.glass);
      place(x0, fy, oz - 1, B.glass); place(x1, fy, oz - 1, B.glass);
      place(ox - 1, fy, z1, B.glass); place(ox + 1, fy, z1, B.glass);
    }
    // INTERIOR STAIRCASE up to the upper floor (along +x wall, going -x)
    flight(x1 - 1, oz - 1, -1, 0, base + 2, 4, B.oakStairsNX, base + 5);
    // UPSTAIRS BEDS (real bed blocks), two of them, each with a chest
    place(x0 + 1, base + 6, z1 - 1, B.bedHead); place(x0 + 1, base + 6, z1 - 2, B.bedFoot);
    place(x0 + 2, base + 6, z1 - 1, B.chest); place(x0 + 2, base + 7, z1 - 1, B.flowerPot);
    place(x1 - 1, base + 6, z0 + 1, B.bedHead); place(x1 - 1, base + 6, z0 + 2, B.bedFoot);
    place(x1 - 2, base + 6, z0 + 1, B.chest);
    // GROUND-FLOOR KITCHEN / WORKSHOP nook: furnace, crafting table, bookshelf
    place(x0 + 1, base + 2, z1 - 1, B.furnace); place(x0 + 2, base + 2, z1 - 1, B.craftingTable);
    place(x0 + 1, base + 2, z1 - 2, B.bookshelf); place(x1 - 1, base + 2, z1 - 1, B.barrel);
    place(x1 - 1, base + 3, z1 - 1, B.flowerPot);
    // SMALL BACK BALCONY: slab platform + fence railing
    for (let dx = -1; dx <= 1; dx++) place(ox + dx, base + 6, z1 + 1, B.oakSlab);
    place(ox - 1, base + 7, z1 + 1, B.oakFence); place(ox + 1, base + 7, z1 + 1, B.oakFence);
    // INTERIOR LIGHTS on each floor — hanging lanterns, not glowstone (which
    // is a Nether block). Lanterns read as warm hearth fixtures.
    place(ox, base + 4, oz, B.lantern); place(ox, base + 9, oz, B.lantern);
  };
  // Fenced farm plot with tilled rows, a scarecrow (log + hay bale + carved
  // pumpkin substitute), produce, a fence gate, and a hay-bale rest pile.
  const farm = (ox: number, oz: number) => {
    const r = 4, base = platform(ox, oz, r);
    if (base === null) return;
    lay(ox, oz, r, base, B.dirt, 4);
    const x0 = ox - r, x1 = ox + r, z0 = oz - r, z1 = oz + r;
    // alternating tilled rows of mud + podzol
    for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++)
      place(wx, base, wz, ((wx - x0) & 1) === 0 ? B.mud : B.podzol);
    // FENCE PERIMETER + gate gap
    walls(x0, z0, x1, z1, base + 1, base + 1, B.oakFence);
    place(ox, base + 1, z0, B.air);
    place(ox - 1, base + 1, z0, B.oakFence); place(ox + 1, base + 1, z0, B.oakFence);
    // SUGAR CANE rows along the centre
    for (const dx of [-2, 0, 2]) {
      place(ox + dx, base + 1, oz, B.sugarCane);
      place(ox + dx, base + 2, oz, B.sugarCane);
    }
    // SCARECROW: log + crossbeam, hay-bale "head"
    place(x0 + 1, base + 1, z1 - 1, B.tree);
    place(x0 + 1, base + 2, z1 - 1, B.tree);
    place(x0 + 1, base + 3, z1 - 1, B.hayBale);
    place(x0, base + 2, z1 - 1, B.strippedOakLog);
    place(x0 + 2, base + 2, z1 - 1, B.strippedOakLog);
    // HAY-BALE STACK in the corner
    place(x1 - 1, base + 1, z0 + 1, B.hayBale);
    place(x1 - 2, base + 1, z0 + 1, B.hayBale);
    place(x1 - 1, base + 2, z0 + 1, B.hayBale);
    // FLOWERS scattered
    place(ox - 3, base + 1, oz - 2, B.flowerPoppy);
    place(ox + 3, base + 1, oz + 2, B.flowerDandelion);
    place(ox - 1, base + 1, oz - 3, B.flowerOxeye);
  };
  // Library (9×9): mixed stone-brick shell with mossy/cracked weathering, log
  // corner trim, dark-oak gable roof, bookshelf-lined inner walls, lectern,
  // window arches with stair lintels.
  const library = (ox: number, oz: number) => {
    const r = 4, base = platform(ox, oz, r);
    if (base === null) return;
    lay(ox, oz, r + 1, base, B.cobblestone, 11);
    const x0 = ox - r, x1 = ox + r, z0 = oz - r, z1 = oz + r;
    fillRect(x0, z0, x1, z1, base + 1, B.smoothStone);                       // polished floor
    // WEATHERED STONE-BRICK WALLS (level 2-6)
    for (let wy = base + 2; wy <= base + 6; wy++) for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++) {
      if (wx === x0 || wx === x1 || wz === z0 || wz === z1) place(wx, wy, wz, weatheredStoneBricks(wx, wy, wz));
    }
    // DARK-OAK CORNER POSTS + TOP PLATE
    for (let wy = base + 1; wy <= base + 7; wy++) {
      place(x0, wy, z0, B.darkOakLog); place(x1, wy, z0, B.darkOakLog);
      place(x0, wy, z1, B.darkOakLog); place(x1, wy, z1, B.darkOakLog);
    }
    walls(x0, z0, x1, z1, base + 7, base + 7, B.darkOakLog);
    // GABLE ROOF (dark oak palette uses oak stairs since no dark-oak stairs exist)
    gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, base + 8, OAK_ST, B.oakSlab);
    // INNER BOOKSHELF LINING — leaves a 1-block gap above for clerestory windows
    walls(x0 + 1, z0 + 1, x1 - 1, z1 - 1, base + 2, base + 4, B.bookshelf);
    // ENTRY ALCOVE clear + door with chiseled-stone lintel
    place(ox, base + 2, z0 + 1, B.air); place(ox, base + 3, z0 + 1, B.air);
    place(ox, base + 2, z0, B.oakDoorLowerClosed); place(ox, base + 3, z0, B.oakDoorUpperClosed);
    place(ox, base + 4, z0, B.chiseledStoneBricks);
    place(ox - 1, base + 4, z0, OAK_ST[1]); place(ox + 1, base + 4, z0, OAK_ST[0]);
    // ENTRY STEP
    place(ox, base + 1, z0 - 1, STN_ST[2]);
    // WINDOWS (with stair-arch lintels)
    for (const [px, pz, ax] of [[x0, oz, 0] as const, [x1, oz, 0] as const, [ox, z1, 1] as const]) {
      place(px, base + 5, pz, B.glass);
      if (ax === 0) {
        place(px, base + 6, pz - 1, OAK_ST[2]); place(px, base + 6, pz + 1, OAK_ST[3]);
      } else {
        place(px - 1, base + 6, pz, OAK_ST[0]); place(px + 1, base + 6, pz, OAK_ST[1]);
      }
    }
    // CHANDELIER — a lantern hung at the apex (overworld-appropriate)
    place(ox, base + 7, oz, B.lantern);
    // LECTERN — slab on log post in the centre, reading-stand vibe
    place(ox, base + 2, oz, B.darkOakLog); place(ox, base + 3, oz, B.oakSlab);
  };
  // Blacksmith (9×7): stone-brick shell, dark-oak roof, exposed forge with a
  // magma "fire" + cobble chimney + iron-block anvil, work-bench. Distinct
  // silhouette so the village reads as having an industrial corner.
  const blacksmith = (ox: number, oz: number) => {
    const rx = 4, rz = 3, base = platform(ox, oz, Math.max(rx, rz));
    if (base === null) return;
    lay(ox, oz, Math.max(rx, rz) + 1, base, B.cobblestone, 9);
    const x0 = ox - rx, x1 = ox + rx, z0 = oz - rz, z1 = oz + rz;
    fillRect(x0, z0, x1, z1, base + 1, B.smoothStone);
    // WEATHERED STONE-BRICK SHELL
    for (let wy = base + 2; wy <= base + 5; wy++) for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++)
      if (wx === x0 || wx === x1 || wz === z0 || wz === z1) place(wx, wy, wz, weatheredStoneBricks(wx, wy, wz));
    for (let wy = base + 1; wy <= base + 6; wy++) {
      place(x0, wy, z0, B.darkOakLog); place(x1, wy, z0, B.darkOakLog);
      place(x0, wy, z1, B.darkOakLog); place(x1, wy, z1, B.darkOakLog);
    }
    walls(x0, z0, x1, z1, base + 6, base + 6, B.darkOakLog);
    // DARK-OAK GABLE ROOF
    gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, base + 7, OAK_ST, B.oakSlab);
    // ENTRANCE (open arch — no door, blacksmiths stay open)
    place(ox, base + 2, z0, B.air); place(ox, base + 3, z0, B.air); place(ox, base + 4, z0, B.air);
    place(ox - 1, base + 4, z0, OAK_ST[1]); place(ox + 1, base + 4, z0, OAK_ST[0]);
    place(ox, base + 1, z0 - 1, STN_ST[2]);
    // WINDOWS
    place(x0, base + 4, oz, B.glass); place(x1, base + 4, oz, B.glass);
    // FORGE: cobble fire-pit with campfire "fire" + chimney rising through the
    // roof. Campfire is the overworld fire source (replaces the previous
    // magma block which read as nether-y).
    place(ox - 2, base + 2, z1 - 1, B.cobblestone); place(ox - 2, base + 2, z1 - 2, B.cobblestone);
    place(ox - 1, base + 2, z1 - 1, B.cobblestone); place(ox - 1, base + 2, z1 - 2, B.cobblestone);
    place(ox - 2, base + 1, z1 - 1, B.cobblestone);                        // hearth stone under the campfire
    place(ox - 2, base + 2, z1 - 1, B.campfire);                           // forge fire (overworld)
    place(ox - 1, base + 3, z1 - 1, B.cobblestone); place(ox - 2, base + 3, z1 - 1, B.cobblestone);
    chimney(ox - 2, z1 - 1, base + 4, base + 11);
    // ANVIL surrogate (iron block) on a stripped-oak post
    place(ox + 1, base + 2, oz, B.strippedOakLog);
    place(ox + 1, base + 3, oz, B.ironBlock);
    // WORKBENCH — slab counter
    place(ox + 2, base + 2, oz - 1, B.oakSlab); place(ox + 2, base + 2, oz, B.oakSlab); place(ox + 2, base + 2, oz + 1, B.oakSlab);
    // INTERIOR LIGHT — overhead lantern (overworld light source)
    place(ox, base + 5, oz, B.lantern);
  };
  // Tavern (11×9): mixed materials (stone-brick base + plank upper storey),
  // covered porch with fence rail, hay-bale roof (thatched look), warm
  // glowstone interior. Distinct silhouette so a village reads as varied.
  const tavern = (ox: number, oz: number) => {
    const rx = 5, rz = 4, base = platform(ox, oz, Math.max(rx, rz));
    if (base === null) return;
    lay(ox, oz, Math.max(rx, rz) + 1, base, B.cobblestone, 12);
    const x0 = ox - rx, x1 = ox + rx, z0 = oz - rz, z1 = oz + rz;
    // STONE-BRICK GROUND FLOOR
    for (let wy = base + 1; wy <= base + 3; wy++) for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++)
      if (wx === x0 || wx === x1 || wz === z0 || wz === z1) place(wx, wy, wz, weatheredStoneBricks(wx, wy, wz));
    fillRect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, base + 1, B.oakPlanks);
    // PLANK UPPER STOREY
    walls(x0, z0, x1, z1, base + 4, base + 6, B.oakPlanks);
    // LOG CORNERS
    for (let wy = base + 1; wy <= base + 7; wy++) {
      place(x0, wy, z0, B.tree); place(x1, wy, z0, B.tree);
      place(x0, wy, z1, B.tree); place(x1, wy, z1, B.tree);
    }
    walls(x0, z0, x1, z1, base + 4, base + 4, B.tree);    // mid-plate band
    walls(x0, z0, x1, z1, base + 7, base + 7, B.tree);    // top plate
    // HAY-BALE THATCHED ROOF (gabled with hay slabs as the cap)
    fillRect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, base + 7, B.oakPlanks);
    gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, base + 8, OAK_ST, B.oakSlab);
    // Replace the central ridge with hay bales for thatched effect
    for (let wx = x0; wx <= x1; wx++) {
      const idx = wx - x0;
      if (idx >= 1 && idx <= rx * 2 - 1) place(wx, base + 8 + Math.floor(rz / 2), oz, B.hayBale);
    }
    // ENTRANCE: 2-wide door
    for (const dx of [-1, 0]) {
      place(ox + dx, base + 2, z0, B.oakDoorLowerClosed);
      place(ox + dx, base + 3, z0, B.oakDoorUpperClosed);
    }
    place(ox - 1, base + 4, z0, B.tree); place(ox, base + 4, z0, B.tree);
    // PORCH AWNING (fence-supported, slab roof)
    for (const dx of [-2, 2]) place(ox + dx, base + 2, z0 - 1, B.oakFence);
    for (const dx of [-3, -2, -1, 0, 1, 2, 3]) place(ox + dx, base + 3, z0 - 1, B.oakSlab);
    // STEP UP
    for (const dx of [-1, 0]) place(ox + dx, base + 1, z0 - 1, OAK_ST[2]);
    // WINDOWS upstairs
    for (const dx of [-3, -1, 1, 3]) place(ox + dx, base + 5, z0, B.glass);
    for (const dx of [-3, -1, 1, 3]) place(ox + dx, base + 5, z1, B.glass);
    place(x0, base + 5, oz, B.glass); place(x1, base + 5, oz, B.glass);
    // WINDOWS downstairs
    for (const dx of [3, -3]) place(ox + dx, base + 2, z0, B.glass);
    // INTERIOR: bar (oak slab counter), bookshelf back wall, hanging lanterns
    for (let dx = -2; dx <= 2; dx++) place(ox + dx, base + 2, z1 - 1, B.oakSlab);
    walls(ox - 2, z1 - 2, ox + 2, z1 - 2, base + 2, base + 3, B.bookshelf);
    place(ox, base + 3, oz, B.lantern); place(ox, base + 6, oz, B.lantern);
    // SECOND-STOREY FLOOR + STAIRCASE. The two-tone walls + upstairs windows
    // (base+5) + the upper lantern (base+6) imply an upper floor, but it had no
    // floor and no way up. Add a plank floor at base+4 (interior), then a -x stair
    // flight from the ground floor up to it — placed AFTER the floor so the
    // flight's headroom-clear opens the stairwell through it and the top step
    // lands flush on the upper floor (same proven pattern as bigHouse).
    fillRect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, base + 4, B.oakPlanks);
    flight(x1 - 1, oz - 1, -1, 0, base + 2, 3, B.oakStairsNX, base + 4);
  };
  // A real WELL: 3×3 wellhead (curb + posts + roof) over a deep air shaft carved
  // straight down the centre column, lined with cobble. The centre carve is the
  // only sub-surface dig in the whole system → made apron-safe by wellShaftRange.
  // Now built with a cobble-stair-flared roof and a fence-bucket ornament.
  const well = (ox: number, oz: number) => {
    const r = 2, base = platform(ox, oz, r);
    if (base === null) return;
    lay(ox, oz, r + 1, base, B.cobblestone, 7);
    // PAVED COBBLE PLAZA around the well (5×5)
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const wx = ox + dx, wz = oz + dz;
      // already filled to base by lay(); the +1 row is the visible plaza surface
      place(wx, base + 1, wz, weatheredCobble(wx, base + 1, wz));
    }
    // CURB ring at base+2 (the centre stays open as the shaft mouth)
    walls(ox - 1, oz - 1, ox + 1, oz + 1, base + 2, base + 2, B.cobblestone);
    // 4 LOG POSTS supporting the cap
    for (let wy = base + 3; wy <= base + 5; wy++) {
      place(ox - 1, wy, oz - 1, B.tree); place(ox + 1, wy, oz - 1, B.tree);
      place(ox - 1, wy, oz + 1, B.tree); place(ox + 1, wy, oz + 1, B.tree);
    }
    // Cap: small stair-flared cobble roof
    fillRect(ox - 1, oz - 1, ox + 1, oz + 1, base + 6, B.cobblestone);
    place(ox - 2, base + 6, oz, COB_ST[0]); place(ox + 2, base + 6, oz, COB_ST[1]);
    place(ox, base + 6, oz - 2, COB_ST[2]); place(ox, base + 6, oz + 2, COB_ST[3]);
    place(ox, base + 7, oz, B.cobbleSlab);
    // BUCKET on a fence "rope": fence post over the centre, lantern hanging below
    place(ox, base + 5, oz, B.oakFence);
    place(ox, base + 4, oz, B.lantern);   // hanging well lantern (glows over the shaft)
    // SHAFT (sub-surface, apron-aware via wellShaftRange)
    for (let dy = 0; dy < WELL_SHAFT; dy++) {
      const y = base - dy;
      walls(ox - 1, oz - 1, ox + 1, oz + 1, y, y, B.cobblestone);
      place(ox, y, oz, B.air);
    }
    walls(ox - 1, oz - 1, ox + 1, oz + 1, base - WELL_SHAFT, base - WELL_SHAFT, B.cobblestone);
    place(ox, base - WELL_SHAFT, oz, B.mossyCobblestone);
  };
  // Watchtower / wizard tower — 9×9 stepped plinth narrowing to a 7×7 shaft.
  // Cohesive STONE-BRICK aesthetic throughout (no cobble/glowstone hodgepodge):
  //   - weathered stone bricks (mossy + cracked dither) on plinth and shaft
  //   - stair-flared plinth + stair-corbelled plinth-to-shaft transition
  //   - stripped-log corner accents read as timber framing
  //   - a SUPPORTED -z balcony at mid-height (slab deck on stair brackets, NOT
  //     a floating ring) with a fence railing and a small balcony door
  //   - real CONICAL ROOF made of THREE narrowing stair rings (7×7 → 5×5 → 3×3)
  //     capping a single chiseled-stone-brick weather-vane block
  //   - one glowstone "lantern" inside the spire (visible through a gap), no
  //     corner braziers
  //   - square-spiral staircase climbing the inside, exit through the deck.
  // Optionally draws an organic TRAIL leaving the entrance (gravel that twists
  // and thins out so the world reads as travelled-from).
  const tower = (ox: number, oz: number, rng: RNG, withTrail = true) => {
    const rBase = 4, rShaft = 3;
    const base = platform(ox, oz, rBase);
    if (base === null) return;
    const elev = clamp((base - sea) / 70, 0, 1);
    const top = Math.round((22 - 12 * elev) + rng.random() * 8);   // ~22-30 near water → ~10-18 high up
    lay(ox, oz, rBase + 1, base, B.stoneBricks, top + 12);
    const sx0 = ox - rShaft, sx1 = ox + rShaft, sz0 = oz - rShaft, sz1 = oz + rShaft;
    const bx0 = ox - rBase,  bx1 = ox + rBase,  bz0 = oz - rBase,  bz1 = oz + rBase;
    // INTERIOR FLOOR — WOODEN (dark-oak plank) disc inside the shaft (was bare
    // smooth stone). A furnished ground-floor nook is laid below, clear of the
    // spiral's cells (the spiral only reaches base+2 at the door cell ox,oz-2).
    for (let wx = sx0; wx <= sx1; wx++) for (let wz = sz0; wz <= sz1; wz++)
      place(wx, base + 1, wz, B.darkOakPlanks);
    // GROUND-FLOOR FURNISHINGS against the back (+z) wall: a small library shelf,
    // a chest, a crafting table and a potted flower — reads as a warden's quarters.
    place(ox - 2, base + 2, oz + 2, B.bookshelf); place(ox - 1, base + 2, oz + 2, B.bookshelf);
    place(ox + 2, base + 2, oz + 2, B.chest); place(ox + 1, base + 2, oz + 2, B.craftingTable);
    place(ox - 2, base + 2, oz + 1, B.barrel); place(ox - 2, base + 3, oz + 1, B.flowerPot);
    place(ox + 2, base + 5, oz, B.torch); place(ox - 2, base + 5, oz, B.torch);   // wall torches for light
    // PLINTH (9×9 × 2 high, weathered stone bricks)
    for (let wy = base + 1; wy <= base + 2; wy++) for (let wx = bx0; wx <= bx1; wx++) for (let wz = bz0; wz <= bz1; wz++) {
      if (wx === bx0 || wx === bx1 || wz === bz0 || wz === bz1)
        place(wx, wy, wz, weatheredStoneBricks(wx, wy, wz));
    }
    // STAIR-FLARED PLINTH SKIRT — a single flared step around the perimeter,
    // making the plinth read as a proper masonry foundation rather than a box.
    for (let wx = bx0; wx <= bx1; wx++) {
      place(wx, base + 1, bz0 - 1, STN_ST[2]); place(wx, base + 1, bz1 + 1, STN_ST[3]);
    }
    for (let wz = bz0; wz <= bz1; wz++) {
      place(bx0 - 1, base + 1, wz, STN_ST[0]); place(bx1 + 1, base + 1, wz, STN_ST[1]);
    }
    // PLINTH → SHAFT TRANSITION: a stair-flared splay around the shaft base
    // at y=base+3, sitting on the plinth top. Each stair's TALL side faces
    // INWARD (toward the shaft wall), so the splay rises from the plinth's
    // outer edge up to the shaft wall — reads as the shaft growing out of a
    // stepped flared base. The DOOR COLUMN (ox, bz0) is INTENTIONALLY skipped
    // so the player has body-clearance walking through the entry — without
    // this skip the splay block sits exactly where the player's head goes.
    for (let wx = sx0; wx <= sx1; wx++) {
      if (wx !== ox) place(wx, base + 3, bz0, STN_ST[2]);   // -z plinth edge, tall on +z (toward shaft) — skip door
      place(wx, base + 3, bz1, STN_ST[3]);                  // +z plinth edge, tall on -z (toward shaft)
    }
    for (let wz = sz0; wz <= sz1; wz++) {
      place(bx0, base + 3, wz, STN_ST[0]);   // -x plinth edge, tall on +x (toward shaft)
      place(bx1, base + 3, wz, STN_ST[1]);   // +x plinth edge, tall on -x (toward shaft)
    }
    // CORNERS of the splay: chiseled stone-brick caps fill the four plinth
    // corners (the stair loops only cover the four edge spans).
    for (const [px, pz] of [[bx0, bz0], [bx1, bz0], [bx0, bz1], [bx1, bz1]] as const)
      place(px, base + 3, pz, B.chiseledStoneBricks);
    // MAIN SHAFT 7×7 — weathered stone bricks from base+3 up to base+top
    for (let wy = base + 3; wy <= base + top; wy++) {
      for (let wx = sx0; wx <= sx1; wx++) for (let wz = sz0; wz <= sz1; wz++) {
        if (wx === sx0 || wx === sx1 || wz === sz0 || wz === sz1)
          place(wx, wy, wz, weatheredStoneBricks(wx, wy, wz));
      }
    }
    // STRIPPED-LOG CORNER ACCENTS (timber framing) — full shaft height
    for (let wy = base + 3; wy <= base + top; wy++) {
      place(sx0, wy, sz0, B.darkOakLog); place(sx1, wy, sz0, B.darkOakLog);
      place(sx0, wy, sz1, B.darkOakLog); place(sx1, wy, sz1, B.darkOakLog);
    }
    // ARROW-SLIT WINDOWS (glass) at multiple tiers, with stone-brick stair
    // lintels above each — no oak hodgepodge.
    for (let wy = base + 7; wy <= base + top - 3; wy += 5) {
      place(ox, wy, sz0, B.glass); place(ox, wy, sz1, B.glass);
      place(sx0, wy, oz, B.glass); place(sx1, wy, oz, B.glass);
      place(ox - 1, wy + 1, sz0, STN_ST[1]); place(ox + 1, wy + 1, sz0, STN_ST[0]);
      place(ox - 1, wy + 1, sz1, STN_ST[1]); place(ox + 1, wy + 1, sz1, STN_ST[0]);
    }
    // ENTRANCE on -z (door + log lintel + stone-brick step). The THRESHOLD
    // block at (ox, base+2, sz0) sits directly under the door so the player
    // has support across the door cell instead of walking into a 1-block
    // hole and dropping inside the shaft.
    place(ox, base + 2, sz0, B.stoneBricks);                                 // door threshold (under the door)
    place(ox, base + 3, sz0, B.oakDoorLowerClosed);
    place(ox, base + 4, sz0, B.oakDoorUpperClosed);
    place(ox, base + 5, sz0, B.chiseledStoneBricks);
    place(ox - 1, base + 5, sz0, STN_ST[1]); place(ox + 1, base + 5, sz0, STN_ST[0]);
    place(ox, base + 2, sz0 - 1, STN_ST[2]);     // step up to door from outside
    // SUPPORTED -Z BALCONY at mid-height — stone slab deck on stair brackets
    // beneath, fence railing on top, balcony door cut into the shaft. NOT a
    // floating ring: the slab deck is held up by underside stair brackets so
    // it reads as a real masonry balcony.
    const balY = base + Math.floor(top / 2) + 2;
    for (let dx = -2; dx <= 2; dx++) place(ox + dx, balY, sz0 - 1, B.stoneSlab);
    // Stair brackets supporting the balcony from below (only at the ends so it
    // looks structural, not solid).
    place(ox - 2, balY - 1, sz0 - 1, STN_ST[3]);
    place(ox + 2, balY - 1, sz0 - 1, STN_ST[3]);
    // Fence railing on the deck, with lit torches at the two ends
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0) continue;
      place(ox + dx, balY + 1, sz0 - 1, Math.abs(dx) === 2 ? B.torch : B.cobbleFence);
    }
    // Balcony door cut through the shaft wall
    place(ox, balY, sz0, B.oakDoorLowerClosed);
    place(ox, balY + 1, sz0, B.oakDoorUpperClosed);
    place(ox, balY + 2, sz0, B.chiseledStoneBricks);
    // DECK at the top of the shaft — stone-brick floor (=top of shaft body).
    // Placed BEFORE the spiral so the spiral's last stair (at y=ry) cleanly
    // overrides the deck stone at the exit cell, giving a seamless walk-off
    // from the spiral onto the deck.
    const ry = base + top + 1;
    fillRect(sx0, sz0, sx1, sz1, ry, B.stoneBricks);
    // CRENELLATED PARAPET around the deck — stone-brick merlons (alternating
    // every other column), no glowstone braziers, no cobble.
    for (let wx = sx0; wx <= sx1; wx++) {
      if (((wx - sx0) & 1) === 0) {
        place(wx, ry + 1, sz0, B.stoneBricks); place(wx, ry + 1, sz1, B.stoneBricks);
      }
    }
    for (let wz = sz0; wz <= sz1; wz++) {
      if (((wz - sz0) & 1) === 0) {
        place(sx0, ry + 1, wz, B.stoneBricks); place(sx1, ry + 1, wz, B.stoneBricks);
      }
    }
    // SPIRAL STAIRCASE inside (square spiral) — stone-brick stairs around the
    // 5×5 inner perimeter of the shaft. Starts at the cell DIRECTLY INSIDE
    // the south door (ox, oz-2) so the player walking +z through the door
    // lands on step 0 from the open (-z) side — auto-step works. Each
    // subsequent step rises 1 block and walks +x → +z → -x → -z around the
    // perimeter. Last stair lands AT the deck level for a seamless walk-off.
    const a = 2;
    const pathCells: Array<[number, number]> = [
      // -z edge: from (ox, oz-2) going +x
      [ox,         oz - a    ], [ox + 1,     oz - a    ],
      // +x edge: corner at (ox+2, oz-2), going +z
      [ox + a,     oz - a    ], [ox + a,     oz - 1    ], [ox + a,     oz        ], [ox + a,     oz + 1    ],
      // +z edge: corner at (ox+2, oz+2), going -x
      [ox + a,     oz + a    ], [ox + 1,     oz + a    ], [ox,         oz + a    ], [ox - 1,     oz + a    ],
      // -x edge: corner at (ox-2, oz+2), going -z
      [ox - a,     oz + a    ], [ox - a,     oz + 1    ], [ox - a,     oz        ], [ox - a,     oz - 1    ],
      // -z edge wrap: corner at (ox-2, oz-2), going +x back to start
      [ox - a,     oz - a    ], [ox - 1,     oz - a    ],
    ];
    const P = pathCells.length;
    const steps = top;                 // last stair at y=base+top+1 = deck level
    for (let i = 0; i < steps; i++) {
      const [csx, csz] = pathCells[i % P];
      const [nx, nz] = pathCells[(i + 1) % P];
      const y = base + 2 + i;
      place(csx, y, csz, stairFor(STN_ST, nx - csx, nz - csz));
      // Clear up to AND including the deck level (y=ry) at this spiral cell —
      // leaves an open shaft through the deck so the player has body-height
      // clearance ascending. Spiral cells punch holes in the deck (16 holes
      // out of a 7×7 deck — acceptable, plenty of solid deck remains).
      for (let hy = y + 1; hy <= ry; hy++) place(csx, hy, csz, B.air);
    }
    // CONICAL ROOF — three narrowing stair rings (7×7 → 5×5 → 3×3) capped by a
    // single chiseled stone-brick weather-vane. Each stair's TALL side faces
    // INWARD (toward the centre of the cone) so the slope rises from the
    // eaves up to the apex — a proper roof slope, not an inverted bowl.
    // Ring 1: 7×7 stair perimeter at ry+2 (the eaves of the cone).
    for (let wx = sx0; wx <= sx1; wx++) {
      place(wx, ry + 2, sz0, STN_ST[2]);     // -z eaves, tall on +z (toward centre)
      place(wx, ry + 2, sz1, STN_ST[3]);     // +z eaves, tall on -z (toward centre)
    }
    for (let wz = sz0; wz <= sz1; wz++) {
      place(sx0, ry + 2, wz, STN_ST[0]);     // -x eaves, tall on +x (toward centre)
      place(sx1, ry + 2, wz, STN_ST[1]);     // +x eaves, tall on -x (toward centre)
    }
    fillRect(sx0 + 1, sz0 + 1, sx1 - 1, sz1 - 1, ry + 2, B.stoneBricks);
    // Ring 2: 5×5 stair perimeter at ry+3
    for (let wx = sx0 + 1; wx <= sx1 - 1; wx++) {
      place(wx, ry + 3, sz0 + 1, STN_ST[2]); place(wx, ry + 3, sz1 - 1, STN_ST[3]);
    }
    for (let wz = sz0 + 1; wz <= sz1 - 1; wz++) {
      place(sx0 + 1, ry + 3, wz, STN_ST[0]); place(sx1 - 1, ry + 3, wz, STN_ST[1]);
    }
    fillRect(sx0 + 2, sz0 + 2, sx1 - 2, sz1 - 2, ry + 3, B.stoneBricks);
    // Ring 3: 3×3 stair perimeter at ry+4 (cap of the cone)
    place(ox, ry + 4, oz - 1, STN_ST[2]); place(ox, ry + 4, oz + 1, STN_ST[3]);
    place(ox - 1, ry + 4, oz, STN_ST[0]); place(ox + 1, ry + 4, oz, STN_ST[1]);
    // Diagonal corners of ring 3: chiseled stone-brick "ridge stones"
    place(ox - 1, ry + 4, oz - 1, B.chiseledStoneBricks);
    place(ox + 1, ry + 4, oz - 1, B.chiseledStoneBricks);
    place(ox - 1, ry + 4, oz + 1, B.chiseledStoneBricks);
    place(ox + 1, ry + 4, oz + 1, B.chiseledStoneBricks);
    place(ox, ry + 4, oz, B.lantern);                              // beacon lantern (overworld light, not glowstone)
    // SPIRE: chiseled stone-brick weather-vane atop the apex
    place(ox, ry + 5, oz, B.chiseledStoneBricks);
    // OUTSIDE: lampposts flanking the entrance (the only outside lights)
    lampPost(ox - 3, sz0 - 2, base + 2, B.darkOakLog);
    lampPost(ox + 3, sz0 - 2, base + 2, B.darkOakLog);
    // TRAILING PATH leaving the entrance — twists and thins out (tower only,
    // not when called inside a village which lays its own roads).
    if (withTrail) {
      // Walk roughly outward (-z direction with simplex-driven turns) for a
      // decent length so the world reads as having a road TO this tower.
      const ang0 = -Math.PI / 2 + (rng.random() - 0.5) * 0.6;     // base direction: -z ± 0.3 rad
      drawTrailPath(ox, sz0 - 3, 28 + Math.floor(rng.random() * 18), ang0);
      // optional secondary spur at a random angle for "branched" feel
      if (rng.random() < 0.5) {
        const ang1 = ang0 + (rng.random() < 0.5 ? -1 : 1) * (0.7 + rng.random() * 0.6);
        drawTrailPath(ox, sz0 - 3, 14 + Math.floor(rng.random() * 12), ang1);
      }
    }
  };
  // Desert temple — BIG, with a hidden BASEMENT chamber (apron-safe by virtue
  // of an ELEVATED stone foundation: the basement sits ABOVE max ground but
  // below the main entry hall, so visually it reads as "underground" while
  // the apron's air-above-surface default suffices). Footprint 29×29 (r=14)
  // with 11 step levels + apex spire, 4 corner pillar towers (chiseled +
  // Ankh-style orange terracotta accents), main hall (a 9×9 chamber two
  // storeys tall with a wind-rose pattern of orange-and-blue terracotta and
  // sandstone-stair seating around the perimeter), grand front staircase, a
  // collapsed sandstone-stair descent to the basement (chest plinth + gold
  // block + lapis-and-redstone "puzzle floor"), and stair-flared accents on
  // each step for proper Egyptian-temple depth.
  const pyramid = (ox: number, oz: number) => {
    const r = 14, base = platform(ox, oz, r);
    if (base === null) return;
    const L = 11;                                 // step levels
    const FOUNDATION = 5;                          // height of elevated foundation (basement lives inside)
    const FLOOR = base + FOUNDATION;               // main hall floor (raised above ground)
    lay(ox, oz, r + 1, base, B.sandstone, L + FOUNDATION + 8);
    // FOUNDATION: solid sandstone rectangular plinth (29×29 × FOUNDATION-tall)
    for (let wy = base + 1; wy <= FLOOR; wy++) {
      // Mix smooth and cut sandstone for variety; cut bands every 2 rows.
      const id = (wy - base) % 3 === 0 ? B.smoothSandstone : B.sandstone;
      fillRect(ox - r, oz - r, ox + r, oz + r, wy, id);
    }
    // STEP LEVELS above the main floor: each level shrinks by 1 on each side
    for (let lvl = 0; lvl <= L; lvl++) {
      const rr = r - lvl;
      // Layer top: sandstone with weathered chiseled accents on alternate levels
      fillRect(ox - rr, oz - rr, ox + rr, oz + rr, FLOOR + lvl + 1, B.sandstone);
      if (lvl > 0) {
        // Outer band: alternating orange terracotta + cut sandstone for the
        // characteristic Egyptian striping.
        const bandId = lvl % 3 === 0 ? B.terracottaOrange : lvl % 3 === 1 ? B.cutSandstone : B.smoothSandstone;
        walls(ox - rr, oz - rr, ox + rr, oz + rr, FLOOR + lvl + 1, FLOOR + lvl + 1, bandId);
      }
      // Stair-flared edge on the front face every other level — proper
      // stepped-pyramid feel.
      if (lvl > 0 && lvl < L && lvl % 2 === 0) {
        for (let wx = ox - rr; wx <= ox + rr; wx++) {
          place(wx, FLOOR + lvl + 1, oz - rr - 1, SS_ST[2]);
          place(wx, FLOOR + lvl + 1, oz + rr + 1, SS_ST[3]);
        }
        for (let wz = oz - rr; wz <= oz + rr; wz++) {
          place(ox - rr - 1, FLOOR + lvl + 1, wz, SS_ST[0]);
          place(ox + rr + 1, FLOOR + lvl + 1, wz, SS_ST[1]);
        }
      }
    }
    // CORNER OBELISK MARKERS — small chiseled-sandstone spires at the 4 BODY
    // corners. They rise from INSIDE the pyramid step on which they sit (so
    // they don't float above the body — a common community-build mistake).
    // Each marker is a 1-block column 3 tall, capped with terracotta orange.
    for (const [px, pz, lvl] of [
      [ox - r + 2, oz - r + 2, 1] as const,    // SW corner, sits on lvl 1 step
      [ox + r - 2, oz - r + 2, 1] as const,    // SE
      [ox - r + 2, oz + r - 2, 1] as const,    // NW
      [ox + r - 2, oz + r - 2, 1] as const,    // NE
    ]) {
      const baseY = FLOOR + lvl + 1;             // top of the pyramid step at this column
      place(px, baseY,     pz, B.chiseledSandstone);
      place(px, baseY + 1, pz, B.cutSandstone);
      place(px, baseY + 2, pz, B.terracottaOrange);
      place(px, baseY + 3, pz, B.chiseledSandstone);
    }
    // MAIN HALL: 9×9×6 hollow chamber inside the body (carved from the steps,
    // not foundation — entirely above FLOOR → trivially apron-safe).
    fillBox(ox - 4, FLOOR + 1, oz - 4, ox + 4, FLOOR + 6, oz + 4, B.air);
    fillRect(ox - 4, oz - 4, ox + 4, oz + 4, FLOOR + 7, B.smoothSandstone);     // hall ceiling
    // WIND-ROSE FLOOR PATTERN with orange + blue terracotta over sandstone
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      const a = Math.abs(dx), b = Math.abs(dz);
      let id: number = B.smoothSandstone;
      if (a + b === 0) id = B.terracottaOrange;                       // centre marker
      else if (a === b && a <= 2) id = B.terracottaOrange;
      else if ((a === 0 || b === 0) && a + b === 4) id = B.terracottaOrange;
      else if ((a === 0 || b === 0) && a + b === 2) id = B.cutSandstone;
      else if (a === 4 || b === 4) id = B.cutSandstone;
      place(ox + dx, FLOOR, oz + dz, id);
    }
    place(ox, FLOOR, oz, B.terracottaOrange);     // wind-rose hub (visible "X marks the spot")
    // SANDSTONE-STAIR SEATING / corbel ring around the hall walls
    for (let wx = ox - 3; wx <= ox + 3; wx++) {
      place(wx, FLOOR + 1, oz - 4, SS_ST[3]); place(wx, FLOOR + 1, oz + 4, SS_ST[2]);
    }
    for (let wz = oz - 3; wz <= oz + 3; wz++) {
      place(ox - 4, FLOOR + 1, wz, SS_ST[1]); place(ox + 4, FLOOR + 1, wz, SS_ST[0]);
    }
    // WALL TORCHES (overworld light source — no glowstone, which is a Nether
    // material). Mounted on the seating-row tops along each wall + a central
    // hanging lantern at the apex.
    for (const wx of [ox - 2, ox, ox + 2]) {
      place(wx, FLOOR + 2, oz - 4, B.torch); place(wx, FLOOR + 2, oz + 4, B.torch);
    }
    for (const wz of [oz - 2, oz, oz + 2]) {
      place(ox - 4, FLOOR + 2, wz, B.torch); place(ox + 4, FLOOR + 2, wz, B.torch);
    }
    place(ox, FLOOR + 6, oz, B.lantern);                              // central hanging lantern
    // FRONT ENTRANCE: a clean 3-wide × 4-tall corridor cut horizontally
    // through the pyramid steps from the door to the outer face. Constant
    // height keeps the entrance reading as a deliberate doorway-with-hall,
    // not the awkward narrowing slot it used to be.
    for (let dz = -r; dz <= -4; dz++) for (let dx = -1; dx <= 1; dx++) {
      for (let wy = FLOOR + 1; wy <= FLOOR + 4; wy++) place(ox + dx, wy, oz + dz, B.air);
    }
    // GRAND OUTER STEPS from ground up to the main hall floor (5 sandstone
    // stairs, 3 wide). They sit JUST SOUTH of the pyramid body so the player
    // climbs ground → main floor in a single uninterrupted run.
    for (let i = 0; i < FOUNDATION; i++) {
      for (let dx = -1; dx <= 1; dx++) place(ox + dx, base + 1 + i, oz - r - 1 + i, SS_ST[2]);
    }
    // OPEN THE STAIRWELL: steps i≥1 land INSIDE the foundation footprint, which the
    // plinth fill packs solid up to FLOOR — so without this carve the staircase was
    // buried in sandstone and the entrance read as a blank wall (the reported bug).
    // Clear headroom above every step (and through to the corridor) so the climb
    // from the desert up to the hall floor is actually walkable. All above `base`
    // (above max ground) → apron-safe.
    for (let i = 0; i < FOUNDATION; i++) {
      for (let dx = -1; dx <= 1; dx++)
        for (let wy = base + 2 + i; wy <= FLOOR + 4; wy++) place(ox + dx, wy, oz - r - 1 + i, B.air);
    }
    // SIDE WALLS of the entry stair: sandstone curbs on either side so the
    // stair reads as a flanked grand approach (not a stair stranded on bare
    // ground). Placed AFTER the carve so the curbs aren't cleared.
    for (let i = 0; i < FOUNDATION; i++) {
      place(ox - 2, base + 1 + i, oz - r - 1 + i, B.smoothSandstone);
      place(ox + 2, base + 1 + i, oz - r - 1 + i, B.smoothSandstone);
      place(ox - 2, base + 2 + i, oz - r - 1 + i, B.smoothSandstone);   // taller curb walls flank the open run
      place(ox + 2, base + 2 + i, oz - r - 1 + i, B.smoothSandstone);
    }
    // DOOR + lintel at the inner end of the corridor
    place(ox, FLOOR + 1, oz - 4, B.oakDoorLowerClosed);
    place(ox, FLOOR + 2, oz - 4, B.oakDoorUpperClosed);
    place(ox - 1, FLOOR + 3, oz - 4, B.chiseledSandstone);
    place(ox, FLOOR + 3, oz - 4, B.chiseledSandstone);
    place(ox + 1, FLOOR + 3, oz - 4, B.chiseledSandstone);
    // BASEMENT CHAMBER carved INTO the foundation (above max ground, apron-safe).
    // 7×7×3 hollow lit by glowstone, with chiseled-sandstone columns, a
    // gold-block treasure plinth on a lapis/redstone "puzzle floor", suspicious
    // sand-style hint of brushed sand.
    fillBox(ox - 3, base + 1, oz - 3, ox + 3, base + 3, oz + 3, B.air);
    walls(ox - 4, oz - 4, ox + 4, oz + 4, base + 1, base + 4, B.cutSandstone);  // basement walls
    fillRect(ox - 3, oz - 3, ox + 3, oz + 3, base + 4, B.smoothSandstone);      // basement ceiling
    // PUZZLE FLOOR (lapis + redstone block alternating around a gold centre)
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      const a = Math.abs(dx), b = Math.abs(dz);
      let id: number = B.cutSandstone;
      if (a === 0 && b === 0) id = B.goldBlock;
      else if (a + b <= 1) id = B.lapisBlock;
      else if (((dx + dz) & 1) === 0 && a + b === 4) id = B.redstoneBlock;
      place(ox + dx, base, oz + dz, id);
    }
    // CHISELED PILLARS in basement corners
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]] as const) {
      place(ox + dx, base + 1, oz + dz, B.chiseledSandstone);
      place(ox + dx, base + 2, oz + dz, B.chiseledSandstone);
      place(ox + dx, base + 3, oz + dz, B.chiseledSandstone);
    }
    place(ox, base + 1, oz, B.goldBlock);                  // treasure plinth (centre)
    place(ox, base + 2, oz, B.diamondBlock);
    // CORNERS: 3 chests substitute (cut sandstone with terracotta tops)
    for (const [dx, dz] of [[-2, 2], [2, -2], [2, 2]] as const) {
      place(ox + dx, base + 1, oz + dz, B.cutSandstone);
      place(ox + dx, base + 2, oz + dz, B.terracottaOrange);
    }
    // BASEMENT TORCHES on the 4 chiseled-sandstone pillars + a central hanging
    // lantern (overworld light sources only — no glowstone)
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]] as const) {
      place(ox + dx, base + 3, oz + dz, B.torch);                   // wall torch atop each pillar
    }
    place(ox, base + 4, oz, B.lantern);                             // hanging central lantern
    // STAIR DESCENT from main hall to basement: a 4-step sandstone-stair flight
    // built as an UP-flight from basement (base+1) to just below main hall floor
    // (base+4). The flight clears the FLOOR block above the top step → hole
    // through which the player drops onto the staircase to descend. Stairs face
    // PX (tall on +x = upward direction); player walks -x to descend.
    flight(ox - 2, oz, 1, 0, base + 1, 4, B.sandstoneStairsPX, FLOOR);
    // Tear out the wind-rose tile above the top step + the top step itself so
    // it reads as a rough "collapsed" hole in the main-hall floor.
    place(ox + 1, FLOOR, oz, B.air);
    // APEX SPIRE: chiseled-sandstone obelisk capped by a terracotta-orange
    // pinnacle (no glowstone — overworld pyramids are stone all the way up)
    place(ox, FLOOR + L + 2, oz, B.chiseledSandstone);
    place(ox, FLOOR + L + 3, oz, B.terracottaOrange);
    place(ox, FLOOR + L + 4, oz, B.chiseledSandstone);
    place(ox, FLOOR + L + 5, oz, B.terracottaOrange);
    place(ox, FLOOR + L + 6, oz, B.chiseledSandstone);
  };
  // Woodland mansion — full recreate. T-shaped footprint (~25×25): a 21×17
  // main hall + a 13×13 north wing, with a 7×7 corner watchtower attached to
  // the north-east. Three storeys + attic + tower deck. Mixed materials per
  // community medieval style: weathered cobble foundation, dark-oak/birch
  // alternating timber-frame on the walls (vertical log every 4 blocks), big
  // gable roofs with overhangs, multiple chimneys, balconies on the upper
  // floors with fence railings, a covered porch with stair entrance, an
  // INTERIOR dotted with rooms — central great hall with chandelier, library
  // wing, dining hall, blacksmith corner, throne room, multiple bedrooms,
  // attic storage, and a roof-terrace garden.
  const mansion = (ox: number, oz: number) => {
    // Footprint: main rectangle ox±MX, oz∈[oz-MZ_S, oz+MZ_N]; wing extends
    // further on +z, tower attaches at NE corner (extending +z and +x).
    // WIDER + THICKER (not taller): the footprint grew ~40% (21×21 → 29×28) while the
    // storey heights (F0..F3/ROOF) are unchanged — bigger rooms, same silhouette.
    const MX = 14, MZ_S = 11, MZ_N = 16;       // main block half-extents (asymmetric N/S)
    const r = Math.max(MX, MZ_N) + 2;          // platform radius (18 ≪ STRUCT_MAX_R 56)
    const base = platform(ox, oz, r);
    if (base === null) return;
    lay(ox, oz, r, base, B.cobblestone, 26);
    const mx0 = ox - MX, mx1 = ox + MX;
    const mz0 = oz - MZ_S, mz1 = oz + MZ_N;
    const F0 = base + 1;                       // ground floor level (above the cobble plinth)
    const F1 = base + 6, F2 = base + 11, F3 = base + 16;  // upper floor levels
    const ROOF = base + 17;
    // ===== STONE PLINTH (raised cobble base, 2 high, all of footprint) =====
    for (let wx = mx0; wx <= mx1; wx++) for (let wz = mz0; wz <= mz1; wz++) {
      place(wx, base + 1, wz, weatheredCobble(wx, base + 1, wz));
      if (wx === mx0 || wx === mx1 || wz === mz0 || wz === mz1)
        place(wx, base + 2, wz, weatheredCobble(wx, base + 2, wz));
    }
    // ===== GROUND-FLOOR PLANK FLOOR (over the plinth) =====
    fillRect(mx0 + 1, mz0 + 1, mx1 - 1, mz1 - 1, F0 + 1, B.darkOakPlanks);
    // ===== WALL SHELL: dark-oak planks main; birch planks on the wing for contrast =====
    // Main block walls (dark oak)
    for (let wy = F0 + 2; wy <= F3 + 4; wy++) {
      for (let wx = mx0; wx <= mx1; wx++) for (let wz = mz0; wz <= mz1; wz++) {
        if (wx === mx0 || wx === mx1 || wz === mz0 || wz === mz1) {
          place(wx, wy, wz, B.darkOakPlanks);
        }
      }
    }
    // ===== TIMBER FRAMING: vertical dark-oak logs every 4 blocks of wall =====
    const framePosts = (x0: number, x1: number, z0: number, z1: number, yLo: number, yHi: number) => {
      for (let wx = x0; wx <= x1; wx += 4) {
        for (let wy = yLo; wy <= yHi; wy++) { place(wx, wy, z0, B.darkOakLog); place(wx, wy, z1, B.darkOakLog); }
      }
      for (let wz = z0; wz <= z1; wz += 4) {
        for (let wy = yLo; wy <= yHi; wy++) { place(x0, wy, wz, B.darkOakLog); place(x1, wy, wz, B.darkOakLog); }
      }
      // ensure corners always log
      for (let wy = yLo; wy <= yHi; wy++) {
        place(x0, wy, z0, B.darkOakLog); place(x1, wy, z0, B.darkOakLog);
        place(x0, wy, z1, B.darkOakLog); place(x1, wy, z1, B.darkOakLog);
      }
    };
    framePosts(mx0, mx1, mz0, mz1, F0 + 1, F3 + 5);
    // ===== HORIZONTAL TIMBER BANDS (cross-beam log bands at each floor plate) =====
    for (const fy of [F1, F2, F3]) {
      for (let wx = mx0; wx <= mx1; wx++) { place(wx, fy, mz0, B.darkOakLog); place(wx, fy, mz1, B.darkOakLog); }
      for (let wz = mz0; wz <= mz1; wz++) { place(mx0, fy, wz, B.darkOakLog); place(mx1, fy, wz, B.darkOakLog); }
    }
    // ===== UPPER FLOORS (interior) — stone-brick partitions for the great hall =====
    fillRect(mx0 + 1, mz0 + 1, mx1 - 1, mz1 - 1, F1, B.darkOakPlanks);
    fillRect(mx0 + 1, mz0 + 1, mx1 - 1, mz1 - 1, F2, B.darkOakPlanks);
    fillRect(mx0 + 1, mz0 + 1, mx1 - 1, mz1 - 1, F3, B.darkOakPlanks);
    fillRect(mx0 + 1, mz0 + 1, mx1 - 1, mz1 - 1, ROOF, B.darkOakPlanks);   // roof plate
    // ===== ROOF: BIG GABLE with eave overhang =====
    gableRoof(mx0 - 1, mz0 - 1, mx1 + 1, mz1 + 1, ROOF + 1, OAK_ST, B.oakSlab);
    // ===== CHIMNEYS through the roof (3 of them along the ridge) =====
    chimney(mx0 + 2, oz, F0 + 2, ROOF + 8);
    chimney(mx1 - 2, oz, F0 + 2, ROOF + 8);
    chimney(ox, mz1 - 2, F0 + 2, ROOF + 8);
    // ===== HUGE WINDOWS — clerestory rows on each storey (span the full wider walls) =====
    for (const fy of [F0, F1, F2]) {
      for (let wx = mx0 + 2; wx <= mx1 - 2; wx += 3) {
        place(wx, fy + 3, mz0, B.glass); place(wx, fy + 3, mz1, B.glass);
        place(wx, fy + 4, mz0, OAK_ST[3]); place(wx, fy + 4, mz1, OAK_ST[2]);   // stair lintels
      }
      for (let wz = mz0 + 2; wz <= mz1 - 2; wz += 3) {
        place(mx0, fy + 3, wz, B.glass); place(mx1, fy + 3, wz, B.glass);
      }
    }
    // ===== GRAND ENTRANCE on -z side — 3-wide stone-arched doorway with porch =====
    for (const dx of [-1, 0, 1]) for (let dy = 1; dy <= 5; dy++) place(ox + dx, F0 + dy, mz0, B.air);
    for (const dx of [-1, 1]) {
      place(ox + dx, F0 + 1, mz0, B.oakDoorLowerClosed);
      place(ox + dx, F0 + 2, mz0, B.oakDoorUpperClosed);
    }
    place(ox - 1, F0 + 4, mz0, B.darkOakLog); place(ox, F0 + 4, mz0, B.darkOakLog); place(ox + 1, F0 + 4, mz0, B.darkOakLog);
    place(ox - 2, F0 + 4, mz0, OAK_ST[1]); place(ox + 2, F0 + 4, mz0, OAK_ST[0]);
    // PORCH (covered, fence-supported, slab roof, stair-step entrance)
    for (let dx = -3; dx <= 3; dx++) {
      place(ox + dx, F0, mz0 - 1, weatheredCobble(ox + dx, F0, mz0 - 1));
      place(ox + dx, F0, mz0 - 2, weatheredCobble(ox + dx, F0, mz0 - 2));
    }
    place(ox - 3, F0 + 1, mz0 - 2, B.oakFence); place(ox + 3, F0 + 1, mz0 - 2, B.oakFence);
    place(ox - 3, F0 + 2, mz0 - 2, B.oakFence); place(ox + 3, F0 + 2, mz0 - 2, B.oakFence);
    place(ox - 3, F0 + 3, mz0 - 2, B.darkOakLog); place(ox + 3, F0 + 3, mz0 - 2, B.darkOakLog);
    for (let dx = -3; dx <= 3; dx++) {
      place(ox + dx, F0 + 3, mz0 - 1, B.oakSlab);
      place(ox + dx, F0 + 3, mz0 - 2, B.oakSlab);
    }
    // STEP UP at porch lip — auto-step from outside ground (top y=base+1) to
    // porch top (y=base+2). Stair block at y=base+1 (PZ, tall on +z toward
    // mansion); top tall y=base+2 matches porch top y=base+2.
    for (let dx = -2; dx <= 2; dx++) place(ox + dx, F0, mz0 - 3, OAK_ST[2]);
    // INTERIOR THRESHOLD SLABS — without these the door is unreachable: the
    // plinth/porch top is at y=base+2 but the interior plank floor top is at
    // y=base+3 (a +1 step that exceeds auto-step's 0.6). A slab is used
    // INSTEAD of a stair because a stair's "back" box on +z collides with the
    // player's body, blocking the auto-step lift; a slab is a clean half-
    // block (top y=base+2.5) that auto-steps cleanly from y=base+2 then again
    // up to the floor top y=base+3.
    for (const dx of [-1, 0, 1]) {
      place(ox + dx, F0 + 1, mz0 + 1, B.oakSlab);
    }
    // PORCH LANTERNS (lampposts)
    lampPost(ox - 4, mz0 - 2, F0 - 1, B.darkOakLog);
    lampPost(ox + 4, mz0 - 2, F0 - 1, B.darkOakLog);
    // ===== INTERIOR — partitioned rooms via stone-brick walls =====
    // Central great hall: spans from mz0+2 to oz, full width minus partition rooms.
    // Side wall partitions (x = mx0+5 and mx1-5) carve off side rooms.
    const PX_L = mx0 + 5, PX_R = mx1 - 5;
    for (const fy of [F0 + 1, F1 + 1, F2 + 1]) {
      for (let wz = mz0 + 1; wz <= oz - 1; wz++) for (let wy = fy; wy <= fy + 4; wy++) {
        place(PX_L, wy, wz, weatheredStoneBricks(PX_L, wy, wz));
        place(PX_R, wy, wz, weatheredStoneBricks(PX_R, wy, wz));
      }
      // doorway into each side room
      place(PX_L, fy, oz - 2, B.air); place(PX_L, fy + 1, oz - 2, B.air);
      place(PX_R, fy, oz - 2, B.air); place(PX_R, fy + 1, oz - 2, B.air);
    }
    // Library wing (left side ground): bookshelves lining inner wall +
    // reading lectern + glowstone chandelier
    walls(mx0 + 1, mz0 + 1, PX_L - 1, oz - 1, F0 + 2, F0 + 4, B.bookshelf);
    place(PX_L - 1, F0 + 2, oz - 2, B.air);                          // door clear
    place(mx0 + 2, F0 + 2, mz0 + 2, B.darkOakLog); place(mx0 + 2, F0 + 3, mz0 + 2, B.oakSlab);  // lectern
    place(mx0 + 2, F0 + 4, mz0 + 2, B.flowerPot);                    // bloom atop the lectern
    place(mx0 + 4, F0 + 2, mz0 + 2, B.bookshelf); place(mx0 + 4, F0 + 2, mz0 + 3, B.chest);     // reading nook + chest
    place(mx0 + 3, F0 + 5, oz - 3, B.lantern);                       // hanging lantern (overworld light)
    // Dining hall (right side ground): long oak-slab table with bench seating
    for (let wz = mz0 + 4; wz <= oz - 2; wz++) {
      place(PX_R + 2, F0 + 2, wz, B.oakSlab);                        // table
      place(PX_R + 1, F0 + 2, wz, OAK_ST[0]); place(PX_R + 3, F0 + 2, wz, OAK_ST[1]);  // benches
    }
    place(PX_R + 2, F0 + 3, oz - 3, B.flowerPot);                    // centrepiece on the table
    place(PX_R + 2, F0 + 5, oz - 3, B.lantern);                      // hanging lantern
    // KITCHEN nook at the front of the dining wing — a working hearth (lit furnace),
    // crafting table, a second furnace, barrels and a supply chest.
    place(PX_R + 1, F0 + 2, mz0 + 2, B.furnaceLit); place(PX_R + 2, F0 + 2, mz0 + 2, B.craftingTable);
    place(PX_R + 3, F0 + 2, mz0 + 2, B.furnace);
    place(PX_R + 1, F0 + 2, mz0 + 3, B.barrel); place(PX_R + 3, F0 + 2, mz0 + 3, B.chest);
    place(PX_R + 1, F0 + 3, mz0 + 3, B.flowerPot);
    // Throne room / great hall (centre ground): high ceiling (no upper floor here)
    for (let wx = PX_L + 1; wx <= PX_R - 1; wx++) for (let wz = mz0 + 1; wz <= oz - 1; wz++) {
      place(wx, F1, wz, B.air);                                      // open up to floor 2
    }
    // CATWALK: re-lay the F1 floor on the 2 central staircase columns across the
    // open hall so the grand stair is CONTINUOUS — the open-to-F2 clear above would
    // otherwise delete the floor the F1→F2 flight boards from, dead-ending the climb.
    for (let wz = mz0 + 1; wz <= oz; wz++) { place(ox - 1, F1, wz, B.darkOakPlanks); place(ox, F1, wz, B.darkOakPlanks); }
    place(ox, F0 + 1, oz - 4, B.smoothStone); place(ox - 1, F0 + 1, oz - 4, B.oakStairsPX); place(ox + 1, F0 + 1, oz - 4, B.oakStairsNX);
    place(ox, F0 + 2, oz - 4, B.woolRed);    // throne (red wool seat) on smooth-stone dais
    place(ox - 1, F0 + 2, oz - 4, B.darkOakLog); place(ox + 1, F0 + 2, oz - 4, B.darkOakLog);
    place(ox, F0 + 3, oz - 4, B.darkOakLog); place(ox, F0 + 4, oz - 4, B.lantern);   // throne lamp (lantern)
    // RED-CARPET runner from door to throne (on the floor)
    for (let wz = mz0 + 1; wz <= oz - 4; wz++) place(ox, F0 + 1, wz, B.woolRed);
    // GRAND CHANDELIER over the great hall — a lantern hung from a log post
    place(ox, F1 + 4, oz - 2, B.darkOakLog); place(ox, F1 + 3, oz - 2, B.lantern);
    // ===== BEDROOMS upstairs (F1 + F2) — REAL beds + chest/barrel nightstands =====
    for (const fy of [F1 + 1, F2 + 1]) {
      // Left-wing beds (head against the -x wall, foot toward the room) + a chest
      // and a barrel nightstand with a potted flower on top.
      for (const cz of [mz0 + 2, mz0 + 7]) {
        place(mx0 + 1, fy, cz, B.bedHead); place(mx0 + 2, fy, cz, B.bedFoot);
        place(mx0 + 1, fy, cz + 1, B.chest);
        place(mx0 + 2, fy, cz + 1, B.barrel); place(mx0 + 2, fy + 1, cz + 1, B.flowerPot);
      }
      // Right-wing beds (head against the +x wall)
      for (const cz of [mz0 + 2, mz0 + 7]) {
        place(mx1 - 1, fy, cz, B.bedHead); place(mx1 - 2, fy, cz, B.bedFoot);
        place(mx1 - 1, fy, cz + 1, B.chest);
        place(mx1 - 2, fy, cz + 1, B.barrel); place(mx1 - 2, fy + 1, cz + 1, B.flowerPot);
      }
      place(mx0 + 2, fy + 3, oz - 3, B.lantern);
      place(mx1 - 2, fy + 3, oz - 3, B.lantern);
    }
    // ===== GRAND STAIRCASE — central, two-wide, dark-oak — climbs all floors =====
    for (const sx of [ox - 1, ox]) {
      flight(sx, mz1 - 1, 0, -1, F0 + 1, 5, B.oakStairsNZ, F1);    // ground → 2nd
      flight(sx, mz0 + 1, 0, 1, F1 + 1, 5, B.oakStairsPZ, F2);     // 2nd → 3rd
      flight(sx, mz1 - 1, 0, -1, F2 + 1, 5, B.oakStairsNZ, F3);    // 3rd → attic
    }
    // ===== ROOF TERRACE GARDEN with fence railing on top of roof plate =====
    walls(mx0, mz0, mx1, mz1, ROOF + 1, ROOF + 1, B.oakFence);
    // Few decorative tall grass + flowers on the terrace (placed only if cell is air)
    place(mx0 + 3, ROOF + 1, mz0 + 3, B.flowerOxeye);
    place(mx1 - 3, ROOF + 1, mz0 + 3, B.flowerPoppy);
    place(mx0 + 3, ROOF + 1, mz1 - 3, B.flowerDandelion);
    place(mx1 - 3, ROOF + 1, mz1 - 3, B.flowerCornflower);
    // ===== UPPER BALCONY on -z facade (between F1 and F2) =====
    for (let dx = -3; dx <= 3; dx++) place(ox + dx, F1 + 1, mz0 - 1, B.oakSlab);
    for (let dx = -3; dx <= 3; dx += 6) place(ox + dx, F1 + 2, mz0 - 1, B.oakFence);
    place(ox - 3, F1 + 2, mz0 - 1, B.oakFence); place(ox + 3, F1 + 2, mz0 - 1, B.oakFence);
    place(ox - 2, F1 + 2, mz0 - 1, B.oakFence); place(ox + 2, F1 + 2, mz0 - 1, B.oakFence);
    place(ox - 1, F1 + 2, mz0 - 1, B.oakFence); place(ox + 1, F1 + 2, mz0 - 1, B.oakFence);
    place(ox, F1 + 2, mz0 - 1, B.oakFence);
    // ===== NE CORNER WATCHTOWER (5×5, projects above the main roof) =====
    const tx = mx1 - 2, tz = mz1 - 2;     // corner-tower centre
    for (let wy = F0 + 1; wy <= ROOF + 5; wy++) {
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) === 2 || Math.abs(dz) === 2)
          place(tx + dx, wy, tz + dz, weatheredStoneBricks(tx + dx, wy, tz + dz));
      }
    }
    // tower battlements — stone bricks (matches the rest of the watchtower
    // shell); merlons every other column, gaps between
    for (let dx = -2; dx <= 2; dx++) {
      if (((dx + 2) & 1) === 0) {
        place(tx + dx, ROOF + 6, tz - 2, B.stoneBricks); place(tx + dx, ROOF + 6, tz + 2, B.stoneBricks);
      }
    }
    for (let dz = -2; dz <= 2; dz++) {
      if (((dz + 2) & 1) === 0) {
        place(tx - 2, ROOF + 6, tz + dz, B.stoneBricks); place(tx + 2, ROOF + 6, tz + dz, B.stoneBricks);
      }
    }
    // tower beacon — chiseled stone-brick lantern frame around a single lantern
    // (overworld-appropriate; no glowstone)
    place(tx, ROOF + 6, tz, B.chiseledStoneBricks);
    place(tx, ROOF + 7, tz, B.lantern);
    place(tx, ROOF + 8, tz, B.chiseledStoneBricks);
    // ===== APPROACH PATH to the entrance — short stone path =====
    for (let wz = mz0 - 4; wz <= mz0 - 8; wz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = colAt(ox + dx, wz);
        if (c.height > sea) place(ox + dx, c.height, wz, weatheredCobble(ox + dx, c.height, wz));
      }
    }
  };
  // Igloo: a hollow snow dome with ice windows, a low entrance tunnel, and a cozy
  // glowstone in the apex. Cold biomes only. Entirely above the base → apron-safe.
  const igloo = (ox: number, oz: number) => {
    const R = 4, base = platform(ox, oz, R + 1);
    if (base === null) return;
    lay(ox, oz, R + 1, base, B.snow, R + 3);
    fillRect(ox - R, oz - R, ox + R, oz + R, base, B.snow);        // floor
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) for (let dy = 0; dy <= R; dy++) {
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= R && d > R - 1) place(ox + dx, base + dy, oz + dz, B.snow);     // ~1-thick shell
      else if (d < R - 0.5 && dy >= 1) place(ox + dx, base + dy, oz + dz, B.air); // hollow interior
    }
    for (let dz = -(R + 1); dz <= -(R - 1); dz++) {               // entrance tunnel on -z
      place(ox, base, oz + dz, B.snow); place(ox, base + 1, oz + dz, B.air); place(ox, base + 2, oz + dz, B.air);
    }
    place(ox + (R - 1), base + 2, oz, B.ice); place(ox - (R - 1), base + 2, oz, B.ice);   // ice windows
    place(ox, base + 2, oz + (R - 1), B.ice);
    place(ox, base + R, oz, B.lantern);                           // apex hanging lantern
    place(ox + 1, base + 1, oz + 1, B.bedFoot); place(ox + 2, base + 1, oz + 1, B.bedHead);   // a real bed
    place(ox - 2, base + 1, oz + 1, B.chest); place(ox - 2, base + 1, oz - 1, B.craftingTable);   // supplies
  };
  // ===========================================================================
  //  COMMUNITY-STYLE NEW STRUCTURES
  // ===========================================================================

  // Campsite: a wilderness camp at REAL in-game scale — a ridge tent a 2-block
  // player can walk into and stand up in (7-wide A-frame, ridge 3 blocks of head-
  // room over a plank floor, a bed + chest inside), a proper campfire on a stone
  // hearth ringed by log seats, a crafting table + barrel + flower pot, a log pile,
  // and a trail. The old camp was a 3-wide solid-wool prop you couldn't enter.
  const campsite = (ox: number, oz: number, rng: RNG) => {
    const r = 7, base = platform(ox, oz, r);
    if (base === null) return;
    lay(ox, oz, r, base, B.dirt, 7);                            // clear 7 tall → standable tent
    const F = base + 1;                                          // floor-top level (items sit here)
    // ---- CAMPFIRE on a 3×3 cobble / mossy hearth ----
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
      place(ox + dx, base, oz + dz, (dx === 0 && dz === 0) ? B.cobblestone : (dx && dz) ? B.mossyCobblestone : B.cobblestone);
    place(ox, F, oz, B.campfire);
    // log seats ringing the fire (sit on the -x / +x / -z sides; tent is on +z)
    place(ox - 2, F, oz, B.strippedOakLog); place(ox + 2, F, oz, B.strippedOakLog); place(ox, F, oz - 2, B.strippedOakLog);
    // ---- TENT: 7-wide (x: ox-3..ox+3) × 5-deep (z: oz+3..oz+7) ridge A-frame ----
    const tz0 = oz + 3, tz1 = oz + 7, RIDGE = base + 4;
    fillRect(ox - 3, tz0, ox + 3, tz1, base, B.oakPlanks);       // plank groundsheet
    for (let dz = tz0; dz <= tz1; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const ry = RIDGE - Math.abs(dx);                        // A-frame: peak at the ridge, eaves low
        const roof = (Math.abs(dx) === 3) ? B.woolWhite : B.woolRed;   // white eaves, red canvas
        place(ox + dx, ry, oz + dz, roof);
        if (dz === tz1) for (let wy = F; wy < ry; wy++)          // closed BACK gable wall
          place(ox + dx, wy, oz + dz, Math.abs(dx) === 3 ? B.woolWhite : B.woolRed);
      }
    }
    // guy-rope fence pegs at the open front corners
    place(ox - 3, F, tz0 - 1, B.oakFence); place(ox + 3, F, tz0 - 1, B.oakFence);
    // ---- TENT INTERIOR (player can stand in the centre strip) ----
    place(ox - 1, F, oz + 6, B.bedFoot); place(ox - 1, F, oz + 7, B.bedHead);   // a real bed
    place(ox + 2, F, oz + 7, B.chest);                          // supplies chest
    place(ox + 2, F, oz + 6, B.barrel);                         // water/food barrel
    place(ox, base + 3, oz + 5, B.lantern);                     // lantern hung from the ridge
    // ---- CAMP KIT around the fire ----
    place(ox - 3, F, oz - 1, B.craftingTable);
    place(ox - 3, F, oz, B.barrel); place(ox - 3, F + 1, oz, B.flowerPot);   // pot on the barrel
    // log pile (stacked + cross-laid stripped logs)
    place(ox + 3, F, oz - 2, B.strippedOakLog); place(ox + 4, F, oz - 2, B.strippedOakLog);
    place(ox + 3, F + 1, oz - 2, B.strippedOakLog); place(ox + 3, F, oz - 3, B.strippedOakLog);
    // scattered flowers / tall grass
    place(ox + 3, F, oz + 1, B.flowerPoppy); place(ox - 4, F, oz - 3, B.flowerDandelion);
    place(ox + 4, F, oz + 2, B.tallGrassLower); if (base + 2 < H) place(ox + 4, F + 1, oz + 2, B.tallGrassUpper);
    // short trail leaving camp
    if (rng.random() < 0.7) {
      const ang = rng.random() * Math.PI * 2;
      drawTrailPath(ox, oz - 5, 12 + Math.floor(rng.random() * 8), ang);
    }
  };

  // Ruins: a partially-collapsed stone structure — broken stone-brick walls
  // (mossy/cracked weathering) of varying heights, fallen pillars (logs lying
  // on the ground), pile of mossy cobble, a cracked floor, vines hanging from
  // remaining walls. A stone-brick frame with bits of wall missing.
  const ruins = (ox: number, oz: number, rng: RNG) => {
    const r = 6, base = platform(ox, oz, r);
    if (base === null) return;
    // Lift the surface up to the platform base with packed dirt where it dips
    // below — keeps walls / pillars from floating over hollows in the terrain
    // — and clear the air above so we can build the ruin on a flat plane.
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const wx = ox + dx, wz = oz + dz;
      const sh = colAt(wx, wz).height;
      for (let wy = sh + 1; wy <= base; wy++) place(wx, wy, wz, B.dirt);
      for (let wy = base + 1; wy <= base + 4; wy++) place(wx, wy, wz, B.air);
    }
    // CRACKED STONE FLOOR slab (broken up — ~70% coverage so it reads ruined)
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
      const wx = ox + dx, wz = oz + dz;
      const r3 = hash01(wx * 13 + 5, wz * 17 + 9);
      if (r3 < 0.7) place(wx, base, wz, r3 < 0.4 ? B.mossyCobblestone : B.crackedStoneBricks);
    }
    // 4 PARTIAL WALLS at varying heights — random missing chunks
    const walls4 = [
      [-5, -5, 5, -5] as const, [-5, 5, 5, 5] as const,
      [-5, -5, -5, 5] as const, [5, -5, 5, 5] as const,
    ];
    for (const [dx0, dz0, dx1, dz1] of walls4) {
      const wallH = 1 + Math.floor(rng.random() * 3);
      const xa = ox + dx0, xb = ox + dx1, za = oz + dz0, zb = oz + dz1;
      const sx = Math.sign(xb - xa), sz = Math.sign(zb - za);
      const len = Math.max(Math.abs(xb - xa), Math.abs(zb - za));
      for (let i = 0; i <= len; i++) {
        const wx = xa + sx * i, wz = za + sz * i;
        const localH = wallH + Math.round(simplex.noise(wx * 0.4, wz * 0.4) * 1.5);
        for (let dy = 1; dy <= Math.max(1, localH); dy++) {
          if (hash01(wx * 7 + dy * 11, wz * 13 + dy * 5) < 0.85) {
            place(wx, base + dy, wz, weatheredStoneBricks(wx, base + dy, wz));
          }
        }
      }
    }
    // A FALLEN PILLAR (a log lying on its side)
    for (let dx = -3; dx <= 3; dx++) place(ox + dx, base + 1, oz - 2, B.strippedOakLog);
    // BROKEN COLUMNS in the centre (stub pillars)
    for (const [dx, dz] of [[-2, 2], [2, 2], [-2, -1], [2, -1]] as const) {
      const ph = 1 + Math.floor(rng.random() * 3);
      for (let dy = 1; dy <= ph; dy++) place(ox + dx, base + dy, oz + dz, B.stoneBricks);
      if (ph >= 2) place(ox + dx, base + ph + 1, oz + dz, B.crackedStoneBricks);
    }
    // SCATTERED MOSSY COBBLE RUBBLE
    for (let i = 0; i < 14; i++) {
      const dx = Math.floor((rng.random() - 0.5) * 10);
      const dz = Math.floor((rng.random() - 0.5) * 10);
      const wx = ox + dx, wz = oz + dz;
      if (Math.abs(dx) >= 5 || Math.abs(dz) >= 5) continue;
      place(wx, base + 1, wz, hash01(wx, wz) < 0.5 ? B.mossyCobblestone : B.cobblestone);
    }
    // A LONE BROKEN ALTAR (chiseled stone bricks) in the centre
    place(ox, base + 1, oz, B.chiseledStoneBricks);
    place(ox, base + 2, oz, B.crackedStoneBricks);
    // VINES on a couple of remaining wall stubs
    for (let i = 0; i < 6; i++) {
      const wx = ox + Math.floor((rng.random() - 0.5) * 10);
      const wz = oz + Math.floor((rng.random() - 0.5) * 10);
      place(wx, base + 1, wz, B.vine);
    }
  };

  // Pillager outpost — 5×5 footprint, 9 blocks tall to a lookout deck. Cobble
  // corner posts + dark-oak plank infill walls, a real INTERIOR SQUARE-SPIRAL
  // stair (oak stairs around the 3×3 interior perimeter) so the player can
  // actually climb to the deck (a vertical log column would be unclimbable).
  // A small camp clearing at the base (campfire ring, log stools, banner).
  const outpost = (ox: number, oz: number, rng: RNG) => {
    const r = 2, base = platform(ox, oz, r + 1);
    if (base === null) return;
    const top = 9;     // height of shaft (deck sits at base+top+1)
    lay(ox, oz, r + 2, base, B.cobblestone, top + 6);
    // CAMP CLEARING: dirt + gravel splotches around the tower footprint
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      const wx = ox + dx, wz = oz + dz;
      if (Math.abs(dx) <= r && Math.abs(dz) <= r) continue;          // tower footprint
      if (hash01(wx, wz) < 0.4) place(wx, base + 1, wz, hash01(wx + 1, wz + 1) < 0.5 ? B.gravel : B.dirt);
    }
    // TOWER SHAFT — cobble corner posts + dark-oak plank infill, full enclosed
    // (so the spiral inside is shaded). The lookout level (top tier) is open.
    const x0 = ox - r, x1 = ox + r, z0 = oz - r, z1 = oz + r;
    for (let wy = base + 1; wy <= base + top; wy++) {
      // 4 corner posts cobble
      place(x0, wy, z0, B.cobblestone); place(x1, wy, z0, B.cobblestone);
      place(x0, wy, z1, B.cobblestone); place(x1, wy, z1, B.cobblestone);
      // Dark-oak plank infill on every level except the top 2 (open lookout)
      const open = wy >= base + top - 1;
      for (let wx = x0 + 1; wx <= x1 - 1; wx++) {
        if (open) continue;
        place(wx, wy, z0, B.darkOakPlanks); place(wx, wy, z1, B.darkOakPlanks);
      }
      for (let wz = z0 + 1; wz <= z1 - 1; wz++) {
        if (open) continue;
        place(x0, wy, wz, B.darkOakPlanks); place(x1, wy, wz, B.darkOakPlanks);
      }
    }
    // LOOKOUT DECK at base+top+1: dark-oak planks + fence railing on the perimeter.
    // Placed BEFORE the spiral so the spiral's last stair (at y=deck) cleanly
    // overrides the deck plank at the exit cell — seamless walk-off.
    const deckY = base + top + 1;
    fillRect(x0, z0, x1, z1, deckY, B.darkOakPlanks);
    walls(x0, z0, x1, z1, deckY + 1, deckY + 1, B.oakFence);
    // INTERIOR SQUARE-SPIRAL STAIR around the 3×3 perimeter. The spiral now
    // STARTS at the cell directly inside the south door (ox, oz-1) so the
    // player walking +z through the door lands on step 0 from its OPEN side
    // (auto-step works). Last stair sits AT the deck level so the player
    // walks off the spiral seamlessly — no jump, no drop.
    const a = 1;
    const pathCells: Array<[number, number]> = [
      [ox,     oz - a], [ox + a, oz - a],         // south edge: from door inwards
      [ox + a, oz    ], [ox + a, oz + a],         // east edge
      [ox,     oz + a], [ox - a, oz + a],         // north edge
      [ox - a, oz    ], [ox - a, oz - a],         // west edge (wraps back)
    ];
    const P = pathCells.length;
    const steps = top + 1;             // last stair at y=base+top+1 = deck level
    for (let i = 0; i < steps; i++) {
      const [csx, csz] = pathCells[i % P];
      const [nx, nz] = pathCells[(i + 1) % P];
      const y = base + 1 + i;
      place(csx, y, csz, stairFor(OAK_ST, nx - csx, nz - csz));
      // Clear up to AND including the deck level (y=deckY) at this spiral
      // cell — leaves an open shaft through the deck so the player has body
      // clearance while ascending. The 8 spiral cells become "holes" in the
      // deck (acceptable — the deck is 5×5 with only 8 cells punched out).
      for (let hy = y + 1; hy <= deckY; hy++) place(csx, hy, csz, B.air);
    }
    // STAIR-FLARED HIP ROOF over the deck
    hipRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, base + top + 3, OAK_ST, B.oakSlab);
    // BANNER (red + white wool stripe) hanging on the +x side
    for (let dy = 4; dy <= top - 1; dy++) {
      place(x1 + 1, base + dy, oz, dy % 2 === 0 ? B.woolRed : B.woolWhite);
    }
    // DOORWAY at -z (open archway, no door — outpost reads as semi-fortified
    // but accessible). NO entry stair: the floor at the door (foundation top
    // y=base+1) matches the outside ground level, so the player walks straight
    // in without a height change. (The previous design had an entry stair
    // that lifted the player +1 then dropped them back into the door — broken.)
    place(ox, base + 1, z0, B.air); place(ox, base + 2, z0, B.air);
    // CAMPFIRE next to outpost (campfire block on a cobble ring) + log stools
    place(ox + 5, base + 1, oz, B.cobblestone); place(ox + 3, base + 1, oz, B.cobblestone);
    place(ox + 4, base + 1, oz + 1, B.cobblestone); place(ox + 4, base + 1, oz - 1, B.cobblestone);
    place(ox + 4, base + 1, oz, B.campfire);                       // proper overworld campfire
    place(ox + 6, base + 1, oz, B.strippedOakLog);
    place(ox + 4, base + 1, oz + 2, B.strippedOakLog);
    // A short trail leaving the outpost (away from -z) — twists + thins
    if (rng.random() < 0.6) {
      const ang = -Math.PI / 2 + (rng.random() - 0.5) * 0.7;
      drawTrailPath(ox, z0 - 2, 18 + Math.floor(rng.random() * 10), ang);
    }
  };
  // Lighthouse — 5×5 footprint, 16 blocks tall to a glass lantern room, with a
  // proper conical cap of stair rings narrowing 5×5 → 3×3 → 1. White-and-red
  // wool stripes on the shaft; quartz-pillar corner frame for trim. INTERIOR
  // SQUARE-SPIRAL STAIR (8 cells per lap around the 3×3 interior) so the
  // climb to the lantern actually works.
  const lighthouse = (ox: number, oz: number) => {
    const r = 2, base = platform(ox, oz, r + 1);
    if (base === null) return;
    const SHAFT_TOP = 16;       // top of striped shaft (relative to base)
    lay(ox, oz, r + 2, base, B.cobblestone, SHAFT_TOP + 8);
    const x0 = ox - r, x1 = ox + r, z0 = oz - r, z1 = oz + r;
    // COBBLE PLINTH (one course wider than the shaft for a hint of base flare)
    fillRect(x0 - 1, z0 - 1, x1 + 1, z1 + 1, base + 1, B.cobblestone);
    // SHAFT: alternating wool stripes every 3 courses, quartz-pillar corner posts
    for (let wy = base + 2; wy <= base + SHAFT_TOP; wy++) {
      const stripe = Math.floor((wy - base - 2) / 3) & 1;
      const id = stripe === 0 ? B.woolWhite : B.woolRed;
      for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++) {
        if (wx === x0 || wx === x1 || wz === z0 || wz === z1) place(wx, wy, wz, id);
      }
      place(x0, wy, z0, B.quartzPillar); place(x1, wy, z0, B.quartzPillar);
      place(x0, wy, z1, B.quartzPillar); place(x1, wy, z1, B.quartzPillar);
    }
    // LANTERN ROOM FLOOR placed BEFORE the spiral so the spiral's last stair
    // (at y=ly) cleanly overrides the floor plank at the exit cell — gives
    // a seamless walk-off from the spiral onto the lantern-room floor.
    const ly = base + SHAFT_TOP + 1;
    fillRect(x0, z0, x1, z1, ly, B.quartzBlock);                           // lantern-room floor
    // INTERIOR SQUARE-SPIRAL STAIR — starts at the cell directly inside the
    // south door (ox, oz-1) so the player auto-steps onto step 0 from its
    // open side. Last stair sits AT the lantern-room floor level so the
    // player walks off the spiral seamlessly onto the floor.
    const a = 1;
    const pathCells: Array<[number, number]> = [
      [ox,     oz - a], [ox + a, oz - a],         // south edge: from door inwards
      [ox + a, oz    ], [ox + a, oz + a],         // east edge
      [ox,     oz + a], [ox - a, oz + a],         // north edge
      [ox - a, oz    ], [ox - a, oz - a],         // west edge (wraps back)
    ];
    const P = pathCells.length;
    const steps = SHAFT_TOP;         // last stair at y=base+SHAFT_TOP+1 = lantern-room floor
    for (let i = 0; i < steps; i++) {
      const [csx, csz] = pathCells[i % P];
      const [nx, nz] = pathCells[(i + 1) % P];
      const y = base + 2 + i;
      place(csx, y, csz, stairFor(OAK_ST, nx - csx, nz - csz));
      // Clear up to AND including the lantern floor level (y=ly) at this
      // spiral cell — leaves an open shaft through the floor so the player
      // has body-height clearance while ascending each step.
      for (let hy = y + 1; hy <= ly; hy++) place(csx, hy, csz, B.air);
    }
    for (let wy = ly + 1; wy <= ly + 2; wy++) {
      for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++) {
        if (wx === x0 || wx === x1 || wz === z0 || wz === z1) place(wx, wy, wz, B.glass);
      }
      place(x0, wy, z0, B.quartzPillar); place(x1, wy, z0, B.quartzPillar);
      place(x0, wy, z1, B.quartzPillar); place(x1, wy, z1, B.quartzPillar);
    }
    // SEA LANTERN beacon (visible through the glass walls)
    place(ox, ly + 1, oz, B.seaLantern);
    place(ox, ly + 2, oz, B.seaLantern);
    // CONICAL CAP — two narrowing stair rings 5×5 → 3×3 capped by a chiseled
    // stone-brick weather-vane. Each stair's TALL side faces INWARD so the
    // dome rises from the eaves up to the apex.
    // Ring 1 (5×5) at ly+3 — eaves of the cap
    for (let wx = x0; wx <= x1; wx++) {
      place(wx, ly + 3, z0, STN_ST[2]); place(wx, ly + 3, z1, STN_ST[3]);
    }
    for (let wz = z0; wz <= z1; wz++) {
      place(x0, ly + 3, wz, STN_ST[0]); place(x1, ly + 3, wz, STN_ST[1]);
    }
    fillRect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, ly + 3, B.stoneBricks);
    // Ring 2 (3×3) at ly+4 — the apex cap
    place(ox, ly + 4, oz - 1, STN_ST[2]); place(ox, ly + 4, oz + 1, STN_ST[3]);
    place(ox - 1, ly + 4, oz, STN_ST[0]); place(ox + 1, ly + 4, oz, STN_ST[1]);
    place(ox - 1, ly + 4, oz - 1, B.chiseledStoneBricks);
    place(ox + 1, ly + 4, oz - 1, B.chiseledStoneBricks);
    place(ox - 1, ly + 4, oz + 1, B.chiseledStoneBricks);
    place(ox + 1, ly + 4, oz + 1, B.chiseledStoneBricks);
    place(ox, ly + 4, oz, B.stoneBricks);
    // Spire: chiseled stone-brick weather-vane
    place(ox, ly + 5, oz, B.chiseledStoneBricks);
    // DOOR at base
    place(ox, base + 2, z0, B.oakDoorLowerClosed); place(ox, base + 3, z0, B.oakDoorUpperClosed);
    place(ox, base + 4, z0, B.darkOakLog);
    place(ox, base + 1, z0 - 1, OAK_ST[2]);
  };

  // Witch hut — small dark-oak shack on stilts over swamp ground. 5×5 hut,
  // raised 2 blocks on dark-oak log stilts so it reads as a proper swamp
  // shack. A 2-step external oak stair flight lets the player actually walk
  // up to the door (it'd be unreachable otherwise — auto-step is only 0.6).
  // Mushroom decorations on the roof, magma "cauldron" inside.
  const witchHut = (ox: number, oz: number) => {
    const r = 2, base = platform(ox, oz, r + 1);
    if (base === null) return;
    // STILTS — 4 dark-oak log columns, lifting the hut floor 2 blocks up
    for (const [px, pz] of [[ox - r, oz - r], [ox + r, oz - r], [ox - r, oz + r], [ox + r, oz + r]] as const) {
      const sh = colAt(px, pz).height;
      for (let wy = sh + 1; wy <= base + 2; wy++) place(px, wy, pz, B.darkOakLog);
    }
    const fy = base + 3;       // hut floor level
    // FLOOR — dark-oak planks
    fillRect(ox - r, oz - r, ox + r, oz + r, fy, B.darkOakPlanks);
    // WALLS — 3 courses tall around the perimeter
    for (let wy = fy + 1; wy <= fy + 3; wy++) {
      for (let wx = ox - r; wx <= ox + r; wx++) for (let wz = oz - r; wz <= oz + r; wz++) {
        if (wx === ox - r || wx === ox + r || wz === oz - r || wz === oz + r)
          place(wx, wy, wz, B.darkOakPlanks);
      }
    }
    // CORNER POSTS — full height (dark-oak log)
    for (const [px, pz] of [[ox - r, oz - r], [ox + r, oz - r], [ox - r, oz + r], [ox + r, oz + r]] as const) {
      for (let wy = fy + 1; wy <= fy + 4; wy++) place(px, wy, pz, B.darkOakLog);
    }
    // ROOF PLATE + GABLE ROOF
    fillRect(ox - r, oz - r, ox + r, oz + r, fy + 4, B.darkOakPlanks);
    gableRoof(ox - r - 1, oz - r - 1, ox + r + 1, oz + r + 1, fy + 5, OAK_ST, B.oakSlab);
    // CHIMNEY (cobble) through the roof
    chimney(ox - r + 1, oz + r - 1, fy + 1, fy + 9);
    // DOOR (south side) + log lintel
    place(ox, fy + 1, oz - r, B.oakDoorLowerClosed); place(ox, fy + 2, oz - r, B.oakDoorUpperClosed);
    place(ox, fy + 3, oz - r, B.darkOakLog);
    // EXTERNAL STAIRS up to the door — 3 oak stairs bridging ground (y=base+1)
    // up to the hut floor top (y=fy+1=base+4). Auto-step is only 0.6 blocks
    // so each course rises exactly 1 block on a sequential cell.
    place(ox, base + 1, oz - r - 3, OAK_ST[2]);  // step 1 — top tall y=base+2
    place(ox, base + 2, oz - r - 2, OAK_ST[2]);  // step 2 — top tall y=base+3
    place(ox, base + 3, oz - r - 1, OAK_ST[2]);  // step 3 — top tall y=base+4 (= floor top)
    // WINDOWS
    place(ox, fy + 2, oz + r, B.glass);
    place(ox - r, fy + 2, oz, B.glass); place(ox + r, fy + 2, oz, B.glass);
    // INTERIOR — witches' "cauldron" (cobble base, campfire on top suggests a
    // bubbling brew), bookshelves
    place(ox, fy + 1, oz, B.cobblestone); place(ox, fy + 2, oz, B.campfire);
    place(ox - 1, fy + 1, oz + 1, B.bookshelf); place(ox + 1, fy + 1, oz + 1, B.bookshelf);
    // MUSHROOM DECORATIONS on the roof
    place(ox - 1, fy + 7, oz, B.mushroomRed);
    place(ox + 1, fy + 7, oz, B.mushroomBrown);
    // Interior overhead light — hanging lantern (overworld appropriate)
    place(ox, fy + 5, oz, B.lantern);
  };

  // ===========================================================================
  //  VILLAGE — bigger, with a road network: a central plaza with the well, 2-3
  //  main MAIN ROADS radiating out (curving via simplex jitter), each carrying
  //  3-4 buildings on alternating sides, with short branch paths to each
  //  building's door. Roads route AROUND building footprints so they don't clip
  //  through houses (per the user's request). 9-12 buildings. Mixed building
  //  types: cabin / bigHouse / tavern / library / blacksmith / farm.
  // ===========================================================================
  const village = (ox: number, oz: number, rng: RNG) => {
    // ---- 1) CENTRAL PLAZA: 7×7 cobble paving + the well in the middle ----
    const plazaR = 3;
    const plazaBase = platform(ox, oz, plazaR);
    if (plazaBase !== null) {
      lay(ox, oz, plazaR + 1, plazaBase, B.cobblestone, 5);
      for (let dx = -plazaR; dx <= plazaR; dx++) for (let dz = -plazaR; dz <= plazaR; dz++) {
        place(ox + dx, plazaBase + 1, oz + dz, weatheredCobble(ox + dx, plazaBase + 1, oz + dz));
      }
      // Plaza corner lampposts
      lampPost(ox - plazaR, oz - plazaR, plazaBase + 1, B.darkOakLog);
      lampPost(ox + plazaR, oz - plazaR, plazaBase + 1, B.darkOakLog);
      lampPost(ox - plazaR, oz + plazaR, plazaBase + 1, B.darkOakLog);
      lampPost(ox + plazaR, oz + plazaR, plazaBase + 1, B.darkOakLog);
      // A bench (oak slab on stripped logs)
      place(ox - plazaR + 1, plazaBase + 2, oz + plazaR - 1, B.strippedOakLog);
      place(ox - plazaR + 2, plazaBase + 2, oz + plazaR - 1, B.oakSlab);
      place(ox - plazaR + 3, plazaBase + 2, oz + plazaR - 1, B.strippedOakLog);
      // A cozy campfire in a clear corner of the plaza (warm flickering light)
      place(ox - plazaR + 1, plazaBase + 2, oz - plazaR + 1, B.campfire);
    }
    well(ox, oz);

    // ---- 2) BUILDING SLOTS along main roads ----
    // Pick 3 main road directions (120° apart, with random rotation), and
    // place 3 buildings per road on alternating sides, well-spaced along the
    // road. Distances are tuned so houses sit ~10-15 blocks apart from each
    // other and never closer than ~12 blocks to the plaza — proper village
    // breathing room rather than a cramped huddle.
    const ROADS = 3;
    const startAng = rng.random() * Math.PI * 2;
    type Slot = { x: number, z: number, kind: number, palette: number };
    const slots: Slot[] = [];
    const avoid: Array<readonly [number, number, number, number]> = [
      [ox - plazaR - 1, oz - plazaR - 1, ox + plazaR + 1, oz + plazaR + 1],     // plaza
    ];
    const buildingRect = (cx: number, cz: number, halfX = 5, halfZ = 5) =>
      [cx - halfX, cz - halfZ, cx + halfX, cz + halfZ] as const;

    for (let r = 0; r < ROADS; r++) {
      const ang = startAng + r * (Math.PI * 2 / ROADS);
      const ux = Math.cos(ang), uz = Math.sin(ang);
      const px = -uz, pz = ux;                                         // perpendicular
      // 3 buildings along this road (always 3, exactly — gives a steady village)
      const nBuildings = 3;
      for (let i = 0; i < nBuildings; i++) {
        // First house ~14 from plaza, each next ~12 further along — well past
        // the plaza paving and never on top of an earlier slot.
        const dist = 14 + i * 12 + Math.floor(rng.random() * 3);
        const side = (i & 1) === 0 ? 1 : -1;                           // alternate sides
        // Sideways offset 5-8 blocks from the road centreline (not touching it).
        const offset = (5 + Math.floor(rng.random() * 4)) * side;
        const cx = ox + Math.round(ux * dist + px * offset);
        const cz = oz + Math.round(uz * dist + pz * offset);
        // Building kind by RNG
        const tk = rng.random();
        const kind = tk < 0.35 ? 0 :                                  // cabin
                     tk < 0.55 ? 1 :                                  // bigHouse
                     tk < 0.70 ? 2 :                                  // farm
                     tk < 0.83 ? 3 :                                  // tavern
                     tk < 0.93 ? 4 : 5;                               // library / blacksmith
        const palette = rng.random() < 0.55 ? 0 : 1;                  // 0=oak, 1=birch
        slots.push({ x: cx, z: cz, kind, palette });
      }
    }

    // Add 1-2 "back-alley" buildings on jitter — give the village a less radial
    // feel. They sit at a distance well clear of the road buildings.
    const nBack = 1 + (rng.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < nBack; i++) {
      const ang = rng.random() * Math.PI * 2, rad = 22 + rng.random() * 14;
      const cx = ox + Math.round(Math.cos(ang) * rad);
      const cz = oz + Math.round(Math.sin(ang) * rad);
      const tk = rng.random();
      const kind = tk < 0.55 ? 2 : tk < 0.85 ? 0 : 1;                 // farm-leaning
      slots.push({ x: cx, z: cz, kind, palette: rng.random() < 0.5 ? 0 : 1 });
    }

    // Reject any slot whose centre is closer than 17 in BOTH axes to an already
    // placed slot — buildings have a half-extent of ~5, so a 17-block centre
    // gap leaves 6-7 blocks of clear breathing space between any two houses.
    const placed: Slot[] = [];
    for (const s of slots) {
      if (placed.some(p => Math.abs(p.x - s.x) < 17 && Math.abs(p.z - s.z) < 17)) continue;
      placed.push(s);
    }

    // ---- 3) BUILD ROADS FIRST so buildings can overwrite path tiles cleanly ----
    // Each placed slot connects back to the plaza via a winding gravel/cobble
    // road that ROUTES AROUND already-placed building rectangles.
    const roadAvoid: Array<readonly [number, number, number, number]> = [...avoid];
    for (const s of placed) {
      drawWindingPath(s.x, s.z, ox, oz, 1, B.gravel, B.cobblestone, roadAvoid);
      roadAvoid.push(buildingRect(s.x, s.z));
    }

    // ---- 4) BUILD THE BUILDINGS ----
    for (const s of placed) {
      const wood: readonly [number, number] = s.palette === 0 ? [B.tree, B.oakPlanks] : [B.birchLog, B.birchPlanks];
      switch (s.kind) {
        case 0: cabin(s.x, s.z, wood[0], wood[1]); break;
        case 1: bigHouse(s.x, s.z, wood[0], wood[1]); break;
        case 2: farm(s.x, s.z); break;
        case 3: tavern(s.x, s.z); break;
        case 4: library(s.x, s.z); break;
        case 5: blacksmith(s.x, s.z); break;
      }
    }

    // ---- 5) Watchtower at the village outskirts (sits well outside the
    //         building cluster, connected back to the plaza via its own
    //         winding path; no trail since the village's roads link things) ----
    const towerAng = rng.random() * Math.PI * 2;
    const towerX = ox + Math.round(Math.cos(towerAng) * 42);
    const towerZ = oz + Math.round(Math.sin(towerAng) * 42);
    tower(towerX, towerZ, rng, false);
    drawWindingPath(towerX, towerZ, ox, oz, 1, B.gravel, B.cobblestone, roadAvoid);

    // ---- 6) STREETLAMPS along each road every ~8 steps ----
    for (const s of placed) {
      for (let f = 0.25; f <= 0.85; f += 0.3) {
        const lx = Math.round(ox + (s.x - ox) * f);
        const lz = Math.round(oz + (s.z - oz) * f);
        const c = colAt(lx, lz);
        if (c.height > sea && onSurfaceAllowed(c.surfaceId)) {
          lampPost(lx, lz, c.height, B.darkOakLog);
        }
      }
    }
  };

  const cx0 = Math.floor((worldX - STRUCT_MAX_R) / STRUCT_CELL), cx1 = Math.floor((worldX + W + STRUCT_MAX_R) / STRUCT_CELL);
  const cz0 = Math.floor((worldZ - STRUCT_MAX_R) / STRUCT_CELL), cz1 = Math.floor((worldZ + W + STRUCT_MAX_R) / STRUCT_CELL);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const s = structInfo(cx, cz, params.seed);
      if (!s) continue;
      if (s.ox + STRUCT_MAX_R < worldX || s.ox - STRUCT_MAX_R >= worldX + W) continue;   // bbox cull
      if (s.oz + STRUCT_MAX_R < worldZ || s.oz - STRUCT_MAX_R >= worldZ + W) continue;
      const rng = new RNG(s.seed);              // seeded by cell → identical in every overlapping chunk
      const b = colAt(s.ox, s.oz).biome;
      if (!structureFitsBiome(s.kind, b)) continue;
      switch (s.kind) {
        case ST_PYRAMID: pyramid(s.ox, s.oz); break;
        case ST_VILLAGE: village(s.ox, s.oz, rng); break;
        case ST_MANSION: mansion(s.ox, s.oz); break;
        case ST_IGLOO: igloo(s.ox, s.oz); break;
        case ST_TOWER: tower(s.ox, s.oz, rng); break;
        case ST_HOUSE: {
          // tower-on-mountain bias: a high-elevation lone house becomes a tower
          // (no shaft → apron unaffected; only wells carry a sub-surface shaft).
          if (colAt(s.ox, s.oz).height > sea + 42 && rng.random() < 0.8) { tower(s.ox, s.oz, rng); break; }
          const warm = b === BIOME.warmForest;
          // Variation: 35% bigHouse, otherwise cabin — a lone-in-the-woods house.
          if (rng.random() < 0.35) bigHouse(s.ox, s.oz, warm ? B.jungleLog : B.tree, warm ? B.junglePlanks : B.oakPlanks);
          else cabin(s.ox, s.oz, warm ? B.jungleLog : B.tree, warm ? B.junglePlanks : B.oakPlanks);
          break;
        }
        case ST_WELL: well(s.ox, s.oz); break;
        case ST_CAMPSITE: campsite(s.ox, s.oz, rng); break;
        case ST_RUINS: ruins(s.ox, s.oz, rng); break;
        case ST_OUTPOST: outpost(s.ox, s.oz, rng); break;
        case ST_LIGHTHOUSE: lighthouse(s.ox, s.oz); break;
        case ST_WITCH_HUT: witchHut(s.ox, s.oz); break;
      }
    }
  }
}
