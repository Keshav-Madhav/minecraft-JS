// Pure block metadata for the MAIN thread (ids, ore-gen scale/scarcity, display
// names/colours). All actual rendering goes through `blockArrayMaterial` (a
// single DataArrayTexture), so there are deliberately NO THREE textures or
// materials here — loading them was pure dead weight that decoded and uploaded
// every PNG to the GPU a second time and built ~30 unused materials. The worker
// uses the parallel pure-data module `blockTypes.ts`.

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

type ResourceInfo = { id: number; name: string; color: number; scale: { x: number; y: number; z: number }; scarcity: number };

function assertResource(block: BlockInfo): ResourceInfo {
  if (block.color === undefined || block.scale === undefined || block.scarcity === undefined) {
    throw new Error(`Block ${block.name} is missing required properties`);
  }
  return { id: block.id, name: block.name, color: block.color, scale: block.scale, scarcity: block.scarcity };
}

export const resources: ResourceInfo[] = [
  // Ore veins scattered into stone. (Stone itself is placed by the terrain
  // pass, so it's no longer a "resource" — that was a no-op that wasted a noise
  // sweep and showed a do-nothing slider.)
  assertResource(blocks.coalOre),
  assertResource(blocks.ironOre),
];
