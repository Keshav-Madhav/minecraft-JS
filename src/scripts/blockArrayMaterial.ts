import * as THREE from 'three';
import { TEXTURE_LAYER, LAYER_COUNT } from './blockTypes';
import { assetUrl } from './assetBase';

// One texture layer per distinct block-face texture, packed into a single
// DataArrayTexture so every block type can be drawn by ONE material -> one draw
// call per chunk instead of one per material.
const LAYER_URLS: (string | null)[] = [];
LAYER_URLS[TEXTURE_LAYER.dirt] = 'textures/dirt.png';
// grass top + oak leaves are GRAYSCALE and biome-tinted at mesh build (see chunkMesh)
LAYER_URLS[TEXTURE_LAYER.grassTop] = 'textures/biomes/grass_top_gray.png';
LAYER_URLS[TEXTURE_LAYER.grassSide] = 'textures/grass_side.png';
LAYER_URLS[TEXTURE_LAYER.stone] = 'textures/stone.png';
LAYER_URLS[TEXTURE_LAYER.bedrock] = 'textures/bedrock.png';
LAYER_URLS[TEXTURE_LAYER.lava] = 'textures/lava.png';
// Wave-4 vegetation
LAYER_URLS[TEXTURE_LAYER.kelp] = 'textures/foliage/kelp.png';
LAYER_URLS[TEXTURE_LAYER.kelpTop] = 'textures/foliage/kelp_top.png';
LAYER_URLS[TEXTURE_LAYER.bamboo] = 'textures/foliage/bamboo.png';
LAYER_URLS[TEXTURE_LAYER.sweetBerryBush] = 'textures/foliage/sweet_berry_bush.png';
LAYER_URLS[TEXTURE_LAYER.sunflowerBottom] = 'textures/foliage/sunflower_bottom.png';
LAYER_URLS[TEXTURE_LAYER.sunflowerTop] = 'textures/foliage/sunflower_top.png';
LAYER_URLS[TEXTURE_LAYER.lilacBottom] = 'textures/foliage/lilac_bottom.png';
LAYER_URLS[TEXTURE_LAYER.lilacTop] = 'textures/foliage/lilac_top.png';
LAYER_URLS[TEXTURE_LAYER.roseBushBottom] = 'textures/foliage/rose_bush_bottom.png';
LAYER_URLS[TEXTURE_LAYER.roseBushTop] = 'textures/foliage/rose_bush_top.png';
LAYER_URLS[TEXTURE_LAYER.peonyBottom] = 'textures/foliage/peony_bottom.png';
LAYER_URLS[TEXTURE_LAYER.peonyTop] = 'textures/foliage/peony_top.png';
LAYER_URLS[TEXTURE_LAYER.seaPickle] = 'textures/foliage/sea_pickle.png';
LAYER_URLS[TEXTURE_LAYER.pumpkinTop] = 'textures/pumpkin_top.png';
LAYER_URLS[TEXTURE_LAYER.pumpkinSide] = 'textures/pumpkin_side.png';
LAYER_URLS[TEXTURE_LAYER.coal] = 'textures/coal_ore.png';
LAYER_URLS[TEXTURE_LAYER.iron] = 'textures/iron_ore.png';
LAYER_URLS[TEXTURE_LAYER.sand] = 'textures/sand.png';
LAYER_URLS[TEXTURE_LAYER.treeSide] = 'textures/tree_side.png';
LAYER_URLS[TEXTURE_LAYER.treeTop] = 'textures/tree_top.png';
LAYER_URLS[TEXTURE_LAYER.leaves] = 'textures/biomes/oak_leaves_gray.png';
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
// --- foliage (original procedural RGBA textures with transparency) ---
LAYER_URLS[TEXTURE_LAYER.shortGrass] = 'textures/foliage/short_grass.png';
LAYER_URLS[TEXTURE_LAYER.fern] = 'textures/foliage/fern.png';
LAYER_URLS[TEXTURE_LAYER.tallGrassBottom] = 'textures/foliage/tall_grass_bottom.png';
LAYER_URLS[TEXTURE_LAYER.tallGrassTop] = 'textures/foliage/tall_grass_top.png';
LAYER_URLS[TEXTURE_LAYER.vine] = 'textures/foliage/vine.png';
LAYER_URLS[TEXTURE_LAYER.deadBush] = 'textures/foliage/dead_bush.png';
LAYER_URLS[TEXTURE_LAYER.lilyPad] = 'textures/foliage/lily_pad.png';
LAYER_URLS[TEXTURE_LAYER.cherryPetals] = 'textures/foliage/cherry_petals.png';
LAYER_URLS[TEXTURE_LAYER.leafLitter] = 'textures/foliage/leaf_litter.png';
LAYER_URLS[TEXTURE_LAYER.flowerDandelion] = 'textures/foliage/flower_dandelion.png';
LAYER_URLS[TEXTURE_LAYER.flowerPoppy] = 'textures/foliage/flower_poppy.png';
LAYER_URLS[TEXTURE_LAYER.flowerCornflower] = 'textures/foliage/flower_cornflower.png';
LAYER_URLS[TEXTURE_LAYER.flowerOxeye] = 'textures/foliage/flower_oxeye.png';
LAYER_URLS[TEXTURE_LAYER.flowerAllium] = 'textures/foliage/flower_allium.png';
LAYER_URLS[TEXTURE_LAYER.flowerTulip] = 'textures/foliage/flower_tulip.png';
LAYER_URLS[TEXTURE_LAYER.seaGrass] = 'textures/foliage/sea_grass.png';
LAYER_URLS[TEXTURE_LAYER.tallSeagrassBottom] = 'textures/foliage/tall_seagrass_bottom.png';
LAYER_URLS[TEXTURE_LAYER.tallSeagrassTop] = 'textures/foliage/tall_seagrass_top.png';
LAYER_URLS[TEXTURE_LAYER.largeFernBottom] = 'textures/foliage/large_fern_bottom.png';
LAYER_URLS[TEXTURE_LAYER.largeFernTop] = 'textures/foliage/large_fern_top.png';
// --- building blocks + wood variants + clay/gravel/sandstone/glass ---
LAYER_URLS[TEXTURE_LAYER.cobblestone] = 'textures/biomes/cobblestone.png';
LAYER_URLS[TEXTURE_LAYER.oakPlanks] = 'textures/biomes/oak_planks.png';
LAYER_URLS[TEXTURE_LAYER.birchPlanks] = 'textures/biomes/birch_planks.png';
LAYER_URLS[TEXTURE_LAYER.darkOakPlanks] = 'textures/biomes/dark_oak_planks.png';
LAYER_URLS[TEXTURE_LAYER.junglePlanks] = 'textures/biomes/jungle_planks.png';
LAYER_URLS[TEXTURE_LAYER.strippedOakLogSide] = 'textures/biomes/stripped_oak_log_side.png';
LAYER_URLS[TEXTURE_LAYER.birchLogSide] = 'textures/biomes/birch_log_side.png';
LAYER_URLS[TEXTURE_LAYER.birchLogTop] = 'textures/biomes/birch_log_top.png';
LAYER_URLS[TEXTURE_LAYER.darkOakLogSide] = 'textures/biomes/dark_oak_log_side.png';
LAYER_URLS[TEXTURE_LAYER.darkOakLogTop] = 'textures/biomes/dark_oak_log_top.png';
LAYER_URLS[TEXTURE_LAYER.jungleLogSide] = 'textures/biomes/jungle_log_side.png';
LAYER_URLS[TEXTURE_LAYER.jungleLogTop] = 'textures/biomes/jungle_log_top.png';
LAYER_URLS[TEXTURE_LAYER.birchLeaves] = 'textures/biomes/birch_leaves.png';
LAYER_URLS[TEXTURE_LAYER.darkOakLeaves] = 'textures/biomes/dark_oak_leaves.png';
LAYER_URLS[TEXTURE_LAYER.jungleLeaves] = 'textures/biomes/jungle_leaves.png';
LAYER_URLS[TEXTURE_LAYER.gravel] = 'textures/biomes/gravel.png';
LAYER_URLS[TEXTURE_LAYER.clay] = 'textures/biomes/clay.png';
LAYER_URLS[TEXTURE_LAYER.sandstone] = 'textures/biomes/sandstone.png';
LAYER_URLS[TEXTURE_LAYER.sandstoneTop] = 'textures/biomes/sandstone_top.png';
LAYER_URLS[TEXTURE_LAYER.glass] = 'textures/biomes/glass.png';
LAYER_URLS[TEXTURE_LAYER.stoneBricks] = 'textures/biomes/stone_bricks.png';
LAYER_URLS[TEXTURE_LAYER.bricks] = 'textures/biomes/bricks.png';
LAYER_URLS[TEXTURE_LAYER.mossyCobblestone] = 'textures/biomes/mossy_cobblestone.png';
LAYER_URLS[TEXTURE_LAYER.smoothStone] = 'textures/biomes/smooth_stone.png';
LAYER_URLS[TEXTURE_LAYER.bookshelf] = 'textures/biomes/bookshelf.png';
LAYER_URLS[TEXTURE_LAYER.glowstone] = 'textures/biomes/glowstone.png';
LAYER_URLS[TEXTURE_LAYER.oakDoor] = 'textures/biomes/oak_door.png';
LAYER_URLS[TEXTURE_LAYER.oakTrapdoor] = 'textures/biomes/oak_trapdoor.png';
// --- interior furniture ---
LAYER_URLS[TEXTURE_LAYER.furnaceSide] = 'textures/biomes/furnace_side.png';
LAYER_URLS[TEXTURE_LAYER.furnaceFront] = 'textures/biomes/furnace_front.png';
LAYER_URLS[TEXTURE_LAYER.furnaceFrontLit] = 'textures/biomes/furnace_front_lit.png';
LAYER_URLS[TEXTURE_LAYER.furnaceTop] = 'textures/biomes/furnace_top.png';
LAYER_URLS[TEXTURE_LAYER.craftingTableTop] = 'textures/biomes/crafting_table_top.png';
LAYER_URLS[TEXTURE_LAYER.craftingTableSide] = 'textures/biomes/crafting_table_side.png';
LAYER_URLS[TEXTURE_LAYER.chestFront] = 'textures/biomes/chest_front.png';
LAYER_URLS[TEXTURE_LAYER.chestSide] = 'textures/biomes/chest_side.png';
LAYER_URLS[TEXTURE_LAYER.chestTop] = 'textures/biomes/chest_top.png';
LAYER_URLS[TEXTURE_LAYER.bedFootTop] = 'textures/biomes/bed_foot_top.png';
LAYER_URLS[TEXTURE_LAYER.bedHeadTop] = 'textures/biomes/bed_head_top.png';
LAYER_URLS[TEXTURE_LAYER.bedSide] = 'textures/biomes/bed_side.png';
LAYER_URLS[TEXTURE_LAYER.barrelTop] = 'textures/biomes/barrel_top.png';
LAYER_URLS[TEXTURE_LAYER.barrelSide] = 'textures/biomes/barrel_side.png';
LAYER_URLS[TEXTURE_LAYER.flowerPot] = 'textures/foliage/flower_pot.png';
LAYER_URLS[TEXTURE_LAYER.ice] = 'textures/biomes/ice.png';
LAYER_URLS[TEXTURE_LAYER.packedIce] = 'textures/biomes/packed_ice.png';
LAYER_URLS[TEXTURE_LAYER.podzolTop] = 'textures/biomes/podzol_top.png';
LAYER_URLS[TEXTURE_LAYER.podzolSide] = 'textures/biomes/podzol_side.png';
LAYER_URLS[TEXTURE_LAYER.mushroomRedSmall] = 'textures/foliage/mushroom_red_small.png';
LAYER_URLS[TEXTURE_LAYER.mushroomBrownSmall] = 'textures/foliage/mushroom_brown_small.png';
LAYER_URLS[TEXTURE_LAYER.sugarCane] = 'textures/foliage/sugar_cane.png';
LAYER_URLS[TEXTURE_LAYER.flowerBlueOrchid] = 'textures/foliage/flower_blue_orchid.png';
// --- expansion set (geology / decorative / ores / mineral / wood / wool) ---
const B = 'textures/biomes/';
LAYER_URLS[TEXTURE_LAYER.andesite] = B + 'andesite.png';
LAYER_URLS[TEXTURE_LAYER.diorite] = B + 'diorite.png';
LAYER_URLS[TEXTURE_LAYER.granite] = B + 'granite.png';
LAYER_URLS[TEXTURE_LAYER.polishedAndesite] = B + 'polished_andesite.png';
LAYER_URLS[TEXTURE_LAYER.polishedDiorite] = B + 'polished_diorite.png';
LAYER_URLS[TEXTURE_LAYER.polishedGranite] = B + 'polished_granite.png';
LAYER_URLS[TEXTURE_LAYER.deepslate] = B + 'deepslate.png';
LAYER_URLS[TEXTURE_LAYER.tuff] = B + 'tuff.png';
LAYER_URLS[TEXTURE_LAYER.calcite] = B + 'calcite.png';
LAYER_URLS[TEXTURE_LAYER.basalt] = B + 'basalt.png';
LAYER_URLS[TEXTURE_LAYER.blackstone] = B + 'blackstone.png';
LAYER_URLS[TEXTURE_LAYER.netherrack] = B + 'netherrack.png';
LAYER_URLS[TEXTURE_LAYER.endStone] = B + 'end_stone.png';
LAYER_URLS[TEXTURE_LAYER.obsidian] = B + 'obsidian.png';
LAYER_URLS[TEXTURE_LAYER.magma] = B + 'magma.png';
LAYER_URLS[TEXTURE_LAYER.quartzBlock] = B + 'quartz_block.png';
LAYER_URLS[TEXTURE_LAYER.quartzPillarSide] = B + 'quartz_pillar_side.png';
LAYER_URLS[TEXTURE_LAYER.quartzPillarTop] = B + 'quartz_pillar_top.png';
LAYER_URLS[TEXTURE_LAYER.netherBricks] = B + 'nether_bricks.png';
LAYER_URLS[TEXTURE_LAYER.prismarine] = B + 'prismarine.png';
LAYER_URLS[TEXTURE_LAYER.prismarineBricks] = B + 'prismarine_bricks.png';
LAYER_URLS[TEXTURE_LAYER.seaLantern] = B + 'sea_lantern.png';
LAYER_URLS[TEXTURE_LAYER.crackedStoneBricks] = B + 'cracked_stone_bricks.png';
LAYER_URLS[TEXTURE_LAYER.chiseledStoneBricks] = B + 'chiseled_stone_bricks.png';
LAYER_URLS[TEXTURE_LAYER.mossyStoneBricks] = B + 'mossy_stone_bricks.png';
LAYER_URLS[TEXTURE_LAYER.cutSandstone] = B + 'cut_sandstone.png';
LAYER_URLS[TEXTURE_LAYER.smoothSandstone] = B + 'smooth_sandstone.png';
LAYER_URLS[TEXTURE_LAYER.chiseledSandstone] = B + 'chiseled_sandstone.png';
LAYER_URLS[TEXTURE_LAYER.redSandstoneSide] = B + 'red_sandstone.png';
LAYER_URLS[TEXTURE_LAYER.redSandstoneTop] = B + 'red_sandstone_top.png';
LAYER_URLS[TEXTURE_LAYER.cutRedSandstone] = B + 'cut_red_sandstone.png';
LAYER_URLS[TEXTURE_LAYER.goldOre] = B + 'gold_ore.png';
LAYER_URLS[TEXTURE_LAYER.diamondOre] = B + 'diamond_ore.png';
LAYER_URLS[TEXTURE_LAYER.emeraldOre] = B + 'emerald_ore.png';
LAYER_URLS[TEXTURE_LAYER.lapisOre] = B + 'lapis_ore.png';
LAYER_URLS[TEXTURE_LAYER.redstoneOre] = B + 'redstone_ore.png';
LAYER_URLS[TEXTURE_LAYER.copperOre] = B + 'copper_ore.png';
LAYER_URLS[TEXTURE_LAYER.goldBlock] = B + 'gold_block.png';
LAYER_URLS[TEXTURE_LAYER.diamondBlock] = B + 'diamond_block.png';
LAYER_URLS[TEXTURE_LAYER.emeraldBlock] = B + 'emerald_block.png';
LAYER_URLS[TEXTURE_LAYER.ironBlock] = B + 'iron_block.png';
LAYER_URLS[TEXTURE_LAYER.lapisBlock] = B + 'lapis_block.png';
LAYER_URLS[TEXTURE_LAYER.redstoneBlock] = B + 'redstone_block.png';
LAYER_URLS[TEXTURE_LAYER.copperBlock] = B + 'copper_block.png';
LAYER_URLS[TEXTURE_LAYER.coalBlock] = B + 'coal_block.png';
LAYER_URLS[TEXTURE_LAYER.acaciaPlanks] = B + 'acacia_planks.png';
LAYER_URLS[TEXTURE_LAYER.sprucePlanks] = B + 'spruce_planks.png';
LAYER_URLS[TEXTURE_LAYER.mangrovePlanks] = B + 'mangrove_planks.png';
LAYER_URLS[TEXTURE_LAYER.cherryPlanks] = B + 'cherry_planks.png';
LAYER_URLS[TEXTURE_LAYER.acaciaLogSide] = B + 'acacia_log_side.png';
LAYER_URLS[TEXTURE_LAYER.acaciaLogTop] = B + 'acacia_log_top.png';
LAYER_URLS[TEXTURE_LAYER.spruceLogSide] = B + 'spruce_log_side.png';
LAYER_URLS[TEXTURE_LAYER.spruceLogTop] = B + 'spruce_log_top.png';
LAYER_URLS[TEXTURE_LAYER.mangroveLogSide] = B + 'mangrove_log_side.png';
LAYER_URLS[TEXTURE_LAYER.mangroveLogTop] = B + 'mangrove_log_top.png';
LAYER_URLS[TEXTURE_LAYER.acaciaLeaves] = B + 'acacia_leaves.png';
LAYER_URLS[TEXTURE_LAYER.spruceLeaves] = B + 'spruce_leaves.png';
LAYER_URLS[TEXTURE_LAYER.mangroveLeaves] = B + 'mangrove_leaves.png';
LAYER_URLS[TEXTURE_LAYER.hayBaleSide] = B + 'hay_bale_side.png';
LAYER_URLS[TEXTURE_LAYER.hayBaleTop] = B + 'hay_bale_top.png';
LAYER_URLS[TEXTURE_LAYER.woolWhite] = B + 'wool_white.png';
LAYER_URLS[TEXTURE_LAYER.woolOrange] = B + 'wool_orange.png';
LAYER_URLS[TEXTURE_LAYER.woolMagenta] = B + 'wool_magenta.png';
LAYER_URLS[TEXTURE_LAYER.woolLightBlue] = B + 'wool_light_blue.png';
LAYER_URLS[TEXTURE_LAYER.woolYellow] = B + 'wool_yellow.png';
LAYER_URLS[TEXTURE_LAYER.woolLime] = B + 'wool_lime.png';
LAYER_URLS[TEXTURE_LAYER.woolPink] = B + 'wool_pink.png';
LAYER_URLS[TEXTURE_LAYER.woolGray] = B + 'wool_gray.png';
LAYER_URLS[TEXTURE_LAYER.woolLightGray] = B + 'wool_light_gray.png';
LAYER_URLS[TEXTURE_LAYER.woolCyan] = B + 'wool_cyan.png';
LAYER_URLS[TEXTURE_LAYER.woolPurple] = B + 'wool_purple.png';
LAYER_URLS[TEXTURE_LAYER.woolBlue] = B + 'wool_blue.png';
LAYER_URLS[TEXTURE_LAYER.woolBrown] = B + 'wool_brown.png';
LAYER_URLS[TEXTURE_LAYER.woolGreen] = B + 'wool_green.png';
LAYER_URLS[TEXTURE_LAYER.woolRed] = B + 'wool_red.png';
LAYER_URLS[TEXTURE_LAYER.woolBlack] = B + 'wool_black.png';
// light-emitting blocks
LAYER_URLS[TEXTURE_LAYER.lantern] = B + 'lantern.png';
LAYER_URLS[TEXTURE_LAYER.torch] = B + 'torch.png';
LAYER_URLS[TEXTURE_LAYER.campfireTop] = B + 'campfire_top.png';
LAYER_URLS[TEXTURE_LAYER.campfireSide] = B + 'campfire_side.png';
LAYER_URLS[TEXTURE_LAYER.jackLanternSide] = B + 'jack_lantern_side.png';
LAYER_URLS[TEXTURE_LAYER.jackLanternTop] = B + 'jack_lantern_top.png';

