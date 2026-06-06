import { resources } from "./blocks";
import { Player } from "./player";
import { World } from "./world";
import { findNearestBiome, findNearestStructure, compass, BIOME_TARGETS, STRUCTURE_TARGETS, type FindResult } from "./finder";

export type GameMode = 'survival' | 'creative' | 'spectator';

export type PerfSettings = { uncapFPS: boolean, fpsCap: number, fog: boolean, fogNear: number, resolutionScale: number };

// Live lighting handles (applied immediately, no rebuild).
export type LightingControls = {
  getSun: () => number, setSun: (v: number) => void,
  getFill: () => number, setFill: (v: number) => void,
  getExposure: () => number, setExposure: (v: number) => void,
  getAzimuth: () => number, setAzimuth: (v: number) => void,
  getElevation: () => number, setElevation: (v: number) => void,
  getBiomeTint: () => boolean, setBiomeTint: (v: boolean) => void,
  getDayNight: () => boolean, setDayNight: (v: boolean) => void,
  getTime: () => number, setTime: (v: number) => void,
  getDayLength: () => number, setDayLength: (v: number) => void,
};

export type ShadowQuality = 'off' | 'low' | 'medium' | 'high' | 'ultra';
export type QualityPreset = 'low' | 'balanced' | 'fancy' | 'ultra' | 'max' | 'custom';

// Quality / optimization handles. Presets set everything at once; the advanced
// rows tune individual knobs (which flips the preset to 'custom').
export type QualityControls = {
  applyPreset: (p: QualityPreset) => void,
  getPreset: () => QualityPreset,
  // Unified view distance (chunks): the value is the LOD horizon; the
  // full-detail chunk ring defaults to a quarter of it (mapped in main.ts).
  getViewDistance: () => number, setViewDistance: (v: number) => void,
  // Advanced override for the full-detail ring (decoupled from the ¼ rule).
  getDetailDistance: () => number, setDetailDistance: (v: number) => void,
  getFoliage: () => boolean, setFoliage: (v: boolean) => void,
  getFoliageDistance: () => number, setFoliageDistance: (v: number) => void,
  getShadowQuality: () => ShadowQuality, setShadowQuality: (v: ShadowQuality) => void,
  getShadowRange: () => number, setShadowRange: (v: number) => void,
  getBlockLights: () => boolean, setBlockLights: (v: boolean) => void,
  getClouds: () => boolean, setClouds: (v: boolean) => void,
  getCloudOpacity: () => number, setCloudOpacity: (v: number) => void,
  getFrustumStreaming: () => boolean, setFrustumStreaming: (v: boolean) => void,
  getStatsOverlay: () => boolean, setStatsOverlay: (v: boolean) => void,
  getUltraGraphics: () => boolean, setUltraGraphics: (v: boolean) => void,
  getBloom: () => number, setBloom: (v: number) => void,
  getGodRays: () => number, setGodRays: (v: number) => void,
  getResolutionScale: () => number, setResolutionScale: (v: number) => void,
};

// Multiplayer (P2P co-op) controls — backed by Net in net.ts, wired in main.ts.
// The menu only triggers actions + renders the live status; it owns no state.
export type MultiplayerStatus = { state: string, code: string, detail: string };
export type MultiplayerControls = {
  host: () => void,
  join: (code: string) => void,
  leave: () => void,
  getStatus: () => MultiplayerStatus,
};

// First-person / spectator view controls (applied live, no rebuild).
export type PlayerViewControls = {
  getFov: () => number, setFov: (v: number) => void,
  getMouseSensitivity: () => number, setMouseSensitivity: (v: number) => void,
};

export type StatsSnapshot = {
  fps: number, x: number, y: number, z: number,
  drawCalls: number, triangles: number, chunks: number, lodTiles: number,
  geometries: number, textures: number, mode: GameMode, flying: boolean, onGround: boolean,
};

