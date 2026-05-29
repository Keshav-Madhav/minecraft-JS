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
  size: ChunkSize, params: ChunkParams, worldX: number, worldZ: number, resources: ResourceGenInfo[]
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

  generateTerrain(simplex, params, size, worldX, worldZ, set);
  generateResources(rng, size, worldX, worldZ, resources, get, set);

  // Features use a per-chunk RNG for placement (a shared rng repeats the same
  // sequence every chunk → a visible grid), but the shared simplex for the
  // continuous biome/density fields so woods/clearings span chunk borders.
  const treeRng = new RNG(
    (Math.imul(worldX, 73856093) ^ Math.imul(worldZ, 19349663) ^ Math.imul(params.seed, 83492791)) | 0
  );
  generateFeatures(treeRng, simplex, params, size, worldX, worldZ, get, set);

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
} as const;

type SurfCtx = { aboveSea: number, tempEff: number, humid: number, erosion: number, wx: number, wz: number };
type Tint = { sky: number, ground: number, clear: number, bright: number };
// Declarative feature recipe — generateFeatures reads this; no per-biome code.
type FeatureSpec = { oak?: number, cactus?: number, cherry?: number, giantMushroom?: number, swampOak?: number };

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
  name: 'taiga', surface: grassSurf, features: { oak: 0.5 },
  mapColor: [70, 96, 68], tint: { sky: 0xaec6dc, ground: 0x3f4f38, clear: 0x86a2c2, bright: 0.94 },
};
BIOMES[BIOME.plains] = {
  name: 'plains', surface: grassSurf, features: { oak: 0.12 },
  mapColor: [120, 154, 80], tint: { sky: 0xbcd6ff, ground: 0x4d4233, clear: 0x80a0e0, bright: 1.0 },
};
BIOMES[BIOME.forest] = {
  name: 'forest', surface: grassSurf, features: { oak: 0.6 },
  mapColor: [56, 96, 54], tint: { sky: 0xb0cdea, ground: 0x35452a, clear: 0x7796c4, bright: 0.9 },
};
BIOMES[BIOME.savanna] = {
  name: 'savanna', surface: grassSurf, features: { oak: 0.05, cactus: 0.02 },
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
  name: 'desert', surface: sandSurf, features: { cactus: 0.05 },
  mapColor: [214, 203, 146], tint: { sky: 0xffe7c2, ground: 0xb59055, clear: 0xcdc6ac, bright: 1.08 },
};
BIOMES[BIOME.warmForest] = {
  name: 'warmForest', surface: grassSurf, features: { oak: 0.6 },
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
// MIDDLE[tempLevel][humidLevel] → biome id. Cold→snowy/taiga, temperate→plains/
// forest, warm→savanna/forest, hot-dry→desert (overridden by the badlands nest),
// hot-wet→warmForest (our jungle substitute). MC dark-forest/birch/jungle/mangrove
// are folded into forest/warmForest (no palette for distinct wood).
const MIDDLE: number[][] = [
  /*T0 cold */ [_S.snowy,      _S.snowy,      _S.snowy,  _S.taiga,      _S.taiga],
  /*T1      */ [_S.coldPlains, _S.coldPlains, _S.forest, _S.taiga,      _S.taiga],
  /*T2 temp */ [_S.plains,     _S.plains,     _S.forest, _S.forest,     _S.forest],
  /*T3 warm */ [_S.savanna,    _S.savanna,    _S.plains, _S.warmForest, _S.warmForest],
  /*T4 hot  */ [_S.desert,     _S.desert,     _S.desert, _S.desert,     _S.warmForest],
];

// Ocean biome by temperature level (reuses tempLevel — MC types oceans by the
// same temperature field as land). Index 2 (temperate) is the normal `ocean`.
const OCEAN_BY_LEVEL = [BIOME.frozenOcean, BIOME.coldOcean, BIOME.ocean, BIOME.lukewarmOcean, BIOME.warmOcean];

function selectClimate(temp: number, humid: number, weird: number): number {
  const tl = tempLevel(temp), hl = humidLevel(humid);
  let id = MIDDLE[tl][hl];
  // Weirdness-sign variants where MC's grid differs by it.
  if ((tl === 2 || tl === 3) && hl === 2) id = weird < 0 ? _S.forest : _S.plains;
  if (tl === 4 && hl === 3) id = weird < 0 ? _S.desert : _S.warmForest;
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
};
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
    case BLOCK_IDS.dirt: return [120, 100, 78];
    default: return GRASS_TINT[biome] ?? [120, 154, 80]; // grass
  }
}

