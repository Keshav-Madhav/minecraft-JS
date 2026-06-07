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
import { updatePlantWind, toggleReferenceTextures, updateCubeUniforms, setFoliageShadows, registerFogShader, updateFogCamera, CYL_FOG_FRAGMENT } from './blockArrayMaterial';
import { LightManager } from './lightManager';
import { PostFX } from './ultraGraphics';
import { Net } from './net';
import { RemotePlayer } from './remotePlayer';

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
  postfx?.setSize(winWidth, winHeight);
})

let previousTime = performance.now();

// Settings surfaced in the menu. Defaults: VSYNC ON (uncapFPS off) — the uncapped
// MessageChannel spin floods the main thread with macrotasks, starving compositor
// commits and pointer-lock mousemove delivery: the loop counter reads 500+ "fps"
// while the screen visibly updates at ~10. Worst in production builds (minified →
// faster spin → harder starvation), which is why Vercel felt broken while local
// dev looked fine. Uncapped stays as an opt-in benchmark toggle. Fog on, biome
// tint + day/night on, and an always-on stats overlay while playing.
// fogNear 0.85 (was 0.7): with the LOD horizon at 1-4km, a fog ramp starting at
// 70% put a HUNDREDS-of-metres-wide milky gradient across most of the visible
// frame ("blurry / non-HD" feel). At 0.85 + a tighter band the world stays
// vivid out to the far ring and only the horizon itself dissolves.
const settings = { uncapFPS: false, fpsCap: 0, fog: true, fogNear: 0.85, resolutionScale: 1, biomeLighting: true, dayNight: true, statsOverlay: true };
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
    if (settings.fpsCap > 0) {
      // Soft frame-rate cap: wait out the remainder of the target interval since
      // this frame STARTED (previousTime), then run. JS timer jitter is fine for
      // a soft cap and keeps the GPU/battery from a pointless uncapped spin.
      const wait = Math.max(0, 1000 / settings.fpsCap - (performance.now() - previousTime));
      setTimeout(animate, wait);
    } else if (!frameScheduled) {
      frameScheduled = true; frameChannel.port2.postMessage(0);
    }
  } else {
    requestAnimationFrame(animate);
  }
}

// --- live perf stats (shown in the debug menu, not a permanent HUD) ----------
let fps = 0, fpsFrames = 0, fpsLast = performance.now();

// DISPLAY fps: a dedicated rAF chain that just counts ticks. rAF fires once per
// display frame the main thread actually services, so when the uncapped loop
// floods the thread this drops in step with the visible jank while the loop
// counter (`fps` above) stays sky-high. Shown next to the loop fps when they
// diverge so the meter can't claim 500 while the screen crawls.
let dispFps = 0, dispFrames = 0, dispLast = performance.now();
(function dispTick() {
  dispFrames++;
  const t = performance.now();
  if (t - dispLast >= 250) { dispFps = dispFrames * 1000 / (t - dispLast); dispFrames = 0; dispLast = t; }
  requestAnimationFrame(dispTick);
})();

// --- Boot safety net ---------------------------------------------------------
// Surface a readable overlay if startup fails, instead of a silent blank canvas.
// Fires only BEFORE the first frame renders (`booted`), so a non-fatal mid-game
// error never throws up a scary full-screen panel. A module-evaluation throw
// (e.g. the WebGL failure below) also fires the window 'error' event.
let booted = false;
let fatalShown = false;
function showFatal(text: string) {
  if (fatalShown) return;
  fatalShown = true;
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;'
    + 'background:#80a0e0;color:#fff;font:600 18px/1.5 sans-serif;text-align:center;padding:24px;z-index:99999';
  d.textContent = text;
  document.body.appendChild(d);
}
window.addEventListener('error', (e) => { if (!booted) showFatal('The game failed to start: ' + (e.message || 'unexpected error') + '. See the console for details.'); });
window.addEventListener('unhandledrejection', () => { if (!booted) showFatal('The game failed to start (async error). See the console for details.'); });