const TILE = 16;

// Cutout-mip fix (Voxy's "solidify" pass): transparent texels in our PNGs carry
// RGB(0,0,0), so the driver's mip chain averages BLACK into every cutout layer —
// distant leaves/foliage read darker the further the mip (the LOD canopy
// noticeably darkened with distance). Before upload, dilate the nearest opaque
// RGB into transparent texels (alpha untouched — the cutout still cuts) so the
// mip blend only ever averages real surface colour.
function dilateTransparentRGB(px: Uint8ClampedArray) {
  const N = TILE * TILE;
  let hasTransparent = false;
  for (let i = 0; i < N; i++) if (px[i * 4 + 3] < 16) { hasTransparent = true; break; }
  if (!hasTransparent) return;
  const filled = new Uint8Array(N);   // 1 = has usable RGB (opaque or already dilated)
  for (let i = 0; i < N; i++) filled[i] = px[i * 4 + 3] >= 16 ? 1 : 0;
  // few passes of 4-neighbour dilation — TILE is 16, this converges fast
  for (let pass = 0; pass < TILE; pass++) {
    let changed = false;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = y * TILE + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        const consider = (j: number) => { if (filled[j]) { r += px[j * 4]; g += px[j * 4 + 1]; b += px[j * 4 + 2]; n++; } };
        if (x > 0) consider(i - 1);
        if (x < TILE - 1) consider(i + 1);
        if (y > 0) consider(i - TILE);
        if (y < TILE - 1) consider(i + TILE);
        if (n > 0) {
          px[i * 4] = r / n; px[i * 4 + 1] = g / n; px[i * 4 + 2] = b / n;
          filled[i] = 2;   // mark filled, but don't let this pass cascade within itself unfairly — fine for our purposes
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

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
    let retries = 0;
    img.onload = () => {
      ctx.clearRect(0, 0, TILE, TILE);
      ctx.drawImage(img, 0, 0, TILE, TILE);
      const pixels = ctx.getImageData(0, 0, TILE, TILE).data;
      dilateTransparentRGB(pixels);
      data.set(pixels, layer * TILE * TILE * 4);
      done();
    };
    img.onerror = () => {
      // Texture fetches can fail TRANSIENTLY (dev-server restart mid-load, a
      // network blip) — and a failure here used to bake magenta into the array
      // texture for the whole session ("everything is purple"). Retry a couple
      // of times with backoff; only a genuinely missing file goes magenta (so
      // the failure stays obvious), with the URL logged.
      if (retries++ < 2) {
        setTimeout(() => { img.src = `${assetUrl(url)}?retry=${retries}`; }, 1500 * retries);
        return;
      }
      console.warn(`block texture failed to load: ${url}`);
      const off = layer * TILE * TILE * 4;
      for (let i = 0; i < TILE * TILE; i++) { data[off + i * 4] = 255; data[off + i * 4 + 1] = 0; data[off + i * 4 + 2] = 255; data[off + i * 4 + 3] = 255; }
      done();
    };
    // assetUrl: resolve against BASE_URL, not the page path — a tab open at a
    // non-root path (stale /minecraft-JS/ bookmark) must not 404 every texture.
    img.src = assetUrl(url);
  });

  return texture;
}

