import * as THREE from 'three';

const textureLoader = new THREE.TextureLoader();

function loadTexture(url: string) {
  const texture = textureLoader.load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;

  return texture;
}

const textures = {
  dirt: loadTexture('textures/dirt.png'),
  grass: loadTexture('textures/grass.png'),
  grassSide: loadTexture('textures/grass_side.png'),
  stone: loadTexture('textures/stone.png'),
  coalOre: loadTexture('textures/coal_ore.png'),
  ironOre: loadTexture('textures/iron_ore.png'),
  sand: loadTexture('textures/sand.png'),
  treeSide: loadTexture('textures/tree_side.png'),
  treeTop: loadTexture('textures/tree_top.png'),
  leaves: loadTexture('textures/leaves.png'),
}

type allBlocks = 'air' | 'grass' | 'dirt' | 'stone' | 'coalOre' | 'ironOre' | 'tree' | 'leaves' | 'sand' | 'cloud';

export const blocks:{
  [key in allBlocks]: {
    id: number;
    name: string;
    material: THREE.Material[];
    color?: number;
    scale?: {
      x: number;
      y: number;
      z: number;
    };
    scarcity?: number;
  }
} = {
  air: {
    id: 0,
    name: 'Air',
    material: []
  },
  grass:{
    id: 1,
    name: 'Grass Block',
    color: 0x559020,
    material: [
      new THREE.MeshLambertMaterial({ map: textures.grassSide }),
      new THREE.MeshLambertMaterial({ map: textures.grassSide }),
      new THREE.MeshLambertMaterial({ map: textures.grass }),
      new THREE.MeshLambertMaterial({ map: textures.dirt }),
      new THREE.MeshLambertMaterial({ map: textures.grassSide }),
      new THREE.MeshLambertMaterial({ map: textures.grassSide }),
    ]
  },
  dirt:{
    id: 2,
    name: 'Dirt Block',
    color: 0x807020,
    material: new Array(6).fill(new THREE.MeshLambertMaterial({ map: textures.dirt }))
  },
  stone:{
    id: 3,
    name: 'Stone Block',
    color: 0x808080,
    scale: {
      x: 30,
      y: 30,
      z: 30
    },
    scarcity: 0.76,
    material: new Array(6).fill(new THREE.MeshLambertMaterial({ map: textures.stone }))
  },
  coalOre:{
    id: 4,
    name: 'Coal Ore',
    color: 0x202020,
    scale: {
      x: 20,
      y: 20,
      z: 20
    },
    scarcity: 0.8,
    material: new Array(6).fill(new THREE.MeshLambertMaterial({ map: textures.coalOre }))
  },
  ironOre:{
    id: 5,
    name: 'Iron Ore',
    color: 0x806060,
    scale: {
      x: 14,
      y: 14,
      z: 22
    },
    scarcity: 0.8,
    material: new Array(6).fill(new THREE.MeshLambertMaterial({ map: textures.ironOre }))
  },
  tree:{
    id: 6,
    name: 'Tree',
    color: 0x805020,
    material: [
      new THREE.MeshLambertMaterial({ map: textures.treeSide }),
      new THREE.MeshLambertMaterial({ map: textures.treeSide }),
      new THREE.MeshLambertMaterial({ map: textures.treeTop }),
      new THREE.MeshLambertMaterial({ map: textures.treeTop }),
      new THREE.MeshLambertMaterial({ map: textures.treeSide }),
      new THREE.MeshLambertMaterial({ map: textures.treeSide }),
    ],
  },
  leaves:{
    id: 7,
    name: 'Leaves',
    color: 0x208020,
    material: new Array(6).fill(new THREE.MeshLambertMaterial({ map: textures.leaves }))
  },
  sand:{
    id: 8,
    name: 'Sand',
    color: 0x908020,
    material: new Array(6).fill(new THREE.MeshLambertMaterial({ map: textures.sand }))
  },
  cloud:{
    id: 9,
    name: 'Cloud',
    color: 0xf0f0f0,
    material: new Array(6).fill(new THREE.MeshBasicMaterial({ color: 0xf0f0f0 }))
  }
}

function assertFullBlock(block: typeof blocks[keyof typeof blocks]): Required<typeof block> {
  if (block.color === undefined || block.scale === undefined || block.scarcity === undefined) {
    throw new Error(`Block ${block.name} is missing required properties`);
  }
  return block as Required<typeof block>;
}

export const resources: {
  id: number;
  name: string;
  material: THREE.Material[];
  color: number;
  scale: {
    x: number;
    y: number;
    z: number;
  };
  scarcity: number;
}[] = [
  assertFullBlock(blocks.stone),
  assertFullBlock(blocks.coalOre),
  assertFullBlock(blocks.ironOre),
]