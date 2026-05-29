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
