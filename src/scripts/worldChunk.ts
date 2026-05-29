import * as THREE from 'three';
import { Object3D } from 'three';
import { DataStore } from './dataStore';
import { ChunkParams, ChunkSize, blockIndex, generateChunkData } from './chunkGen';
import { ResourceGenInfo, BLOCK_IDS } from './blockTypes';
import { blockArrayMaterial, plantMaterial } from './blockArrayMaterial';
import { buildChunkGeometry, GeometryArrays } from './chunkMesh';

// Returns the block id at a world position, or 0 (air) when unknown. Used so a
// chunk can cull faces against blocks that live in neighbouring chunks.
export type WorldBlockGetter = (worldX: number, worldY: number, worldZ: number) => number;
// Biome id at a world column — bakes the per-column grass tint into plant verts.
export type WorldBiomeGetter = (worldX: number, worldZ: number) => number;

export class WorldChunk extends THREE.Group {
  loaded: boolean;
  hasData: boolean;
  size: ChunkSize;
  params: ChunkParams;
  data: Uint8Array;
  dataStore: DataStore;

  constructor(size: ChunkSize, params: ChunkParams, dataStore: DataStore) {
    super();
    this.loaded = false;
    this.hasData = false;
    this.size = size;
    this.params = params;
    this.dataStore = dataStore;
    this.data = new Uint8Array(0);
  }

  // Synchronous generation path (used when no worker is available).
  generate(resources: ResourceGenInfo[], getWorldBlock?: WorldBlockGetter, getBiome?: WorldBiomeGetter) {
    const data = generateChunkData(this.size, this.params, this.position.x, this.position.z, resources);
    this.setData(data);
    this.buildMeshes(getWorldBlock, getBiome);
  }

  // Adopt freshly generated block data, then layer any player edits on top.
  setData(data: Uint8Array) {
    this.data = data;
    this.hasData = true;
    this.loadPlayerChanges();
  }

  loadPlayerChanges() {
    // Apply only the cells the player actually edited (usually none), instead of
    // probing all width*height*width cells — that full scan, run on every chunk
    // apply, was the main streaming stutter at 256-tall chunks.
    this.dataStore.forEachEdit(this.position.x, this.position.z, (x, y, z, id) => {
      this.setBlockId(x, y, z, id);
    });
  }

  // Local meshing path (single-block edits, and the no-worker fallback). During
  // normal streaming the worker meshes off-thread and we call applyGeometry().
  buildMeshes(getWorldBlock?: WorldBlockGetter, getBiome?: WorldBiomeGetter) {
    if (!this.hasData) return;
    const getOutside = (lx: number, y: number, lz: number) =>
      getWorldBlock ? getWorldBlock(this.position.x + lx, y, this.position.z + lz) : BLOCK_IDS.air;
    const biomeAt = getBiome
      ? (lx: number, lz: number) => getBiome(this.position.x + lx, this.position.z + lz)
      : undefined;
    const geometry = buildChunkGeometry(this.data, this.size, getOutside, biomeAt);
    this.applyGeometry(geometry.casters, geometry.nonCasters, geometry.plants);
  }

  // Turn geometry buffers (from the worker or the local mesher) into THREE
  // meshes. One mesh for shadow casters, one for leaves/clouds — so ~1-2 draw
  // calls per chunk regardless of how many block types it contains. Water is a
  // single world-wide sea-level plane (see World/main), not per-chunk, so it no
  // longer adds a transparent draw + depth-sort entry for every land chunk.
  applyGeometry(casters: GeometryArrays | null, nonCasters: GeometryArrays | null, plants: GeometryArrays | null) {
    this.clearMeshes();
    this.addGeometryMesh(casters, true, blockArrayMaterial, false);
    // Leaves (the "non-caster" group) DO cast shadows now — trees were casting
    // only their trunks, so canopies floated shadowless. They're still a
    // separate mesh from the opaque casters for material/sorting reasons.
    this.addGeometryMesh(nonCasters, true, blockArrayMaterial, false);
    // Foliage: alpha-tested cross billboards / carpets / vines on their own
    // material. They don't cast shadows (cheap, and avoids shadow-acne on thin
    // geometry) and carry a per-vertex biome tint (plantColor, vec4).
    this.addGeometryMesh(plants, false, plantMaterial, true);
    this.loaded = true;
  }

  private addGeometryMesh(arrays: GeometryArrays | null, castShadow: boolean,
    material: THREE.Material, withColor: boolean) {
    if (!arrays || arrays.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(arrays.normals, 3));
    geometry.setAttribute('tileUv', new THREE.BufferAttribute(arrays.uvs, 2));
    geometry.setAttribute('layerIndex', new THREE.BufferAttribute(arrays.layers, 1));
    if (withColor && arrays.colors) {
      // normalized=true → the Uint8 0..255 tint/sway is read as 0..1 in the shader
      geometry.setAttribute('plantColor', new THREE.BufferAttribute(arrays.colors, 4, true));
    }
    geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
    geometry.computeBoundingSphere(); // tight bounds so frustum culling is accurate

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.userData.chunkGeometry = true;
    mesh.matrixAutoUpdate = false; // static — never moves
    mesh.updateMatrix();
    this.add(mesh);
  }

  getBlockId(x: number, y: number, z: number) {
    if (!this.hasData || !this.inBounds(x, y, z)) return BLOCK_IDS.air;
    return this.data[blockIndex(x, y, z, this.size)];
  }

  getBlock(x: number, y: number, z: number) {
    if (this.inBounds(x, y, z)) {
      return { id: this.getBlockId(x, y, z) };
    }
    return null;
  }

  inBounds(x: number, y: number, z: number) {
    return x >= 0 && x < this.size.width &&
           y >= 0 && y < this.size.height &&
           z >= 0 && z < this.size.width;
  }

  setBlockId(x: number, y: number, z: number, id: number) {
    if (this.inBounds(x, y, z)) {
      this.data[blockIndex(x, y, z, this.size)] = id;
    }
  }

  addBlock(x: number, y: number, z: number, id: number, getWorldBlock?: WorldBlockGetter, getBiome?: WorldBiomeGetter) {
    if (this.getBlockId(x, y, z) === BLOCK_IDS.air) {
      this.setBlockId(x, y, z, id);
      this.dataStore.set({ chunkX: this.position.x, chunkZ: this.position.z, blockX: x, blockY: y, blockZ: z, blockID: id });
      this.buildMeshes(getWorldBlock, getBiome);
    }
  }

  removeBlock(x: number, y: number, z: number, getWorldBlock?: WorldBlockGetter, getBiome?: WorldBiomeGetter) {
    if (this.getBlockId(x, y, z) !== BLOCK_IDS.air) {
      this.setBlockId(x, y, z, BLOCK_IDS.air);
      this.dataStore.set({ chunkX: this.position.x, chunkZ: this.position.z, blockX: x, blockY: y, blockZ: z, blockID: BLOCK_IDS.air });
      this.buildMeshes(getWorldBlock, getBiome);
    }
  }

  // Dispose the per-chunk geometry of every built block mesh. Shared resources
  // (the array material, water geometry/material) are left intact.
  private disposeMeshGeometries() {
    for (const child of this.children) {
      if ((child as Object3D).userData?.chunkGeometry) {
        (child as THREE.Mesh).geometry.dispose();
      }
    }
  }

  clearMeshes() {
    this.disposeMeshGeometries();
    this.clear();
    this.loaded = false;
  }

  disposeInstance() {
    this.disposeMeshGeometries();
    this.clear();
    this.loaded = false;
    this.hasData = false;
  }
}
