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
  // --- ice / snow expansion (solid cube blocks) ---
  ice: 47,             // frozen water surface (slippery)
  packedIce: 48,       // ice-spike material (slippery)
  podzol: 49,          // taiga forest floor
  // --- more foliage (plants) ---
  smallMushroomRed: 50,
  smallMushroomBrown: 51,
  sugarCane: 52,
  flowerBlueOrchid: 53,
  // --- building blocks + wood variants + clay/gravel/sandstone/glass ---
  cobblestone: 54,
  oakPlanks: 55,
  birchLog: 56,
  birchLeaves: 57,
  darkOakLog: 58,
  darkOakLeaves: 59,
  jungleLog: 60,
  jungleLeaves: 61,
  birchPlanks: 62,
  darkOakPlanks: 63,
  junglePlanks: 64,
  strippedOakLog: 65,
  gravel: 66,
  clay: 67,
  sandstone: 68,
  glass: 69,          // see-through cutout cube (collides, rendered alpha-tested)
  // --- shaped blocks (partial collision + geometry) ---
  oakSlab: 70, cobbleSlab: 71, stoneSlab: 72, sandstoneSlab: 73,
  // stairs: 4 facings each (PX=tall-back-on-+x, NX, PZ, NZ)
  oakStairsPX: 74, oakStairsNX: 75, oakStairsPZ: 76, oakStairsNZ: 77,
  cobbleStairsPX: 78, cobbleStairsNX: 79, cobbleStairsPZ: 80, cobbleStairsNZ: 81,
  stoneStairsPX: 82, stoneStairsNX: 83, stoneStairsPZ: 84, stoneStairsNZ: 85,
  sandstoneStairsPX: 86, sandstoneStairsNX: 87, sandstoneStairsPZ: 88, sandstoneStairsNZ: 89,
  oakFence: 90, cobbleFence: 91,
  // openable door (2-tall) + trapdoor — closed/open are distinct ids (no per-block state)
  oakDoorLowerClosed: 92, oakDoorUpperClosed: 93, oakDoorLowerOpen: 94, oakDoorUpperOpen: 95,
  oakTrapdoorClosed: 96, oakTrapdoorOpen: 97,
  // --- decorative full cubes (fill out the world) ---
  stoneBricks: 98, bricks: 99, mossyCobblestone: 100, smoothStone: 101, bookshelf: 102, glowstone: 103,
  // --- expansion: geology / decorative / ores / mineral blocks / wood / wool ---
  andesite: 104, diorite: 105, granite: 106, polishedAndesite: 107, polishedDiorite: 108, polishedGranite: 109,
  deepslate: 110, tuff: 111, calcite: 112, basalt: 113, blackstone: 114, netherrack: 115, endStone: 116,
  obsidian: 117, magma: 118, quartzBlock: 119, quartzPillar: 120, netherBricks: 121,
  prismarine: 122, prismarineBricks: 123, seaLantern: 124,
  crackedStoneBricks: 125, chiseledStoneBricks: 126, mossyStoneBricks: 127,
  cutSandstone: 128, smoothSandstone: 129, chiseledSandstone: 130, redSandstone: 131, cutRedSandstone: 132,
  goldOre: 133, diamondOre: 134, emeraldOre: 135, lapisOre: 136, redstoneOre: 137, copperOre: 138,
  goldBlock: 139, diamondBlock: 140, emeraldBlock: 141, ironBlock: 142, lapisBlock: 143, redstoneBlock: 144, copperBlock: 145, coalBlock: 146,
  acaciaPlanks: 147, sprucePlanks: 148, mangrovePlanks: 149, cherryPlanks: 150,
  acaciaLog: 151, spruceLog: 152, mangroveLog: 153,
  acaciaLeaves: 154, spruceLeaves: 155, mangroveLeaves: 156,
  hayBale: 157,
  woolWhite: 158, woolOrange: 159, woolMagenta: 160, woolLightBlue: 161, woolYellow: 162, woolLime: 163,
  woolPink: 164, woolGray: 165, woolLightGray: 166, woolCyan: 167, woolPurple: 168, woolBlue: 169,
  woolBrown: 170, woolGreen: 171, woolRed: 172, woolBlack: 173,
  // --- light-emitting blocks ---
  lantern: 174, torch: 175, campfire: 176, jackOLantern: 177,
} as const;

