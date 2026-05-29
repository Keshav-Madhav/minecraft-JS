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
import { biomeTint, biomeWaterHex } from './chunkGen';

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
let hudTick = 0; // counts rendered frames; throttles the debug HUD refresh

// Settings surfaced in the GUI. Real-play defaults: vsync on (uncapFPS off), fog
// on (hides the streamed edge + carries the day/night colour), biome tint + the
// day/night cycle on.
const settings = { uncapFPS: false, fog: true, resolutionScale: 1, biomeLighting: true, dayNight: true };
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

// logarithmicDepthBuffer fixed z-fighting at distance (the thin sliver above
// water flickering) but forces a per-fragment gl_FragDepth write that disables
// hardware early-Z — costly in this overdraw-heavy scene. We instead reclaim
// depth precision cheaply: a higher camera NEAR plane (the hyperbolic depth
// buffer wastes most of its range in [0.1, ~10]; near=0.5 is ~5× better) plus a
// polygonOffset on the water plane. Default OFF (the perf path). If the water
// flicker returns over the ocean from the orbit cam, flip this back to `true`.
const LOG_DEPTH = false;
// 0.3 (not 0.1) reclaims most depth-buffer precision without clipping the held
// tool (attached to the player camera at ~0.5 units). OrbitCam has no tool.
const CAMERA_NEAR = 0.3;
// Antialias is off — MSAA over this many triangles tanked the frame rate.
function createRenderer(): THREE.WebGLRenderer {
  try {
    return new THREE.WebGLRenderer({ logarithmicDepthBuffer: LOG_DEPTH });
  } catch (e) {
    // No WebGL (old browser / disabled / blacklisted GPU): show a message instead
    // of a blank page with a cryptic console error.
    const msg = document.createElement('div');
    msg.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;'
      + 'background:#80a0e0;color:#fff;font:600 18px/1.5 sans-serif;text-align:center;padding:24px';
    msg.textContent = 'This game needs WebGL, which your browser/GPU did not provide.';
    document.body.appendChild(msg);
    throw e;
  }
}
const renderer = createRenderer();
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
const OrbitCam = new THREE.PerspectiveCamera(70, winWidth / winHeight, CAMERA_NEAR, 4000);
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
world.drawDistance = 16; // real-play draw distance (smooth + plenty of view)
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
  // Cover the whole visible area + the snap-lag margin (the plane only re-centres
  // every WATER_SNAP blocks) so the ocean always reaches the horizon.
  waterSpanCur = (span + 48 + WATER_SNAP) * 2;
  waterMesh.scale.set(waterSpanCur, 1, waterSpanCur);   // horizontal XZ grid
  waterSnapX = NaN;                                     // force a colour recompute next frame
}


// Sky cloud layer (separate from the voxel world).
const clouds = new Clouds();
scene.add(clouds);

// A single sea-level water plane that follows the player (still ONE draw call /
// one transparent-sort entry — not per-chunk). But it's now a SUBDIVIDED grid
// whose vertices are COLOURED by water depth + ocean type, sampled in world space
// — so in-game the water reads shallow-teal over shelves, dark over deep basins,
// and tinted per ocean type (warm→teal, frozen→pale), instead of one flat colour.
// Land above sea still occludes it via the depth buffer, so it only shows in water.
const WATER_SEG = 48;                 // grid resolution (49² sampled vertices)
const WATER_SNAP = 24;                // re-centre + recolour the plane every 24 blocks of movement
let waterSpanCur = 64;                // world-units the plane covers (set by updateViewDistance)
let waterSnapX = NaN, waterSnapZ = NaN;
function buildWaterGeometry(seg: number): THREE.BufferGeometry {
  const n = seg + 1, verts = n * n;
  const pos = new Float32Array(verts * 3), col = new Float32Array(verts * 3), nrm = new Float32Array(verts * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = (j * n + i) * 3;
    pos[k] = i / seg - 0.5; pos[k + 1] = 0; pos[k + 2] = j / seg - 0.5;  // horizontal XZ grid, local [-0.5,0.5]
    nrm[k + 1] = 1;                                                      // flat up normal (for the sun glint)
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
  // Bias toward the camera in depth so the thin shoreline band doesn't z-fight
  // (this + the higher near plane replaces logarithmicDepthBuffer).
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
}));
waterMesh.layers.set(1);
waterMesh.frustumCulled = false;
scene.add(waterMesh);

// Sample water colour at each grid vertex (world space): shallow shelves read a
// light tint, deep basins darken, and the hue follows the ocean TYPE under that
// vertex. Recomputed only when the snapped plane centre moves (see animate), so
// colours stay aligned with the mesh and the cost is paid only while moving.
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
    const t = Math.min(1, Math.max(0, seaY - s.height) / 36);     // 0 shallow → 1 deep
    _wcOut.copy(_wcShallow).lerp(_wcDeep, t).multiplyScalar(1 - 0.32 * t); // darken with depth
    const k = (j * n + i) * 3;
    col[k] = _wcOut.r; col[k + 1] = _wcOut.g; col[k + 2] = _wcOut.b;
  }
  waterGeo.attributes.color.needsUpdate = true;
}

