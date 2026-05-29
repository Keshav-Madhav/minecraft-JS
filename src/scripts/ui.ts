import { resources } from "./blocks";
import { Player } from "./player";
import { World } from "./world";

export type PerfSettings = { uncapFPS: boolean, fog: boolean, resolutionScale: number };

// Live lighting handles (applied immediately, no rebuild).
export type LightingControls = {
  getSun: () => number, setSun: (v: number) => void,
  getFill: () => number, setFill: (v: number) => void,
  getExposure: () => number, setExposure: (v: number) => void,
  getShadowRange: () => number, setShadowRange: (v: number) => void,
  getShadows: () => boolean, setShadows: (v: boolean) => void,
  getAzimuth: () => number, setAzimuth: (v: number) => void,
  getElevation: () => number, setElevation: (v: number) => void,
  getBiomeTint: () => boolean, setBiomeTint: (v: boolean) => void,
  getDayNight: () => boolean, setDayNight: (v: boolean) => void,
  getTime: () => number, setTime: (v: number) => void,
  getDayLength: () => number, setDayLength: (v: number) => void,
};

type GuiOptions = {
  world: World,
  player: Player,
  settings: PerfSettings,
  lighting: LightingControls,
  regenerate: () => void,          // rebuild the world (terrain/resource params changed)
  onViewDistanceChange: () => void, // draw distance / fog changed (updates camera far + fog)
  onResolutionChange: () => void,   // resolution scale changed (updates renderer pixel ratio)
};

// ---- small DOM helpers ------------------------------------------------------

function el(tag: string, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

type SliderOpts = {
  min: number, max: number, step: number,
  get: () => number, set: (v: number) => void,
  decimals?: number,
  onInput?: () => void,   // applied live while dragging
  onChange?: () => void,  // applied once on release (e.g. regenerate)
};

function addSlider(parent: HTMLElement, label: string, o: SliderOpts) {
  const fmt = (v: number) => o.decimals !== undefined ? v.toFixed(o.decimals) : String(v);

  const row = el('div', 'ui-row');
  const top = el('div', 'ui-row__top');
  top.append(el('span', 'ui-label', label));
  const value = el('span', 'ui-val', fmt(o.get()));
  top.append(value);

  const input = el('input', 'ui-range') as HTMLInputElement;
  input.type = 'range';
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);
  input.value = String(o.get());

  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    o.set(v);
    value.textContent = fmt(v);
    o.onInput?.();
  });
  input.addEventListener('change', () => o.onChange?.());

  row.append(top, input);
  parent.append(row);
}