const arrayTexture = createArrayTexture();

// Anisotropy is a per-fragment texture-tap multiplier (8× ≈ up to 8 taps on
// grazing-angle ground — exactly where the fragment-bound presets hurt; weaker
// GPUs pay 5-20% for 8-16× AF in texture-heavy scenes). Quality presets tier it:
// 2× on low/balanced (16×16 pixel art barely shows the difference), 8× on
// fancy+. Changing it requires a texture re-upload (sampler params apply at
// upload) — preset-change-time only, ~160KB, negligible.
export function setTextureAnisotropy(n: number) {
  for (const t of [arrayTexture, refArrayTexture]) {
    if (t && t.anisotropy !== n) { t.anisotropy = n; t.needsUpdate = true; }
  }
}

// Shared material for every chunk's opaque geometry. A standard MeshLambertMaterial
// (so it keeps three's lighting/shadows) is patched to sample the array texture by
// a per-vertex layer index, using textureGrad with the un-fract'd derivatives so
// greedy-merged quads tile cleanly without mip seams.
// Shared shader injection for the cube materials: sample the array texture by a
// per-vertex layer index (textureGrad with un-fract'd derivatives → clean tiling
// on greedy-merged quads) and multiply by the baked per-vertex biome tint.
// Shared uniforms for the cube/leaf shaders, updated each frame: uTime drives the
// caustic ripple, uCaustics/uSea gate fake underwater caustics (ultra graphics).
const cubeShaders: THREE.WebGLProgramParametersWithUniforms[] = [];
export function updateCubeUniforms(timeSeconds: number, sea: number, caustics: boolean) {
  for (const s of cubeShaders) {
    if (s.uniforms.uTime) s.uniforms.uTime.value = timeSeconds;
    if (s.uniforms.uSea) s.uniforms.uSea.value = sea;
    if (s.uniforms.uCaustics) s.uniforms.uCaustics.value = caustics ? 1 : 0;
  }
}

