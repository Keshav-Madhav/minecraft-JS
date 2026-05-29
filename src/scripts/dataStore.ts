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

  // True if the player has placed/removed any block in this chunk. Used to
  // decide whether worker-produced geometry (built from raw terrain) is stale.
  hasChunkEdits(chunkX: number, chunkZ: number){
    const prefix = `${chunkX}-${chunkZ},`;
    for(const key in this.data){
      if(key.startsWith(prefix)) return true;
    }
    return false;
  }

  // Visit only the player's edits inside one chunk. The store holds a handful of
  // edited blocks total, so iterating its keys is far cheaper than scanning all
  // width*height*width cells of the chunk (the hot path on every chunk apply).
  // Key layout: "<chunkX>-<chunkZ>,<blockX>-<blockY>-<blockZ>"; block coords are
  // always non-negative so the suffix splits cleanly on '-'.
  forEachEdit(chunkX: number, chunkZ: number, cb: (x: number, y: number, z: number, id: number) => void){
    const prefix = `${chunkX}-${chunkZ},`;
    for(const key in this.data){
      if(!key.startsWith(prefix)) continue;
      const parts = key.slice(prefix.length).split('-');
      cb(+parts[0], +parts[1], +parts[2], this.data[key]);
    }
  }
}