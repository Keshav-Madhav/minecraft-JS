import * as THREE from 'three';
import { createMenu, GameMode, ShadowQuality, QualityPreset } from './ui';
import { Player } from './player';
import { Physics } from './physics';
import { World } from './world';
import { blocks } from './blocks';
import { BLOCK_IDS } from './blockTypes';
import { ModelLoader } from './ModelLoader';
import { Clouds } from './clouds';
import { WorldMap } from './map';
import { Spectator } from './spectator';
import { biomeTint, biomeWaterHex } from './chunkGen';
import { updatePlantWind, toggleReferenceTextures } from './blockArrayMaterial';
import { LightManager } from './lightManager';

// Get window size
let winWidth = window.innerWidth;
let winHeight = window.innerHeight;
window.addEventListener('resize', () => {
  winWidth = window.innerWidth;
  winHeight = window.innerHeight;

  spectator.camera.aspect = winWidth / winHeight;
  spectator.camera.updateProjectionMatrix();

  player.camera.aspect = winWidth / winHeight;
  player.camera.updateProjectionMatrix();

  renderer.setSize(winWidth, winHeight);
})

let previousTime = performance.now();

// Settings surfaced in the menu. Defaults: FPS UNLOCKED (uncapFPS on → VSync is
// an opt-in toggle), fog on, biome tint + day/night on, and an always-on stats
// overlay (top-right, under the minimap) while playing.
const settings = { uncapFPS: true, fog: true, resolutionScale: 1, biomeLighting: true, dayNight: true, statsOverlay: true };
const SKY_COLOR = 0x80a0e0;

// Frame scheduler. requestAnimationFrame is hard-locked to the display refresh
// rate (e.g. 60/120 Hz). To render uncapped, drive the loop via a MessageChannel,
// which has no minimum-delay clamp the way setTimeout(0) does.
const frameChannel = new MessageChannel();
let frameScheduled = false;
frameChannel.port1.onmessage = () => { frameScheduled = false; animate(); };
function scheduleFrame() {
  // Uncapped only while actively playing — no point spinning thousands of fps
  // behind the pause menu or the world map (just vsync there).
  if (settings.uncapFPS && !paused && !worldMap.isOpen()) {
    if (!frameScheduled) { frameScheduled = true; frameChannel.port2.postMessage(0); }
  } else {
    requestAnimationFrame(animate);
  }
}

// --- live perf stats (shown in the debug menu, not a permanent HUD) ----------
let fps = 0, fpsFrames = 0, fpsLast = performance.now();