type MenuOptions = {
  world: World,
  player: Player,
  settings: PerfSettings,
  lighting: LightingControls,
  quality: QualityControls,
  playerView: PlayerViewControls,
  multiplayer: MultiplayerControls,
  regenerate: () => void,
  onViewDistanceChange: () => void,
  getStats: () => StatsSnapshot,
  getMode: () => GameMode,
  setMode: (m: GameMode) => void,
  onResume: () => void,
  onSave: () => void,
  onLoad: () => void,
};

export type MenuController = {
  el: HTMLElement,
  isOpen: () => boolean,
  open: () => void,
  close: () => void,
  refreshStats: () => void,
  syncMode: () => void,
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
  onInput?: () => void,
  onChange?: () => void,
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
  input.min = String(o.min); input.max = String(o.max); input.step = String(o.step);
  input.value = String(o.get());
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    o.set(v); value.textContent = fmt(v); o.onInput?.();
  });
  input.addEventListener('change', () => o.onChange?.());
  // Let callers refresh the displayed value/position when a preset changes it.
  (row as any)._sync = () => { input.value = String(o.get()); value.textContent = fmt(o.get()); };
  row.append(top, input);
  parent.append(row);
  return row;
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
  (row as any)._sync = () => { input.checked = get(); };
  parent.append(row);
  return row;
}

// Segmented button group (e.g. quality presets, shadow quality).
function addSegmented<T extends string>(parent: HTMLElement, label: string,
  options: { value: T, label: string }[], get: () => T, set: (v: T) => void) {
  const row = el('div', 'ui-row');
  row.append(el('div', 'ui-row__top', label));
  const group = el('div', 'ui-seg');
  const btns: { value: T, btn: HTMLButtonElement }[] = [];
  const sync = () => { const cur = get(); for (const b of btns) b.btn.classList.toggle('ui-seg__btn--on', b.value === cur); };
  for (const opt of options) {
    const btn = el('button', 'ui-seg__btn', opt.label) as HTMLButtonElement;
    btn.addEventListener('click', () => { set(opt.value); sync(); });
    btns.push({ value: opt.value, btn });
    group.append(btn);
  }
  sync();
  (row as any)._sync = sync;
  row.append(group);
  parent.append(row);
  return row;
}

function addButton(parent: HTMLElement, label: string, onClick: () => void, variant = '') {
  const btn = el('button', 'ui-btn ' + variant, label) as HTMLButtonElement;
  btn.addEventListener('click', onClick);
  parent.append(btn);
  return btn;
}

function addSection(parent: HTMLElement, title: string, collapsed = false) {
  const section = el('div', 'ui-section' + (collapsed ? ' ui-section--collapsed' : ''));
  const secHeader = el('div', 'ui-section__header', title);
  const secBody = el('div', 'ui-section__body');
  secHeader.addEventListener('click', () => section.classList.toggle('ui-section--collapsed'));
  section.append(secHeader, secBody);
  parent.append(section);
  return secBody;
}

// ---- menu -------------------------------------------------------------------