export type ColumnSurface = {
  height: number, surfaceId: number, subId: number, biome: number,
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
  const rA = fbm(simplex, wx + 1300, wz + 1300, fs * 2.2, 3);    // big primary ridgelines (~570b)
  const rB = fbm(simplex, wx + 4300, wz + 2300, fs * 1.3, 2);    // coarse secondary ridges
  let ridge = Math.pow(1 - Math.abs(rA), 3) * 0.85 + Math.pow(1 - Math.abs(rB), 3) * 0.15;
  ridge = Math.max(0, ridge - 0.12);                            // flat between ridgelines
  const relief = ridge * mountainAmp * land * (mountainous * mountainous);
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
  // ... then the narrow channel still carves the floor to sea-2 (continuous water).
  const riverMem = channelBand * rgate;
  if (riverMem > 0) height += riverMem * ((sea - 2) - height);    // from the post-valley floor

  // LAKES — rare lowland basins carved to sea-3 so the plane floods them. Confined
  // to flat near-sea land (not ocean, not hillside → no dry above-sea pit).
  const lakeN = fbm(simplex, wx + 64500, wz + 64500, fs * 6, 3);
  const lakeBasin = sm(lakeN, 0.62, 0.74);                        // rare: only the field's high tail
  const lakeLowland = sm(baseH, sea + 1, sea + 8) * (1 - sm(baseH, sea + 16, sea + 30));
  const lakeMem = lakeBasin * lakeLowland * (1 - badlandsMem) * (1 - riverMem);
  if (lakeMem > 0) height += lakeMem * ((sea - 3) - baseH);

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

  // --- biome selection: specials (by gate, priority order) → water bands → grid ---
  // The badlands shells (core → red-desert → desert) are checked before the grid
  // so the nest is guaranteed concentric. The climate grid uses RAW temp (MC
  // places biomes on the horizontal field; elevation cooling is a surface concern
  // via the snow/rock overlay below, not a biome reassignment).
  let biome: number;
  if (islandMem > 0.3 && aboveSea > -10) biome = BIOME.mushroom;
  else if (swampMem > 0.5) biome = BIOME.swamp;
  // Badlands shells only ABOVE sea — so a river/coast that carved one of these
  // columns below sea reads as water, not red sand bleeding into the river/ocean.
  else if (badlandsMem > 0.5 && aboveSea > 0) biome = BIOME.badlands;
  else if (redDesertMem > 0.5 && aboveSea > 0) biome = BIOME.redDesert;
  else if (desertRing > 0.5 && aboveSea > 0) biome = BIOME.desert;  // outer sand ring around the mesa
  else if (cherryMem > 0.5) biome = BIOME.cherry;
  else if (riverMem > 0.55 && aboveSea <= 1)            // carved river channel
    biome = tempEff < -0.46 ? BIOME.frozenRiver : BIOME.river;
  else if (lakeMem > 0.5 && aboveSea <= 0) biome = BIOME.lake;
  else if (height < sea) biome = OCEAN_BY_LEVEL[tempLevel(c.temp)]; // temperature-typed ocean
  else if (aboveSea <= 3) biome = BIOME.beach;
  else {
    // Dither temp/humid (grid bucketing only — the gates above keep raw smooth
    // values) so biome borders stipple/interleave instead of being a clean line.
    const dT = (hash01(wx, wz) - 0.5) * BORDER_DITHER * flatness;
    const dH = (hash01(wx + 99991, wz + 57331) - 0.5) * BORDER_DITHER * flatness;
    biome = selectClimate(c.temp + dT, c.humid + dH, c.weird);
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
    || biome === BIOME.mushroom || biome === BIOME.swamp;
  if (!coloured && biome !== BIOME.ocean && biome !== BIOME.beach) {
    if (aboveSea > 48) { surfaceId = BLOCK_IDS.stone; subId = BLOCK_IDS.stone; }   // exposed rock
    if (aboveSea > 66 || tempEff < -0.46) surfaceId = BLOCK_IDS.snow;             // alpine / frozen cap
  }

  return { height, surfaceId, subId, biome };
}

export function createWorldSampler(params: ChunkParams, size: ChunkSize): WorldSampler {
  const simplex = new SimplexNoise(new RNG(params.seed));
  const cfg = makeSurfaceConfig(params, size);
  return (wx, wz) => columnSurface(simplex, cfg, wx, wz);
}

// ===========================================================================
//  RESOURCES (ore) — unchanged: coarse-grid noise gated on stone.
// ===========================================================================
const ORE_STEP = 2;
function generateResources(rng: RNG, size: ChunkSize, worldX: number, worldZ: number, resources: ResourceGenInfo[], get: GetFn, set: SetFn) {
  resources.forEach(resource => {
    const simplex = new SimplexNoise(rng);
    for (let x = 0; x < size.width; x += ORE_STEP)
      for (let z = 0; z < size.width; z += ORE_STEP)
        for (let y = 0; y < size.height; y += ORE_STEP) {
          if (get(x, y, z) !== BLOCK_IDS.stone) continue;
          const val = simplex.noise3d((worldX + x) / resource.scale.x, y / resource.scale.y, (worldZ + z) / resource.scale.z);
          if (val > resource.scarcity) {
            for (let dx = 0; dx < ORE_STEP; dx++)
              for (let dy = 0; dy < ORE_STEP; dy++)
                for (let dz = 0; dz < ORE_STEP; dz++)
                  if (get(x + dx, y + dy, z + dz) === BLOCK_IDS.stone) set(x + dx, y + dy, z + dz, resource.id);
          }
        }
  });
}

// ===========================================================================
//  TERRAIN  — fill each column; badlands columns use their per-Y band override.
// ===========================================================================
function generateTerrain(simplex: SimplexNoise, params: ChunkParams, size: ChunkSize, worldX: number, worldZ: number, set: SetFn) {
  const cfg = makeSurfaceConfig(params, size);
  for (let x = 0; x < size.width; x++) {
    for (let z = 0; z < size.width; z++) {
      const { height, surfaceId, subId, biome } = columnSurface(simplex, cfg, worldX + x, worldZ + z);
      const band = BIOMES[biome].band;
      for (let y = 0; y <= height; y++) {
        if (band) set(x, y, z, band(y, height, cfg.sea));
        else if (y === height) set(x, y, z, surfaceId);
        else if (y > height - 4) set(x, y, z, subId);
        else set(x, y, z, BLOCK_IDS.stone);
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

function generateFeatures(rng: RNG, simplex: SimplexNoise, params: ChunkParams, size: ChunkSize, worldX: number, worldZ: number, get: GetFn, set: SetFn) {
  const surfaceYOf = (x: number, z: number, roots: readonly number[]): number => {
    for (let y = size.height - 1; y >= 0; y--) {
      const id = get(x, y, z);
      if (id !== BLOCK_IDS.air && roots.includes(id)) return y;
    }
    return -1;
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
    minH: number, maxH: number, minR: number, maxR: number, density: number) => {
    const y0 = surfaceYOf(x, z, roots);
    if (y0 < 0) return;
    const h = Math.round(minH + (maxH - minH) * rng.random());
    for (let ty = y0 + 1; ty <= y0 + h; ty++) set(x, ty, z, logId);
    buildCanopy(x, y0 + h, z, Math.round(minR + (maxR - minR) * rng.random()), density, leafId);
  };
  const buildCactus = (x: number, z: number) => {
    const y0 = surfaceYOf(x, z, SANDY_ROOT);
    if (y0 < 0) return;
    const h = 2 + Math.floor(rng.random() * 3);
    for (let i = 1; i <= h; i++) { if (get(x, y0 + i, z) !== BLOCK_IDS.air) break; set(x, y0 + i, z, BLOCK_IDS.cactus); }
  };
  const buildGiantMushroom = (x: number, z: number) => {
    const y0 = surfaceYOf(x, z, MYC_ROOT);
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
  const oak = (x: number, z: number, roots: readonly number[], density = 0.7) =>
    buildTree(x, z, roots, BLOCK_IDS.tree, BLOCK_IDS.leaves,
      params.trees.trunk.minHeight, params.trees.trunk.maxHeight,
      params.trees.canopy.minRadius, params.trees.canopy.maxRadius, density);

  const cfg = makeSurfaceConfig(params, size);
  const CELL = 6;
  for (let gx = 0; gx < size.width; gx += CELL) {
    for (let gz = 0; gz < size.width; gz += CELL) {
      const x = gx + Math.floor(rng.random() * CELL);
      const z = gz + Math.floor(rng.random() * CELL);
      if (x < 1 || x >= size.width - 1 || z < 1 || z >= size.width - 1) continue;

      const { biome } = columnSurface(simplex, cfg, worldX + x, worldZ + z);
      const f = BIOMES[biome].features;
      if (!f) continue;
      const r = rng.random();
      if (f.cherry && r < f.cherry) buildTree(x, z, GRASS_ROOT, BLOCK_IDS.cherryLog, BLOCK_IDS.cherryLeaves, 4, 6, 2, 3, 0.72);
      else if (f.giantMushroom && r < f.giantMushroom) buildGiantMushroom(x, z);
      else if (f.swampOak && r < f.swampOak) oak(x, z, SWAMP_ROOT, 0.65);
      else if (f.oak && r < f.oak) oak(x, z, GRASS_ROOT, params.trees.canopy.density);
      else if (f.cactus && r < f.cactus) buildCactus(x, z);
    }
  }
}