const LOG_DEPTH = false;
const CAMERA_NEAR = 0.3;
function createRenderer(): THREE.WebGLRenderer {
  try {
    // antialias: MSAA on the default framebuffer — smooths the jaggy voxel edges
    // in the normal (non-ultra) render path. The ultra composer does its own MSAA
    // (multisampled render target) since post-processing bypasses this buffer.
    return new THREE.WebGLRenderer({ logarithmicDepthBuffer: LOG_DEPTH, antialias: true });
  } catch (e) {
    showFatal('This game needs WebGL, which your browser/GPU did not provide.');
    throw e;   // terminal: nothing works without a renderer (the overlay above explains why)
  }
}
const renderer = createRenderer();
function applyResolution() {
  // resolutionScale > 1 supersamples (SSAA) for crisp voxel edges; clamp the final
  // device-pixel product at 3 so a hi-DPI panel + 2× scale can't melt the GPU.
  renderer.setPixelRatio(Math.min(Math.min(window.devicePixelRatio, 2) * settings.resolutionScale, 3));
}
applyResolution();
renderer.setSize(winWidth, winHeight);
renderer.setClearColor(0x80a0e0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // soft shadow edges (r182+: PCFSoftShadowMap was deprecated; PCFShadowMap is soft now)
// Accumulate render-info across ALL passes in a frame (reset manually each frame),
// so the stats overlay shows the true scene draw count even in ultra mode where
// the EffectComposer issues several post-process passes after the scene render.
renderer.info.autoReset = false;
// No per-frame z-sort of the render list: with thousands of opaque voxel draws
// the projectObject+sort cost is real CPU while early-Z already handles overdraw.
// The only transparent object is the single water plane, so ordering is moot.
renderer.sortObjects = false;
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

// XYZ orientation gizmo pinned to the spectator's orbit pivot — a placement
// reference (which way is +X/+Y/+Z, and where the camera is orbiting). Shown only
// while spectating; rendered on top (depthTest off) so it stays visible even when
// the pivot sits inside terrain.
const orbitGizmo = new THREE.Group();
{
  const L = 3, mkArrow = (dir: THREE.Vector3, color: number) => {
    const a = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), L, color, L * 0.32, L * 0.2);
    a.traverse((o) => {
      o.renderOrder = 999;
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) { m.depthTest = false; m.transparent = true; }
    });
    return a;
  };
  orbitGizmo.add(mkArrow(new THREE.Vector3(1, 0, 0), 0xff5050));   // +X red
  orbitGizmo.add(mkArrow(new THREE.Vector3(0, 1, 0), 0x50ff50));   // +Y green
  orbitGizmo.add(mkArrow(new THREE.Vector3(0, 0, 1), 0x5090ff));   // +Z blue
}
orbitGizmo.visible = false;
scene.add(orbitGizmo);

// Localized block lighting: a pool of point lights snapped to nearby emitters.
const lightManager = new LightManager(scene);
let lightInterval = 2;   // frames between point-light gathers (quality preset)
let lightTick = 0;

// Fog and the camera far plane scale with the VIEW distance — the farther of
// the full-detail ring and the LOD far-terrain ring — so the loaded edge fades
// into the sky. Applied to BOTH cameras so fog matches whichever is active.
function updateViewDistance() {
  const span = Math.max(world.drawDistance, world.lodDistance, 1) * world.chunkSize.width;
  player.camera.far = span + 48;
  player.camera.updateProjectionMatrix();
  spectator.camera.far = span + 48;
  spectator.camera.updateProjectionMatrix();
  // Lighter fog: clear out to ~70% of the view, fading only the far edge (was
  // span*0.4 → fully opaque well before the draw edge, which made even a long
  // render distance look short). The fade ends slightly past the edge so the very
  // last ring isn't a hard wall.
  // Fog Distance (settings.fogNear, 0.4–1.0) sets where the haze starts as a
  // fraction of the view span; the fade band is a constant ~0.25 span beyond it
  // so the far edge always dissolves softly (never a hard wall). Band tightened
  // from 0.38 — at multi-km spans a 0.38 band was a huge washed-out gradient.
  scene.fog = settings.fog ? new THREE.Fog(SKY_COLOR, span * settings.fogNear, span * (settings.fogNear + 0.25)) : null;
  clouds.setViewDistance(player.camera.far);
  // Scale the per-frame streaming budget with distance so a big view actually
  // FILLS quickly instead of slowly creeping out (the other half of why high
  // distances felt capped). Bounded so low distances stay light.
  world.maxAppliesPerFrame = Math.max(8, Math.min(18, Math.round(world.drawDistance / 1.8)));
  world.maxMeshBuildsPerFrame = Math.max(3, Math.min(7, Math.round(world.drawDistance / 5)));
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
const waterMaterial = new THREE.MeshPhongMaterial({
  vertexColors: true, color: 0xffffff, transparent: true, opacity: 0.72,
  side: THREE.DoubleSide, depthWrite: false, specular: 0xbfe0ff, shininess: 96,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});
// ULTRA water reflection: a fresnel sky-reflection — at grazing angles the surface
// mirrors the (day/night) sky colour, giving a glossy reflective sheen. Gated by
// uReflect (0 off / 1 ultra); uSkyRefl tracks the live sky colour each frame. The
// plane is horizontal so the world normal is simply +Y → fresnel = pow(1-viewDir.y,3).
let waterShader: THREE.WebGLProgramParametersWithUniforms | null = null;
waterMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uReflect = { value: 0 };
  shader.uniforms.uSkyRefl = { value: new THREE.Color(0xbcd6ff) };
  shader.uniforms.uWaterTime = { value: 0 };
  registerFogShader(shader);   // cylindrical fog (uses vWaterPos)
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uReflect;\nuniform vec3 uSkyRefl;\nuniform float uWaterTime;\nuniform vec2 uCamXZ;\nvarying vec3 vWaterPos;')
    .replace('#include <fog_fragment>', CYL_FOG_FRAGMENT('vWaterPos'))
    // Animate the surface normal with crossing ripples → the Phong sun glint and
    // the fresnel sky-reflection shimmer like real moving water (ultra only).
    .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  if (uReflect > 0.5) {\n    float wt = uWaterTime; vec2 wp = vWaterPos.xz;\n    float nx = 0.14 * (sin(wp.x * 0.55 + wt * 1.1) + 0.6 * sin(wp.x * 1.7 - wt * 1.7 + wp.y * 0.4));\n    float nz = 0.14 * (cos(wp.y * 0.5 + wt * 0.9) + 0.6 * sin(wp.y * 1.6 + wt * 1.3 + wp.x * 0.4));\n    normal = normalize(normal + vec3(nx, 0.0, nz));\n  }')
    .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  if (uReflect > 0.5) {\n    vec3 vd = normalize(cameraPosition - vWaterPos);\n    float fres = pow(1.0 - clamp(dot(vd, normalize(normal)), 0.0, 1.0), 3.0);\n    gl_FragColor.rgb = mix(gl_FragColor.rgb, uSkyRefl, fres * 0.6);\n    gl_FragColor.a = clamp(gl_FragColor.a + fres * 0.25, 0.0, 1.0);\n  }');
  waterShader = shader;
};
const waterMesh = new THREE.Mesh(waterGeo, waterMaterial);
waterMesh.layers.set(1);
waterMesh.frustumCulled = false;
scene.add(waterMesh);

