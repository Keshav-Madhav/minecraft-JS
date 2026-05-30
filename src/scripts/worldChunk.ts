import * as THREE from 'three';
import { Object3D } from 'three';
import { DataStore } from './dataStore';
import { ChunkParams, ChunkSize, blockIndex, generateChunkData } from './chunkGen';
import { ResourceGenInfo, BLOCK_IDS } from './blockTypes';
import { blockArrayMaterial, leafArrayMaterial, plantMaterial } from './blockArrayMaterial';
import { buildChunkGeometry, buildChunkMapTile, scanEmitters, GeometryArrays } from './chunkMesh';

// Returns the block id at a world position, or 0 (air) when unknown. Used so a
// chunk can cull faces against blocks that live in neighbouring chunks.
export type WorldBlockGetter = (worldX: number, worldY: number, worldZ: number) => number;
// Climate grass tint (rgb 0..1) at a world column — baked into plant vertices.
export type WorldTintGetter = (worldX: number, worldZ: number) => readonly [number, number, number];

export class WorldChunk extends THREE.Group {
  loaded: boolean;
  hasData: boolean;
  size: ChunkSize;
  params: ChunkParams;
  data: Uint8Array;
  dataStore: DataStore;
  // Light-emitter world positions [wx,wy,wz,id,…] in this chunk (set from the
  // worker mesh message, or rescanned locally on edit). Read by the point-light pool.
  lightEmitters: Float32Array = new Float32Array(0);