// Settings used by procedural resource (ore) generation. Plain data so it can
// be structured-cloned through postMessage.
export type ResourceGenInfo = {
  id: number,
  scale: { x: number, y: number, z: number },
  scarcity: number,
  minY?: number,   // optional depth window — only sweep this Y range (cheaper + lets
  maxY?: number,   // ores/variants layer by depth: diamond deep, copper shallow, …)
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
  ice: 52,
  packedIce: 53,
  podzolTop: 54,
  podzolSide: 55,
  mushroomRedSmall: 56,
  mushroomBrownSmall: 57,
  sugarCane: 58,
  flowerBlueOrchid: 59,
  cobblestone: 60,
  oakPlanks: 61,
  birchPlanks: 62,
  darkOakPlanks: 63,
  junglePlanks: 64,
  strippedOakLogSide: 65,
  birchLogSide: 66,
  birchLogTop: 67,
  darkOakLogSide: 68,
  darkOakLogTop: 69,
  jungleLogSide: 70,
  jungleLogTop: 71,
  birchLeaves: 72,
  darkOakLeaves: 73,
  jungleLeaves: 74,
  gravel: 75,
  clay: 76,
  sandstone: 77,
  sandstoneTop: 78,
  glass: 79,
  stoneBricks: 80,
  bricks: 81,
  mossyCobblestone: 82,
  smoothStone: 83,
  bookshelf: 84,
  glowstone: 85,
  oakDoor: 86,
  oakTrapdoor: 87,
  // --- expansion set (textures in public/textures/biomes) ---
  andesite: 88, diorite: 89, granite: 90, polishedAndesite: 91, polishedDiorite: 92, polishedGranite: 93,
  deepslate: 94, tuff: 95, calcite: 96, basalt: 97, blackstone: 98, netherrack: 99, endStone: 100,
  obsidian: 101, magma: 102, quartzBlock: 103, quartzPillarSide: 104, quartzPillarTop: 105, netherBricks: 106,
  prismarine: 107, prismarineBricks: 108, seaLantern: 109,
  crackedStoneBricks: 110, chiseledStoneBricks: 111, mossyStoneBricks: 112,
  cutSandstone: 113, smoothSandstone: 114, chiseledSandstone: 115, redSandstoneSide: 116, redSandstoneTop: 117, cutRedSandstone: 118,
  goldOre: 119, diamondOre: 120, emeraldOre: 121, lapisOre: 122, redstoneOre: 123, copperOre: 124,
  goldBlock: 125, diamondBlock: 126, emeraldBlock: 127, ironBlock: 128, lapisBlock: 129, redstoneBlock: 130, copperBlock: 131, coalBlock: 132,
  acaciaPlanks: 133, sprucePlanks: 134, mangrovePlanks: 135, cherryPlanks: 136,
  acaciaLogSide: 137, acaciaLogTop: 138, spruceLogSide: 139, spruceLogTop: 140, mangroveLogSide: 141, mangroveLogTop: 142,
  acaciaLeaves: 143, spruceLeaves: 144, mangroveLeaves: 145,
  hayBaleSide: 146, hayBaleTop: 147,
  woolWhite: 148, woolOrange: 149, woolMagenta: 150, woolLightBlue: 151, woolYellow: 152, woolLime: 153,
  woolPink: 154, woolGray: 155, woolLightGray: 156, woolCyan: 157, woolPurple: 158, woolBlue: 159,
  woolBrown: 160, woolGreen: 161, woolRed: 162, woolBlack: 163,
  // --- light-emitting blocks ---
  lantern: 164, torch: 165, campfireTop: 166, campfireSide: 167, jackLanternSide: 168, jackLanternTop: 169,
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
  [BLOCK_IDS.ice]: [T.ice, T.ice, T.ice, T.ice, T.ice, T.ice],
  [BLOCK_IDS.packedIce]: [T.packedIce, T.packedIce, T.packedIce, T.packedIce, T.packedIce, T.packedIce],
  [BLOCK_IDS.podzol]: [T.podzolSide, T.podzolSide, T.podzolTop, T.dirt, T.podzolSide, T.podzolSide],
  [BLOCK_IDS.cobblestone]: [T.cobblestone, T.cobblestone, T.cobblestone, T.cobblestone, T.cobblestone, T.cobblestone],
  [BLOCK_IDS.oakPlanks]: [T.oakPlanks, T.oakPlanks, T.oakPlanks, T.oakPlanks, T.oakPlanks, T.oakPlanks],
  [BLOCK_IDS.birchPlanks]: [T.birchPlanks, T.birchPlanks, T.birchPlanks, T.birchPlanks, T.birchPlanks, T.birchPlanks],
  [BLOCK_IDS.darkOakPlanks]: [T.darkOakPlanks, T.darkOakPlanks, T.darkOakPlanks, T.darkOakPlanks, T.darkOakPlanks, T.darkOakPlanks],
  [BLOCK_IDS.junglePlanks]: [T.junglePlanks, T.junglePlanks, T.junglePlanks, T.junglePlanks, T.junglePlanks, T.junglePlanks],
  [BLOCK_IDS.strippedOakLog]: [T.strippedOakLogSide, T.strippedOakLogSide, T.treeTop, T.treeTop, T.strippedOakLogSide, T.strippedOakLogSide],
  [BLOCK_IDS.birchLog]: [T.birchLogSide, T.birchLogSide, T.birchLogTop, T.birchLogTop, T.birchLogSide, T.birchLogSide],
  [BLOCK_IDS.darkOakLog]: [T.darkOakLogSide, T.darkOakLogSide, T.darkOakLogTop, T.darkOakLogTop, T.darkOakLogSide, T.darkOakLogSide],
  [BLOCK_IDS.jungleLog]: [T.jungleLogSide, T.jungleLogSide, T.jungleLogTop, T.jungleLogTop, T.jungleLogSide, T.jungleLogSide],
  [BLOCK_IDS.birchLeaves]: [T.birchLeaves, T.birchLeaves, T.birchLeaves, T.birchLeaves, T.birchLeaves, T.birchLeaves],
  [BLOCK_IDS.darkOakLeaves]: [T.darkOakLeaves, T.darkOakLeaves, T.darkOakLeaves, T.darkOakLeaves, T.darkOakLeaves, T.darkOakLeaves],
  [BLOCK_IDS.jungleLeaves]: [T.jungleLeaves, T.jungleLeaves, T.jungleLeaves, T.jungleLeaves, T.jungleLeaves, T.jungleLeaves],
  [BLOCK_IDS.gravel]: [T.gravel, T.gravel, T.gravel, T.gravel, T.gravel, T.gravel],
  [BLOCK_IDS.clay]: [T.clay, T.clay, T.clay, T.clay, T.clay, T.clay],
  [BLOCK_IDS.sandstone]: [T.sandstone, T.sandstone, T.sandstoneTop, T.sandstoneTop, T.sandstone, T.sandstone],
  [BLOCK_IDS.glass]: [T.glass, T.glass, T.glass, T.glass, T.glass, T.glass],
  [BLOCK_IDS.stoneBricks]: [T.stoneBricks, T.stoneBricks, T.stoneBricks, T.stoneBricks, T.stoneBricks, T.stoneBricks],
  [BLOCK_IDS.bricks]: [T.bricks, T.bricks, T.bricks, T.bricks, T.bricks, T.bricks],
  [BLOCK_IDS.mossyCobblestone]: [T.mossyCobblestone, T.mossyCobblestone, T.mossyCobblestone, T.mossyCobblestone, T.mossyCobblestone, T.mossyCobblestone],
  [BLOCK_IDS.smoothStone]: [T.smoothStone, T.smoothStone, T.smoothStone, T.smoothStone, T.smoothStone, T.smoothStone],
  [BLOCK_IDS.bookshelf]: [T.bookshelf, T.bookshelf, T.oakPlanks, T.oakPlanks, T.bookshelf, T.bookshelf],
  [BLOCK_IDS.glowstone]: [T.glowstone, T.glowstone, T.glowstone, T.glowstone, T.glowstone, T.glowstone],
};

