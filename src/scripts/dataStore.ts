type EditQuery = { chunkX: number, chunkZ: number, blockX: number, blockY: number, blockZ: number };

export class DataStore {
  data: { [key: string]: number };
  // Set of "<chunkX>-<chunkZ>" prefixes that have at least one edit. Lets
  // hasChunkEdits / forEachEdit answer the common "no edits here" case in O(1)
  // instead of scanning the whole edit store — that scan was being run up to
  // ~5×/applied-chunk on the streaming hot path.
  private editedChunks: Set<string>;

  constructor() {
    this.data = {};
    this.editedChunks = new Set();
  }

  clear() {
    this.data = {};
    this.editedChunks.clear();
  }

  // Rebuild the edit index from `data` — call after assigning `data` directly
  // (e.g. load()), which bypasses set() and would otherwise leave the index stale
  // so edits silently fail to re-apply.
  rebuildIndex() {
    this.editedChunks.clear();
    for (const key in this.data) {
      this.editedChunks.add(key.slice(0, key.indexOf(',')));
    }
  }

  contains({ chunkX, chunkZ, blockX, blockY, blockZ }: EditQuery) {
    return this.data[this.getKey({ chunkX, chunkZ, blockX, blockY, blockZ })] !== undefined;
  }

  get({ chunkX, chunkZ, blockX, blockY, blockZ }: EditQuery) {
    return this.data[this.getKey({ chunkX, chunkZ, blockX, blockY, blockZ })];
  }

  set({ chunkX, chunkZ, blockX, blockY, blockZ, blockID }: EditQuery & { blockID: number }) {
    this.data[this.getKey({ chunkX, chunkZ, blockX, blockY, blockZ })] = blockID;
    this.editedChunks.add(`${chunkX}-${chunkZ}`);
  }

  getKey({ chunkX, chunkZ, blockX, blockY, blockZ }: EditQuery) {
    return `${chunkX}-${chunkZ},${blockX}-${blockY}-${blockZ}`;
  }

  // True if the player has placed/removed any block in this chunk. Used to decide
  // whether worker-produced geometry (built from raw terrain) is stale. O(1).
  hasChunkEdits(chunkX: number, chunkZ: number) {
    return this.editedChunks.has(`${chunkX}-${chunkZ}`);
  }

  // Visit only the player's edits inside one chunk. Early-outs in O(1) when the
  // chunk has no edits (the common case on the apply hot path); otherwise scans
  // the store. Key layout: "<chunkX>-<chunkZ>,<blockX>-<blockY>-<blockZ>"; block
  // coords are always non-negative so the suffix splits cleanly on '-'.
  forEachEdit(chunkX: number, chunkZ: number, cb: (x: number, y: number, z: number, id: number) => void) {
    if (!this.editedChunks.has(`${chunkX}-${chunkZ}`)) return;
    const prefix = `${chunkX}-${chunkZ},`;
    for (const key in this.data) {
      if (!key.startsWith(prefix)) continue;
      const parts = key.slice(prefix.length).split('-');
      cb(+parts[0], +parts[1], +parts[2], this.data[key]);
    }
  }
}