  // W×W RGBA top-down minimap tile (from the worker, or rebuilt locally on edit).
  // Lazily wrapped in a tiny canvas the minimap can blit directly (fast path).
  mapTile: Uint8Array | null = null;
  private mapTileCanvas: HTMLCanvasElement | null = null;
  // The plant (foliage) mesh, tracked so the world can distance-cull it cheaply.
  plantMesh: THREE.Mesh | null = null;

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
  generate(resources: ResourceGenInfo[], getWorldBlock?: WorldBlockGetter, getTint?: WorldTintGetter) {
    const data = generateChunkData(this.size, this.params, this.position.x, this.position.z, resources);
    this.setData(data);
    this.buildMeshes(getWorldBlock, getTint);
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
  buildMeshes(getWorldBlock?: WorldBlockGetter, getTint?: WorldTintGetter) {
    if (!this.hasData) return;
    const getOutside = (lx: number, y: number, lz: number) =>
      getWorldBlock ? getWorldBlock(this.position.x + lx, y, this.position.z + lz) : BLOCK_IDS.air;
    const tintAt = getTint
      ? (lx: number, lz: number) => getTint(this.position.x + lx, this.position.z + lz)
      : undefined;
    const geometry = buildChunkGeometry(this.data, this.size, getOutside, tintAt);
    this.applyGeometry(geometry.casters, geometry.nonCasters, geometry.plants);
    // local (edit / no-worker) path → rescan emitters so placing a torch lights up
    this.lightEmitters = scanEmitters(this.data, this.size, this.position.x, this.position.z);
    // rebuild the minimap tile so edits show on the map immediately (water hue
    // falls back to the default ocean blue here — only matters for the rare
    // edit to a submerged column; streamed chunks carry the per-biome hue)
    this.setMapTile(buildChunkMapTile(this.data, this.size, this.params.terrain.waterOffset, tintAt));
  }

  // Adopt emitter positions computed by the worker (streamed-chunk path).
  setEmitters(e: Float32Array) { this.lightEmitters = e; }

  // Adopt the worker's minimap tile (streamed-chunk path); drops the cached canvas.
  setMapTile(t: Uint8Array) { this.mapTile = t; this.mapTileCanvas = null; }

  // A tiny W×W canvas wrapping `mapTile`, built once and cached, for the minimap to
  // drawImage-scale directly (far cheaper than putImageData per frame).
  getMapTileCanvas(): HTMLCanvasElement | null {
    if (this.mapTileCanvas) return this.mapTileCanvas;
    if (!this.mapTile) return null;
    const W = this.size.width;
    const c = document.createElement('canvas');
    c.width = c.height = W;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(this.mapTile), W, W), 0, 0);
    this.mapTileCanvas = c;
    return c;
  }

  // Turn geometry buffers (from the worker or the local mesher) into THREE
  // meshes. One mesh for shadow casters, one for leaves/clouds — so ~1-2 draw
  // calls per chunk regardless of how many block types it contains. Water is a
  // single world-wide sea-level plane (see World/main), not per-chunk, so it no
  // longer adds a transparent draw + depth-sort entry for every land chunk.
  applyGeometry(casters: GeometryArrays | null, nonCasters: GeometryArrays | null, plants: GeometryArrays | null) {
    this.clearMeshes();
    this.addGeometryMesh(casters, true, blockArrayMaterial);
    // Leaves + clouds (the "non-caster" group) use the ALPHA-TESTED leaf material
    // so the cutout holes in the leaf textures show through (transparent fancy
    // leaves); clouds are opaque so alphaTest keeps them. Still cast shadows.
    this.addGeometryMesh(nonCasters, true, leafArrayMaterial);
    // Foliage: alpha-tested cross billboards / carpets / vines on their own
    // material. They don't cast shadows (cheap, and avoids shadow-acne on thin
    // geometry) and carry a per-vertex biome tint (plantColor, vec4).
    this.addGeometryMesh(plants, false, plantMaterial);
    this.loaded = true;
  }

  private addGeometryMesh(arrays: GeometryArrays | null, castShadow: boolean, material: THREE.Material) {
    if (!arrays || arrays.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(arrays.normals, 3));
    geometry.setAttribute('tileUv', new THREE.BufferAttribute(arrays.uvs, 2));
    geometry.setAttribute('layerIndex', new THREE.BufferAttribute(arrays.layers, 1));
    if (arrays.colors) {
      // normalized=true → the Uint8 0..255 tint/sway is read as 0..1 in the shader.
      // Plants read it as `plantColor` (rgb tint + sway a); opaque cubes read it as
      // `tintColor` (rgb biome tint, white where untinted) in blockArrayMaterial.
      const attr = new THREE.BufferAttribute(arrays.colors, 4, true);
      geometry.setAttribute(material === plantMaterial ? 'plantColor' : 'tintColor', attr);
    }
    geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
    geometry.computeBoundingSphere(); // tight bounds so frustum culling is accurate

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.userData.chunkGeometry = true;
    mesh.matrixAutoUpdate = false; // static — never moves
    mesh.updateMatrix();
    if (material === plantMaterial) this.plantMesh = mesh;   // tracked for distance culling
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

  addBlock(x: number, y: number, z: number, id: number, getWorldBlock?: WorldBlockGetter, getTint?: WorldTintGetter) {
    if (this.getBlockId(x, y, z) === BLOCK_IDS.air) {
      this.setBlockId(x, y, z, id);
      this.dataStore.set({ chunkX: this.position.x, chunkZ: this.position.z, blockX: x, blockY: y, blockZ: z, blockID: id });
      this.buildMeshes(getWorldBlock, getTint);
    }
  }

  removeBlock(x: number, y: number, z: number, getWorldBlock?: WorldBlockGetter, getTint?: WorldTintGetter) {
    if (this.getBlockId(x, y, z) !== BLOCK_IDS.air) {
      this.setBlockId(x, y, z, BLOCK_IDS.air);
      this.dataStore.set({ chunkX: this.position.x, chunkZ: this.position.z, blockX: x, blockY: y, blockZ: z, blockID: BLOCK_IDS.air });
      this.buildMeshes(getWorldBlock, getTint);
    }
  }

  // Overwrite a block regardless of its current value (used for door/trapdoor
  // toggle, where the target is non-air). Persists the edit + re-meshes.
  setBlockEdit(x: number, y: number, z: number, id: number, getWorldBlock?: WorldBlockGetter, getTint?: WorldTintGetter) {
    this.setBlockId(x, y, z, id);
    this.dataStore.set({ chunkX: this.position.x, chunkZ: this.position.z, blockX: x, blockY: y, blockZ: z, blockID: id });
    this.buildMeshes(getWorldBlock, getTint);
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
    this.plantMesh = null;
    this.loaded = false;
  }

  disposeInstance() {
    this.disposeMeshGeometries();
    this.clear();
    this.loaded = false;
    this.hasData = false;
    this.mapTile = null;
    this.mapTileCanvas = null;
  }
}
