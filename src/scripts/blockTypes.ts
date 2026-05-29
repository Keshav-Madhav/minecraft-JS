// THREE-free block metadata. Kept separate from blocks.ts (which builds
// THREE.Material objects and loads textures) so this module can be imported by
// the chunk-generation Web Worker, where `document`/`Image` are unavailable.

export const BLOCK_IDS = {
  air: 0,
  grass: 1,
  dirt: 2,
  stone: 3,
  coalOre: 4,
  ironOre: 5,
  tree: 6,
  leaves: 7,
  sand: 8,
  cloud: 9,
  snow: 10,
  // --- biome expansion ---
  cherryLog: 11,
  cherryLeaves: 12,
  mycelium: 13,
  redSand: 14,
  terracottaOrange: 15,
  terracottaWhite: 16,
  terracottaYellow: 17,
  terracottaRed: 18,
  terracottaBrown: 19,
  terracottaLightGray: 20,
  mud: 21,
  cactus: 22,
  mushroomRed: 23,   // red cap block
  mushroomBrown: 24, // brown cap block
  mushroomStem: 25,
  // --- foliage (cross-billboard / carpet / vine plants; NOT cube-meshed) ---
  shortGrass: 26,
  fern: 27,
  tallGrassLower: 28,  // 2-block tall grass: lower cell
  tallGrassUpper: 29,  // 2-block tall grass: upper cell
  deadBush: 30,
  flowerDandelion: 31,
  flowerPoppy: 32,
  flowerCornflower: 33,
  flowerOxeye: 34,
  flowerAllium: 35,
  flowerTulip: 36,
  lilyPad: 37,         // flat pad on a water surface
  cherryPetals: 38,    // pink petal carpet
  leafLitter: 39,      // dried-leaf carpet
  snowLayer: 40,       // thin snow sheet
  vine: 41,            // hangs on solid faces (trunks / cliffs)
  seagrass: 42,        // underwater grass on the seabed
  tallSeagrassLower: 43,
  tallSeagrassUpper: 44,
  largeFernLower: 45,  // 2-block fern: lower cell
  largeFernUpper: 46,  // 2-block fern: upper cell
} as const;

// Settings used by procedural resource (ore) generation. Plain data so it can
// be structured-cloned through postMessage.
export type ResourceGenInfo = {
  id: number,
  scale: { x: number, y: number, z: number },
  scarcity: number,
};

// Texture-array layer index per distinct block-face texture. Shared by the
// (DOM-using) material builder and the (pure) mesher, so it lives here.
export const TEXTURE_LAYER = {
  dirt: 0,
  grassTop: 1,
  grassSide: 2,
  stone: 3,
  coal: 4,
  iron: 5,
  sand: 6,
  treeSide: 7,
  treeTop: 8,
  leaves: 9,
  snow: 10,
  white: 11,
  // --- biome expansion (textures live in public/textures/biomes) ---
  cherryLogSide: 12,
  cherryLogTop: 13,
  cherryLeaves: 14,
  myceliumTop: 15,
  myceliumSide: 16,
  redSand: 17,
  terracottaOrange: 18,
  terracottaWhite: 19,
  terracottaYellow: 20,
  terracottaRed: 21,
  terracottaBrown: 22,
  terracottaLightGray: 23,
  mud: 24,
  cactusTop: 25,
  cactusBottom: 26,
  cactusSide: 27,
  mushroomRed: 28,
  mushroomBrown: 29,
  mushroomStem: 30,
  mushroomPores: 31,
  // --- foliage textures (public/textures/foliage); grass/fern/vine/tall-grass
  //     are near-grayscale and tinted per-biome at render time (see plant material) ---
  shortGrass: 32,
  fern: 33,
  tallGrassBottom: 34,
  tallGrassTop: 35,
  vine: 36,
  deadBush: 37,
  lilyPad: 38,
  cherryPetals: 39,
  leafLitter: 40,
  flowerDandelion: 41,
  flowerPoppy: 42,
  flowerCornflower: 43,
  flowerOxeye: 44,
  flowerAllium: 45,
  flowerTulip: 46,
  seaGrass: 47,
  tallSeagrassBottom: 48,
  tallSeagrassTop: 49,
  largeFernBottom: 50,
  largeFernTop: 51,
} as const;

// Derived so it can never drift out of sync when a layer is added.
export const LAYER_COUNT = Math.max(...Object.values(TEXTURE_LAYER)) + 1;