const _W_SHALLOW = new THREE.Color(0x86d0d8);
const _wcDeep = new THREE.Color(), _wcShallow = new THREE.Color(), _wcOut = new THREE.Color();
// Coarse colour grid (stride WC_STRIDE): the per-vertex water colour was 49² = 2401
// world.sampler() calls on every snap-move (a ~5ms hitch over water). We sample a
// stride-2 grid (25² = 625 calls, ~4× fewer) and BILINEARLY interpolate the colour
// into the full vertex grid — even vertices stay exact, the rest blend smoothly
// (water colour is a smooth field, so this is visually identical / nicer at biome
// edges). The grid is pre-allocated once.
const WC_STRIDE = 2;
const WC_N = (WATER_SEG / WC_STRIDE) + 1;            // 25 coarse points per side
const _waterCoarse = new Float32Array(WC_N * WC_N * 3);
function updateWaterColors(cx: number, cz: number) {
  const seaY = world.params.terrain.waterOffset;
  const col = waterGeo.attributes.color.array as Float32Array;
  const n = WATER_SEG + 1, span = waterSpanCur, cg = _waterCoarse;
  // 1) sample the coarse grid
  for (let cj = 0; cj < WC_N; cj++) for (let ci = 0; ci < WC_N; ci++) {
    const i = ci * WC_STRIDE, j = cj * WC_STRIDE;
    const wx = cx + (i / WATER_SEG - 0.5) * span, wz = cz + (j / WATER_SEG - 0.5) * span;
    const s = world.sampler(Math.floor(wx), Math.floor(wz));
    _wcDeep.setHex(biomeWaterHex(s.biome));
    _wcShallow.copy(_wcDeep).lerp(_W_SHALLOW, 0.55);
    const t = Math.min(1, Math.max(0, seaY - s.height) / 36);
    _wcOut.copy(_wcShallow).lerp(_wcDeep, t).multiplyScalar(1 - 0.32 * t);
    const k = (cj * WC_N + ci) * 3;
    cg[k] = _wcOut.r; cg[k + 1] = _wcOut.g; cg[k + 2] = _wcOut.b;
  }
  // 2) bilinear-interpolate the coarse colours into every vertex
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const fi = i / WC_STRIDE, fj = j / WC_STRIDE;
    const ci0 = Math.min(WC_N - 2, fi | 0), cj0 = Math.min(WC_N - 2, fj | 0);
    const tx = fi - ci0, tz = fj - cj0;
    const a = (cj0 * WC_N + ci0) * 3, b = a + 3, c = a + WC_N * 3, d = c + 3, k = (j * n + i) * 3;
    for (let ch = 0; ch < 3; ch++) {
      const top = cg[a + ch] * (1 - tx) + cg[b + ch] * tx;
      const bot = cg[c + ch] * (1 - tx) + cg[d + ch] * tx;
      col[k + ch] = top * (1 - tz) + bot * tz;
    }
  }
  waterGeo.attributes.color.needsUpdate = true;
}

// Setup for player
const player = new Player(scene);
const physics = new Physics(scene);

// Spawn AT the surface (deterministic via the sampler — no chunk load needed)
// instead of free-falling from y=340: that long drop, if the spawn chunk hadn't
// meshed yet, left the player frozen mid-air with no feedback. Over ocean, spawn at
// the waterline (sea) rather than the seabed. Snaps both the initial spawn and the
// R-key respawn (player.spawnPoint).
{
  const sx = Math.floor(player.position.x), sz = Math.floor(player.position.z);
  const surf = Math.max(world.sampler(sx, sz).height, world.params.terrain.waterOffset);
  player.spawnPoint.set(player.position.x, surf + 3, player.position.z);
  player.position.copy(player.spawnPoint);
}

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
  getMapEpoch: () => world.mapTileEpoch,
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
// (world.onAfterGenerate is assigned in the MULTIPLAYER block below — it runs
// configureMap first, then re-snapshots the world to a connected guest.)

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

