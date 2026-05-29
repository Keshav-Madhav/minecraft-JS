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
} as const;

export const LAYER_COUNT = 12;

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
};

// Blocks that should not cast shadows (cheap canopies / sky decoration).
export const NON_SHADOW_CASTER_IDS: ReadonlySet<number> = new Set([BLOCK_IDS.leaves, BLOCK_IDS.cloud]);
