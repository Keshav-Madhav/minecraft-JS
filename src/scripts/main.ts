import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { createGUI } from './ui';
import { Player } from './player';
import { Physics } from './physics';
import { World } from './world';
import { blocks } from './blocks';
import { ModelLoader } from './ModelLoader';
import { Clouds } from './clouds';
import { WorldMap } from './map';

// Get window size
let winWidth = window.innerWidth;
let winHeight = window.innerHeight;
window.addEventListener('resize', () => {
  winWidth = window.innerWidth;
  winHeight = window.innerHeight;

  OrbitCam.aspect = winWidth / winHeight;
  OrbitCam.updateProjectionMatrix();

  player.camera.aspect = winWidth / winHeight;
  player.camera.updateProjectionMatrix();

  renderer.setSize(winWidth, winHeight);
})

let previousTime = performance.now();
let frustumTick = 0;

// Settings surfaced in the GUI.
const settings = { uncapFPS: true, fog: false, resolutionScale: 1, biomeLighting: true };
const SKY_COLOR = 0x80a0e0;

// Frame scheduler. requestAnimationFrame is hard-locked to the display refresh
// rate (e.g. 60/120 Hz). To render uncapped (so FPS differences are visible),
// drive the loop via a MessageChannel, which has no minimum-delay clamp the way
// setTimeout(0) does.
const frameChannel = new MessageChannel();
let frameScheduled = false;
frameChannel.port1.onmessage = () => { frameScheduled = false; animate(); };
function scheduleFrame() {
  if (settings.uncapFPS) {
    if (!frameScheduled) { frameScheduled = true; frameChannel.port2.postMessage(0); }
  } else {
    requestAnimationFrame(animate);
  }
}


// Stats = FPS monitor
const stats = new Stats();
document.body.appendChild(stats.dom);
const renderStatsEl = document.getElementById('render-stats');

// Setup for renderer. logarithmicDepthBuffer fixes z-fighting at distance (e.g.
// the thin layer just above water flickering when zoomed out). Antialias is off
// — MSAA over this many triangles tanked the frame rate.
const renderer = new THREE.WebGLRenderer({ logarithmicDepthBuffer: true });
// Cap native ratio at 2 (a 3×+ display would otherwise shade 9× the fragments
// for no visible gain) and scale by the user's resolution setting.
function applyResolution() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * settings.resolutionScale);
}
applyResolution();
renderer.setSize(winWidth, winHeight);
renderer.setClearColor(0x80a0e0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // cheaper than soft; blocky shadows read fine
// Full-rate shadow updates: updating only every other frame made the map stale
// while moving, which read as the shadows jittering. The shadow pass is bounded
// by the shadow RANGE (not draw distance), so per-frame is affordable. Swimming
// is handled instead by snapping the shadow frustum to texel steps (see animate).
// Filmic tone mapping rolls off bright highlights instead of clipping them to
// white, which (with the brighter physically-based lights below) gives a richer,
// less washed-out image. Exposure is user-tunable in the Lighting panel.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

// Setup for OrbitCam
const OrbitCam = new THREE.PerspectiveCamera(70, winWidth / winHeight, 0.1, 4000);
OrbitCam.position.set(-48, 190, -48); // above the terrain (sea level is 128)
OrbitCam.layers.enable(1);
OrbitCam.lookAt(8, 130, 8);

// Setup for controls
const controls = new OrbitControls(OrbitCam, renderer.domElement);
controls.target.set(8, 130, 8);
controls.update();

// Setup for scene
const scene = new THREE.Scene();
const world = new World();
world.params.seed = Math.floor(Math.random() * 10000);
world.drawDistance = 32; // temporary: large draw distance for testing
world.generate();
scene.add(world);

// Fog and the camera far plane scale with draw distance so the loaded edge
// fades into the sky instead of either being clipped early or popping in.
function updateViewDistance() {
  const span = Math.max(world.drawDistance, 1) * world.chunkSize.width;
  player.camera.far = span + 48;
  player.camera.updateProjectionMatrix();
  scene.fog = settings.fog ? new THREE.Fog(SKY_COLOR, span * 0.4, span) : null;
  clouds.setViewDistance(player.camera.far);
  // Cover the whole visible area (plus margin) so the ocean reaches the horizon.
  const waterSpan = (span + 48) * 2;
  waterMesh.scale.set(waterSpan, waterSpan, 1);
}


// Sky cloud layer (separate from the voxel world).
const clouds = new Clouds();
scene.add(clouds);

// A SINGLE sea-level water plane that follows the player, instead of one
// transparent plane per chunk. Land (which is above sea level) occludes it via
// the depth buffer, so it only shows in oceans/holes — visually identical to
// the old per-chunk planes, but it's one draw call and one entry in the
// per-frame transparent depth-sort instead of thousands.
const waterMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  // Phong (not Lambert) so the sun glints off the surface — gives the otherwise
  // flat plane some life. Deeper blue + a touch more opaque reads more like water.
  new THREE.MeshPhongMaterial({
    color: 0x2f6aa6, transparent: true, opacity: 0.62,
    side: THREE.DoubleSide, depthWrite: false,
    specular: 0xbfe0ff, shininess: 96,
  }),
);
waterMesh.rotation.x = -Math.PI / 2;
waterMesh.layers.set(1);
waterMesh.frustumCulled = false;
scene.add(waterMesh);