// Scroll adjusts FLIGHT SPEED while flying in Creative / Survival-flight (spectator
// has its own wheel handler). Exponential, clamped — scroll up = faster.
renderer.domElement.addEventListener('wheel', (e) => {
  if (mode === 'spectator' || !player.flying || !player.controls.isLocked) return;
  e.preventDefault();
  player.flySpeedScale = Math.min(8, Math.max(0.25, player.flySpeedScale * Math.exp(-e.deltaY * 0.0015)));
}, { passive: false });

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
// --- shadow re-render throttle state (see the animate() shadow block) -------
let shadowDirty = true;                  // force a render on the next daylight frame
const _lastShadowCenter = new THREE.Vector3(NaN, NaN, NaN);
let lastShadowAz = NaN, lastShadowEl = NaN;
let lastShadowMeshEpoch = -1;

function applyShadowRange(r: number) {
  shadowRange = r;
  const cam = sun.shadow.camera;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
  cam.far = SUN_DISTANCE + r * 2 + 80;
  cam.updateProjectionMatrix();
  shadowDirty = true;
}

// Shadow QUALITY: map resolution + range, or off. Map size must agree with the
// texel-snap in updateSunShadow (it reads sun.shadow.mapSize.x), so we change it
// here and dispose the old map so three reallocates at the new size.
let shadowQuality: ShadowQuality = 'medium';
function applyShadowQuality(q: ShadowQuality) {
  shadowQuality = q;
  if (q === 'off') { sun.castShadow = false; return; }
  sun.castShadow = true;
  // ultra = an 8192 map over a wide range → ~0.16-block texels (razor-crisp), with
  // the foliage/leaf cutout shadows + soft PCF reading as real dappled light.
  const size = q === 'low' ? 1024 : q === 'medium' ? 2048 : q === 'high' ? 4096 : 8192;
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    // Drop the old render target so three reallocates it at the new resolution.
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
  // Ranges pushed out (was 110/200/320/440): three returns FULLY LIT for any
  // fragment outside the shadow frustum — no fade — so a small range painted a
  // hard bright ring on the ground mid-terrain ("weird lighting"). Larger
  // ranges move the seam toward the fog band; texels stay sharp (2r/size).
  // The caster-count cost is absorbed by the shadow re-render throttle below.
  applyShadowRange(q === 'low' ? 140 : q === 'medium' ? 280 : q === 'high' ? 480 : 640);
  shadowDirty = true;
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
let currentDaylight = 1;   // 0 night → 1 day; drives the god-ray intensity
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
  currentDaylight = daylight;
  const glow = sstep(elevReal, -8, 3) * (1 - sstep(elevReal, 3, 16));

  if (settings.biomeLighting && (biomeTintTick++ % 8) === 0) {
    const s = world.sampler(Math.floor(player.position.x), Math.floor(player.position.z));
    const t = biomeTint(s.biome);
    _targetSky.setHex(t.sky); _targetGround.setHex(t.ground); _targetClear.setHex(t.clear); _targetBright = t.bright;
  }
  // Frame-rate-INDEPENDENT chase (was a fixed 0.04/frame, so biome/ambient
  // colour transitions ran ~5× faster at 200fps than at 40 — visible "weird
  // lighting" drift speed changes). k ≈ 0.04 at 60fps; k=0 while paused (delta 0).
  const tintK = 1 - Math.exp(-2.5 * delta);
  _tintSky.lerp(_targetSky, tintK);
  _tintGround.lerp(_targetGround, tintK);
  _tintClear.lerp(_targetClear, tintK);
  _bright += (_targetBright - _bright) * tintK;

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

  // Moon only rises once the sun is nearly gone — previously sun + moon + hemi
  // all contributed through dusk, additively over-brightening those frames.
  moon.intensity = MOON_PEAK * (1 - daylight) * (1 - sstep(daylight, 0.05, 0.2));
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
      // Beds are 2 cells (foot + head): auto-place the matching half one cell along
      // the player's facing (cardinal) so a hotbar-placed bed is a complete bed, not
      // an orphan half. Skip if that cell is occupied.
      else if (player.activeBlockId === BLOCK_IDS.bedFoot || player.activeBlockId === BLOCK_IDS.bedHead) {
        const d = player.camera.getWorldDirection(_camDir);
        const dx = Math.abs(d.x) > Math.abs(d.z) ? Math.sign(d.x) : 0;
        const dz = dx === 0 ? Math.sign(d.z) || 1 : 0;
        const other = player.activeBlockId === BLOCK_IDS.bedFoot ? BLOCK_IDS.bedHead : BLOCK_IDS.bedFoot;
        if ((world.getBlock(c.x + dx, c.y, c.z + dz)?.id ?? blocks.air.id) === blocks.air.id)
          world.setBlock(c.x + dx, c.y, c.z + dz, other);
      }
    }
  }
}
document.addEventListener('mousedown', onMouseDown);

