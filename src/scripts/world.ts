import * as Three from 'three';
import { WorldChunk } from './worldChunk';
import { Player } from './player';

type chunkCoords = {x: number, z: number};

export class World extends Three.Group {
  seed: number;

  chunkSize = {width: 16, height: 32}
  params = {
    seed: 0,
    terrain: {
      scale: 60,
      magnitude: 0.1,
      offset: 0.35,
    }
  }
  drawDistance = 3;

  asyncLoading = true;

  constructor(seed = 0){
    super();
    this.seed = seed
  }

  update(player: Player){
    const visibleChunks = this.getVisibleChunks(player);
    const chunksToAdd = this.getChunksToAdd(visibleChunks);

    this.removeUnusedChunks(visibleChunks);

    for(const {x, z} of chunksToAdd){
      this.generateChunk(x, z);
    };
  }

  getVisibleChunks(player: Player){
    const visibleChunks: chunkCoords[] = [];
    const coords = this.worldToChunkCoords(player.position.x, player.position.y, player.position.z);
    const { x, z } = coords.chunk;

    for(let i = x - this.drawDistance; i <= x + this.drawDistance; i++){
      for(let j = z - this.drawDistance; j <= z + this.drawDistance; j++){
        visibleChunks.push({x: i, z: j});
      }
    }

    return visibleChunks;
  }

  getChunksToAdd(visibleChunks: chunkCoords[]){
    return visibleChunks.filter((coords) => {
      const chunkExists = this.children.map((child: Three.Object3D) => child.userData).find(({x, z}) => x === coords.x && z === coords.z);

      return !chunkExists;
    })
  }

  removeUnusedChunks(visibleChunks: chunkCoords[]){
    const chunksToRemove = this.children.filter((coords) => {
      const vixibleX = coords.userData.x;
      const visibleZ = coords.userData.z;
      const chunkExists = visibleChunks.find(({x, z}) => x === vixibleX && z === visibleZ);

      return !chunkExists;
    }) as WorldChunk[];

    chunksToRemove.forEach((chunk) => {
      chunk.disposeInstance();
      this.remove(chunk);
    })
  }

  generateChunk(x: number, z: number){
    const chunk = new WorldChunk(this.chunkSize, this.params);
    chunk.position.set(x * this.chunkSize.width, 0, z * this.chunkSize.width);
    chunk.userData = {x, z};

    if(this.asyncLoading){
      requestIdleCallback(chunk.generate.bind(chunk), {timeout: 1000});
    } else{
      chunk.generate();
    }
    this.add(chunk);
  }

  generate(){
    this.disposeChunks();
    this.children.length = 0

    for(let x = -this.drawDistance; x <= this.drawDistance; x++){
      for(let z = -this.drawDistance; z <= this.drawDistance; z++){
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

    if(chunk && chunk.loaded){
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

  setBlock(x: number, y: number, z: number, id: number){
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if(chunk){
      chunk.addBlock(
        coords.block.x,
        coords.block.y,
        coords.block.z,
        id
      );

      // hide blocks that are obscured
      this.hideBlock(x-1, y, z);
      this.hideBlock(x+1, y, z);
      this.hideBlock(x, y-1, z);
      this.hideBlock(x, y+1, z);
      this.hideBlock(x, y, z-1);
      this.hideBlock(x, y, z+1);
    }
  }

  hideBlock(x: number, y: number, z: number){
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if(chunk && chunk.isBlockObscured(coords.block.x, coords.block.y, coords.block.z)){
      chunk.deleteBlockInstance(
        coords.block.x,
        coords.block.y,
        coords.block.z
      )
    }
  }

  removeBlock(x: number, y: number, z: number){
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if(chunk){
      chunk.removeBlock(
        coords.block.x,
        coords.block.y,
        coords.block.z
      );

      // reveal blocks that were previously obscured
      this.revealBlock(x-1, y, z);
      this.revealBlock(x+1, y, z);
      this.revealBlock(x, y-1, z);
      this.revealBlock(x, y+1, z);
      this.revealBlock(x, y, z-1);
      this.revealBlock(x, y, z+1);
    }
  }

  revealBlock(x: number, y: number, z: number){
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);
    
    if(chunk){
      chunk.addBlockInstance(
        coords.block.x,
        coords.block.y,
        coords.block.z
      )
    }
  }

  disposeChunks() {
    this.traverse((child: Three.Object3D) => {
      if (child instanceof WorldChunk && typeof child.disposeInstance === 'function') {
        child.disposeInstance();
      }
    });
  }
}