// CYLINDRICAL FOG: fog distance = HORIZONTAL world distance from the camera (XZ),
// not THREE's planar view-space depth. So terrain far BELOW the camera (looking
// down) stays clear — fog only veils the chunk-streaming edge on the horizon.
// Replaces three's <fog_fragment>; reuses three's fogColor/fogNear/fogFar uniforms.
// `worldVar` is the fragment's world-position varying (vWorldPos for cube/plant,
// vWaterPos for water). All fogged materials share uCamXZ, updated each frame.
// AERIAL PERSPECTIVE on top of the plain fog mix: a SUBTLE desaturation +
// blue shift confined to the FAR band (last ~30% before the fog wall). The
// first version of this started at 35% of the fog distance at 55% strength
// with a black-lift — it milk-washed the entire mid-field and read as
// "blurry / non-HD". Distance cues must whisper, not shout: mid-range terrain
// stays fully vivid, only the horizon breathes a little atmosphere before the
// real fog finishes the job.
export const CYL_FOG_FRAGMENT = (worldVar: string) => /* glsl */`
  #ifdef USE_FOG
    float vFogCyl = length(${worldVar}.xz - uCamXZ);
    float aerial = smoothstep( fogNear * 0.7, fogFar, vFogCyl ) * 0.3;
    float lum = dot( gl_FragColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
    vec3 hazed = mix( gl_FragColor.rgb, vec3( lum ), aerial * 0.5 );      // gentle desaturate
    hazed = mix( hazed, hazed * vec3( 0.95, 0.985, 1.05 ), aerial );      // faint blue shift, NO black lift
    gl_FragColor.rgb = hazed;
    float fogFactor = smoothstep( fogNear, fogFar, vFogCyl );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif
`;
const _fogShaders: THREE.WebGLProgramParametersWithUniforms[] = [];   // every material with cylindrical fog
export function registerFogShader(s: THREE.WebGLProgramParametersWithUniforms) {
  s.uniforms.uCamXZ = { value: new THREE.Vector2() };
  _fogShaders.push(s);
}
export function updateFogCamera(x: number, z: number) {
  for (const s of _fogShaders) if (s.uniforms.uCamXZ) s.uniforms.uCamXZ.value.set(x, z);
}