// Expansion set: uniform single-texture cubes (all six faces identical).
for (const [id, layer] of [
  [BLOCK_IDS.andesite, T.andesite], [BLOCK_IDS.diorite, T.diorite], [BLOCK_IDS.granite, T.granite],
  [BLOCK_IDS.polishedAndesite, T.polishedAndesite], [BLOCK_IDS.polishedDiorite, T.polishedDiorite], [BLOCK_IDS.polishedGranite, T.polishedGranite],
  [BLOCK_IDS.deepslate, T.deepslate], [BLOCK_IDS.tuff, T.tuff], [BLOCK_IDS.calcite, T.calcite],
  [BLOCK_IDS.basalt, T.basalt], [BLOCK_IDS.blackstone, T.blackstone], [BLOCK_IDS.netherrack, T.netherrack],
  [BLOCK_IDS.endStone, T.endStone], [BLOCK_IDS.obsidian, T.obsidian], [BLOCK_IDS.magma, T.magma],
  [BLOCK_IDS.quartzBlock, T.quartzBlock], [BLOCK_IDS.netherBricks, T.netherBricks],
  [BLOCK_IDS.prismarine, T.prismarine], [BLOCK_IDS.prismarineBricks, T.prismarineBricks], [BLOCK_IDS.seaLantern, T.seaLantern],
  [BLOCK_IDS.crackedStoneBricks, T.crackedStoneBricks], [BLOCK_IDS.chiseledStoneBricks, T.chiseledStoneBricks], [BLOCK_IDS.mossyStoneBricks, T.mossyStoneBricks],
  [BLOCK_IDS.cutSandstone, T.cutSandstone], [BLOCK_IDS.smoothSandstone, T.smoothSandstone], [BLOCK_IDS.chiseledSandstone, T.chiseledSandstone], [BLOCK_IDS.cutRedSandstone, T.cutRedSandstone],
  [BLOCK_IDS.goldOre, T.goldOre], [BLOCK_IDS.diamondOre, T.diamondOre], [BLOCK_IDS.emeraldOre, T.emeraldOre],
  [BLOCK_IDS.lapisOre, T.lapisOre], [BLOCK_IDS.redstoneOre, T.redstoneOre], [BLOCK_IDS.copperOre, T.copperOre],
  [BLOCK_IDS.goldBlock, T.goldBlock], [BLOCK_IDS.diamondBlock, T.diamondBlock], [BLOCK_IDS.emeraldBlock, T.emeraldBlock],
  [BLOCK_IDS.ironBlock, T.ironBlock], [BLOCK_IDS.lapisBlock, T.lapisBlock], [BLOCK_IDS.redstoneBlock, T.redstoneBlock],
  [BLOCK_IDS.copperBlock, T.copperBlock], [BLOCK_IDS.coalBlock, T.coalBlock],
  [BLOCK_IDS.acaciaPlanks, T.acaciaPlanks], [BLOCK_IDS.sprucePlanks, T.sprucePlanks], [BLOCK_IDS.mangrovePlanks, T.mangrovePlanks], [BLOCK_IDS.cherryPlanks, T.cherryPlanks],
  [BLOCK_IDS.acaciaLeaves, T.acaciaLeaves], [BLOCK_IDS.spruceLeaves, T.spruceLeaves], [BLOCK_IDS.mangroveLeaves, T.mangroveLeaves],
  [BLOCK_IDS.woolWhite, T.woolWhite], [BLOCK_IDS.woolOrange, T.woolOrange], [BLOCK_IDS.woolMagenta, T.woolMagenta],
  [BLOCK_IDS.woolLightBlue, T.woolLightBlue], [BLOCK_IDS.woolYellow, T.woolYellow], [BLOCK_IDS.woolLime, T.woolLime],
  [BLOCK_IDS.woolPink, T.woolPink], [BLOCK_IDS.woolGray, T.woolGray], [BLOCK_IDS.woolLightGray, T.woolLightGray],
  [BLOCK_IDS.woolCyan, T.woolCyan], [BLOCK_IDS.woolPurple, T.woolPurple], [BLOCK_IDS.woolBlue, T.woolBlue],
  [BLOCK_IDS.woolBrown, T.woolBrown], [BLOCK_IDS.woolGreen, T.woolGreen], [BLOCK_IDS.woolRed, T.woolRed], [BLOCK_IDS.woolBlack, T.woolBlack],
  [BLOCK_IDS.lantern, T.lantern],
] as const) {
  BLOCK_FACE_LAYERS[id] = [layer, layer, layer, layer, layer, layer];
}
// Expansion set: side/top cubes (logs, pillar, red sandstone, hay bale, campfire, jack-o'-lantern). Face order [+x,-x,+y,-y,+z,-z].
for (const [id, side, top] of [
  [BLOCK_IDS.acaciaLog, T.acaciaLogSide, T.acaciaLogTop], [BLOCK_IDS.spruceLog, T.spruceLogSide, T.spruceLogTop],
  [BLOCK_IDS.mangroveLog, T.mangroveLogSide, T.mangroveLogTop], [BLOCK_IDS.quartzPillar, T.quartzPillarSide, T.quartzPillarTop],
  [BLOCK_IDS.redSandstone, T.redSandstoneSide, T.redSandstoneTop], [BLOCK_IDS.hayBale, T.hayBaleSide, T.hayBaleTop],
  [BLOCK_IDS.campfire, T.campfireSide, T.campfireTop], [BLOCK_IDS.jackOLantern, T.jackLanternSide, T.jackLanternTop],
] as const) {
  BLOCK_FACE_LAYERS[id] = [side, side, top, top, side, side];
}

