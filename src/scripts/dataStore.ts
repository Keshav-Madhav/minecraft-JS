export class DataStore {
  data: {[key: string]: number};

  constructor(){
    this.data = {};
  }

  clear(){
    this.data = {};
  }

  contains({chunkX, chunkZ, blockX, blockY, blockZ}: {chunkX: number, chunkZ: number, blockX: number, blockY: number, blockZ: number}){
    const key = this.getKey({chunkX, chunkZ, blockX, blockY, blockZ});
    return this.data[key] !== undefined;
  }

  get({chunkX, chunkZ, blockX, blockY, blockZ}: {chunkX: number, chunkZ: number, blockX: number, blockY: number, blockZ: number}){
    const key = this.getKey({chunkX, chunkZ, blockX, blockY, blockZ});
    const blockID = this.data[key];
    return blockID;
  }

  set({chunkX, chunkZ, blockX, blockY, blockZ, blockID}: {chunkX: number, chunkZ: number, blockX: number, blockY: number, blockZ: number, blockID: number}){
    const key = this.getKey({chunkX, chunkZ, blockX, blockY, blockZ});
    this.data[key] = blockID;
  }

  getKey({chunkX, chunkZ, blockX, blockY, blockZ}: {chunkX: number, chunkZ: number, blockX: number, blockY: number, blockZ: number}){
    return `${chunkX}-${chunkZ},${blockX}-${blockY}-${blockZ}`;
  }
} 