function injectCubeShader(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.uniforms.uArray = { value: arrayTexture };
  shader.uniforms.uTime = { value: 0 };
  shader.uniforms.uSea = { value: 128 };
  shader.uniforms.uCaustics = { value: 0 };
  cubeShaders.push(shader);
  registerFogShader(shader);   // cylindrical fog (uses vWorldPos, declared below)
  // QUANTIZED VERTEX FORMAT (Sodium-style, 40 B → 16 B/vertex):
  //  • position: normalized u16, world = local·QSCALE − QOFF, decoded by the
  //    MESH/INSTANCE MATRIX (scale+offset baked in) so three's depth/shadow/
  //    distance materials all decode for free — no shader change needed there.
  //  • tileUv: normalized u16, same (v+8)·64 scheme — decoded HERE.
  //  • layerIndex: normalized u16 carrying (texture layer | faceId << 12);
  //    the 3-bit face id replaces the 12-byte normal attribute entirely (every
  //    face we emit is axis-aligned; plants are always 'up').
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', /* glsl */`
      #include <common>
      attribute vec2 tileUv;
      attribute float layerIndex;
      attribute vec4 tintColor;   // rgb = baked biome tint (white = untinted), a = emissive amount
      varying vec2 vTileUv;
      varying float vLayer;
      varying vec3 vTintCol;
      varying float vEmis;
      varying vec3 vWorldPos;
      const vec3 FACE_NORMALS[6] = vec3[6](
        vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
    `)
    .replace('#include <beginnormal_vertex>', /* glsl */`
      int _ldi = int(floor(layerIndex * 65535.0 + 0.5));
      vec3 objectNormal = FACE_NORMALS[_ldi >> 12];
    `)
    .replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      vTileUv = tileUv * 1023.984375 - 8.0;   // u16-normalized → block coords ((v+8)·64 encode)
      vLayer = float(_ldi & 4095);
      vTintCol = tintColor.rgb;
      vEmis = tintColor.a;
      // BatchedMesh applies the per-instance transform LATER (project_vertex:
      // batchingMatrix * mvPosition) — 'transformed' here is still geometry-
      // local. Our world-position varying (cylindrical fog + caustics) must
      // apply it manually or every batched chunk fogs as if at the origin.
      vec3 _wpLocal = transformed;
      #ifdef USE_BATCHING
        _wpLocal = (batchingMatrix * vec4(_wpLocal, 1.0)).xyz;
      #endif
      vWorldPos = (modelMatrix * vec4(_wpLocal, 1.0)).xyz;
    `);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', /* glsl */`
      #include <common>
      uniform sampler2DArray uArray;
      uniform float uTime;
      uniform float uSea;
      uniform float uCaustics;
      uniform vec2 uCamXZ;
      varying vec2 vTileUv;
      varying float vLayer;
      varying vec3 vTintCol;
      varying float vEmis;
      varying vec3 vWorldPos;
    `)
    .replace('#include <fog_fragment>', CYL_FOG_FRAGMENT('vWorldPos'))
    .replace('#include <map_fragment>', /* glsl */`
      // Flip V: DataArrayTexture stores image rows top-to-bottom, but world V
      // increases upward, so without this side textures appear upside down.
      vec2 auv = fract(vTileUv);
      auv.y = 1.0 - auv.y;
      vec4 texel = textureGrad(uArray, vec3(auv, vLayer), dFdx(vTileUv), dFdy(vTileUv));
      // sRGB -> linear so lighting is correct (output is re-encoded by three).
      texel.rgb = pow(texel.rgb, vec3(2.2));
      texel.rgb *= vTintCol;   // MC-style per-biome tint (grass tops / biome leaves; white elsewhere)
      diffuseColor *= texel;   // diffuseColor.a now carries texel.a → alphaTest (leaf material) discards holes
    `)
    // Emitter blocks (torch/lantern/glowstone/…) glow their own texture colour
    // regardless of scene light — vEmis (=tintColor.a) is 0 for normal blocks.
    // ULTRA: fake caustics — rippling refracted-sunlight bands added to submerged
    // surfaces (terrain/seabed below sea level), strongest near the surface.
    .replace('#include <emissivemap_fragment>', /* glsl */`
      #include <emissivemap_fragment>
      totalEmissiveRadiance += texel.rgb * vEmis;
      if (uCaustics > 0.5 && vWorldPos.y < uSea) {
        vec2 cp = vWorldPos.xz * 0.35;
        float t = uTime * 0.7;
        float c = sin(cp.x * 1.7 + t) * sin(cp.y * 1.5 - t * 1.1)
                + sin((cp.x + cp.y) * 1.1 + t * 1.3) * 0.7
                + sin((cp.x - cp.y) * 2.3 - t * 0.6) * 0.5;
        c = pow(max(c * 0.35 + 0.5, 0.0), 4.0);
        float fade = clamp((uSea - vWorldPos.y) / 22.0, 0.0, 1.0);   // 0 at surface → 1 deep
        totalEmissiveRadiance += vec3(0.45, 0.8, 1.0) * c * 0.6 * (1.0 - fade);
      }
    `);
}

let blockShader: THREE.WebGLProgramParametersWithUniforms | null = null;
let leafShader: THREE.WebGLProgramParametersWithUniforms | null = null;
export const blockArrayMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
blockArrayMaterial.onBeforeCompile = (shader) => { blockShader = shader; injectCubeShader(shader); };

// Leaf material: identical shader + biome tint, but ALPHA-TESTED so the cutout
// holes in the leaf textures show through (MC "fancy" leaves). Used for the
// nonCasters mesh (leaves + clouds; clouds are opaque so alphaTest keeps them).
// alphaTest (not transparent) keeps it in the cheap OPAQUE pass — no depth re-sort.
export const leafArrayMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
leafArrayMaterial.alphaTest = 0.5;
leafArrayMaterial.onBeforeCompile = (shader) => { leafShader = shader; injectCubeShader(shader); };

// ---------------------------------------------------------------------------
//  PLANT MATERIAL — for the cross-billboard / carpet / vine "plants" geometry
//  group. Same DataArrayTexture sampling as blockArrayMaterial, PLUS:
//   • alphaTest (NOT transparent) so it renders in the OPAQUE pass — no per-frame
//     transparent-depth re-sort (the single biggest reason this is cheap; see the
//     water plane, which is the only thing that pays that cost).
//   • DoubleSide so a billboard is visible from both sides (we emit one winding).
//   • a per-vertex `plantColor` (rgb = biome tint baked at mesh-build, a = wind
//     sway weight 0..1) — grayscale grass/fern/vine textures become the biome's
//     grass colour, MC-style, with zero runtime biome lookup.
//   • a cheap wind sway in the vertex shader keyed on world position + uTime, so
//     grass and flowers actually move. Top of a plant sways, base stays planted.
// ---------------------------------------------------------------------------
let plantShader: THREE.WebGLProgramParametersWithUniforms | null = null;
export const plantMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
plantMaterial.alphaTest = 0.5;
plantMaterial.side = THREE.DoubleSide;
plantMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uArray = { value: arrayTexture };
  shader.uniforms.uTime = { value: 0 };
  plantShader = shader;
  registerFogShader(shader);   // cylindrical fog (uses vWorldPos varying added below)

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', /* glsl */`
      #include <common>
      attribute vec2 tileUv;
      attribute float layerIndex;
      attribute vec4 plantColor;   // rgb = biome tint, a = sway weight
      uniform float uTime;
      varying vec2 vTileUv;
      varying float vLayer;
      varying vec3 vTint;
      varying vec3 vWorldPos;
    `)
    .replace('#include <beginnormal_vertex>', /* glsl */`
      // quantized format: plants always carry faceId 2 ('up') — even lighting,
      // no stored normal (see the cube shader's FACE_NORMALS rationale)
      vec3 objectNormal = vec3(0.0, 1.0, 0.0);
    `)
    .replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      vTileUv = tileUv * 1023.984375 - 8.0;   // u16-normalized → block coords
      vLayer = float(int(floor(layerIndex * 65535.0 + 0.5)) & 4095);
      vTint = plantColor.rgb;
      // Wind: phase from WORLD position so neighbouring plants/chunks sway
      // coherently. Scaled by the per-vertex sway weight (0 at the rooted
      // base, 1 at the tip). Batched plants: the per-instance (chunk) offset
      // lives in batchingMatrix, applied later in project_vertex — fold it in
      // here or batched plants would fog/sway as if at the world origin.
      // Displacement happens in QUANTIZED local units (1 unit = 65535/64
      // blocks, the mesh matrix descales) → scale block-space amplitudes down.
      float sway = plantColor.a;
      vec3 _ppLocal = transformed;
      #ifdef USE_BATCHING
        _ppLocal = (batchingMatrix * vec4(_ppLocal, 1.0)).xyz;
      #endif
      vec3 wpos = (modelMatrix * vec4(_ppLocal, 1.0)).xyz;
      vWorldPos = wpos;           // for cylindrical fog
      float ph = wpos.x * 0.6 + wpos.z * 0.45;
      const float Q2L = 64.0 / 65535.0;   // blocks → quantized-local units
      transformed.x += (sin(uTime * 1.6 + ph) + 0.3 * sin(uTime * 3.1 + ph * 1.7)) * 0.07 * Q2L * sway;
      transformed.z += cos(uTime * 1.3 + ph * 1.1) * 0.06 * Q2L * sway;
    `);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', /* glsl */`
      #include <common>
      uniform sampler2DArray uArray;
      uniform vec2 uCamXZ;
      varying vec2 vTileUv;
      varying float vLayer;
      varying vec3 vTint;
      varying vec3 vWorldPos;
    `)
    .replace('#include <fog_fragment>', CYL_FOG_FRAGMENT('vWorldPos'))
    // Force the shading normal UP on BOTH faces. These are DoubleSide billboards;
    // three's normal_fragment_begin flips the normal to point DOWN on back faces
    // (normal *= faceDirection), which lit them from below → pitch black. An up
    // normal lights both sides evenly from the sky/sun, like flat vegetation.
    .replace('#include <normal_fragment_begin>', /* glsl */`
      #include <normal_fragment_begin>
      normal = vec3(0.0, 1.0, 0.0);
    `)
    .replace('#include <map_fragment>', /* glsl */`
      vec2 auv = fract(vTileUv);
      auv.y = 1.0 - auv.y;
      vec4 texel = textureGrad(uArray, vec3(auv, vLayer), dFdx(vTileUv), dFdy(vTileUv));
      texel.rgb = pow(texel.rgb, vec3(2.2));
      texel.rgb *= vTint;          // MC-style biome tint of the (grayscale) plant
      diffuseColor *= texel;       // diffuseColor.a now carries texel.a -> alphaTest discards
    `)
    // The torch billboard is a light EMITTER — make its layer glow (self-lit) so it
    // reads as a flame even in the dark. Detected by texture layer (no extra attribute).
    .replace('#include <emissivemap_fragment>', /* glsl */`
      #include <emissivemap_fragment>
      if (abs(vLayer - ${TEXTURE_LAYER.torch}.0) < 0.5) totalEmissiveRadiance += texel.rgb;
    `);
};

// Advance the foliage wind (called once per rendered frame from the draw loop).
export function updatePlantWind(timeSeconds: number) {
  if (plantShader) plantShader.uniforms.uTime.value = timeSeconds;
}

// ---------------------------------------------------------------------------
//  ULTRA shadows: a custom DEPTH material for the leaf + plant meshes that honours
//  the texture's ALPHA — so the sun's shadow map carries the cutout HOLES, giving
//  dappled leaf shadows and real grass/flower silhouettes instead of solid blobs.
//  Assigned as `mesh.customDepthMaterial` only in ultra (see WorldChunk). DoubleSide
//  so a single-winding billboard still casts from both faces.
// ---------------------------------------------------------------------------
export const cutoutDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
cutoutDepthMaterial.side = THREE.DoubleSide;
cutoutDepthMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uArray = { value: arrayTexture };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 tileUv;\nattribute float layerIndex;\nvarying vec2 vTileUv;\nvarying float vLayer;')
    // quantized format decode (see injectCubeShader) — positions descale via the
    // mesh/instance matrix, so the depth pass needs only the uv/layer decode
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTileUv = tileUv * 1023.984375 - 8.0;\nvLayer = float(int(floor(layerIndex * 65535.0 + 0.5)) & 4095);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform sampler2DArray uArray;\nvarying vec2 vTileUv;\nvarying float vLayer;')
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nvec2 _auv = fract(vTileUv); _auv.y = 1.0 - _auv.y;\nif (textureGrad(uArray, vec3(_auv, vLayer), dFdx(vTileUv), dFdy(vTileUv)).a < 0.5) discard;');
};

// Whether foliage (plants) cast shadows + leaves cast cutout shadows. Toggled by
// the ultra-graphics setting; WorldChunk reads it when (re)building chunk meshes.
let _foliageShadows = false;
export function setFoliageShadows(v: boolean) { _foliageShadows = v; }
export function getFoliageShadows() { return _foliageShadows; }

// ---------------------------------------------------------------------------
//  DEV-ONLY texture toggle — swap the live DataArrayTexture between OUR textures
//  and the Minecraft reference set. The refs live in the gitignored public/_ref/
//  (generated by .texref/make_compare.py); when that pack is absent the toggle
//  no-ops. Our per-vertex biome tint still applies, so MC's grayscale grass/leaves
//  show correctly tinted — a faithful side-by-side in the actual world.
// ---------------------------------------------------------------------------
let refArrayTexture: THREE.DataArrayTexture | null = null;
let usingRef = false;

function buildRefArrayTexture(refmap: Record<string, string>): THREE.DataArrayTexture {
  const data = new Uint8Array(TILE * TILE * 4 * LAYER_COUNT);
  const whiteOffset = TEXTURE_LAYER.white * TILE * TILE * 4;
  data.fill(255, whiteOffset, whiteOffset + TILE * TILE * 4);
  const texture = new THREE.DataArrayTexture(data, TILE, TILE, LAYER_COUNT);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let pending = 0;
  const done = () => { if (--pending === 0) texture.needsUpdate = true; };
  LAYER_URLS.forEach((url, layer) => {
    if (!url) return;
    const base = url.split('/').pop()!;            // our texture filename, e.g. 'andesite.png'
    const ref = refmap[base];
    const src = assetUrl(ref ? ('_ref/' + ref) : url);   // MC reference where mapped, else keep ours
    pending++;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, TILE, TILE);
      ctx.drawImage(img, 0, 0, TILE, TILE);
      data.set(ctx.getImageData(0, 0, TILE, TILE).data, layer * TILE * TILE * 4);
      done();
    };
    img.onerror = () => done();
    img.src = src;
  });
  return texture;
}

// Flip between our textures and the MC reference set (builds the ref texture once).
export function toggleReferenceTextures(): void {
  const apply = () => {
    usingRef = !usingRef;
    const tex = usingRef ? refArrayTexture! : arrayTexture;
    if (blockShader) blockShader.uniforms.uArray.value = tex;
    if (leafShader) leafShader.uniforms.uArray.value = tex;
    if (plantShader) plantShader.uniforms.uArray.value = tex;
    console.info(`[texture toggle] now showing ${usingRef ? 'MINECRAFT reference' : 'our'} textures`);
  };
  if (refArrayTexture) { apply(); return; }
  fetch(assetUrl('_ref/refmap.json'))
    .then(r => r.ok ? r.json() : Promise.reject(new Error('no ref pack')))
    .then((refmap: Record<string, string>) => { refArrayTexture = buildRefArrayTexture(refmap); apply(); })
    .catch(() => console.warn('[texture toggle] dev ref pack missing — run `python3 .texref/make_compare.py` to enable'));
}