// ===========================================================================
//  SHAPED BLOCKS — slabs / stairs / fences / doors / trapdoors. Each carries a
//  list of AABBs ([minX,minY,minZ,maxX,maxY,maxZ] in [0,1] cell-local) used BOTH
//  for physics collision and (for slabs/stairs/doors/trapdoors) as the meshed
//  geometry. They're SOLID (collide) but NOT greedy cube-meshed — the plant pass
//  emits their box faces into the shadow-casting group. Door/trapdoor open vs
//  closed are distinct block ids (the voxel grid has no per-block state).
// ===========================================================================
export type AABB = readonly [number, number, number, number, number, number];
const SLAB_SHAPE: AABB[] = [[0, 0, 0, 1, 0.5, 1]];
const FENCE_SHAPE: AABB[] = [[0.375, 0, 0.375, 0.625, 1.5, 0.625]];   // post, 1.5 tall like MC
const DOOR_CLOSED_SHAPE: AABB[] = [[0, 0, 0, 1, 1, 0.2]];             // panel across the -z face
const DOOR_OPEN_SHAPE: AABB[] = [[0, 0, 0, 0.2, 1, 1]];              // swung aside → doorway clear
const TRAP_CLOSED_SHAPE: AABB[] = [[0, 0, 0, 1, 0.2, 1]];            // flat on the floor
const TRAP_OPEN_SHAPE: AABB[] = [[0, 0, 0, 1, 1, 0.2]];             // up against the -z wall
const stairShape = (facing: number): AABB[] => {
  const back: AABB = facing === 0 ? [0.5, 0.5, 0, 1, 1, 1] : facing === 1 ? [0, 0.5, 0, 0.5, 1, 1]
    : facing === 2 ? [0, 0.5, 0.5, 1, 1, 1] : [0, 0.5, 0, 1, 1, 0.5];
  return [[0, 0, 0, 1, 0.5, 1], back];
};

