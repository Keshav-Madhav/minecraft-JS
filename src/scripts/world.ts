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
    return null
  }

  disposeChunks() {
    this.traverse((child: Three.Object3D) => {
      if (child instanceof WorldChunk && typeof child.disposeInstance === 'function') {
        child.disposeInstance();
      }
    });
  }
}