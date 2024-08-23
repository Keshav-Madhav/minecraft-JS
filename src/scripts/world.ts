import * as Three from 'three';
import { WorldChunk } from './worldChunk';

export class World extends Three.Group {
  seed: number;

  chunkSize = {width: 16, height: 64}
  params = {
    seed: 0,
    terrain: {
      scale: 30,
      magnitude: 0.3,
      offset: 0.35,
    }
  }

  constructor(seed = 0){
    super();
    this.seed = seed
  }

  generate(){
    this.disposeChunks();

    for(let x = -1; x <= 1; x++){
      for(let z = -1; z <= 1; z++){
        const chunk = new WorldChunk(this.chunkSize, this.params);
        chunk.position.set(x * this.chunkSize.width, 0, z * this.chunkSize.width);
        chunk.userData = {x, z};
        chunk.generate();
        this.add(chunk);
      }
    }
  }

  getBlock(x: number, y: number, z: number){
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    console.log(coords);

    if(chunk){
      return chunk.getBlock(coords.block.x, coords.block.y, coords.block.z);
    } else {
      return null;
    }
  }

  worldToChunkCoords(x: number, y: number, z: number){
    const chunkCoords = {
      x: Math.floor(x / this.chunkSize.width),
      z: Math.floor(z / this.chunkSize.width)
    }

    const blockCoords ={
      x: x - this.chunkSize.width * chunkCoords.x,
      y,
      z: z - this.chunkSize.width * chunkCoords.z
    }

    return {
      chunk: chunkCoords,
      block: blockCoords
    }
  }

  getChunk(x: number, z: number){
    return this.children.find((child: Three.Object3D) => {
      return child.userData.x === x && child.userData.z === z
    }) as WorldChunk;
  }

  disposeChunks() {
    this.traverse((child: Three.Object3D) => {
      if (child instanceof WorldChunk && typeof child.disposeInstance === 'function') {
        child.disposeInstance();
      }
    });
  }
}