const LOG_DEPTH = false;
const CAMERA_NEAR = 0.3;
function createRenderer(): THREE.WebGLRenderer {
  try {
    return new THREE.WebGLRenderer({ logarithmicDepthBuffer: LOG_DEPTH });
  } catch (e) {
    const msg = document.createElement('div');
    msg.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;'
      + 'background:#80a0e0;color:#fff;font:600 18px/1.5 sans-serif;text-align:center;padding:24px';
    msg.textContent = 'This game needs WebGL, which your browser/GPU did not provide.';
    document.body.appendChild(msg);
    throw e;
  }
}
const renderer = createRenderer();
function applyResolution() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * settings.resolutionScale);
}
applyResolution();
renderer.setSize(winWidth, winHeight);
renderer.setClearColor(0x80a0e0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // cheaper than soft; blocky shadows read fine
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

// Setup for scene
const scene = new THREE.Scene();
const world = new World();
world.params.seed = Math.floor(Math.random() * 10000);
world.generate();
scene.add(world);

// SPECTATOR free-cam (the repurposed orbital camera). Created after the renderer
// so it can bind OrbitControls to the canvas. Used only in spectator mode.
const spectator = new Spectator(
  new THREE.PerspectiveCamera(70, winWidth / winHeight, CAMERA_NEAR, 4000),
  renderer.domElement,
);
spectator.camera.position.set(-48, 190, -48);
spectator.camera.layers.enable(1);
spectator.controls.target.set(8, 130, 8);
spectator.controls.update();

// Localized block lighting: a pool of point lights snapped to nearby emitters.
const lightManager = new LightManager(scene);
let lightInterval = 2;   // frames between point-light gathers (quality preset)
let lightTick = 0;

// Fog and the camera far plane scale with draw distance so the loaded edge fades
// into the sky. Applied to BOTH cameras so fog matches whichever is active.
function updateViewDistance() {
  const span = Math.max(world.drawDistance, 1) * world.chunkSize.width;
  player.camera.far = span + 48;
  player.camera.updateProjectionMatrix();
  spectator.camera.far = span + 48;
  spectator.camera.updateProjectionMatrix();
  scene.fog = settings.fog ? new THREE.Fog(SKY_COLOR, span * 0.4, span) : null;
  clouds.setViewDistance(player.camera.far);
  waterSpanCur = (span + 48 + WATER_SNAP) * 2;
  waterMesh.scale.set(waterSpanCur, 1, waterSpanCur);
  waterSnapX = NaN;
}

// Sky cloud layer (separate from the voxel world).
const clouds = new Clouds();
scene.add(clouds);

// A single sea-level water plane that follows the player, vertex-coloured by
// depth + ocean type (see updateWaterColors). One draw call, not per-chunk.
const WATER_SEG = 48;
const WATER_SNAP = 24;
let waterSpanCur = 64;
let waterSnapX = NaN, waterSnapZ = NaN;
function buildWaterGeometry(seg: number): THREE.BufferGeometry {
  const n = seg + 1, verts = n * n;
  const pos = new Float32Array(verts * 3), col = new Float32Array(verts * 3), nrm = new Float32Array(verts * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = (j * n + i) * 3;
    pos[k] = i / seg - 0.5; pos[k + 1] = 0; pos[k + 2] = j / seg - 0.5;
    nrm[k + 1] = 1;
  }
  const idx = new Uint32Array(seg * seg * 6); let o = 0;
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
const waterGeo = buildWaterGeometry(WATER_SEG);
const waterMesh = new THREE.Mesh(waterGeo, new THREE.MeshPhongMaterial({
  vertexColors: true, color: 0xffffff, transparent: true, opacity: 0.72,
  side: THREE.DoubleSide, depthWrite: false, specular: 0xbfe0ff, shininess: 96,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
}));
waterMesh.layers.set(1);
waterMesh.frustumCulled = false;
scene.add(waterMesh);

const _W_SHALLOW = new THREE.Color(0x86d0d8);
const _wcDeep = new THREE.Color(), _wcShallow = new THREE.Color(), _wcOut = new THREE.Color();
function updateWaterColors(cx: number, cz: number) {
  const seaY = world.params.terrain.waterOffset;
  const col = waterGeo.attributes.color.array as Float32Array;
  const n = WATER_SEG + 1, span = waterSpanCur;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const wx = cx + (i / WATER_SEG - 0.5) * span, wz = cz + (j / WATER_SEG - 0.5) * span;
    const s = world.sampler(Math.floor(wx), Math.floor(wz));
    _wcDeep.setHex(biomeWaterHex(s.biome));
    _wcShallow.copy(_wcDeep).lerp(_W_SHALLOW, 0.55);
    const t = Math.min(1, Math.max(0, seaY - s.height) / 36);
    _wcOut.copy(_wcShallow).lerp(_wcDeep, t).multiplyScalar(1 - 0.32 * t);
    const k = (j * n + i) * 3;
    col[k] = _wcOut.r; col[k + 1] = _wcOut.g; col[k + 2] = _wcOut.b;
  }
  waterGeo.attributes.color.needsUpdate = true;
}

// Setup for player
const player = new Player(scene);
const physics = new Physics(scene);

// Minimap + fullscreen 2D world map. The minimap now blits the world's own
// per-chunk tiles (always in sync, no regeneration); the fullscreen map streams
// IDB-persisted worker tiles.
const _camDir = new THREE.Vector3();
const worldMap = new WorldMap({
  getPlayer: () => {
    const cam = mode === 'spectator' ? spectator.camera : player.camera;
    cam.getWorldDirection(_camDir);
    const pos = mode === 'spectator' ? spectator.camera.position : player.position;
    return { x: pos.x, z: pos.z, yaw: Math.atan2(_camDir.x, -_camDir.z) };
  },
  getChunkTile: (cx, cz) => world.getChunkMapTileCanvas(cx, cz),
  onTeleport: (x, z) => {
    const surface = world.sampler(Math.floor(x), Math.floor(z));
    player.position.set(x, surface.height + 3, z);
    player.velocity.set(0, 0, 0);
    spectator.camera.getWorldDirection(_camDir);
    spectator.placeAt(new THREE.Vector3(x, surface.height + 30, z), _camDir);
  },
  onOpen: () => {
    player.enabled = false;
    if (mode === 'spectator') spectator.setEnabled(false);
    else document.exitPointerLock();
    updateHudVisibility();
  },
  onClose: () => {
    player.enabled = true;
    if (mode === 'spectator') { if (!paused) spectator.setEnabled(true); }
    else if (!paused) player.controls.lock();   // works when closed via a click (teleport / ✕)
    updateHudVisibility();
  },
});
function configureMap() {
  worldMap.configure(world.params, world.chunkSize, world.params.terrain.waterOffset);
}
configureMap();
world.onAfterGenerate = configureMap;

const modelLoader = new ModelLoader();
modelLoader.loadModels((models) => {
  player.tool.setMesh(models.pickaxe);
})

// ===========================================================================
//  GAME MODES + PAUSE / MENU STATE MACHINE
// ===========================================================================
let mode: GameMode = 'survival';
let paused = true;   // start paused: the menu doubles as the "click to play" screen
const isFPS = () => mode !== 'spectator';

const crosshairEl = document.getElementById('crosshair');
const toolbarEl = document.getElementById('toolbar-container');
// Always-on stats HUD (top-right, under the minimap) — toggleable in Settings.
const statsOverlayEl = document.createElement('div');
statsOverlayEl.id = 'stats-overlay';
statsOverlayEl.style.display = 'none';
document.body.appendChild(statsOverlayEl);
function updateHudVisibility() {
  const playing = !paused && !worldMap.isOpen();
  const fpsPlay = isFPS() && playing;
  if (toolbarEl) toolbarEl.style.display = fpsPlay ? '' : 'none';
  if (crosshairEl) crosshairEl.style.display = (fpsPlay && player.controls.isLocked) ? '' : 'none';
  if (statsOverlayEl) statsOverlayEl.style.display = (playing && settings.statsOverlay) ? '' : 'none';
}

function setMode(m: GameMode) {
  const prev = mode;
  mode = m;
  if (m === 'spectator') {
    player.camera.getWorldDirection(_camDir);
    spectator.placeAt(player.position, _camDir);
    player.enabled = false;
    player.selectionHelper.visible = false;   // no block targeting in spectator
    spectator.setEnabled(!paused);
  } else {
    if (prev === 'spectator') {
      player.position.copy(spectator.camera.position);   // continuity: possess where you spectated
      player.velocity.set(0, 0, 0);
    }
    spectator.setEnabled(false);
    player.enabled = true;
    player.canFly = true;
    player.setFlying(m === 'creative');   // Creative flies by default; Survival walks
  }
  updateHudVisibility();
}

function pause() {
  if (paused) return;
  paused = true;
  if (isFPS()) {
    // player.enabled=false so movement keys don't re-grab the pointer while the
    // menu is up; exitPointerLock fires 'unlock' which sees paused===true (no re-pause).
    player.enabled = false;
    document.exitPointerLock();
  } else {
    spectator.setEnabled(false);
  }
  menu.open();
  updateHudVisibility();
}
function resume() {
  paused = false;
  menu.close();
  if (isFPS()) { player.enabled = true; player.controls.lock(); }   // resume() always runs from a user gesture
  else spectator.setEnabled(true);
  updateHudVisibility();
}

// Pointer-lock events drive the FPS pause flow: Esc exits lock → menu opens.
player.controls.addEventListener('lock', () => { paused = false; menu.close(); updateHudVisibility(); });
player.controls.addEventListener('unlock', () => {
  if (worldMap.isOpen() || !isFPS()) return;   // map / spectator manage themselves
  if (!paused) pause();
});

// Any click on the canvas while playing FPS but unlocked (e.g. after closing the
// map with Esc) re-locks the pointer. The block-edit handler below is gated on
// isLocked, so this locking click never also edits.
renderer.domElement.addEventListener('mousedown', () => {
  if (isFPS() && !paused && !worldMap.isOpen() && !player.controls.isLocked) player.controls.lock();
});

document.addEventListener('keydown', (event) => {
  const k = event.key;
  if (k === 'm' || k === 'M') {
    if (!paused) worldMap.toggle();
  } else if (k === 'o' || k === 'O') {
    toggleReferenceTextures();   // DEV-only texture compare
  } else if (k === 'Escape') {
    if (worldMap.isOpen()) worldMap.close();
    else if (paused) resume();
    else if (!isFPS()) pause();   // spectator has no pointer-lock event to hook
    // FPS + unpaused: the browser exits pointer lock → 'unlock' handler opens the menu
  }
});

// Lighting. Brighter physically-based intensities (three r155+ dropped legacy lights).
const sun = new THREE.DirectionalLight(0xfff2d8, 2.9);
const hemi = new THREE.HemisphereLight(0xbcd6ff /* sky */, 0x4d4233 /* ground */, 1.1);
const moon = new THREE.DirectionalLight(0xaec6f0, 0);
const MOON_PEAK = 0.45;

function makeGlowTexture(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 1, 32, 32, 32);
  grd.addColorStop(0, inner); grd.addColorStop(0.30, inner); grd.addColorStop(1, outer);
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture('rgba(255,250,235,1)', 'rgba(255,196,110,0)'),
  transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
}));
const moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture('rgba(238,244,255,1)', 'rgba(150,178,228,0)'),
  transparent: true, depthWrite: false, fog: false,
}));
sunSprite.frustumCulled = false;
moonSprite.frustumCulled = false;
sunSprite.layers.enable(1);
moonSprite.layers.enable(1);
scene.add(sunSprite);
scene.add(moonSprite);
const _sunDir = new THREE.Vector3();