// Setup for player
const player = new Player(scene);

const physics = new Physics(scene);

// Minimap + fullscreen 2D world map. Tiles are rendered off-thread (map worker)
// from the same terrain noise as the world and cached, so what you see is what
// generates and panning/zooming stays smooth.
const worldMap = new WorldMap({
  getPlayer: () => ({ x: player.position.x, z: player.position.z, yaw: player.camera.rotation.y }),
  onTeleport: (x, z) => {
    const surface = world.sampler(Math.floor(x), Math.floor(z));
    player.position.set(x, surface.height + 3, z);
    player.velocity.set(0, 0, 0);
    // After the map closes the pointer is unlocked, so the OrbitCam renders —
    // move it (and its target) to the destination too, or it'd keep showing the
    // old location while chunks stream in at the new one.
    OrbitCam.position.set(x - 50, surface.height + 70, z - 50);
    controls.target.set(x, surface.height, z);
    controls.update();
  },
  // Release the pointer + freeze input while the map is open, restore on close.
  onOpen: () => { player.enabled = false; document.exitPointerLock(); },
  onClose: () => { player.enabled = true; },
});
function configureMap() {
  worldMap.configure(world.params, world.chunkSize, world.params.terrain.waterOffset);
}
configureMap();

// 'G' toggles the world map.
document.addEventListener('keydown', (event) => {
  if (event.key === 'g' || event.key === 'G') {
    worldMap.toggle();
  } else if (event.key === 'Escape' && worldMap.isOpen()) {
    worldMap.close();
  }
});

const modelLoader = new ModelLoader();
modelLoader.loadModels((models) => {
  player.tool.setMesh(models.pickaxe);
})

// Lighting. three r167 uses physically-based light intensities (legacy lights
// off since r155), so the pre-r155 "intensity 1" sun is ~×π brighter now — hence
// sun ≈ 3.0. The directional sun gives shape/shadows; a HemisphereLight provides
// bright sky-vs-ground ambient fill so faces turned away from the sun aren't
// crushed to near-black.
const sun = new THREE.DirectionalLight(0xfff2d8, 2.9);
const hemi = new THREE.HemisphereLight(0xbcd6ff /* sky */, 0x4d4233 /* ground */, 1.1);

// The sun is a DIRECTIONAL light: only its DIRECTION matters, expressed as a
// compass azimuth + elevation above the horizon. The light is parked at this
// offset from the player each frame (and the shadow frustum re-centres on the
// player). A mid elevation (~45°) casts clearly visible, directional shadows;
// straight overhead would make shadows vanishingly short (which read as "no
// shadows").
const SUN_DISTANCE = 240;
let sunAzimuth = 199;   // degrees (compass)
let sunElevation = 28;  // degrees above horizon (low = longer, more visible shadows)
const sunOffset = new THREE.Vector3();
function applySunDirection(azimuthDeg: number, elevationDeg: number) {
  sunAzimuth = azimuthDeg;
  sunElevation = elevationDeg;
  const az = azimuthDeg * Math.PI / 180;
  const el = THREE.MathUtils.clamp(elevationDeg, 3, 89) * Math.PI / 180;
  const horiz = Math.cos(el) * SUN_DISTANCE;
  sunOffset.set(Math.cos(az) * horiz, Math.sin(el) * SUN_DISTANCE, Math.sin(az) * horiz);
}

// Half-width of the shadow frustum (world units). Bigger = shadows cover more
// of the scene (the "spotlight" is larger) but the same shadow map is spread
// thinner and more casters are drawn in the shadow pass. User-tunable.
let shadowRange = 140;
function applyShadowRange(r: number) {
  shadowRange = r;
  const cam = sun.shadow.camera;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
  // Depth must span the whole frustum even with a low (grazing) sun, or distant
  // casters drop out. Generous far keeps that covered as range grows.
  cam.far = SUN_DISTANCE + r * 2 + 80;
  cam.updateProjectionMatrix();
}