const T = TEXTURE_LAYER;
// Per-block, per-face texture layer. Face order: [+x, -x, +y, -y, +z, -z].
export const BLOCK_FACE_LAYERS: { [id: number]: readonly number[] } = {
  [BLOCK_IDS.grass]: [T.grassSide, T.grassSide, T.grassTop, T.dirt, T.grassSide, T.grassSide],
  [BLOCK_IDS.dirt]: [T.dirt, T.dirt, T.dirt, T.dirt, T.dirt, T.dirt],
  [BLOCK_IDS.stone]: [T.stone, T.stone, T.stone, T.stone, T.stone, T.stone],
  [BLOCK_IDS.coalOre]: [T.coal, T.coal, T.coal, T.coal, T.coal, T.coal],
  [BLOCK_IDS.ironOre]: [T.iron, T.iron, T.iron, T.iron, T.iron, T.iron],
  [BLOCK_IDS.tree]: [T.treeSide, T.treeSide, T.treeTop, T.treeTop, T.treeSide, T.treeSide],
  [BLOCK_IDS.leaves]: [T.leaves, T.leaves, T.leaves, T.leaves, T.leaves, T.leaves],
  [BLOCK_IDS.sand]: [T.sand, T.sand, T.sand, T.sand, T.sand, T.sand],
  [BLOCK_IDS.cloud]: [T.white, T.white, T.white, T.white, T.white, T.white],
  [BLOCK_IDS.snow]: [T.snow, T.snow, T.snow, T.snow, T.snow, T.snow],
  // --- biome expansion ---
  [BLOCK_IDS.cherryLog]: [T.cherryLogSide, T.cherryLogSide, T.cherryLogTop, T.cherryLogTop, T.cherryLogSide, T.cherryLogSide],
  [BLOCK_IDS.cherryLeaves]: [T.cherryLeaves, T.cherryLeaves, T.cherryLeaves, T.cherryLeaves, T.cherryLeaves, T.cherryLeaves],
  [BLOCK_IDS.mycelium]: [T.myceliumSide, T.myceliumSide, T.myceliumTop, T.dirt, T.myceliumSide, T.myceliumSide],
  [BLOCK_IDS.redSand]: [T.redSand, T.redSand, T.redSand, T.redSand, T.redSand, T.redSand],
  [BLOCK_IDS.terracottaOrange]: [T.terracottaOrange, T.terracottaOrange, T.terracottaOrange, T.terracottaOrange, T.terracottaOrange, T.terracottaOrange],
  [BLOCK_IDS.terracottaWhite]: [T.terracottaWhite, T.terracottaWhite, T.terracottaWhite, T.terracottaWhite, T.terracottaWhite, T.terracottaWhite],
  [BLOCK_IDS.terracottaYellow]: [T.terracottaYellow, T.terracottaYellow, T.terracottaYellow, T.terracottaYellow, T.terracottaYellow, T.terracottaYellow],
  [BLOCK_IDS.terracottaRed]: [T.terracottaRed, T.terracottaRed, T.terracottaRed, T.terracottaRed, T.terracottaRed, T.terracottaRed],
  [BLOCK_IDS.terracottaBrown]: [T.terracottaBrown, T.terracottaBrown, T.terracottaBrown, T.terracottaBrown, T.terracottaBrown, T.terracottaBrown],
  [BLOCK_IDS.terracottaLightGray]: [T.terracottaLightGray, T.terracottaLightGray, T.terracottaLightGray, T.terracottaLightGray, T.terracottaLightGray, T.terracottaLightGray],
  [BLOCK_IDS.mud]: [T.mud, T.mud, T.mud, T.mud, T.mud, T.mud],
  [BLOCK_IDS.cactus]: [T.cactusSide, T.cactusSide, T.cactusTop, T.cactusBottom, T.cactusSide, T.cactusSide],
  [BLOCK_IDS.mushroomRed]: [T.mushroomRed, T.mushroomRed, T.mushroomRed, T.mushroomPores, T.mushroomRed, T.mushroomRed],
  [BLOCK_IDS.mushroomBrown]: [T.mushroomBrown, T.mushroomBrown, T.mushroomBrown, T.mushroomPores, T.mushroomBrown, T.mushroomBrown],
  [BLOCK_IDS.mushroomStem]: [T.mushroomStem, T.mushroomStem, T.mushroomPores, T.mushroomPores, T.mushroomStem, T.mushroomStem],
};

// Blocks that should not cast shadows (cheap canopies / sky decoration). Cherry
// leaves join the leaf/canopy group so they mesh into the same buffer as leaves.
export const NON_SHADOW_CASTER_IDS: ReadonlySet<number> = new Set([BLOCK_IDS.leaves, BLOCK_IDS.cloud, BLOCK_IDS.cherryLeaves]);