// ===========================================================================
//  QUALITY PRESETS  — bundle render distance, foliage, shadows, lights, etc.
// ===========================================================================
// UNIFIED view distance: one knob (chunks) drives both rings. The value is the
// LOD far-terrain horizon; the full-detail (physics/edit) chunk ring is always
// a QUARTER of it — 256 → 64 real chunks + 4km of LOD, 48 → 12 real chunks.
// Smooth (step 1): odd values just round the chunk ring.
function applyUnifiedViewDistance(v: number) {
  world.lodDistance = Math.max(4, Math.round(v));
  world.drawDistance = Math.min(64, Math.max(2, Math.round(v / 4)));
  updateViewDistance();
}

let qualityPreset: QualityPreset = 'balanced';   // sensible default out of the box
function applyQualityPreset(p: QualityPreset) {
  qualityPreset = p;
  // Ultra Graphics (post-FX) stays an independent ADD-ON for the normal ladder —
  // only MAX forces it on ("everything maxed"); other presets leave it as-is.
  // Every preset sets ONE unified View Distance (chunks): the slider value IS
  // the LOD horizon, and the full-detail chunk ring is always a quarter of it
  // (32→8, 64→16, 128→32, 192→48, 256→64) — see applyUnifiedViewDistance.
  if (p === 'low') {
    // Lowest: short view, tight foliage, NO shadow pass, NO dynamic point lights,
    // NO cloud overdraw, lightly downscaled render — the cheapest the engine goes.
    // (0.85 not 0.7 so the out-of-box image isn't noticeably blurry on weak GPUs.)
    applyUnifiedViewDistance(32); world.setFoliage(true, 5);
    applyShadowQuality('off'); lightInterval = 4; lightManager.setEnabled(false);
    settings.resolutionScale = 0.85; clouds.visible = false;
  } else if (p === 'balanced') {
    applyUnifiedViewDistance(64); world.setFoliage(true, 10);
    applyShadowQuality('medium'); lightInterval = 2; lightManager.setEnabled(true);
    settings.resolutionScale = 1; clouds.visible = true;
  } else if (p === 'fancy') {
    applyUnifiedViewDistance(128); world.setFoliage(true, 20);
    applyShadowQuality('high'); lightInterval = 1; lightManager.setEnabled(true);
    settings.resolutionScale = 1; clouds.visible = true;
  } else if (p === 'ultra') {
    // 48-chunk full-detail ring under a ~3km LOD horizon, 8192 soft shadows.
    applyUnifiedViewDistance(192); world.setFoliage(true, 32);
    applyShadowQuality('ultra'); lightInterval = 1; lightManager.setEnabled(true);
    settings.resolutionScale = 1; clouds.visible = true;
  } else if (p === 'max') {
    // MAX: every slider at its limit — 64 real chunks + 4km LOD horizon, 8K soft
    // shadows, far foliage, post-FX pipeline, 2× supersampling. The UI shows a
    // warning; this is the "I have a monster machine" button.
    applyUnifiedViewDistance(256); world.setFoliage(true, 64);
    applyShadowQuality('ultra'); lightInterval = 1; lightManager.setEnabled(true);
    settings.resolutionScale = 2; clouds.visible = true;
    setUltraGraphics(true);
  }
  applyResolution();
  updateViewDistance();
}

// Ultra graphics: post-processing (bloom + god rays), foliage/leaf cutout shadows,
// underwater caustics, and a glossy fresnel water reflection. Heavy — opt-in, and
// INDEPENDENT of the quality preset (layers onto any of them; OFF by default).
let ultraGraphics = false;
let postfx: PostFX | null = null;
// User tuning for the post-FX look (settings sliders). Defaults match the values
// that used to be hardcoded in PostFX, so the look is unchanged at defaults. Kept
// here (not on PostFX) so they survive the lazy create/dispose of the pipeline.
const postfxSettings = { bloom: 0.6, godRays: 1.0 };
function setUltraGraphics(on: boolean) {
  ultraGraphics = on;
  setFoliageShadows(on);            // new chunk meshes pick this up...
  world.refreshFoliageShadows(on);  // ...and existing ones are updated in place
  shadowDirty = true;               // caster set changed (foliage shadows) → re-render the map
  // (water uReflect is driven every frame in the render loop from `ultraGraphics`)
  if (on && !postfx) postfx = new PostFX(renderer, scene, mode === 'spectator' ? spectator.camera : player.camera);
  else if (!on && postfx) { postfx.dispose(); postfx = null; }   // free the HDR buffers when ultra is off
  if (postfx) { postfx.bloom.strength = postfxSettings.bloom; postfx.godRayScale = postfxSettings.godRays; }
}

setUpLights();
applyQualityPreset(qualityPreset);   // sets draw distance + shadows + lights + resolution (calls updateViewDistance itself)

// ===========================================================================
//  MULTIPLAYER (P2P co-op via net.ts)
//  The world never crosses the wire — terrain is deterministic from
//  params.seed, so the host sends { params, edits, timeOfDay } once and the
//  guest regenerates locally. After that: tiny edit events + ~20 Hz positions.
// ===========================================================================
const net = new Net();
const remote = new RemotePlayer();
scene.add(remote.group);