const SUN_DISTANCE = 240;
let sunAzimuth = 199;
let sunElevation = 28;
const sunOffset = new THREE.Vector3();
function applySunDirection(azimuthDeg: number, elevationDeg: number) {
  sunAzimuth = azimuthDeg;
  sunElevation = elevationDeg;
  const az = azimuthDeg * Math.PI / 180;
  const el = THREE.MathUtils.clamp(elevationDeg, 3, 89) * Math.PI / 180;
  const horiz = Math.cos(el) * SUN_DISTANCE;
  sunOffset.set(Math.cos(az) * horiz, Math.sin(el) * SUN_DISTANCE, Math.sin(az) * horiz);
}

let shadowRange = 320;
function applyShadowRange(r: number) {
  shadowRange = r;
  const cam = sun.shadow.camera;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
  cam.far = SUN_DISTANCE + r * 2 + 80;
  cam.updateProjectionMatrix();
}

// Shadow QUALITY: map resolution + range, or off. Map size must agree with the
// texel-snap in updateSunShadow (it reads sun.shadow.mapSize.x), so we change it
// here and dispose the old map so three reallocates at the new size.
let shadowQuality: ShadowQuality = 'medium';
function applyShadowQuality(q: ShadowQuality) {
  shadowQuality = q;
  if (q === 'off') { sun.castShadow = false; return; }
  sun.castShadow = true;
  const size = q === 'low' ? 1024 : q === 'medium' ? 2048 : 4096;
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    // Drop the old render target so three reallocates it at the new resolution.
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
  applyShadowRange(q === 'low' ? 110 : q === 'medium' ? 200 : 320);
}