function setUpLights() {
  sun.castShadow = true;
  // Shadow frustum follows the player (re-centred each frame). A 4096 map over a
  // ±140 range keeps texels small (~0.07 world units) so the bias can be TINY —
  // which is what stops the shadow detaching ("peter-panning") from the block it
  // belongs to. Large bias/normalBias is what caused the floating-shadow look.
  sun.shadow.camera.near = 1;
  sun.shadow.bias = -0.00008;
  sun.shadow.normalBias = 0.02;
  sun.shadow.mapSize.set(4096, 4096);
  applyShadowRange(shadowRange);
  applySunDirection(sunAzimuth, sunElevation);
  scene.add(sun);
  scene.add(sun.target);

  const shadowHelper = new THREE.CameraHelper(sun.shadow.camera);
  shadowHelper.visible = false;
  scene.add(shadowHelper);

  scene.add(hemi);
}

// Park the sun at its directional offset from the player and centre the shadow
// frustum on the player — but SNAP that centre to whole shadow-map texel steps
// along the light's own plane axes. Without this the texel grid slides
// continuously under the geometry as you move, so shadow edges crawl/shimmer
// ("swimming"). Snapping makes the grid jump one texel at a time, which is
// imperceptible and rock-steady.
const SHADOW_MAP_SIZE = 4096;
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(0, 0, 1);
const _center = new THREE.Vector3();
function updateSunShadow() {
  _fwd.copy(sunOffset).negate().normalize();                 // sun → player
  const up0 = Math.abs(_fwd.y) > 0.99 ? _altUp : _worldUp;
  _right.crossVectors(_fwd, up0).normalize();
  _up.crossVectors(_right, _fwd).normalize();

  const texel = (2 * shadowRange) / SHADOW_MAP_SIZE;
  const px = player.position;
  const u = Math.round(px.dot(_right) / texel) * texel;
  const v = Math.round(px.dot(_up) / texel) * texel;
  const w = px.dot(_fwd);
  _center.set(0, 0, 0).addScaledVector(_right, u).addScaledVector(_up, v).addScaledVector(_fwd, w);

  sun.target.position.copy(_center);
  sun.position.copy(_center).add(sunOffset);
}

// --- Biome-aware ambient tint ---------------------------------------------
// Shift the sky/ground fill + sky clear colour AND a brightness multiplier
// toward the biome the player is in. `bright` multiplies the user's Sky/Fill
// base (so that slider stays authoritative for the overall level, while biomes
// read brighter/darker relative to it). Everything is lerped so biome borders
// cross smoothly.
type Tint = { sky: number, ground: number, clear: number, bright: number };
const BIOME_TINT: Record<number, Tint> = {
  8:  { sky: 0xffe7c2, ground: 0xb59055, clear: 0xcdc6ac, bright: 1.05 }, // sand  → desert: warmer
  10: { sky: 0xd2e2ff, ground: 0xa6bad6, clear: 0xc4d8f4, bright: 1.22 }, // snow  → colder + bright
  3:  { sky: 0xd8e4f6, ground: 0x808a9c, clear: 0xb2caec, bright: 1.18 }, // stone → mountains: brighter + colder
  1:  { sky: 0xbcd6ff, ground: 0x4d4233, clear: 0x80a0e0, bright: 1.0  }, // grass → plains (neutral)
};
const FOREST_TINT: Tint = { sky: 0xa6c0da, ground: 0x2e3b23, clear: 0x6d8ebc, bright: 0.82 }; // darker + colder
const OCEAN_TINT:  Tint = { sky: 0xfff2dc, ground: 0x8fbccd, clear: 0xcadef2, bright: 1.38 }; // warmer + much brighter
let baseFill = 1.1; // user's Sky/Fill level (the biome `bright` multiplies this)
const _tintSky = new THREE.Color(0xbcd6ff);
const _tintGround = new THREE.Color(0x4d4233);
const _tintClear = new THREE.Color(SKY_COLOR);
const _targetSky = new THREE.Color();
const _targetGround = new THREE.Color();
const _targetClear = new THREE.Color();
let _bright = 1, _targetBright = 1;
let biomeTintTick = 0;
function updateBiomeLighting() {
  if (!settings.biomeLighting) return;
  // Throttle the surface sample (a noise eval) to a few times a second.
  if ((biomeTintTick++ % 8) === 0) {
    const s = world.sampler(Math.floor(player.position.x), Math.floor(player.position.z));
    let t: Tint;
    if (s.height < world.params.terrain.waterOffset) {
      t = OCEAN_TINT;                                      // standing over/under water
    } else if (s.surfaceId === 1 && s.forest > 0.6) {
      t = FOREST_TINT;                                     // dense woods
    } else {
      t = BIOME_TINT[s.surfaceId] ?? BIOME_TINT[1];
    }
    _targetSky.setHex(t.sky); _targetGround.setHex(t.ground); _targetClear.setHex(t.clear);
    _targetBright = t.bright;
  }
  _tintSky.lerp(_targetSky, 0.05);
  _tintGround.lerp(_targetGround, 0.05);
  _tintClear.lerp(_targetClear, 0.05);
  _bright += (_targetBright - _bright) * 0.05;
  hemi.color.copy(_tintSky);
  hemi.groundColor.copy(_tintGround);
  hemi.intensity = baseFill * _bright;
  renderer.setClearColor(_tintClear);
}