// Setup for player
const player = new Player(scene);

const physics = new Physics(scene);

// Minimap + fullscreen 2D world map. Tiles are rendered off-thread (map worker)
// from the same terrain noise as the world and cached, so what you see is what
// generates and panning/zooming stays smooth.
const _camDir = new THREE.Vector3();
const worldMap = new WorldMap({
  getPlayer: () => {
    // Heading from the camera's actual forward vector (reliable regardless of the
    // PointerLockControls euler order). `yaw` is the CSS rotation that turns the
    // minimap arrow (which points up = north = −Z at 0) to face the look direction.
    player.camera.getWorldDirection(_camDir);
    return { x: player.position.x, z: player.position.z, yaw: Math.atan2(_camDir.x, -_camDir.z) };
  },
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
// Re-point the map worker at the new params whenever the world regenerates
// (GUI Apply, or loading a saved world via 'm') — otherwise the map silently
// keeps rendering the old seed's terrain.
world.onAfterGenerate = configureMap;

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
// Shadow-map resolution. Shared by the map allocation AND the texel-snap maths
// (updateSunShadow) — they MUST agree or the snap quantises to the wrong grid and
// shadows shimmer while moving.
const SHADOW_MAP_SIZE = 4096;
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
let shadowRange = 320;
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
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
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
// Each biome carries an ambient tint (sky/ground fill + clear colour + a
// brightness multiplier) in the chunkGen registry. We sample the biome under the
// player and ease the lights toward its tint; the per-frame lerp makes crossing a
// border a smooth fade (and biome regions are large, so it never strobes). This
// is fully data-driven — a new biome's tint comes with its registry entry, no
// edits here. `bright` multiplies the user's Sky/Fill base (slider stays boss).
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
// The sun rises in the east, arcs across the sky, and sets; the sky goes blue by
// day → orange at dawn/dusk → dark navy at night, the directional sun fades out
// at night (a low hemisphere "moonlight" floor keeps things visible), and fog +
// clear colour follow the sky. Biome tint still shades the DAYTIME hue.
let timeOfDay = 0.30;          // 0 midnight · 0.25 sunrise · 0.5 noon · 0.75 sunset
let dayLength = 480;           // real seconds per full cycle
let sunPeak = 2.9;             // midday sun intensity (GUI "Sun Brightness")
// Sun elevation = BIAS + AMP·sin(...). The raised baseline (34) means the sun
// only dips ~14° below the horizon at midnight, so the dark phase (elev<-6) is a
// SHORT ~18% of the cycle — most of the day is daylight, with brief night.
const SUN_BIAS = 34, SUN_AMP = 48;
const NIGHT_SKY = new THREE.Color(0x0a1024);
const DUSK_SKY = new THREE.Color(0xe07338);
const NIGHT_HEMI = new THREE.Color(0x26344e);
const SUN_DAY = new THREE.Color(0xfff2d8);
const SUN_DUSK = new THREE.Color(0xff7326);
const _sky = new THREE.Color();
const _hemiC = new THREE.Color();
const sstep = THREE.MathUtils.smoothstep;

function updateSky(delta: number) {
  // 1) Place the sun. Day/night drives azimuth+elevation from `timeOfDay`; else
  // the manual GUI sliders (sunAzimuth/sunElevation) hold.
  let elevReal = sunElevation;
  if (settings.dayNight) {
    timeOfDay = (timeOfDay + delta / Math.max(20, dayLength)) % 1;
    elevReal = SUN_BIAS + SUN_AMP * Math.sin((timeOfDay - 0.25) * Math.PI * 2); // ~-14..+82
    applySunDirection((timeOfDay * 360 + 60) % 360, elevReal);               // clamps elev for the light vector
  }
  const daylight = THREE.MathUtils.clamp((elevReal + 6) / 18, 0, 1);         // 0 night → 1 day (twilight band)
  const glow = sstep(elevReal, -8, 3) * (1 - sstep(elevReal, 3, 16));        // warm dawn/dusk near the horizon

  // 2) Biome tint target (throttled sample) — the DAYTIME hue.
  if (settings.biomeLighting && (biomeTintTick++ % 8) === 0) {
    const s = world.sampler(Math.floor(player.position.x), Math.floor(player.position.z));
    const t = biomeTint(s.biome);
    _targetSky.setHex(t.sky); _targetGround.setHex(t.ground); _targetClear.setHex(t.clear); _targetBright = t.bright;
  }
  _tintSky.lerp(_targetSky, 0.04);
  _tintGround.lerp(_targetGround, 0.04);
  _tintClear.lerp(_targetClear, 0.04);
  _bright += (_targetBright - _bright) * 0.04;

  // 3) Compose day/night over the biome tint.
  _sky.copy(NIGHT_SKY).lerp(_tintClear, daylight).lerp(DUSK_SKY, glow * 0.6);  // sky/fog colour
  renderer.setClearColor(_sky);
  if (scene.fog) (scene.fog as THREE.Fog).color.copy(_sky);
  _hemiC.copy(NIGHT_HEMI).lerp(_tintSky, daylight);
  hemi.color.copy(_hemiC);
  hemi.groundColor.copy(_tintGround).multiplyScalar(0.3 + 0.7 * daylight);
  hemi.intensity = baseFill * _bright * (0.12 + 0.88 * daylight);            // night ambient floor 0.12
  sun.intensity = sunPeak * daylight;                                         // sun off at night
  sun.color.copy(SUN_DUSK).lerp(SUN_DAY, Math.min(1, daylight * 1.6));        // warm at the horizon
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

  // Advance the day/night cycle (places + colours the sun, sets sky/fog), then
  // position the directed sun + its texel-snapped shadow frustum on the player.
  updateSky(delta);
  updateSunShadow();

  worldMap.update();

  // When the 2D world map is open we don't render the voxel world at all — just
  // the map overlay — so the main thread is free for map sampling.
  if (!worldMap.isOpen()) {
    // Stream chunks and drain the bounded work queues every frame, even before
    // pointer lock, so draw-distance changes fill in smoothly.
    world.update(player);
    world.processQueues();

    clouds.update(player.position.x, player.position.z, currentTime / 1000);
    // Snap the water plane to a coarse grid and recolour its vertices only when
    // that snapped centre changes — colours stay aligned with the (snapped) mesh,
    // and the per-vertex world-sampling cost is paid only while crossing water.
    const wsx = Math.round(player.position.x / WATER_SNAP) * WATER_SNAP;
    const wsz = Math.round(player.position.z / WATER_SNAP) * WATER_SNAP;
    waterMesh.position.set(wsx, world.params.terrain.waterOffset + 0.45, wsz);
    if (wsx !== waterSnapX || wsz !== waterSnapZ) {
      waterSnapX = wsx; waterSnapZ = wsz;
      updateWaterColors(wsx, wsz);
    }

    // Orbit view on spawn (free look at the world); locking the pointer (press a
    // movement key) switches to first-person play.
    const activeCamera = player.controls.isLocked ? player.camera : OrbitCam;
    // No manual frustum culling: three.js culls each chunk mesh automatically and
    // PER PASS (main camera for colour, the sun's shadow camera for shadows), so
    // an off-screen mountain still casts its shadow onto the player. Hiding
    // chunks with .visible=false would have removed them from the shadow pass.
    hudTick++;
    renderer.render(scene, activeCamera);
  }
  stats.update();

  // Refresh the debug HUD a few times a second, not every frame — building the
  // string (toLocaleString etc.) and writing innerText every frame is needless.
  if (renderStatsEl && (hudTick & 15) === 0) {
    const r = renderer.info.render, m = renderer.info.memory;
    // Draw calls already reflect what survives three's per-pass frustum cull, so
    // it's the meaningful "what's actually drawn" number (chunks = total loaded).
    // geom/tex (live GPU resources) are a cheap leak guard-rail — they should
    // track chunkCount, not climb without bound.
    renderStatsEl.innerText =
      `draw calls: ${r.calls}  |  triangles: ${r.triangles.toLocaleString()}\n` +
      `chunks loaded: ${world.chunkCount}  |  geom: ${m.geometries}  tex: ${m.textures}`;
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
  regenerate: () => { world.generate(false); }, // preserve edits; generate() refreshes the map via onAfterGenerate
  onViewDistanceChange: updateViewDistance,
  onResolutionChange: applyResolution,
  lighting: {
    getSun: () => sunPeak, setSun: (v) => { sunPeak = v; },   // midday peak; day/night scales it
    getFill: () => baseFill, setFill: (v) => { baseFill = v; },
    getExposure: () => renderer.toneMappingExposure, setExposure: (v) => { renderer.toneMappingExposure = v; },
    getShadowRange: () => shadowRange, setShadowRange: applyShadowRange,
    getShadows: () => sun.castShadow, setShadows: (v) => { sun.castShadow = v; },
    // Sun direction (manual). Used when the Day/Night cycle is OFF; otherwise the
    // cycle overwrites it each frame.
    getAzimuth: () => sunAzimuth, setAzimuth: (v) => applySunDirection(v, sunElevation),
    getElevation: () => sunElevation, setElevation: (v) => applySunDirection(sunAzimuth, v),
    getBiomeTint: () => settings.biomeLighting, setBiomeTint: (v) => { settings.biomeLighting = v; },
    // Day/night cycle.
    getDayNight: () => settings.dayNight, setDayNight: (v) => { settings.dayNight = v; },
    getTime: () => timeOfDay, setTime: (v) => { timeOfDay = v; },
    getDayLength: () => dayLength, setDayLength: (v) => { dayLength = v; },
  },
});
animate();