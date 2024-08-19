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
}

type allBlocks = 'air' | 'grass' | 'dirt' | 'stone' | 'coalOre' | 'ironOre';

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
      new THREE.MeshBasicMaterial({ map: textures.grassSide }),
      new THREE.MeshBasicMaterial({ map: textures.grassSide }),
      new THREE.MeshBasicMaterial({ map: textures.grass }),
      new THREE.MeshBasicMaterial({ map: textures.dirt }),
      new THREE.MeshBasicMaterial({ map: textures.grassSide }),
      new THREE.MeshBasicMaterial({ map: textures.grassSide }),
    ]
  },
  dirt:{
    id: 2,
    name: 'Dirt Block',
    color: 0x807020,
    material: new Array(6).fill(new THREE.MeshBasicMaterial({ map: textures.dirt }))
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
    material: new Array(6).fill(new THREE.MeshBasicMaterial({ map: textures.stone }))
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
    material: new Array(6).fill(new THREE.MeshBasicMaterial({ map: textures.coalOre }))
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
    material: new Array(6).fill(new THREE.MeshBasicMaterial({ map: textures.ironOre }))
  },
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