export const BLOCK_SHAPES: { [id: number]: AABB[] } = {};
export const SHAPED_LOOKUP = new Uint8Array(256);   // box geometry emitted by the plant pass
export const FENCE_LOOKUP = new Uint8Array(256);     // post+arm geometry (special)
const sixOf = (l: number): readonly number[] => [l, l, l, l, l, l];
const I = BLOCK_IDS;
for (const [id, layer] of [[I.oakSlab, T.oakPlanks], [I.cobbleSlab, T.cobblestone], [I.stoneSlab, T.stone], [I.sandstoneSlab, T.sandstone]] as const) {
  BLOCK_SHAPES[id] = SLAB_SHAPE; SHAPED_LOOKUP[id] = 1; BLOCK_FACE_LAYERS[id] = sixOf(layer);
}
for (const [ids, layer] of [
  [[I.oakStairsPX, I.oakStairsNX, I.oakStairsPZ, I.oakStairsNZ], T.oakPlanks],
  [[I.cobbleStairsPX, I.cobbleStairsNX, I.cobbleStairsPZ, I.cobbleStairsNZ], T.cobblestone],
  [[I.stoneStairsPX, I.stoneStairsNX, I.stoneStairsPZ, I.stoneStairsNZ], T.stone],
  [[I.sandstoneStairsPX, I.sandstoneStairsNX, I.sandstoneStairsPZ, I.sandstoneStairsNZ], T.sandstone],
] as const) {
  ids.forEach((id, f) => { BLOCK_SHAPES[id] = stairShape(f); SHAPED_LOOKUP[id] = 1; BLOCK_FACE_LAYERS[id] = sixOf(layer); });
}
for (const [id, layer] of [[I.oakFence, T.oakPlanks], [I.cobbleFence, T.cobblestone]] as const) {
  BLOCK_SHAPES[id] = FENCE_SHAPE; FENCE_LOOKUP[id] = 1; BLOCK_FACE_LAYERS[id] = sixOf(layer);
}
for (const [id, shape] of [
  [I.oakDoorLowerClosed, DOOR_CLOSED_SHAPE], [I.oakDoorUpperClosed, DOOR_CLOSED_SHAPE],
  [I.oakDoorLowerOpen, DOOR_OPEN_SHAPE], [I.oakDoorUpperOpen, DOOR_OPEN_SHAPE],
] as const) { BLOCK_SHAPES[id] = shape; SHAPED_LOOKUP[id] = 1; BLOCK_FACE_LAYERS[id] = sixOf(T.oakDoor); }
for (const [id, shape] of [[I.oakTrapdoorClosed, TRAP_CLOSED_SHAPE], [I.oakTrapdoorOpen, TRAP_OPEN_SHAPE]] as const) {
  BLOCK_SHAPES[id] = shape; SHAPED_LOOKUP[id] = 1; BLOCK_FACE_LAYERS[id] = sixOf(T.oakTrapdoor);
}
export const isShaped = (id: number): boolean => SHAPED_LOOKUP[id] === 1;
export const isFence = (id: number): boolean => FENCE_LOOKUP[id] === 1;
const FULL_CUBE: AABB[] = [[0, 0, 0, 1, 1, 1]];
// Collision AABB list (cell-local [0,1]); full cube unless the block is shaped/fence.
export function collisionBoxes(id: number): AABB[] { return BLOCK_SHAPES[id] ?? FULL_CUBE; }