const POS_SEND_MS = 50;        // ~20 Hz — the avatar interpolates between these
const TIME_SYNC_MS = 10_000;   // host re-syncs the day/night clock occasionally
let lastPosSendAt = 0, lastTimeSyncAt = 0;
const _netEuler = new THREE.Euler(0, 0, 0, 'YXZ');

net.getInitPayload = () => ({ params: world.params, edits: world.dataStore.data, timeOfDay });

// GUEST: adopt the host's world wholesale — same machinery as world.load().
net.onInit = ({ params, edits, timeOfDay: tod }) => {
  world.params = params;
  world.dataStore.data = edits;
  world.dataStore.rebuildIndex();   // data was assigned directly (bypassing set())
  timeOfDay = tod;
  world.generate(false);            // regenerate = the host's exact terrain (deterministic)
  // Snap to the new terrain's surface at our current XZ (same as the boot spawn
  // snap) — the old world's ground height is meaningless in the host's world.
  const sx = Math.floor(player.position.x), sz = Math.floor(player.position.z);
  const surf = Math.max(world.sampler(sx, sz).height, world.params.terrain.waterOffset);
  player.spawnPoint.set(player.position.x, surf + 3, player.position.z);
  player.position.copy(player.spawnPoint);
  player.velocity.set(0, 0, 0);
};

net.onEdit = (x, y, z, id) => world.applyRemoteEdit(x, y, z, id);
net.onPos = (p, yaw, pitch) => remote.push(performance.now(), p, yaw, pitch);
net.onTime = (tod) => { timeOfDay = tod; };
net.onPeerChange = (connected) => {
  remote.group.visible = connected;
  if (!connected) remote.reset();
  const status = document.getElementById('status');
  if (status) {
    status.innerHTML = connected ? '🤝 Friend connected' : 'Friend disconnected';
    setTimeout(() => { status.innerHTML = ''; }, 3000);
  }
};

// Local edits broadcast to the peer (world fires this only for REAL changes,
// and mutes it while applying edits that came FROM the peer — no echo loops).
world.onEdit = (x, y, z, id) => net.sendEdit(x, y, z, id);

// Regenerate/load while hosting → push a fresh world snapshot to the guest
// (configureMap was the previous onAfterGenerate — keep it first).
world.onAfterGenerate = () => { configureMap(); net.sendInit(); };

// Debug/test handle — mp-smoke.mjs / lod-bench.mjs drive real game paths
// through this (host edits → guest world, avatar tracking, perf metrics).
// Read-only convenience in prod.
(window as unknown as Record<string, unknown>).__mcDebug = { world, player, net, remote, BLOCK_IDS, renderer };

// While connected as GUEST, the host owns the world: regenerating or loading a
// local save here would silently desync every future edit (same coords,
// different terrain). The host doing either re-syncs the guest automatically
// (onAfterGenerate → sendInit), so only the guest needs the guard.
function guestWorldGuard(): boolean {
  if (!net.connected || net.isHost) return false;
  const status = document.getElementById('status');
  if (status) {
    status.innerHTML = 'The HOST owns the world while connected';
    setTimeout(() => { status.innerHTML = ''; }, 3000);
  }
  return true;
}