export function createMenu(opts: MenuOptions): MenuController {
  const { world, player, settings, lighting, quality } = opts;

  const root = el('div', 'menu');
  const backdrop = el('div', 'menu__backdrop');
  backdrop.addEventListener('click', () => opts.onResume());
  const panel = el('div', 'menu__panel');

  // header
  const header = el('div', 'menu__header');
  header.append(el('div', 'menu__title', '⛏  Minecraft JS'));
  const resumeBtn = el('button', 'menu__resume', 'Play') as HTMLButtonElement;
  resumeBtn.addEventListener('click', () => opts.onResume());
  header.append(resumeBtn);

  // tabs
  const tabbar = el('div', 'menu__tabs');
  const bodies: Record<string, HTMLElement> = {};
  const tabBtns: Record<string, HTMLElement> = {};
  const TABS = ['Stats', 'Settings', 'Finder', 'Mode', 'Multiplayer', 'Controls'] as const;
  const bodyWrap = el('div', 'menu__bodywrap');
  let active = 'Settings';
  const selectTab = (name: string) => {
    active = name;
    for (const t of TABS) {
      bodies[t].style.display = t === name ? '' : 'none';
      tabBtns[t].classList.toggle('menu__tab--on', t === name);
    }
  };
  for (const t of TABS) {
    const btn = el('button', 'menu__tab', t);
    btn.addEventListener('click', () => selectTab(t));
    tabBtns[t] = btn; tabbar.append(btn);
    const body = el('div', 'menu__body');
    bodies[t] = body; bodyWrap.append(body);
  }

  panel.append(header, tabbar, bodyWrap);
  root.append(backdrop, panel);
  document.body.append(root);

  // ===== STATS tab ==========================================================
  const statsBody = bodies['Stats'];
  const statGrid = el('div', 'menu__stats');
  statsBody.append(statGrid);
  // name → value element
  const statRows: Record<string, HTMLElement> = {};
  const STAT_ORDER = ['Mode', 'FPS', 'Position', 'State', 'Draw calls', 'Triangles', 'Chunks loaded', 'LOD tiles', 'GPU geometries', 'GPU textures'];
  for (const name of STAT_ORDER) {
    statGrid.append(el('div', 'menu__stat-k', name));
    const v = el('div', 'menu__stat-v', '—');
    statRows[name] = v;
    statGrid.append(v);
  }
  // refreshStats is called every frame while the menu is open — it also drives
  // the Multiplayer tab's live status line (assigned in that tab's section).
  let refreshMpStatus = () => {};
  const refreshStats = () => {
    if (active === 'Multiplayer') refreshMpStatus();
    if (active !== 'Stats') return;
    const s = opts.getStats();
    statRows['Mode'].textContent = s.mode;
    statRows['FPS'].textContent = String(Math.round(s.fps));
    statRows['Position'].textContent = `${s.x.toFixed(1)}  ${s.y.toFixed(1)}  ${s.z.toFixed(1)}`;
    statRows['State'].textContent = s.mode === 'spectator' ? 'spectating' : (s.flying ? 'flying' : (s.onGround ? 'grounded' : 'airborne'));
    statRows['Draw calls'].textContent = String(s.drawCalls);
    statRows['Triangles'].textContent = s.triangles.toLocaleString();
    statRows['Chunks loaded'].textContent = String(s.chunks);
    statRows['LOD tiles'].textContent = String(s.lodTiles);
    statRows['GPU geometries'].textContent = String(s.geometries);
    statRows['GPU textures'].textContent = String(s.textures);
  };

  // ===== FINDER tab =========================================================
  // Locate the nearest biome / structure (direction + distance + coords). Pure
  // function of the world seed, so it works without loading the target's chunks.
  const finderBody = bodies['Finder'];
  finderBody.append(el('div', 'menu__hint', 'Find the nearest biome or structure. Click a target — its direction, distance and coordinates appear below (computed straight from the world seed; open the map to navigate there).'));
  const finderResult = el('div', 'finder-result', 'Pick a target to locate.');
  finderBody.append(finderResult);
  const showFind = (label: string, res: FindResult) => {
    if (!res) { finderResult.textContent = `${label}: none found within range.`; return; }
    const dx = res.x - player.position.x, dz = res.z - player.position.z;
    finderResult.textContent = `${label}  —  ${Math.round(res.dist).toLocaleString()} blocks ${compass(dx, dz)}  →  (${Math.round(res.x)}, ${Math.round(res.z)})`;
  };
  const biomeGrid = el('div', 'finder-grid');
  addSection(finderBody, 'Biomes', false).append(biomeGrid);
  for (const t of BIOME_TARGETS) {
    addButton(biomeGrid, t.label, () => {
      finderResult.textContent = `Searching for ${t.label}…`;
      // defer one frame so the "Searching…" text paints before the (brief) scan
      setTimeout(() => showFind(t.label, findNearestBiome(world.sampler, player.position.x, player.position.z, t.id)), 0);
    });
  }
  const structGrid = el('div', 'finder-grid');
  addSection(finderBody, 'Structures', false).append(structGrid);
  for (const t of STRUCTURE_TARGETS) {
    addButton(structGrid, t.label, () => {
      showFind(t.label, findNearestStructure(world.sampler, world.params.seed, player.position.x, player.position.z, t.kind));
    });
  }

  // ===== MODE tab ===========================================================
  const modeBody = bodies['Mode'];
  modeBody.append(el('div', 'menu__hint', 'Choose how you play. Survival walks (gravity); Creative flies; Spectator is a free orbital camera that ghosts through the world.'));
  const modeCards = el('div', 'menu__modes');
  const MODES: { id: GameMode, name: string, desc: string }[] = [
    { id: 'survival', name: '🚶  Survival', desc: 'Gravity · walk & sprint · double-tap Space to fly · build' },
    { id: 'creative', name: '🛩  Creative', desc: 'Flight by default · no gravity · build · double-tap Space to land' },
    { id: 'spectator', name: '👁  Spectator', desc: 'Orbital free-cam · drag to look · WASD/Space/Shift fly · no clipping' },
  ];
  const modeBtns: Record<GameMode, HTMLElement> = {} as any;
  for (const m of MODES) {
    const card = el('button', 'menu__mode');
    card.append(el('div', 'menu__mode-name', m.name), el('div', 'menu__mode-desc', m.desc));
    card.addEventListener('click', () => { opts.setMode(m.id); syncMode(); opts.onResume(); });
    modeBtns[m.id] = card;
    modeCards.append(card);
  }
  modeBody.append(modeCards);
  const syncMode = () => {
    const cur = opts.getMode();
    for (const m of MODES) modeBtns[m.id].classList.toggle('menu__mode--on', m.id === cur);
  };
  syncMode();

  // ===== MULTIPLAYER tab ====================================================
  // P2P co-op: the host shares a room code; the friend types it in and joins
  // the host's exact world (terrain regenerates locally from the host's seed —
  // only edits + positions cross the network). All state lives in net.ts.
  {
    const mp = opts.multiplayer;
    const mpBody = bodies['Multiplayer'];
    mpBody.append(el('div', 'menu__hint',
      'Play together! One player hosts and shares the room code; the other joins with it. '
      + 'The joiner loads the host\'s world (terrain, edits, time of day) and you build side by side. '
      + 'Keep this tab open while connecting.'));

    const hostRow = el('div', 'menu__btnrow');
    const hostBtn = addButton(hostRow, '🌐  Host This World', () => { mp.host(); refreshMpStatus(); }, 'ui-btn--primary');

    const joinRow = el('div', 'menu__btnrow');
    const codeInput = el('input', 'ui-input') as HTMLInputElement;
    codeInput.placeholder = 'ROOM CODE';
    codeInput.maxLength = 8;
    codeInput.autocapitalize = 'characters';
    codeInput.spellcheck = false;
    // Keep typed letters out of the game's document-level key handlers
    // ('o' toggles the dev texture-compare, Esc would close the menu, …).
    codeInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') joinBtn.click();
    });
    joinRow.append(codeInput);
    const joinBtn = addButton(joinRow, '🔗  Join', () => { mp.join(codeInput.value); refreshMpStatus(); });

    const leaveRow = el('div', 'menu__btnrow');
    const leaveBtn = addButton(leaveRow, '✕  Disconnect', () => { mp.leave(); refreshMpStatus(); });

    // Live status: room code shown big (click to copy) + a detail line.
    const codeBox = el('div', 'mp-code');
    codeBox.title = 'Click to copy';
    codeBox.addEventListener('click', () => {
      const code = codeBox.dataset.code;
      if (code) {
        navigator.clipboard?.writeText(code).catch(() => {});
        codeBox.textContent = 'copied!';
        setTimeout(refreshMpStatusForce, 800);
      }
    });
    const mpStatus = el('div', 'finder-result mp-status', 'Not connected.');
    mpBody.append(hostRow, joinRow, codeBox, mpStatus, leaveRow);

    let mpLastSig = '';
    const render = () => {
      const s = mp.getStatus();
      const sig = `${s.state}|${s.code}|${s.detail}`;
      if (sig === mpLastSig) return;
      mpLastSig = sig;
      const busy = s.state !== 'off' && s.state !== 'error';
      hostBtn.disabled = busy;
      joinBtn.disabled = busy;
      codeInput.disabled = busy;
      leaveRow.style.display = s.state === 'off' ? 'none' : '';
      leaveBtn.textContent = s.state === 'connected' ? '✕  Disconnect' : '✕  Cancel / Close Room';
      const showCode = s.code && (s.state === 'hosting' || s.state === 'connected');
      codeBox.style.display = showCode ? '' : 'none';
      codeBox.dataset.code = showCode ? s.code : '';
      if (showCode) codeBox.textContent = s.code;
      mpStatus.textContent =
        s.state === 'off' ? 'Not connected.' :
        s.state === 'error' ? `⚠ ${s.detail}` :
        s.state === 'hosting' ? `Hosting — share the code above. ${s.detail}` :
        s.detail;
      mpStatus.classList.toggle('finder-result--err', s.state === 'error');
    };
    const refreshMpStatusForce = () => { mpLastSig = ''; render(); };
    refreshMpStatus = render;
    refreshMpStatusForce();
  }

  // ===== CONTROLS tab =======================================================
  const ctrlBody = bodies['Controls'];
  const controls: [string, string][] = [
    ['Move', 'W A S D'],
    ['Look', 'Mouse'],
    ['Jump / Ascend', 'Space'],
    ['Sprint / Descend', 'Shift  (Shift descends while flying)'],
    ['Sprint (toggle)', 'Double-tap W'],
    ['Toggle flight', 'Double-tap Space  (Survival & Creative)'],
    ['Boost (Spectator)', 'Ctrl'],
    ['Break block', 'Left click'],
    ['Place / Use block', 'Right click'],
    ['Pick block', 'Right click on block'],
    ['Hotbar', '0 – 8'],
    ['Open map', 'M  (or click the minimap)'],
    ['Respawn', 'R'],
    ['Menu', 'Esc'],
  ];
  const ctrlGrid = el('div', 'menu__stats');
  for (const [k, v] of controls) {
    ctrlGrid.append(el('div', 'menu__stat-k', k));
    ctrlGrid.append(el('div', 'menu__stat-v', v));
  }
  ctrlBody.append(ctrlGrid);

  // ===== SETTINGS tab =======================================================
  const setBody = bodies['Settings'];
  const syncables: HTMLElement[] = [];
  const remember = (row: HTMLElement) => { syncables.push(row); return row; };
  // Rows that are only meaningful while a parent toggle is on (e.g. Foliage
  // Distance needs Foliage on) — registered here, then greyed + click-blocked
  // (.ui-row--disabled) whenever their predicate is false.
  const depRules: { row: HTMLElement, on: () => boolean }[] = [];
  const dep = (row: HTMLElement, on: () => boolean) => { depRules.push({ row, on }); return row; };
  const applyDeps = () => { for (const d of depRules) d.row.classList.toggle('ui-row--disabled', !d.on()); };
  // Refresh every control's displayed value + the dependent-row enabled state
  // (after a preset bulk-change or a mode switch flips things under the UI).
  const syncSettings = () => { for (const r of syncables) (r as any)._sync?.(); applyDeps(); };

  // --- Quality: preset + an Advanced drawer split into Graphics / Performance / Debug ---
  const q = addSection(setBody, '⚡  Quality');
  const presetRow = remember(addSegmented<QualityPreset>(q, 'Preset',
    [{ value: 'low', label: 'Low' }, { value: 'balanced', label: 'Balanced' }, { value: 'fancy', label: 'Fancy' }, { value: 'ultra', label: 'Ultra' }, { value: 'max', label: 'MAX' }],
    quality.getPreset,   // returns 'custom' when knobs were tuned → no preset highlighted
    (v) => { quality.applyPreset(v); syncSettings(); opts.onViewDistanceChange(); }));
  // MAX warning: shown whenever the MAX preset is active (it pins EVERY slider).
  const maxWarn = el('div', 'menu__hint', '⚠ MAX pins everything to its limit — 4 km view, 64 full-detail chunks, 8K soft shadows, post-FX, 2× supersampling. Expect heavy GPU/RAM load and a long initial load. For monster machines.');
  maxWarn.style.color = '#ffb054';
  (maxWarn as any)._sync = () => { maxWarn.style.display = quality.getPreset() === 'max' ? '' : 'none'; };
  (maxWarn as any)._sync();
  syncables.push(maxWarn);
  q.append(maxWarn);
  const adv = addSection(q, 'Advanced', true);
  // Tuning ANY advanced knob flips the preset to 'custom' (in the main.ts setters);
  // reflect that instantly by re-syncing the Preset chip (it de-highlights). Delegated
  // on the Advanced body so it covers sliders (input), toggles (change) and segmented
  // buttons (click) alike. The collapse header is a sibling, so it doesn't trigger this.
  const refreshPreset = () => (presetRow as any)._sync?.();
  adv.addEventListener('input', refreshPreset);
  adv.addEventListener('change', refreshPreset);
  adv.addEventListener('click', refreshPreset);

  // GRAPHICS — what the world looks like.
  adv.append(el('div', 'ui-subhead', 'Graphics'));
  remember(addSegmented<ShadowQuality>(adv, 'Shadows',
    [{ value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Med' }, { value: 'high', label: 'High' }, { value: 'ultra', label: 'Ultra' }],
    quality.getShadowQuality, quality.setShadowQuality));   // each tier sets its own map size + range
  // Ultra graphics: post-processing (bloom + god rays), foliage/leaf cutout shadows,
  // fake water caustics + reflections. Heavy — opt-in, layers onto any preset.
  remember(addToggle(adv, 'Ultra Graphics', quality.getUltraGraphics, quality.setUltraGraphics, applyDeps));
  remember(dep(addSlider(adv, 'Bloom Strength', {
    min: 0, max: 1.5, step: 0.05, decimals: 2, get: quality.getBloom, set: quality.setBloom,
  }), quality.getUltraGraphics));
  remember(dep(addSlider(adv, 'God Rays', {
    min: 0, max: 1.5, step: 0.05, decimals: 2, get: quality.getGodRays, set: quality.setGodRays,
  }), quality.getUltraGraphics));
  remember(addToggle(adv, 'Clouds', quality.getClouds, quality.setClouds, applyDeps));
  remember(dep(addSlider(adv, 'Cloud Opacity', {
    min: 0, max: 1, step: 0.05, decimals: 2, get: quality.getCloudOpacity, set: quality.setCloudOpacity,
  }), quality.getClouds));
  remember(addToggle(adv, 'Fog', () => settings.fog, (v) => { settings.fog = v; }, () => { opts.onViewDistanceChange(); applyDeps(); }));
  remember(dep(addSlider(adv, 'Fog Distance', {
    min: 0.4, max: 1, step: 0.05, decimals: 2,
    get: () => settings.fogNear, set: (v) => { settings.fogNear = v; }, onChange: opts.onViewDistanceChange,
  }), () => settings.fog));
  remember(addToggle(adv, 'Block Lights', quality.getBlockLights, quality.setBlockLights));
  remember(addToggle(adv, 'Foliage', quality.getFoliage, quality.setFoliage, applyDeps));
  remember(dep(addSlider(adv, 'Foliage Distance (chunks)', {
    min: 1, max: 64, step: 1, get: quality.getFoliageDistance, set: quality.setFoliageDistance,
  }), quality.getFoliage));

  // PERFORMANCE — how hard the machine works.
  adv.append(el('div', 'ui-subhead', 'Performance'));
  // ONE view-distance knob: the slider is the total visible horizon (LOD far
  // terrain); the full-detail chunk ring (physics, edits, mobs-of-the-future)
  // is always a quarter of it — 256 ⇒ 64 real chunks + ~4km of LOD scenery.
  remember(addSlider(adv, 'View Distance (chunks, ¼ full detail)', {
    min: 4, max: 256, step: 1,
    get: quality.getViewDistance, set: quality.setViewDistance,   // setter re-applies camera/fog/water spans
  }));
  // Decoupled full-detail override: how far REAL (physics/edit) chunks reach.
  // The View Distance slider above resets this to its ¼ default when moved —
  // this knob is for "tiny detail ring, huge LOD horizon" (or the reverse).
  remember(addSlider(adv, 'Full-Detail Distance (chunks)', {
    min: 2, max: 64, step: 1,
    get: quality.getDetailDistance, set: quality.setDetailDistance,
  }));
  remember(addSlider(adv, 'Resolution Scale', {
    min: 0.5, max: 2, step: 0.05, decimals: 2,   // >1 = supersample (SSAA): crisp but heavy
    get: quality.getResolutionScale, set: quality.setResolutionScale,
  }));
  // VSync ON (default) locks to the display refresh via rAF. OFF spins the loop
  // uncapped (benchmark mode — the MessageChannel flood can starve input/compositing,
  // see main.ts), then the Frame Rate Limit below applies a soft cap (Max = unlimited).
  remember(addToggle(adv, 'VSync', () => !settings.uncapFPS, (v) => { settings.uncapFPS = !v; }, applyDeps));
  remember(dep(addSegmented<string>(adv, 'Frame Rate Limit',
    [{ value: '0', label: 'Max' }, { value: '60', label: '60' }, { value: '120', label: '120' }, { value: '144', label: '144' }, { value: '240', label: '240' }],
    () => String(settings.fpsCap), (v) => { const n = Number(v); settings.fpsCap = Number.isFinite(n) ? n : 0; }), () => settings.uncapFPS));
  remember(addToggle(adv, 'Chunk Streaming (saves RAM)', quality.getFrustumStreaming, quality.setFrustumStreaming));

  // DEBUG / HUD
  adv.append(el('div', 'ui-subhead', 'Debug / HUD'));
  remember(addToggle(adv, 'Stats Overlay', quality.getStatsOverlay, quality.setStatsOverlay));

  // --- Lighting ---
  const light = addSection(setBody, '💡  Lighting', true);
  remember(addToggle(light, 'Day/Night Cycle', lighting.getDayNight, lighting.setDayNight));
  remember(addSlider(light, 'Time of Day', { min: 0, max: 1, step: 0.01, decimals: 2, get: lighting.getTime, set: lighting.setTime }));
  remember(addSlider(light, 'Day Length (s)', { min: 20, max: 1200, step: 10, get: lighting.getDayLength, set: lighting.setDayLength }));
  remember(addSlider(light, 'Sun Direction (°)', { min: 0, max: 360, step: 1, get: lighting.getAzimuth, set: lighting.setAzimuth }));
  remember(addSlider(light, 'Sun Height (°)', { min: 3, max: 89, step: 1, get: lighting.getElevation, set: lighting.setElevation }));
  remember(addSlider(light, 'Sun Brightness', { min: 0, max: 6, step: 0.1, decimals: 1, get: lighting.getSun, set: lighting.setSun }));
  remember(addSlider(light, 'Sky / Fill Light', { min: 0, max: 4, step: 0.1, decimals: 1, get: lighting.getFill, set: lighting.setFill }));
  remember(addSlider(light, 'Exposure', { min: 0.4, max: 2, step: 0.05, decimals: 2, get: lighting.getExposure, set: lighting.setExposure }));
  remember(addToggle(light, 'Biome Tint', lighting.getBiomeTint, lighting.setBiomeTint));

  // --- Player (the headline FOV + Sensitivity freedom knobs, kept near the top) ---
  const playerFolder = addSection(setBody, '🏃  Player', true);
  remember(addSlider(playerFolder, 'Field of View (°)', { min: 60, max: 110, step: 1, get: opts.playerView.getFov, set: opts.playerView.setFov }));
  remember(addSlider(playerFolder, 'Mouse Sensitivity', { min: 0.2, max: 3, step: 0.05, decimals: 2, get: opts.playerView.getMouseSensitivity, set: opts.playerView.setMouseSensitivity }));
  remember(addSlider(playerFolder, 'Walk Speed (blocks/s)', { min: 2, max: 20, step: 0.5, decimals: 1, get: () => player.maxSpeed, set: (v) => { player.maxSpeed = v; } }));

  // --- World (queued; Apply rebuilds) ---
  const terrain = addSection(setBody, '🌍  World');
  const applyBar = el('div', 'ui-applybar');
  const applyBtn = addButton(applyBar, 'Apply / Regenerate World', () => {
    applyBtn.classList.add('ui-apply--busy');
    if (world.needsRegen()) opts.regenerate();
    opts.onViewDistanceChange();
    setTimeout(() => applyBtn.classList.remove('ui-apply--busy'), 400);
  }, 'ui-btn--primary');
  const saveLoad = el('div', 'menu__btnrow');
  addButton(saveLoad, '💾  Save', opts.onSave);
  addButton(saveLoad, '📂  Load', opts.onLoad);
  terrain.append(applyBar, saveLoad);
  const gen = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, decimals?: number) =>
    remember(addSlider(terrain, label, { min, max, step, get, set, decimals }));
  gen('Seed', 0, 10000, 1, () => world.params.seed, (v) => { world.params.seed = v; });
  gen('Feature Scale', 50, 600, 5, () => world.params.terrain.scale, (v) => { world.params.terrain.scale = v; });
  gen('Mountain Height', 0, 200, 1, () => world.params.terrain.magnitude, (v) => { world.params.terrain.magnitude = v; });
  gen('Land Bias', 0, 70, 1, () => world.params.terrain.offset, (v) => { world.params.terrain.offset = v; });
  gen('Water Level', 0, 256, 1, () => world.params.terrain.waterOffset, (v) => { world.params.terrain.waterOffset = v; });

  // --- Trees ---
  const trees = addSection(setBody, '🌲  Trees', true);
  const genT = (parent: HTMLElement, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, decimals?: number) =>
    remember(addSlider(parent, label, { min, max, step, get, set, decimals }));
  genT(trees, 'Frequency', 0, 0.5, 0.005, () => world.params.trees.frequency, (v) => { world.params.trees.frequency = v; }, 3);
  genT(trees, 'Trunk Min Height', 1, 10, 1, () => world.params.trees.trunk.minHeight, (v) => { world.params.trees.trunk.minHeight = v; });
  genT(trees, 'Trunk Max Height', 1, 10, 1, () => world.params.trees.trunk.maxHeight, (v) => { world.params.trees.trunk.maxHeight = v; });
  genT(trees, 'Canopy Min Radius', 1, 10, 1, () => world.params.trees.canopy.minRadius, (v) => { world.params.trees.canopy.minRadius = v; });
  genT(trees, 'Canopy Max Radius', 1, 10, 1, () => world.params.trees.canopy.maxRadius, (v) => { world.params.trees.canopy.maxRadius = v; });
  genT(trees, 'Density', 0, 1, 0.05, () => world.params.trees.canopy.density, (v) => { world.params.trees.canopy.density = v; }, 2);

  // --- Resources ---
  const res = addSection(setBody, '💎  Resources', true);
  resources.forEach(resource => {
    res.append(el('div', 'ui-subhead', resource.name));
    genT(res, 'Scarcity', 0, 1, 0.01, () => resource.scarcity, (v) => { resource.scarcity = v; }, 2);
    genT(res, 'Scale X', 10, 100, 1, () => resource.scale.x, (v) => { resource.scale.x = v; });
    genT(res, 'Scale Y', 10, 100, 1, () => resource.scale.y, (v) => { resource.scale.y = v; });
    genT(res, 'Scale Z', 10, 100, 1, () => resource.scale.z, (v) => { resource.scale.z = v; });
  });

  selectTab('Mode');   // first open shows the mode picker + Play

  let open = false;
  let everPlayed = false;
  const setOpen = (v: boolean) => {
    open = v;
    root.classList.toggle('menu--open', v);
    if (v) { resumeBtn.textContent = everPlayed ? 'Resume' : 'Play'; syncMode(); syncSettings(); }
    else { everPlayed = true; }
  };

  return {
    el: root,
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    refreshStats,
    syncMode,
  };
}