// Right-click toggle for openables: each state id maps to its counterpart.
export const TOGGLE: { [id: number]: number } = {
  [I.oakDoorLowerClosed]: I.oakDoorLowerOpen, [I.oakDoorLowerOpen]: I.oakDoorLowerClosed,
  [I.oakDoorUpperClosed]: I.oakDoorUpperOpen, [I.oakDoorUpperOpen]: I.oakDoorUpperClosed,
  [I.oakTrapdoorClosed]: I.oakTrapdoorOpen, [I.oakTrapdoorOpen]: I.oakTrapdoorClosed,
};
export const DOOR_PART = new Uint8Array(256);  // 1 if this id is a door half (toggling pairs the other half)
for (const id of [I.oakDoorLowerClosed, I.oakDoorLowerOpen, I.oakDoorUpperClosed, I.oakDoorUpperOpen]) DOOR_PART[id] = 1;

// Blocks that should not cast shadows (cheap canopies / sky decoration). Cherry
// leaves join the leaf/canopy group so they mesh into the same buffer as leaves.
export const NON_SHADOW_CASTER_IDS: ReadonlySet<number> = new Set([
  BLOCK_IDS.leaves, BLOCK_IDS.cloud, BLOCK_IDS.cherryLeaves,
  BLOCK_IDS.birchLeaves, BLOCK_IDS.darkOakLeaves, BLOCK_IDS.jungleLeaves,
  BLOCK_IDS.acaciaLeaves, BLOCK_IDS.spruceLeaves, BLOCK_IDS.mangroveLeaves,
]);

