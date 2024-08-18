import * as THREE from 'three';
import { SimplexNoise } from 'three/examples/jsm/Addons.js';
import { RNG } from './rng';
import { blocks } from './blocks';

const goemetry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshLambertMaterial();

export class World extends THREE.Group {
  size: {width: number, height: number};
  data: {
    id: number,
    instanceId: number,
  }[][][] = [];

  params = {
    seed: 0,
    terrain: {
      scale: 30,
      magnitude: 0.5,
      offset: 0.2,
    }
  }

  constructor(size = {width: 64, height: 16}) {
    super();

    this.size = size;
  }

  generate(){
    this.InitializeTerrain();
    this.generateTerrain();
    this.generateMeshes();
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

  // Generate the world terrain data
  generateTerrain(){
    const rng = new RNG(this.params.seed);
    const simplex = new SimplexNoise(rng);
    for(let x = 0; x < this.size.width; x++) {
      for(let z = 0; z < this.size.width; z++) {
        const val = simplex.noise(
          x/this.params.terrain.scale,
          z/this.params.terrain.scale
        )

        const scaledNoice = this.params.terrain.offset + this.params.terrain.magnitude * val;

        let height = Math.floor(scaledNoice * this.size.height);
        height = Math.max(0, Math.min(height, this.size.height - 1));

        for(let y = 0; y < this.size.height; y++) {
          if(y < height){
            this.setBlockId(x, y, z, blocks.dirt.id);
          } else if (y === height){
            this.setBlockId(x, y, z, blocks.grass.id);
          } else {
            this.setBlockId(x, y, z, blocks.air.id);
          }
        }
      }
    }
  }

  // Create the 3D representation of the world using world data
  generateMeshes(){
    this.clear();
    const maxCount = this.size.width * this.size.height * this.size.width;
    const mesh = new THREE.InstancedMesh(goemetry, material, maxCount);
    mesh.count = 0;

    const matrix = new THREE.Matrix4();
    for(let i = 0; i < this.size.width; i++) {
      for(let k = 0; k < this.size.height; k++) {
        for(let j = 0; j < this.size.width; j++) {
          const blockId = this.getBlock(i, k, j)?.id;
          const instanceId = mesh.count;
          const blockType = Object.values(blocks).find(block => block.id === blockId);

          if(blockId !== blocks.air.id && !this.isBlockObscured(i, k, j)){
            matrix.setPosition(i+0.5 , k+0.5, j+0.5);
            mesh.setMatrixAt(instanceId, matrix);
            mesh.setColorAt(instanceId, new THREE.Color(blockType?.color));
            this.setBlockInstanceId(i, k, j, instanceId);
            mesh.count++;
          }
        }
      }
    }

    this.add(mesh);
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
}