function setUpLights() {
  sun.castShadow = true;
  sun.shadow.camera.near = 1;
  sun.shadow.bias = -0.00008;
  sun.shadow.normalBias = 0.02;
  applyShadowQuality(shadowQuality);   // sets mapSize + range
  applySunDirection(sunAzimuth, sunElevation);
  scene.add(sun);
  scene.add(sun.target);

  scene.add(hemi);

  moon.castShadow = false;
  scene.add(moon);
  scene.add(moon.target);
}

// Park the sun at its offset from the player + snap the shadow frustum centre to
// whole texel steps along the light's plane axes (stops shadow edges shimmering
// as you move). The streaming anchor (player.position) follows the active camera.
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(0, 0, 1);
const _center = new THREE.Vector3();
function updateSunShadow() {
  _fwd.copy(sunOffset).negate().normalize();
  const up0 = Math.abs(_fwd.y) > 0.99 ? _altUp : _worldUp;
  _right.crossVectors(_fwd, up0).normalize();
  _up.crossVectors(_right, _fwd).normalize();

  const texel = (2 * shadowRange) / sun.shadow.mapSize.x;
  const px = player.position;
  const u = Math.round(px.dot(_right) / texel) * texel;
  const v = Math.round(px.dot(_up) / texel) * texel;
  const w = px.dot(_fwd);
  _center.set(0, 0, 0).addScaledVector(_right, u).addScaledVector(_up, v).addScaledVector(_fwd, w);

  sun.target.position.copy(_center);
  sun.position.copy(_center).add(sunOffset);
}