function addToggle(parent: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void, onChange?: () => void) {
  const row = el('div', 'ui-row ui-row--inline');
  row.append(el('span', 'ui-label', label));

  const sw = el('label', 'ui-switch');
  const input = el('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = get();
  input.addEventListener('change', () => { set(input.checked); onChange?.(); });
  sw.append(input, el('span', 'ui-switch__knob'));

  row.append(sw);
  parent.append(row);
}

// ---- panel ------------------------------------------------------------------

export function createGUI(opts: GuiOptions) {
  const { world, player, settings, lighting, regenerate, onViewDistanceChange, onResolutionChange } = opts;

  // Start collapsed so the panel stays out of the way until opened.
  const panel = el('div', 'ui-panel ui-panel--collapsed');
  const header = el('div', 'ui-panel__title');
  header.append(el('span', undefined, '⛏  Settings'));
  const collapseBtn = el('button', 'ui-panel__collapse', '+');
  header.append(collapseBtn);
  const body = el('div', 'ui-panel__body');
  collapseBtn.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('ui-panel--collapsed');
    collapseBtn.textContent = collapsed ? '+' : '–';
  });
  panel.append(header, body);

  // World-gen edits are NOT applied live — tweak everything, then hit Apply to
  // rebuild the world once. Draw distance is staged here too (committing it
  // live would make world.update stream chunks immediately).
  let pendingDrawDistance = world.drawDistance;

  const applyBar = el('div', 'ui-applybar');
  const applyBtn = el('button', 'ui-apply', 'Apply / Regenerate World') as HTMLButtonElement;
  applyBtn.addEventListener('click', () => {
    applyBtn.classList.add('ui-apply--busy');
    world.drawDistance = pendingDrawDistance;
    // Only rebuild the world if terrain inputs actually changed. A draw-distance
    // change alone keeps existing chunks and just streams the new ring.
    if (world.needsRegen()) regenerate();
    onViewDistanceChange();
    setTimeout(() => applyBtn.classList.remove('ui-apply--busy'), 400);
  });
  applyBar.append(applyBtn);
  body.append(applyBar);

  const addSection = (title: string, collapsed = false) => {
    const section = el('div', 'ui-section' + (collapsed ? ' ui-section--collapsed' : ''));
    const secHeader = el('div', 'ui-section__header', title);
    const secBody = el('div', 'ui-section__body');
    secHeader.addEventListener('click', () => section.classList.toggle('ui-section--collapsed'));
    section.append(secHeader, secBody);
    body.append(section);
    return secBody;
  };

  // --- Rendering ---
  const rendering = addSection('🖥  Rendering');
  // Staged: changing this only takes effect on Apply (otherwise the world would
  // start streaming/unloading chunks live as you drag).
  addSlider(rendering, 'Draw Distance (Apply)', {
    min: 0, max: 32, step: 1,
    get: () => pendingDrawDistance,
    set: (v) => { pendingDrawDistance = v; },
  });
  // Single biggest GPU lever: on a Retina display the renderer draws at the
  // native pixel ratio (often 2×), i.e. 4× the fragments. Lowering this scales
  // the render resolution down — softer image, much higher FPS.
  addSlider(rendering, 'Resolution Scale', {
    min: 0.5, max: 1, step: 0.05, decimals: 2,
    get: () => settings.resolutionScale,
    set: (v) => { settings.resolutionScale = v; },
    onInput: onResolutionChange,
  });
  addToggle(rendering, 'Fog', () => settings.fog, (v) => { settings.fog = v; }, onViewDistanceChange);
  addToggle(rendering, 'Frustum Culling', () => world.frustumCulling, (v) => { world.frustumCulling = v; });
  addToggle(rendering, 'Uncap FPS (no vsync)', () => settings.uncapFPS, (v) => { settings.uncapFPS = v; });

  // --- Lighting (live) ---
  const light = addSection('💡  Lighting');
  // Day/night cycle: when ON, the sun rises/sets automatically and the Sun
  // Direction/Height sliders are driven by it. Time of Day (0=midnight, 0.25=dawn,
  // 0.5=noon, 0.75=dusk) lets you scrub; Day Length sets seconds per full cycle.
  addToggle(light, 'Day/Night Cycle', lighting.getDayNight, lighting.setDayNight);
  addSlider(light, 'Time of Day', {
    min: 0, max: 1, step: 0.01, decimals: 2,
    get: lighting.getTime, set: lighting.setTime,
  });
  addSlider(light, 'Day Length (s)', {
    min: 30, max: 1200, step: 10,
    get: lighting.getDayLength, set: lighting.setDayLength,
  });
  // Sun DIRECTION (manual — used when Day/Night Cycle is OFF): azimuth = compass
  // heading the light comes from; elevation = height above the horizon.
  addSlider(light, 'Sun Direction (°)', {
    min: 0, max: 360, step: 1,
    get: lighting.getAzimuth, set: lighting.setAzimuth,
  });
  addSlider(light, 'Sun Height (°)', {
    min: 5, max: 89, step: 1,
    get: lighting.getElevation, set: lighting.setElevation,
  });
  addSlider(light, 'Sun Brightness', {
    min: 0, max: 6, step: 0.1, decimals: 1,
    get: lighting.getSun, set: lighting.setSun,
  });
  addSlider(light, 'Sky / Fill Light', {
    min: 0, max: 4, step: 0.1, decimals: 1,
    get: lighting.getFill, set: lighting.setFill,
  });
  addSlider(light, 'Exposure', {
    min: 0.4, max: 2, step: 0.05, decimals: 2,
    get: lighting.getExposure, set: lighting.setExposure,
  });
  addToggle(light, 'Shadows', lighting.getShadows, lighting.setShadows);
  // Half-width of the shadowed area around the player. Larger covers more of the
  // view; smaller is sharper and cheaper (fewer casters in the shadow pass).
  addSlider(light, 'Shadow Range', {
    min: 32, max: 320, step: 2,
    get: lighting.getShadowRange, set: lighting.setShadowRange,
  });
  addToggle(light, 'Biome Tint', lighting.getBiomeTint, lighting.setBiomeTint);

  // --- Streaming (live) ---
  const streaming = addSection('⚙️  Streaming', true);
  addToggle(streaming, 'Async Loading (worker)', () => world.asyncLoading, (v) => { world.asyncLoading = v; });
  // Higher = faster chunk loading but more main-thread work per frame (lower FPS
  // while streaming). This is the main load-speed vs framerate trade-off.
  addSlider(streaming, 'Chunk Applies / Frame', {
    min: 1, max: 24, step: 1,
    get: () => world.maxAppliesPerFrame,
    set: (v) => { world.maxAppliesPerFrame = v; },
  });
  addSlider(streaming, 'Max In-Flight', {
    min: 4, max: 48, step: 1,
    get: () => world.maxOutstanding,
    set: (v) => { world.maxOutstanding = v; },
  });

  // --- Player (live) ---
  const playerFolder = addSection('🏃  Player', true);
  addSlider(playerFolder, 'Max Speed', {
    min: 1, max: 40, step: 1,
    get: () => player.maxSpeed,
    set: (v) => { player.maxSpeed = v; },
  });
  addToggle(playerFolder, 'Camera Helper', () => player.cameraHelper.visible, (v) => { player.cameraHelper.visible = v; });

  // --- World terrain (queued; applied on the Apply button) ---
  const terrain = addSection('🌍  Terrain');
  // No onChange -> the value is updated live but the world is only rebuilt on Apply.
  const genSlider = (parent: HTMLElement, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, decimals?: number) =>
    addSlider(parent, label, { min, max, step, get, set, decimals });

  genSlider(terrain, 'Seed', 0, 10000, 1, () => world.params.seed, (v) => { world.params.seed = v; });
  genSlider(terrain, 'Feature Scale', 50, 600, 5, () => world.params.terrain.scale, (v) => { world.params.terrain.scale = v; });
  genSlider(terrain, 'Mountain Height', 0, 120, 1, () => world.params.terrain.magnitude, (v) => { world.params.terrain.magnitude = v; });
  genSlider(terrain, 'Land Bias', 0, 70, 1, () => world.params.terrain.offset, (v) => { world.params.terrain.offset = v; });
  genSlider(terrain, 'Water Level', 0, 256, 1, () => world.params.terrain.waterOffset, (v) => { world.params.terrain.waterOffset = v; });

  // --- Trees ---
  const trees = addSection('🌲  Trees', true);
  genSlider(trees, 'Frequency', 0, 0.5, 0.005, () => world.params.trees.frequency, (v) => { world.params.trees.frequency = v; }, 3);
  genSlider(trees, 'Trunk Min Height', 1, 10, 1, () => world.params.trees.trunk.minHeight, (v) => { world.params.trees.trunk.minHeight = v; });
  genSlider(trees, 'Trunk Max Height', 1, 10, 1, () => world.params.trees.trunk.maxHeight, (v) => { world.params.trees.trunk.maxHeight = v; });
  genSlider(trees, 'Canopy Min Radius', 1, 10, 1, () => world.params.trees.canopy.minRadius, (v) => { world.params.trees.canopy.minRadius = v; });
  genSlider(trees, 'Canopy Max Radius', 1, 10, 1, () => world.params.trees.canopy.maxRadius, (v) => { world.params.trees.canopy.maxRadius = v; });
  genSlider(trees, 'Density', 0, 1, 0.05, () => world.params.trees.canopy.density, (v) => { world.params.trees.canopy.density = v; }, 2);

  // --- Resources (ore veins in stone) ---
  const res = addSection('💎  Resources', true);
  resources.forEach(resource => {
    res.append(el('div', 'ui-subhead', resource.name));
    genSlider(res, 'Scarcity', 0, 1, 0.01, () => resource.scarcity, (v) => { resource.scarcity = v; }, 2);
    genSlider(res, 'Scale X', 10, 100, 1, () => resource.scale.x, (v) => { resource.scale.x = v; });
    genSlider(res, 'Scale Y', 10, 100, 1, () => resource.scale.y, (v) => { resource.scale.y = v; });
    genSlider(res, 'Scale Z', 10, 100, 1, () => resource.scale.z, (v) => { resource.scale.z = v; });
  });

  document.body.append(panel);
}