const menu = createMenu({
  world,
  player,
  settings,
  regenerate: () => { if (!guestWorldGuard()) world.generate(false); },
  onViewDistanceChange: updateViewDistance,
  getStats: () => {
    const r = renderer.info.render, m = renderer.info.memory;
    const p = mode === 'spectator' ? spectator.camera.position : player.position;
    return {
      fps, x: p.x, y: p.y, z: p.z,
      drawCalls: r.calls, triangles: r.triangles, chunks: world.chunkCount,
      lodTiles: world.lodTileCount,
      geometries: m.geometries, textures: m.textures,
      mode, flying: player.flying, onGround: player.onGround,
    };
  },
  getMode: () => mode,
  setMode,
  onResume: resume,
  onSave: () => world.save(),
  onLoad: () => { if (!guestWorldGuard()) world.load(); },
  multiplayer: {
    host: () => net.host(),
    join: (code) => net.join(code),
    leave: () => net.leave(),
    getStatus: () => net.status,
  },
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
  playerView: {
    getFov: () => player.baseFov,
    // Apply to BOTH cameras so the view matches in survival/creative and spectator.
    setFov: (v) => { player.setFov(v); spectator.camera.fov = v; spectator.camera.updateProjectionMatrix(); },
    // One sensitivity drives the first-person look (PointerLockControls) and the
    // spectator orbit drag (OrbitControls). Applied live on the next mouse move.
    getMouseSensitivity: () => player.controls.pointerSpeed,
    setMouseSensitivity: (v) => { player.controls.pointerSpeed = v; spectator.controls.rotateSpeed = v; },
  },
  quality: {
    applyPreset: applyQualityPreset,
    getPreset: () => qualityPreset,
    getViewDistance: () => world.lodDistance,
    setViewDistance: (v) => { applyUnifiedViewDistance(v); qualityPreset = 'custom'; },
    // Advanced override: decouple the full-detail ring from the ¼ rule (e.g. a
    // tiny 4-chunk detail ring under a 4km LOD horizon — the stride ladder is
    // relative to this edge, so the falloff stays gradual at any combination).
    // Moving the View Distance slider re-applies the ¼ rule.
    getDetailDistance: () => world.drawDistance,
    setDetailDistance: (v) => { world.drawDistance = Math.min(64, Math.max(2, Math.round(v))); qualityPreset = 'custom'; updateViewDistance(); },
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
    getFrustumStreaming: () => world.frustumStreaming,
    setFrustumStreaming: (v) => { world.frustumStreaming = v; world.forceRescan(); qualityPreset = 'custom'; },
    getStatsOverlay: () => settings.statsOverlay,
    setStatsOverlay: (v) => { settings.statsOverlay = v; updateHudVisibility(); },
    getUltraGraphics: () => ultraGraphics,
    // Ultra Graphics is an independent ADD-ON — toggling it does NOT change the
    // quality preset (it layers onto whichever preset is active).
    setUltraGraphics: (v) => { setUltraGraphics(v); },
    getResolutionScale: () => settings.resolutionScale,
    setResolutionScale: (v) => { settings.resolutionScale = v; applyResolution(); qualityPreset = 'custom'; },
    // Post-FX tuning (only audible when Ultra Graphics is on; values persist across
    // the lazy create/dispose via postfxSettings, applied live when postfx exists).
    getBloom: () => postfxSettings.bloom,
    setBloom: (v) => { postfxSettings.bloom = v; if (postfx) postfx.bloom.strength = v; },
    getGodRays: () => postfxSettings.godRays,
    setGodRays: (v) => { postfxSettings.godRays = v; if (postfx) postfx.godRayScale = v; },
    getCloudOpacity: () => clouds.opacityMult,
    setCloudOpacity: (v) => { clouds.setOpacity(v); qualityPreset = 'custom'; },
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
  renderer.info.reset();   // start-of-frame; render-info then accumulates all passes
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
  // Orbit gizmo follows the pivot; only visible while actively spectating.
  orbitGizmo.visible = mode === 'spectator' && playing;
  if (orbitGizmo.visible) orbitGizmo.position.copy(spectator.controls.target);

  updateSky(playing ? delta : 0);   // freeze the day/night clock while paused
  // Shadows only contribute while the sun is up (sun.intensity = sunPeak·daylight),
  // so at night the depth pass renders into a map that's then multiplied by ~0 —
  // a full scene re-render (1k–8k texels) wasted for ~half the day cycle. Freeze
  // the shadow map via autoUpdate rather than toggling sun.castShadow: changing
  // the cast-flag would change the shader's shadow-light count and force every
  // material to recompile (a visible dusk/dawn hitch). autoUpdate is a render-time
  // flag only — flipping it costs nothing and triggers no recompile, and three
  // re-renders the map fresh at the player's current position the first daylight
  // frame after it flips back on (the frozen map was invisible at intensity ~0).
  // SHADOW RE-RENDER THROTTLE: with autoUpdate, three re-renders EVERY caster
  // into the shadow map EVERY daylight frame — a silent ~2× draw multiplier
  // (the depth pass submits the same thousands of chunk meshes as the colour
  // pass). The map only actually changes when (a) the texel-snapped frustum
  // centre moves (player crossed a shadow texel), (b) the caster set changed
  // (world.meshEpoch — chunk streamed/removed/edited), or (c) the sun moved
  // (day/night cycle, >0.15°). Standing still or mouse-looking now costs ZERO
  // shadow re-renders; needsUpdate is a one-shot flag three auto-clears.
  const shadowsActive = sun.castShadow && currentDaylight > 0.02;
  renderer.shadowMap.autoUpdate = false;
  if (shadowsActive) {
    updateSunShadow();
    let render = shadowDirty;
    if (!render && !sun.target.position.equals(_lastShadowCenter)) render = true;
    if (!render && world.meshEpoch !== lastShadowMeshEpoch) render = true;
    // 0.5° (was 0.15°): at the default day length the sun crawls 0.75°/s, so
    // 0.15° re-rendered the whole caster set ~5×/s while STANDING STILL —
    // measured ~6 loop fps lost to invisible shadow nudges. At 0.5° the step
    // is ~1.5×/s and a half-degree shadow jump is still imperceptible in play.
    if (!render && settings.dayNight &&
      (Math.abs(sunAzimuth - lastShadowAz) > 0.5 || Math.abs(sunElevation - lastShadowEl) > 0.5)) render = true;
    renderer.shadowMap.needsUpdate = render;
    if (render) {
      _lastShadowCenter.copy(sun.target.position);
      lastShadowAz = sunAzimuth; lastShadowEl = sunElevation;
      lastShadowMeshEpoch = world.meshEpoch;
      shadowDirty = false;
    }
  } else {
    renderer.shadowMap.needsUpdate = false;
    shadowDirty = true;   // dawn: render a fresh map the first daylight frame
  }
  updatePlantWind(currentTime / 1000);

  worldMap.update();

  // --- multiplayer pump (runs even while paused / in the map, so the friend
  // keeps moving on screen and our own position keeps flowing out) ----------
  if (net.status.state !== 'off') {
    remote.update(currentTime);
    if (net.connected && currentTime - lastPosSendAt >= POS_SEND_MS) {
      lastPosSendAt = currentTime;
      const cam = mode === 'spectator' ? spectator.camera : player.camera;
      _netEuler.setFromQuaternion(cam.quaternion, 'YXZ');
      net.sendPos(cam.position, _netEuler.y, _netEuler.x);
      if (net.isHost && currentTime - lastTimeSyncAt >= TIME_SYNC_MS) {
        lastTimeSyncAt = currentTime;
        net.sendTime(timeOfDay);
      }
    }
  }

  if (!worldMap.isOpen()) {
    world.activeCamera = mode === 'spectator' ? spectator.camera : player.camera;   // frustum-streaming view
    world.update(player);
    world.processQueues();
    if (lightManager.enabled && (lightTick++ % lightInterval) === 0) {
      lightManager.update(world, player.position, currentTime / 1000);
    }

    clouds.update(player.position.x, player.position.z, currentTime / 1000);
    const wsx = Math.round(player.position.x / WATER_SNAP) * WATER_SNAP;
    const wsz = Math.round(player.position.z / WATER_SNAP) * WATER_SNAP;
    const seaY = world.params.terrain.waterOffset;
    waterMesh.position.set(wsx, seaY + 0.45, wsz);
    // Hide the single global sea plane when the camera is UNDERGROUND under a LAND
    // column — otherwise, now that caves carve sub-sea air, the flat plane shows as
    // a blue ceiling inside dry caverns. Over open ocean (surface below sea) it
    // stays visible so you still see the surface from below while diving. One
    // columnSurface sample/frame for the camera's own column — negligible.
    const camP = mode === 'spectator' ? spectator.camera.position : player.position;
    const localSurf = world.sampler(Math.floor(camP.x), Math.floor(camP.z)).height;
    waterMesh.visible = !(localSurf > seaY && camP.y < localSurf - 2);
    if (wsx !== waterSnapX || wsz !== waterSnapZ) {
      waterSnapX = wsx; waterSnapZ = wsz;
      updateWaterColors(wsx, wsz);
    }

    // Caustics ripple + the live sky colour for the water reflection (cheap; the
    // shaders gate the effects off when ultra is disabled).
    updateCubeUniforms(currentTime / 1000, world.params.terrain.waterOffset, ultraGraphics);
    if (waterShader) {
      // Drive the water uniforms every frame so they're always in sync regardless
      // of when the material first compiled (the shader exists only after the first
      // render, which can be after setUltraGraphics ran).
      waterShader.uniforms.uReflect.value = ultraGraphics ? 1 : 0;
      waterShader.uniforms.uSkyRefl.value.copy(_sky);
      waterShader.uniforms.uWaterTime.value = currentTime / 1000;
    }

    const activeCamera = mode === 'spectator' ? spectator.camera : player.camera;
    updateFogCamera(activeCamera.position.x, activeCamera.position.z);   // cylindrical fog centre
    if (ultraGraphics && postfx) {
      postfx.update(activeCamera, sunSprite.position, currentDaylight, _sky);   // camera + god-ray source + airlight tint
      postfx.render();
    } else {
      renderer.render(scene, activeCamera);
    }
  }

  // Live FPS (rolling, ~4×/s) for the debug menu + the always-on overlay.
  fpsFrames++;
  if (currentTime - fpsLast >= 250) {
    fps = fpsFrames * 1000 / (currentTime - fpsLast); fpsFrames = 0; fpsLast = currentTime;
    if (statsOverlayEl.style.display !== 'none') {
      const r = renderer.info.render;
      const p = mode === 'spectator' ? spectator.camera.position : player.position;
      // Loop fps vs display fps: show the display rate when the loop runs well
      // ahead of it (uncapped), since what the player perceives is the latter.
      const fpsLabel = fps > dispFps * 1.25
        ? `FPS ${Math.round(dispFps)} (loop ${Math.round(fps)})`
        : `FPS ${Math.round(fps)}`;
      statsOverlayEl.textContent =
        `${fpsLabel}  ·  ${mode}\n` +
        `XYZ ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
        `draws ${r.calls}  ·  tris ${r.triangles.toLocaleString()}\n` +
        `chunks ${world.chunkCount}  ·  lod ${world.lodTileCount}`;
    }
  }
  if (menu.isOpen()) menu.refreshStats();

  previousTime = currentTime;
  scheduleFrame();
}

animate();
booted = true;   // first frame rendered without throwing → stop arming the boot-fail overlay

// Warm the shader program variants off the critical path (KHR_parallel_shader_compile
// under the hood, truly async since r18x): the block/leaf/plant materials each compile
// several variants (shadow on/off × batched/unbatched × depth), and compiling lazily
// on first use caused visible hitches on the first frame and on quality toggles.
renderer.compileAsync(scene, player.camera).catch(() => { /* best-effort warmup */ });