// --- Biome-aware ambient tint ---------------------------------------------
let baseFill = 1.1;
const _tintSky = new THREE.Color(0xbcd6ff);
const _tintGround = new THREE.Color(0x4d4233);
const _tintClear = new THREE.Color(SKY_COLOR);
const _targetSky = new THREE.Color(0xbcd6ff);
const _targetGround = new THREE.Color(0x4d4233);
const _targetClear = new THREE.Color(SKY_COLOR);
let _bright = 1, _targetBright = 1;
let biomeTintTick = 0;

// --- Day/night cycle -------------------------------------------------------
let timeOfDay = 0.30;
let dayLength = 480;
let sunPeak = 2.9;
const SUN_BIAS = 34, SUN_AMP = 48;
const NIGHT_SKY = new THREE.Color(0x0c1120);
const DUSK_SKY = new THREE.Color(0xe07338);
const NIGHT_HEMI = new THREE.Color(0x2c3c58);
const SUN_DAY = new THREE.Color(0xfff2d8);
const SUN_DUSK = new THREE.Color(0xff7326);
const _sky = new THREE.Color();
const _hemiC = new THREE.Color();
const sstep = THREE.MathUtils.smoothstep;

function updateSky(delta: number) {
  let elevReal = sunElevation;
  if (settings.dayNight) {
    timeOfDay = (timeOfDay + delta / Math.max(20, dayLength)) % 1;
    elevReal = SUN_BIAS + SUN_AMP * Math.sin((timeOfDay - 0.25) * Math.PI * 2);
    applySunDirection((timeOfDay * 360 + 60) % 360, elevReal);
  }
  const daylight = THREE.MathUtils.clamp((elevReal + 6) / 18, 0, 1);
  const glow = sstep(elevReal, -8, 3) * (1 - sstep(elevReal, 3, 16));

  if (settings.biomeLighting && (biomeTintTick++ % 8) === 0) {
    const s = world.sampler(Math.floor(player.position.x), Math.floor(player.position.z));
    const t = biomeTint(s.biome);
    _targetSky.setHex(t.sky); _targetGround.setHex(t.ground); _targetClear.setHex(t.clear); _targetBright = t.bright;
  }
  _tintSky.lerp(_targetSky, 0.04);
  _tintGround.lerp(_targetGround, 0.04);
  _tintClear.lerp(_targetClear, 0.04);
  _bright += (_targetBright - _bright) * 0.04;

  _sky.copy(NIGHT_SKY).lerp(_tintClear, daylight).lerp(DUSK_SKY, glow * 0.6);
  renderer.setClearColor(_sky);
  if (scene.fog) (scene.fog as THREE.Fog).color.copy(_sky);
  _hemiC.copy(NIGHT_HEMI).lerp(_tintSky, daylight);
  hemi.color.copy(_hemiC);
  hemi.groundColor.copy(_tintGround).multiplyScalar(0.4 + 0.6 * daylight);
  hemi.intensity = baseFill * _bright * (0.20 + 0.80 * daylight);
  sun.intensity = sunPeak * daylight;
  sun.color.copy(SUN_DUSK).lerp(SUN_DAY, Math.min(1, daylight * 1.6));

  const azr = sunAzimuth * Math.PI / 180, elr = elevReal * Math.PI / 180, ce = Math.cos(elr);
  _sunDir.set(Math.cos(azr) * ce, Math.sin(elr), Math.sin(azr) * ce);
  const skyDist = player.camera.far * 0.9;
  sunSprite.position.copy(player.position).addScaledVector(_sunDir, skyDist);
  moonSprite.position.copy(player.position).addScaledVector(_sunDir, -skyDist);
  const ss = skyDist * 0.13, ms = skyDist * 0.09;
  sunSprite.scale.set(ss, ss, 1);
  moonSprite.scale.set(ms, ms, 1);
  sunSprite.material.opacity = THREE.MathUtils.clamp(daylight * 1.6, 0, 1);
  moonSprite.material.opacity = THREE.MathUtils.clamp((1 - daylight) * 1.3, 0, 1) * 0.95;

  moon.intensity = MOON_PEAK * (1 - daylight);
  moon.position.copy(player.position).addScaledVector(_sunDir, -SUN_DISTANCE);
  moon.target.position.copy(player.position);
}