// ===========================================================================
//  FOLIAGE / PLANTS  — cross-billboard, carpet, pad and vine blocks. These are
//  NOT cube-meshed: the greedy cube mesher skips them and treats them as
//  non-occluding air (so the block they sit on keeps its faces), and a separate
//  plant pass emits their geometry into a third "plants" group. Physics ignores
//  them (non-colliding). All metadata is pure data so the worker can consume it.
// ===========================================================================
export type PlantKind =
  | 'cross'   // two perpendicular X quads, fills the cell vertically (grass, flowers, fern, dead bush)
  | 'carpet'  // one flat quad just above the floor, greedy-merged into sheets (petals, litter)
  | 'slab'    // a THIN box (top + culled sides) → reads as a 3D sheet with height (snow layers)
  | 'pad'     // one flat quad, NOT merged (lily pad — keeps its disc shape)
  | 'vine';   // vertical quads flush against adjacent solid faces (hangs on trunks/cliffs)

// tint: 'grass' multiplies the (near-grayscale) texture by the column's climate
// grass tint at mesh-build time (MC-style); 'none' renders the texture as-authored.
// off: height of a carpet/pad quad above the block's bottom face (cell units).
// swayLo/swayHi: wind-sway weight at this cell's BASE and TOP (default 0..1). For a
// 2-block plant the lower cell uses 0..0.5 and the upper 0.5..1.0 so the whole
// plant bends as ONE continuous arc instead of the two halves splitting apart.
export type PlantDef = { layer: number, kind: PlantKind, tint: 'grass' | 'none', off: number, swayLo?: number, swayHi?: number };

const PT = TEXTURE_LAYER;
export const PLANTS: { readonly [id: number]: PlantDef } = {
  [BLOCK_IDS.shortGrass]:      { layer: PT.shortGrass,      kind: 'cross',  tint: 'grass', off: 0 },
  [BLOCK_IDS.fern]:            { layer: PT.fern,            kind: 'cross',  tint: 'grass', off: 0 },
  [BLOCK_IDS.tallGrassLower]:  { layer: PT.tallGrassBottom, kind: 'cross',  tint: 'grass', off: 0, swayLo: 0, swayHi: 0.5 },
  [BLOCK_IDS.tallGrassUpper]:  { layer: PT.tallGrassTop,    kind: 'cross',  tint: 'grass', off: 0, swayLo: 0.5, swayHi: 1 },
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
  [BLOCK_IDS.snowLayer]:       { layer: PT.snow,            kind: 'slab',   tint: 'none',  off: 0.18 },
  [BLOCK_IDS.vine]:            { layer: PT.vine,            kind: 'vine',   tint: 'grass', off: 0 },
  [BLOCK_IDS.seagrass]:        { layer: PT.seaGrass,        kind: 'cross',  tint: 'none',  off: 0 },
  [BLOCK_IDS.tallSeagrassLower]:{ layer: PT.tallSeagrassBottom, kind: 'cross', tint: 'none', off: 0, swayLo: 0, swayHi: 0.5 },
  [BLOCK_IDS.tallSeagrassUpper]:{ layer: PT.tallSeagrassTop, kind: 'cross',  tint: 'none',  off: 0, swayLo: 0.5, swayHi: 1 },
  [BLOCK_IDS.largeFernLower]:  { layer: PT.largeFernBottom, kind: 'cross',  tint: 'grass', off: 0, swayLo: 0, swayHi: 0.5 },
  [BLOCK_IDS.largeFernUpper]:  { layer: PT.largeFernTop,    kind: 'cross',  tint: 'grass', off: 0, swayLo: 0.5, swayHi: 1 },
  // more foliage
  [BLOCK_IDS.smallMushroomRed]:  { layer: PT.mushroomRedSmall,   kind: 'cross', tint: 'none', off: 0 },
  [BLOCK_IDS.smallMushroomBrown]:{ layer: PT.mushroomBrownSmall, kind: 'cross', tint: 'none', off: 0 },
  [BLOCK_IDS.sugarCane]:         { layer: PT.sugarCane,          kind: 'cross', tint: 'none', off: 0 },
  [BLOCK_IDS.flowerBlueOrchid]:  { layer: PT.flowerBlueOrchid,   kind: 'cross', tint: 'none', off: 0 },
  // torch: a small non-colliding cross billboard (its texture has a transparent
  // margin so it reads as a thin torch); no wind sway; rendered emissive (the
  // plant material self-detects the torch layer — see plantMaterial).
  [BLOCK_IDS.torch]:             { layer: PT.torch,              kind: 'cross', tint: 'none', off: 0, swayLo: 0, swayHi: 0 },
};