function onMouseDown(event: MouseEvent) {
  if(player.controls.isLocked && player.selectedCoords){
    if(event.button === 0){
      if(player.activeBlockId === blocks.air.id){
        world.removeBlock(player.selectedCoords.x, player.selectedCoords.y, player.selectedCoords.z);
        player.tool.startAnimation();
      } else {
        world.setBlock(player.selectedCoords.x, player.selectedCoords.y, player.selectedCoords.z, player.activeBlockId);
      }
    } else if(event.button === 2){
      player.activeBlockId = world.getBlock(player.selectedCoords.x, player.selectedCoords.y, player.selectedCoords.z)?.id ?? blocks.air.id;
    }
  }
}
document.addEventListener('mousedown', onMouseDown);

//draw loop
function animate() {
  const currentTime = performance.now();
  const delta = (currentTime - previousTime) / 1000;

  if(player.controls.isLocked) {
    player.update(world);
    physics.update(delta, player, world);
  }

  // Sun + shadow frustum follow the player every frame (texel-snapped), not just
  // when locked, so the orbit/spawn view is lit and shadowed too.
  updateSunShadow();
  updateBiomeLighting();

  worldMap.update();

  // When the 2D world map is open we don't render the voxel world at all — just
  // the map overlay — so the main thread is free for map sampling.
  if (!worldMap.isOpen()) {
    // Stream chunks and drain the bounded work queues every frame, even before
    // pointer lock, so draw-distance changes fill in smoothly.
    world.update(player);
    world.processQueues();

    clouds.update(player.position.x, player.position.z, currentTime / 1000);
    waterMesh.position.set(player.position.x, world.params.terrain.waterOffset + 0.45, player.position.z);

    const activeCamera = player.controls.isLocked ? player.camera : OrbitCam;
    // No manual frustum culling: three.js culls each chunk mesh automatically and
    // PER PASS (main camera for colour, the sun's shadow camera for shadows), so
    // an off-screen mountain still casts its shadow onto the player. Hiding
    // chunks with .visible=false would have removed them from the shadow pass.
    frustumTick++;
    renderer.render(scene, activeCamera);
  }
  stats.update();

  // Refresh the debug HUD a few times a second, not every frame — building the
  // string (toLocaleString etc.) and writing innerText every frame is needless.
  if (renderStatsEl && (frustumTick & 15) === 0) {
    const info = renderer.info.render;
    // Draw calls already reflect what survives three's per-pass frustum cull, so
    // it's the meaningful "what's actually drawn" number (chunks = total loaded).
    renderStatsEl.innerText =
      `draw calls: ${info.calls}  |  triangles: ${info.triangles.toLocaleString()}\n` +
      `chunks loaded: ${world.chunkCount}`;
  }

  previousTime = currentTime;
  scheduleFrame();
}

setUpLights();
updateViewDistance();
createGUI({
  world,
  player,
  settings,
  regenerate: () => { world.generate(false); configureMap(); }, // preserve edits; refresh map worker
  onViewDistanceChange: updateViewDistance,
  onResolutionChange: applyResolution,
  lighting: {
    getSun: () => sun.intensity, setSun: (v) => { sun.intensity = v; },
    getFill: () => baseFill, setFill: (v) => { baseFill = v; hemi.intensity = v; },
    getExposure: () => renderer.toneMappingExposure, setExposure: (v) => { renderer.toneMappingExposure = v; },
    getShadowRange: () => shadowRange, setShadowRange: applyShadowRange,
    getShadows: () => sun.castShadow, setShadows: (v) => { sun.castShadow = v; },
    getAzimuth: () => sunAzimuth, setAzimuth: (v) => applySunDirection(v, sunElevation),
    getElevation: () => sunElevation, setElevation: (v) => applySunDirection(sunAzimuth, v),
    // Turning the tint off restores the plain user fill level (the per-biome
    // brightness multiplier no longer applies).
    getBiomeTint: () => settings.biomeLighting, setBiomeTint: (v) => { settings.biomeLighting = v; if (!v) hemi.intensity = baseFill; },
  },
});
animate();