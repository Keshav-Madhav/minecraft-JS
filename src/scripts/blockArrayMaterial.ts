import * as THREE from 'three';
import { TEXTURE_LAYER, LAYER_COUNT } from './blockTypes';

// One texture layer per distinct block-face texture, packed into a single
// DataArrayTexture so every block type can be drawn by ONE material -> one draw
// call per chunk instead of one per material.
const LAYER_URLS: (string | null)[] = [];
LAYER_URLS[TEXTURE_LAYER.dirt] = 'textures/dirt.png';
LAYER_URLS[TEXTURE_LAYER.grassTop] = 'textures/grass.png';
LAYER_URLS[TEXTURE_LAYER.grassSide] = 'textures/grass_side.png';
LAYER_URLS[TEXTURE_LAYER.stone] = 'textures/stone.png';
LAYER_URLS[TEXTURE_LAYER.coal] = 'textures/coal_ore.png';
LAYER_URLS[TEXTURE_LAYER.iron] = 'textures/iron_ore.png';
LAYER_URLS[TEXTURE_LAYER.sand] = 'textures/sand.png';
LAYER_URLS[TEXTURE_LAYER.treeSide] = 'textures/tree_side.png';
LAYER_URLS[TEXTURE_LAYER.treeTop] = 'textures/tree_top.png';
LAYER_URLS[TEXTURE_LAYER.leaves] = 'textures/leaves.png';
LAYER_URLS[TEXTURE_LAYER.snow] = 'textures/snow.png';
LAYER_URLS[TEXTURE_LAYER.white] = null; // generated solid white (clouds)
// --- biome expansion: textures live in the separate public/textures/biomes dir ---
LAYER_URLS[TEXTURE_LAYER.cherryLogSide] = 'textures/biomes/cherry_log_side.png';
LAYER_URLS[TEXTURE_LAYER.cherryLogTop] = 'textures/biomes/cherry_log_top.png';
LAYER_URLS[TEXTURE_LAYER.cherryLeaves] = 'textures/biomes/cherry_leaves.png';
LAYER_URLS[TEXTURE_LAYER.myceliumTop] = 'textures/biomes/mycelium_top.png';
LAYER_URLS[TEXTURE_LAYER.myceliumSide] = 'textures/biomes/mycelium_side.png';
LAYER_URLS[TEXTURE_LAYER.redSand] = 'textures/biomes/red_sand.png';
LAYER_URLS[TEXTURE_LAYER.terracottaOrange] = 'textures/biomes/terracotta_orange.png';
LAYER_URLS[TEXTURE_LAYER.terracottaWhite] = 'textures/biomes/terracotta_white.png';
LAYER_URLS[TEXTURE_LAYER.terracottaYellow] = 'textures/biomes/terracotta_yellow.png';
LAYER_URLS[TEXTURE_LAYER.terracottaRed] = 'textures/biomes/terracotta_red.png';
LAYER_URLS[TEXTURE_LAYER.terracottaBrown] = 'textures/biomes/terracotta_brown.png';
LAYER_URLS[TEXTURE_LAYER.terracottaLightGray] = 'textures/biomes/terracotta_light_gray.png';
LAYER_URLS[TEXTURE_LAYER.mud] = 'textures/biomes/mud.png';
LAYER_URLS[TEXTURE_LAYER.cactusTop] = 'textures/biomes/cactus_top.png';
LAYER_URLS[TEXTURE_LAYER.cactusBottom] = 'textures/biomes/cactus_bottom.png';
LAYER_URLS[TEXTURE_LAYER.cactusSide] = 'textures/biomes/cactus_side.png';
LAYER_URLS[TEXTURE_LAYER.mushroomRed] = 'textures/biomes/mushroom_red.png';
LAYER_URLS[TEXTURE_LAYER.mushroomBrown] = 'textures/biomes/mushroom_brown.png';
LAYER_URLS[TEXTURE_LAYER.mushroomStem] = 'textures/biomes/mushroom_stem.png';
LAYER_URLS[TEXTURE_LAYER.mushroomPores] = 'textures/biomes/mushroom_pores.png';

const TILE = 16;

function createArrayTexture(): THREE.DataArrayTexture {
  // Allocate the full RGBA array upfront so the uniform is always a valid
  // sampler; pixel data streams in as each PNG decodes. White layer is filled
  // immediately so clouds render even before images load.
  const data = new Uint8Array(TILE * TILE * 4 * LAYER_COUNT);
  const whiteOffset = TEXTURE_LAYER.white * TILE * TILE * 4;
  data.fill(255, whiteOffset, whiteOffset + TILE * TILE * 4);

  const texture = new THREE.DataArrayTexture(data, TILE, TILE, LAYER_COUNT);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter; // mipmaps => cheap texture LOD far away
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  // Anisotropic filtering keeps textures crisp on surfaces viewed at a grazing
  // angle (long stretches of ground toward the horizon) instead of smearing into
  // a muddy blur. three clamps this to the GPU's max automatically.
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  // Decode each PNG into its layer via an offscreen canvas.
  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  let pending = 0;
  // Flag a single GPU re-upload (+ mipmap regen) once the LAST layer decodes,
  // instead of once per layer — collapses ~30 full-array re-uploads into one.
  const done = () => { if (--pending === 0) texture.needsUpdate = true; };
  LAYER_URLS.forEach((url, layer) => {
    if (!url) return;
    pending++;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, TILE, TILE);
      ctx.drawImage(img, 0, 0, TILE, TILE);
      const pixels = ctx.getImageData(0, 0, TILE, TILE).data;
      data.set(pixels, layer * TILE * TILE * 4);
      done();
    };
    img.onerror = () => {
      // A missing/broken texture would otherwise render as silent black; fill the
      // layer magenta so the failure is obvious, and log which URL failed.
      console.warn(`block texture failed to load: ${url}`);
      const off = layer * TILE * TILE * 4;
      for (let i = 0; i < TILE * TILE; i++) { data[off + i * 4] = 255; data[off + i * 4 + 1] = 0; data[off + i * 4 + 2] = 255; data[off + i * 4 + 3] = 255; }
      done();
    };
    img.src = url;
  });

  return texture;
}

const arrayTexture = createArrayTexture();

// Shared material for every chunk's opaque geometry. A standard MeshLambertMaterial
// (so it keeps three's lighting/shadows) is patched to sample the array texture by
// a per-vertex layer index, using textureGrad with the un-fract'd derivatives so
// greedy-merged quads tile cleanly without mip seams.
export const blockArrayMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
blockArrayMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uArray = { value: arrayTexture };

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', /* glsl */`
      #include <common>
      attribute vec2 tileUv;
      attribute float layerIndex;
      varying vec2 vTileUv;
      varying float vLayer;
    `)
    .replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      vTileUv = tileUv;
      vLayer = layerIndex;
    `);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', /* glsl */`
      #include <common>
      uniform sampler2DArray uArray;
      varying vec2 vTileUv;
      varying float vLayer;
    `)
    .replace('#include <map_fragment>', /* glsl */`
      // Flip V: DataArrayTexture stores image rows top-to-bottom, but world V
      // increases upward, so without this side textures appear upside down.
      vec2 auv = fract(vTileUv);
      auv.y = 1.0 - auv.y;
      vec4 texel = textureGrad(uArray, vec3(auv, vLayer), dFdx(vTileUv), dFdy(vTileUv));
      // sRGB -> linear so lighting is correct (output is re-encoded by three).
      texel.rgb = pow(texel.rgb, vec3(2.2));
      diffuseColor *= texel;
    `);
};
