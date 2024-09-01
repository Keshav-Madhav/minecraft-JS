import * as THREE from 'three';
import { Object3D } from 'three';
import { SimplexNoise } from 'three/examples/jsm/Addons.js';
import { RNG } from './rng';
import { blocks, resources } from './blocks';
import { DataStore } from './dataStore';

type paramsType = {
  seed: number,
  terrain: {
    scale: number,
    magnitude: number,
    offset: number,
    waterOffset: number
  },
  trees:{
    trunk:{
      minHeight: number,
      maxHeight: number,
    },
    canopy:{
      minRadius: number,
      maxRadius: number,
      density: number,
    },
    frequency: number
  },
  clouds:{
    scale: number,
    density: number
  }
}

const goemetry = new THREE.BoxGeometry(1, 1, 1);

export class WorldChunk extends THREE.Group {
  loaded: boolean
  size: {width: number, height: number};
  params: paramsType;
  data: {
    id: number,
    instanceId: number,
  }[][][] = [];
  dataStore: DataStore;

  constructor(size: {width: number, height: number}, params: paramsType, dataStore: DataStore){
    super();

    this.loaded = false;
    this.size = size;
    this.params = params;
    this.dataStore = dataStore;
  }

  generate(){
    const rng = new RNG(this.params.seed);
    this.InitializeTerrain();
    this.generateResources(rng);
    this.generateTerrain(rng);
    this.generateTrees(rng);
    this.generateClouds(rng);
    this.loadPlayerChanges();
    this.generateMeshes();

    this.generateWater();

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
  
        let height = Math.floor(scaledNoise);
        height = Math.max(0, Math.min(height, this.size.height - 1));
  
        for (let y = 0; y < this.size.height; y++) {
          if (y > height) {
            // Everything above height is air
            this.setBlockId(x, y, z, blocks.air.id);
          } else if (y === height) {
            // Top layer is always grass or sand
            if(y <= this.params.terrain.waterOffset){
              this.setBlockId(x, y, z, blocks.sand.id);
            } else {
              this.setBlockId(x, y, z, blocks.grass.id);
            }
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

  generateTrees(rng: RNG){
    const generateTreeTrunk = ( x: number, z: number, rng: RNG) =>{
      const minH = this.params.trees.trunk.minHeight;
      const maxH = this.params.trees.trunk.maxHeight;

      const h = Math.round(minH + (maxH - minH) * rng.random());

      for(let y = this.size.height - 1; y >= 0; y--) {
        const block = this.getBlock(x, y, z);
        if(block && block.id === blocks.grass.id){
          for(let treeY = y+1; treeY <= y + h; treeY++){
            this.setBlockId(x, treeY, z, blocks.tree.id);
          }

          generateTreeCanopy(x, y+h, z, rng);
          break;
        }
      }
    }

    const generateTreeCanopy = (x: number, y: number, z: number, rng: RNG) => {
      const minR = this.params.trees.canopy.minRadius;
      const maxR = this.params.trees.canopy.maxRadius;
      const r = Math.round(minR + (maxR - minR) * rng.random());
      const density = this.params.trees.canopy.density;

      for(let i = -maxR; i <= maxR; i++) {
        for(let j = -maxR; j <= maxR; j++) {
          for(let k = -maxR; k <= maxR; k++) {
            const n = rng.random();
            if((i*i + j*j + k*k) > r*r ) continue;

            const block = this.getBlock(i+x, j+y, k+z);
            if(block && block.id !== blocks.air.id) continue;
            
            if(n < density){
              this.setBlockId(x + i, y + j, z + k, blocks.leaves.id);
            }
          }
        }
      }
    }

    let offset = 1
    for( let x = offset; x < this.size.width - offset; x++) {
      for( let z = offset; z < this.size.width - offset; z++) {
        if(rng.random() < this.params.trees.frequency){
          generateTreeTrunk(x, z, rng);
        }
      }
    }
  }

  generateClouds(rng: RNG){
    const simplex = new SimplexNoise(rng);

    for(let x = 0; x < this.size.width; x++) {
      for(let z = 0; z < this.size.width; z++) {
        const value = (simplex.noise(
          this.position.x + x / this.params.clouds.scale,
          this.position.z + z / this.params.clouds.scale
        ) + 1) * 0.5;

        if(value < this.params.clouds.density){
          this.setBlockId(x, this.size.height - 1, z, blocks.cloud.id);
        }
      }
    }
  }

  loadPlayerChanges(){
    for(let i = 0; i < this.size.width; i++) {
      for(let k = 0; k < this.size.height; k++) {
        for(let j = 0; j < this.size.width; j++) {
          if(this.dataStore.contains({chunkX: this.position.x, chunkZ: this.position.z, blockX: i, blockY: k, blockZ: j})){
            const blockID = this.dataStore.get({chunkX: this.position.x, chunkZ: this.position.z, blockX: i, blockY: k, blockZ: j});
            this.setBlockId(i, k, j, blockID);
          }          
        }
      }
    }
  }

  generateWater(){
    const material = new THREE.MeshLambertMaterial({color: 0x9090e0, transparent: true, opacity: 0.5, side: THREE.DoubleSide});
    const waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);

    waterMesh.rotateX(-Math.PI/2);
    waterMesh.position.set(this.size.width/2, this.params.terrain.waterOffset + 0.45, this.size.width/2);

    waterMesh.scale.set(this.size.width, this.size.width, 1);

    this.add(waterMesh);
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
        // modified mesh name type defination to accept number
        mesh.name = block.id;
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

  addBlockInstance(x: number, y: number, z: number){
    const block = this.getBlock(x, y, z)!

    if(block && block.id !== blocks.air.id && block.instanceId === -1){
      const mesh = this.children.find((child: Object3D) => child.name === block.id)! as THREE.InstancedMesh;
      const instanceId = mesh.count++;
  
      this.setBlockInstanceId(x, y, z, instanceId);
  
      const matrix = new THREE.Matrix4();
      matrix.setPosition(x, y, z);
  
      mesh.setMatrixAt(instanceId, matrix);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    };
  }

  addBlock(x: number, y: number, z: number, id: number){
    if(this.getBlock(x, y, z)?.id === blocks.air.id){
      this.setBlockId(x, y, z, id);
      this.addBlockInstance(x, y, z);
      this.dataStore.set({chunkX: this.position.x, chunkZ: this.position.z, blockX: x, blockY: y, blockZ: z, blockID: id});
    }
  }

  removeBlock(x: number, y: number, z: number){
    const block = this.getBlock(x, y, z);
    if(block && block.id !== blocks.air.id){
      this.deleteBlockInstance(x, y, z);
      this.setBlockId(x, y, z, blocks.air.id);
      this.dataStore.set({chunkX: this.position.x, chunkZ: this.position.z, blockX: x, blockY: y, blockZ: z, blockID: blocks.air.id});
    }
  }

  deleteBlockInstance(x: number, y: number, z: number){
    const block = this.getBlock(x, y, z)!;

    if(block.instanceId === -1 || block.id === blocks.air.id) return;

    const mesh = this.children.find((child: Object3D) => child.name === block.id)! as THREE.InstancedMesh;
    const instanceId = block.instanceId;

    const lastMatrix = new THREE.Matrix4();
    mesh.getMatrixAt(mesh.count - 1, lastMatrix);

    const v = new THREE.Vector3();
    v.setFromMatrixPosition(lastMatrix);
    this.setBlockInstanceId(v.x, v.y, v.z, instanceId);

    mesh.setMatrixAt(instanceId, lastMatrix);

    mesh.count--;
    
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();

    this.setBlockInstanceId(x, y, z, -1);
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