function onMouseDown(event: MouseEvent) {
  if (!player.controls.isLocked) return;   // also blocks edits in spectator / when paused
  if (event.button === 2) {
    const t = player.targetedBlock;
    if (t && world.interactBlock(t.x, t.y, t.z)) return;
    const s = player.selectedCoords;
    if (s) player.activeBlockId = world.getBlock(s.x, s.y, s.z)?.id ?? blocks.air.id;
    return;
  }
  if (event.button === 0 && player.selectedCoords) {
    const c = player.selectedCoords;
    if (player.activeBlockId === blocks.air.id) {
      world.removeBlock(c.x, c.y, c.z);
      player.tool.startAnimation();
    } else {
      world.setBlock(c.x, c.y, c.z, player.activeBlockId);
      if (player.activeBlockId === BLOCK_IDS.oakDoorLowerClosed) world.setBlock(c.x, c.y + 1, c.z, BLOCK_IDS.oakDoorUpperClosed);
    }
  }
}
document.addEventListener('mousedown', onMouseDown);

// ===========================================================================
//  QUALITY PRESETS  — bundle render distance, foliage, shadows, lights, etc.
// ===========================================================================
let qualityPreset: QualityPreset = 'fast';   // default to lowest graphics
function applyQualityPreset(p: QualityPreset) {
  qualityPreset = p;
  if (p === 'fast') {
    // Lowest: short view, tight foliage, NO shadow pass, NO dynamic point lights,
    // NO cloud overdraw, downscaled render — the cheapest the engine goes.
    world.drawDistance = 6; world.setFoliage(true, 3);
    applyShadowQuality('off'); lightInterval = 4; lightManager.setEnabled(false);
    settings.resolutionScale = 0.7; clouds.visible = false;
  } else if (p === 'balanced') {
    world.drawDistance = 12; world.setFoliage(true, 7);
    applyShadowQuality('medium'); lightInterval = 2; lightManager.setEnabled(true);
    settings.resolutionScale = 1; clouds.visible = true;
  } else if (p === 'fancy') {
    world.drawDistance = 16; world.setFoliage(true, 14);
    applyShadowQuality('high'); lightInterval = 1; lightManager.setEnabled(true);
    settings.resolutionScale = 1; clouds.visible = true;
  }
  applyResolution();
  updateViewDistance();
}

setUpLights();
applyQualityPreset(qualityPreset);   // sets draw distance + shadows + lights + resolution
updateViewDistance();

const menu = createMenu({
  world,
  player,
  settings,
  regenerate: () => { world.generate(false); },
  onViewDistanceChange: updateViewDistance,
  onResolutionChange: applyResolution,
  getStats: () => {
    const r = renderer.info.render, m = renderer.info.memory;
    const p = mode === 'spectator' ? spectator.camera.position : player.position;
    return {
      fps, x: p.x, y: p.y, z: p.z,
      drawCalls: r.calls, triangles: r.triangles, chunks: world.chunkCount,
      geometries: m.geometries, textures: m.textures,
      mode, flying: player.flying, onGround: player.onGround,
    };
  },
  getMode: () => mode,
  setMode,
  onResume: resume,
  onSave: () => world.save(),
  onLoad: () => world.load(),
  lighting: {
    getSun: () => sunPeak, setSun: (v) => { sunPeak = v; },
    getFill: () => baseFill, setFill: (v) => { baseFill = v; },
    getExposure: () => renderer.toneMappingExposure, setExposure: (v) => { renderer.toneMappingExposure = v; },
    getAzimuth: () => sunAzimuth, setAzimuth: (v) => applySunDirection(v, sunElevation),
    getElevation: () => sunElevation, setElevation: (v) => applySunDirection(sunAzimuth, v),
    getBiomeTint: () => settings.biomeLighting, setBiomeTint: (v) => { settings.biomeLighting = v; },
    getDayNight: () => settings.dayNight, setDayNight: (v) => { settings.dayNight = v; },
    getTime: () => timeOfDay, setTime: (v) => { timeOfDay = v; },
    getDayLength: () => dayLength, setDayLength: (v) => { dayLength = v; },
  },
  quality: {
    applyPreset: applyQualityPreset,
    getPreset: () => qualityPreset,
    getRenderDistance: () => world.drawDistance,
    setRenderDistance: (v) => { world.drawDistance = v; qualityPreset = 'custom'; updateViewDistance(); },
    getFoliage: () => world.foliageEnabled,
    setFoliage: (v) => { world.setFoliage(v, world.foliageDistance); qualityPreset = 'custom'; },
    getFoliageDistance: () => world.foliageDistance,
    setFoliageDistance: (v) => { world.setFoliage(world.foliageEnabled, v); qualityPreset = 'custom'; },
    getShadowQuality: () => shadowQuality,
    setShadowQuality: (v) => { applyShadowQuality(v); qualityPreset = 'custom'; },
    getShadowRange: () => shadowRange,
    setShadowRange: (v) => { applyShadowRange(v); qualityPreset = 'custom'; },
    getBlockLights: () => lightManager.enabled,
    setBlockLights: (v) => { lightManager.setEnabled(v); qualityPreset = 'custom'; },
    getClouds: () => clouds.visible,
    setClouds: (v) => { clouds.visible = v; qualityPreset = 'custom'; },
    getStatsOverlay: () => settings.statsOverlay,
    setStatsOverlay: (v) => { settings.statsOverlay = v; updateHudVisibility(); },
  },
});