// ===========================================================================
//  FOLIAGE / PLANTS  — cross-billboard, carpet, pad and vine blocks. These are
//  NOT cube-meshed: the greedy cube mesher skips them and treats them as
//  non-occluding air (so the block they sit on keeps its faces), and a separate
//  plant pass emits their geometry into a third "plants" group. Physics ignores
//  them (non-colliding). All metadata is pure data so the worker can consume it.
// ===========================================================================
export type PlantKind =
  | 'cross'   // two perpendicular X quads, fills the cell vertically (grass, flowers, fern, dead bush)
  | 'carpet'  // one flat quad just above the floor, greedy-merged into sheets (petals, litter, snow)
  | 'pad'     // one flat quad, NOT merged (lily pad — keeps its disc shape)
  | 'vine';   // vertical quads flush against adjacent solid faces (hangs on trunks/cliffs)

// tint: 'grass' multiplies the (near-grayscale) texture by the column's per-biome
// GRASS_TINT at mesh-build time (MC-style); 'none' renders the texture as-authored.
// off: height of a carpet/pad quad above the block's bottom face (cell units).
export type PlantDef = { layer: number, kind: PlantKind, tint: 'grass' | 'none', off: number };

const PT = TEXTURE_LAYER;
export const PLANTS: { readonly [id: number]: PlantDef } = {
  [BLOCK_IDS.shortGrass]:      { layer: PT.shortGrass,      kind: 'cross',  tint: 'grass', off: 0 },
  [BLOCK_IDS.fern]:            { layer: PT.fern,            kind: 'cross',  tint: 'grass', off: 0 },
  [BLOCK_IDS.tallGrassLower]:  { layer: PT.tallGrassBottom, kind: 'cross',  tint: 'grass', off: 0 },
  [BLOCK_IDS.tallGrassUpper]:  { layer: PT.tallGrassTop,    kind: 'cross',  tint: 'grass', off: 0 },
  [BLOCK_IDS.deadBush]:        { layer: PT.deadBush,        kind: 'cross',  tint: 'none',  off: 0 },
  [BLOCK_IDS.flowerDandelion]: { layer: PT.flowerDandelion, kind: 'cross',  tint: 'none',  off: 0 },
  [BLOCK_IDS.flowerPoppy]:     { layer: PT.flowerPoppy,     kind: 'cross',  tint: 'none',  off: 0 },
  [BLOCK_IDS.flowerCornflower]:{ layer: PT.flowerCornflower,kind: 'cross',  tint: 'none',  off: 0 },
  [BLOCK_IDS.flowerOxeye]:     { layer: PT.flowerOxeye,     kind: 'cross',  tint: 'none',  off: 0 },
  [BLOCK_IDS.flowerAllium]:    { layer: PT.flowerAllium,    kind: 'cross',  tint: 'none',  off: 0 },
  [BLOCK_IDS.flowerTulip]:     { layer: PT.flowerTulip,     kind: 'cross',  tint: 'none',  off: 0 },
  // lilyPad sits in the sea-level cell; off ~0.98 lifts its quad to the water
  // plane (waterOffset+0.45) so it floats on the surface rather than the seabed.
  [BLOCK_IDS.lilyPad]:         { layer: PT.lilyPad,         kind: 'pad',    tint: 'none',  off: 0.98 },
  [BLOCK_IDS.cherryPetals]:    { layer: PT.cherryPetals,    kind: 'carpet', tint: 'none',  off: 0.0625 },
  [BLOCK_IDS.leafLitter]:      { layer: PT.leafLitter,      kind: 'carpet', tint: 'none',  off: 0.0625 },
  [BLOCK_IDS.snowLayer]:       { layer: PT.snow,            kind: 'carpet', tint: 'none',  off: 0.125 },
  [BLOCK_IDS.vine]:            { layer: PT.vine,            kind: 'vine',   tint: 'grass', off: 0 },
  [BLOCK_IDS.seagrass]:        { layer: PT.seaGrass,        kind: 'cross',  tint: 'none',  off: 0 },
  [BLOCK_IDS.tallSeagrassLower]:{ layer: PT.tallSeagrassBottom, kind: 'cross', tint: 'none', off: 0 },
  [BLOCK_IDS.tallSeagrassUpper]:{ layer: PT.tallSeagrassTop, kind: 'cross',  tint: 'none',  off: 0 },
  [BLOCK_IDS.largeFernLower]:  { layer: PT.largeFernBottom, kind: 'cross',  tint: 'grass', off: 0 },
  [BLOCK_IDS.largeFernUpper]:  { layer: PT.largeFernTop,    kind: 'cross',  tint: 'grass', off: 0 },
};

// O(1) "is this id a plant?" for the mesher's hot loops & physics broadphase —
// indexed by block id (all ids < 256), avoids a Set.has per cell.
export const PLANT_LOOKUP = new Uint8Array(256);
for (const k of Object.keys(PLANTS)) PLANT_LOOKUP[Number(k)] = 1;
export const isPlant = (id: number): boolean => PLANT_LOOKUP[id] === 1;
