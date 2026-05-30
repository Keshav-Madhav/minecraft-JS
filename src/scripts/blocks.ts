// Pure block metadata for the MAIN thread (ids, ore-gen scale/scarcity, display
// names/colours). All actual rendering goes through `blockArrayMaterial` (a
// single DataArrayTexture), so there are deliberately NO THREE textures or
// materials here — loading them was pure dead weight that decoded and uploaded
// every PNG to the GPU a second time and built ~30 unused materials. The worker
// uses the parallel pure-data module `blockTypes.ts`.

import { BLOCK_IDS } from './blockTypes';

type allBlocks = 'air' | 'grass' | 'dirt' | 'stone' | 'coalOre' | 'ironOre' | 'tree' | 'leaves' | 'sand' | 'cloud' | 'snow';

type BlockInfo = {
  id: number;
  name: string;
  color?: number;
  scale?: { x: number; y: number; z: number };
  scarcity?: number;
};

export const blocks: { [key in allBlocks]: BlockInfo } = {
  air:     { id: 0,  name: 'Air' },
  grass:   { id: 1,  name: 'Grass Block', color: 0x559020 },
  dirt:    { id: 2,  name: 'Dirt Block',  color: 0x807020 },
  stone:   { id: 3,  name: 'Stone Block', color: 0x808080, scale: { x: 30, y: 30, z: 30 }, scarcity: 0.76 },
  coalOre: { id: 4,  name: 'Coal Ore',    color: 0x202020, scale: { x: 20, y: 20, z: 20 }, scarcity: 0.8 },
  ironOre: { id: 5,  name: 'Iron Ore',    color: 0x806060, scale: { x: 14, y: 14, z: 22 }, scarcity: 0.8 },
  tree:    { id: 6,  name: 'Tree',        color: 0x805020 },
  leaves:  { id: 7,  name: 'Leaves',      color: 0x208020 },
  sand:    { id: 8,  name: 'Sand',        color: 0x908020 },
  cloud:   { id: 9,  name: 'Cloud',       color: 0xf0f0f0 },
  snow:    { id: 10, name: 'Snow',        color: 0xffffff },
};

type ResourceInfo = { id: number; name: string; color: number; scale: { x: number; y: number; z: number }; scarcity: number; minY?: number; maxY?: number };

function assertResource(block: BlockInfo): ResourceInfo {
  if (block.color === undefined || block.scale === undefined || block.scarcity === undefined) {
    throw new Error(`Block ${block.name} is missing required properties`);
  }
  return { id: block.id, name: block.name, color: block.color, scale: block.scale, scarcity: block.scarcity };
}

// Ore veins + stone-variant patches scattered into the host rock (stone OR
// deepslate). Ores carry a [minY,maxY] depth window so they layer by depth
// (diamond/redstone deep, copper shallow, …) — also makes their sweep cheaper.
// ORES come first so they claim host rock before the (common) stone variants
// fill the rest; variants never overwrite an ore (only host rock is replaced).
const oreGen = (id: number, name: string, color: number, s: number, scarcity: number, minY: number, maxY: number): ResourceInfo =>
  ({ id, name, color, scale: { x: s, y: s, z: s }, scarcity, minY, maxY });

export const resources: ResourceInfo[] = [
  assertResource(blocks.coalOre),
  assertResource(blocks.ironOre),
  oreGen(BLOCK_IDS.copperOre, 'Copper Ore', 0xc06a48, 16, 0.82, 4, 96),
  oreGen(BLOCK_IDS.goldOre, 'Gold Ore', 0xf4c130, 12, 0.86, 2, 40),
  oreGen(BLOCK_IDS.redstoneOre, 'Redstone Ore', 0xc81818, 12, 0.84, 2, 18),
  oreGen(BLOCK_IDS.lapisOre, 'Lapis Ore', 0x2a4c9a, 10, 0.87, 2, 36),
  oreGen(BLOCK_IDS.diamondOre, 'Diamond Ore', 0x5fe0d8, 10, 0.90, 1, 15),
  oreGen(BLOCK_IDS.emeraldOre, 'Emerald Ore', 0x2ea84e, 8, 0.92, 6, 120),
  // stone variants: large smooth blobs of alternate rock through the stone column
  oreGen(BLOCK_IDS.andesite, 'Andesite', 0x8a8a8e, 26, 0.58, 0, 110),
  oreGen(BLOCK_IDS.diorite, 'Diorite', 0xd0d0d2, 26, 0.60, 0, 110),
  oreGen(BLOCK_IDS.granite, 'Granite', 0xa9776a, 26, 0.60, 0, 110),
  oreGen(BLOCK_IDS.tuff, 'Tuff', 0x6e7066, 18, 0.62, 0, 26),
];