// O(1) "is this id a plant?" for the mesher's hot loops & physics broadphase —
// indexed by block id (all ids < 256), avoids a Set.has per cell.
export const PLANT_LOOKUP = new Uint8Array(256);
for (const k of Object.keys(PLANTS)) PLANT_LOOKUP[Number(k)] = 1;
export const isPlant = (id: number): boolean => PLANT_LOOKUP[id] === 1;

// Slippery blocks: standing on one cuts ground friction/acceleration so the player
// slides (ice physics). O(1) lookup for the physics step.
export const SLIPPERY_LOOKUP = new Uint8Array(256);
SLIPPERY_LOOKUP[BLOCK_IDS.ice] = 1;
SLIPPERY_LOOKUP[BLOCK_IDS.packedIce] = 1;
export const isSlippery = (id: number): boolean => SLIPPERY_LOOKUP[id] === 1;

// Cutout blocks: SOLID cubes (collide, in the data grid) but rendered see-through
// via the alpha-tested plant material instead of the opaque cube material — glass.
// The cube greedy-mesher skips them; the plant pass emits their (culled) cube
// faces. They occlude only OTHER cutout blocks (so a glass-glass seam culls), and
// are non-occluding to opaque neighbours (you see solids through glass).
export const CUTOUT_LOOKUP = new Uint8Array(256);
CUTOUT_LOOKUP[BLOCK_IDS.glass] = 1;
export const isCutout = (id: number): boolean => CUTOUT_LOOKUP[id] === 1;

// ===========================================================================
//  LIGHT SOURCES — emitter blocks. Two effects: (1) the block renders full-bright
//  (emissive, via the cube tintColor.a channel baked at mesh build), and (2) the
//  worker records its position so a pool of dynamic point lights snaps to the
//  nearest emitters and lights the surroundings (see World + main.ts LightManager).
//  color rgb 0..1 · intensity (physically-based) · range (falloff radius) ·
//  flicker (0..1 amplitude of a per-frame brightness wobble — torches/campfires).
// ===========================================================================
export type LightSpec = { r: number, g: number, b: number, intensity: number, range: number, flicker: number };
// `range` = the emitter's Minecraft block-light level (how many blocks the light
// reaches): torch 14, glowstone/lantern/sea-lantern/campfire/jack 15, magma small.
// decay=1 (see lightManager) gives the even, gradual falloff across that range.
export const LIGHT_SOURCES: { readonly [id: number]: LightSpec } = {
  [BLOCK_IDS.torch]:      { r: 1.00, g: 0.80, b: 0.48, intensity: 10, range: 14, flicker: 0.16 },
  [BLOCK_IDS.lantern]:    { r: 1.00, g: 0.87, b: 0.62, intensity: 13, range: 15, flicker: 0.05 },
  [BLOCK_IDS.campfire]:   { r: 1.00, g: 0.68, b: 0.36, intensity: 13, range: 15, flicker: 0.20 },
  [BLOCK_IDS.jackOLantern]: { r: 1.00, g: 0.76, b: 0.42, intensity: 12, range: 15, flicker: 0.09 },
  [BLOCK_IDS.glowstone]:  { r: 1.00, g: 0.89, b: 0.64, intensity: 14, range: 15, flicker: 0 },
  [BLOCK_IDS.seaLantern]: { r: 0.80, g: 0.95, b: 0.96, intensity: 14, range: 15, flicker: 0 },
  [BLOCK_IDS.magma]:      { r: 1.00, g: 0.50, b: 0.22, intensity: 6, range: 7, flicker: 0.12 },
};
// O(1) "is this id a light emitter?" — also the EMISSIVE set (rendered full-bright).
export const EMITTER_LOOKUP = new Uint8Array(256);
for (const k of Object.keys(LIGHT_SOURCES)) EMITTER_LOOKUP[Number(k)] = 1;
export const isEmitter = (id: number): boolean => EMITTER_LOOKUP[id] === 1;
