import * as THREE from 'three';
import { Object3D } from 'three';
import { SimplexNoise } from 'three/examples/jsm/Addons.js';
import { RNG } from './rng';
import { blocks, resources } from './blocks';

const goemetry = new THREE.BoxGeometry(1, 1, 1);

export class WorldChunk extends THREE.Group {
  loaded: boolean
  size: {width: number, height: number};
  params: {seed: number, terrain: {scale: number, magnitude: number, offset: number}};
  data: {
    id: number,
    instanceId: number,
  }[][][] = [];


  constructor(size: {width: number, height: number}, params: {seed: number, terrain: {scale: number, magnitude: number, offset: number}}){
    super();

    this.loaded = false;
    this.size = size;
    this.params = params;
  }

  generate(){
    const rng = new RNG(this.params.seed);
    this.InitializeTerrain();
    this.generateResources(rng);
    this.generateTerrain(rng);
    this.generateMeshes();

    this.loaded = true;
  }

  // Initialize the world terrain data
  InitializeTerrain(){
    this.data =[]
    for(let x = 0; x < this.size.width; x++) {
      const slice = [];
      for(let y = 0; y < this.size.height; y++) {
        const row = [];
        for(let z = 0; z < this.size.width; z++) {
          row.push({
            id: blocks.air.id,
            instanceId: -1,
          });
        }
        slice.push(row);
      }
      this.data.push(slice);
    }
  }

  // Generate the world resources
  generateResources(rng: RNG){
    const simplex = new SimplexNoise(rng);
    resources.forEach(resource => {
      for(let i = 0; i < this.size.width; i++) {
        for(let j = 0; j < this.size.width; j++) {
          for(let k = 0; k < this.size.height; k++) {
            const val = simplex.noise3d(
              (this.position.x + i)/ resource.scale.x,
              (this.position.y + j)/ resource.scale.y,
              (this.position.z + k)/ resource.scale.z
            )
  
            if(val > resource.scarcity){
              this.setBlockId(i, k, j, resource.id);
            }
          }
        }
      }
    })
  }

  generateTerrain(rng: RNG) {
    const simplex = new SimplexNoise(rng);
    for (let x = 0; x < this.size.width; x++) {
      for (let z = 0; z < this.size.width; z++) {
        const val = simplex.noise(
          (this.position.x + x) / this.params.terrain.scale,
          (this.position.z + z) / this.params.terrain.scale
        );
  
        const scaledNoise = this.params.terrain.offset + this.params.terrain.magnitude * val;
  
        let height = Math.floor(scaledNoise * this.size.height);
        height = Math.max(0, Math.min(height, this.size.height - 1));
  
        for (let y = 0; y < this.size.height; y++) {
          if (y > height) {
            // Everything above height is air
            this.setBlockId(x, y, z, blocks.air.id);
          } else if (y === height) {
            // Top layer is always grass
            this.setBlockId(x, y, z, blocks.grass.id);
          } else if (y >= height - 3 && this.getBlock(x, y, z)?.id === blocks.air.id) {
            // Next 3 layers are dirt
            this.setBlockId(x, y, z, blocks.dirt.id);
          } else if(this.getBlock(x, y, z)?.id === blocks.air.id) {
            // Everything else below is stone
            this.setBlockId(x, y, z, blocks.stone.id);
          }
        }
      }
    }
  }

  // Create the 3D representation of the world using world data
  generateMeshes(){
    this.clear();
    const maxCount = this.size.width * this.size.height * this.size.width;

    // creating a look up table for block instance ids
    const meshes: {[key: number]: THREE.InstancedMesh} = {};

    Object.values(blocks).
      filter(block => block.id !== blocks.air.id).
      forEach(block => {
        const mesh = new THREE.InstancedMesh(goemetry, block.material, maxCount);
        mesh.name = block.name;
        mesh.count = 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        meshes[block.id] = mesh;
      });


    const matrix = new THREE.Matrix4();
    for(let i = 0; i < this.size.width; i++) {
      for(let k = 0; k < this.size.height; k++) {
        for(let j = 0; j < this.size.width; j++) {
          const blockId = this.getBlock(i, k, j)?.id;
          if(blockId && blockId !== blocks.air.id) {
            const mesh = meshes[blockId];
            const instanceId = mesh.count;
  
            if(!this.isBlockObscured(i, k, j)){
              matrix.setPosition(i, k, j);
              mesh.setMatrixAt(instanceId, matrix);
              this.setBlockInstanceId(i, k, j, instanceId);
              mesh.count++;
            }
          };
        }
      }
    }

    this.add(...Object.values(meshes));
  }

  getBlock(x: number, y: number, z: number){
    if(this.inBounds(x, y, z)){
      return this.data[x][y][z];
    } else {
      return null;
    }
  }

  inBounds(x: number, y: number, z: number){
    if( x < 0 || x >= this.size.width ||
        y < 0 || y >= this.size.height ||
        z < 0 || z >= this.size.width) {
      return false;
    } else {
      return true;
    }
  }

  setBlockId(x: number, y: number, z: number, id: number){
    if(this.inBounds(x, y, z)){
      this.data[x][y][z].id = id;
    }
  }

  setBlockInstanceId(x: number, y: number, z: number, instanceId: number){
    if(this.inBounds(x, y, z)){
      this.data[x][y][z].instanceId = instanceId;
    }
  }

  isBlockObscured(x: number, y: number, z: number){
    const up = this.getBlock(x, y+1, z)?.id ?? blocks.air.id;
    const down = this.getBlock(x, y-1, z)?.id ?? blocks.air.id;
    const left = this.getBlock(x+1, y, z)?.id ?? blocks.air.id;
    const right = this.getBlock(x-1, y, z)?.id ?? blocks.air.id;
    const front = this.getBlock(x, y, z+1)?.id ?? blocks.air.id;
    const back = this.getBlock(x, y, z-1)?.id ?? blocks.air.id;

    if(up !== blocks.air.id && down !== blocks.air.id &&
        left !== blocks.air.id && right !== blocks.air.id &&
        front !== blocks.air.id && back !== blocks.air.id){
      return true;
    } else {
      return false;
    }
  }

  disposeInstance() {
    this.traverse((child: Object3D) => {
      if (child instanceof THREE.Mesh) {
        if (child.geometry) {
          child.geometry.dispose();
        }
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(material => material.dispose());
          } else {
            child.material.dispose();
          }
        }
      }
    });
    this.clear();
  }
}