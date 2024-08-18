import * as THREE from 'three';

const goemetry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshLambertMaterial({ color: 0x00ff00 });

export class World extends THREE.Group {
  size: {width: number, height: number};
  data: {
    id: number,
    instanceId: number,
  }[][][] = [];

  constructor(size = {width: 64, height: 16}) {
    super();

    this.size = size;
  }

  generate(){
    this.generateTerrain();
    this.generateMeshes();
  }

  // Generate the world terrain data
  generateTerrain(){
    this.data =[]
    for(let x = 0; x < this.size.width; x++) {
      const slice = [];
      for(let y = 0; y < this.size.height; y++) {
        const row = [];
        for(let z = 0; z < this.size.width; z++) {
          row.push({
            id: 1,
            instanceId: -1,
          });
        }
        slice.push(row);
      }
      this.data.push(slice);
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
          if(blockId !== 0){
            matrix.setPosition(i+0.5 , k+0.5, j+0.5);
            mesh.setMatrixAt(instanceId, matrix);
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
}