// Start in the menu (Survival selected). The user clicks Play to lock in and go.
// player input stays disabled until then so stray key presses don't grab the pointer.
player.enabled = false;
menu.open();
updateHudVisibility();

// draw loop
function animate() {
  const currentTime = performance.now();
  // Clamp the step so a backgrounded tab (huge dt) can't spiral the physics
  // accumulator into thousands of substeps on refocus.
  const delta = Math.min((currentTime - previousTime) / 1000, 0.1);
  const playing = !paused && !worldMap.isOpen();

  if (mode === 'spectator') {
    spectator.update(delta, !playing);
    if (playing) player.position.copy(spectator.camera.position);   // streaming anchor follows the free-cam
  } else if (playing && player.controls.isLocked) {
    player.update(world);
    physics.update(delta, player, world);
  }

  updateSky(playing ? delta : 0);   // freeze the day/night clock while paused
  if (sun.castShadow) updateSunShadow();   // skip the frustum maths entirely when shadows are off
  updatePlantWind(currentTime / 1000);

  worldMap.update();

  if (!worldMap.isOpen()) {
    world.update(player);
    world.processQueues();
    if (lightManager.enabled && (lightTick++ % lightInterval) === 0) {
      lightManager.update(world, player.position, currentTime / 1000);
    }

    clouds.update(player.position.x, player.position.z, currentTime / 1000);
    const wsx = Math.round(player.position.x / WATER_SNAP) * WATER_SNAP;
    const wsz = Math.round(player.position.z / WATER_SNAP) * WATER_SNAP;
    waterMesh.position.set(wsx, world.params.terrain.waterOffset + 0.45, wsz);
    if (wsx !== waterSnapX || wsz !== waterSnapZ) {
      waterSnapX = wsx; waterSnapZ = wsz;
      updateWaterColors(wsx, wsz);
    }

    const activeCamera = mode === 'spectator' ? spectator.camera : player.camera;
    renderer.render(scene, activeCamera);
  }

  // Live FPS (rolling, ~4×/s) for the debug menu + the always-on overlay.
  fpsFrames++;
  if (currentTime - fpsLast >= 250) {
    fps = fpsFrames * 1000 / (currentTime - fpsLast); fpsFrames = 0; fpsLast = currentTime;
    if (statsOverlayEl.style.display !== 'none') {
      const r = renderer.info.render;
      const p = mode === 'spectator' ? spectator.camera.position : player.position;
      statsOverlayEl.textContent =
        `FPS ${Math.round(fps)}  ·  ${mode}\n` +
        `XYZ ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
        `draws ${r.calls}  ·  tris ${r.triangles.toLocaleString()}\n` +
        `chunks ${world.chunkCount}`;
    }
  }
  if (menu.isOpen()) menu.refreshStats();

  previousTime = currentTime;
  scheduleFrame();
}

animate();
