// ============================================================================
//  HOTBAR + CREATIVE INVENTORY — Minecraft-style block selection.
//
//  - 9-slot hotbar: keys 1-9 select, mouse wheel cycles, middle-click picks the
//    targeted block (jumps to its slot if present, else replaces the selection).
//  - E opens the creative inventory: every placeable block, categorised +
//    searchable. Click a cell to put it in the selected hotbar slot, drag it
//    onto a specific slot, or hover it and press 1-9 (MC behaviour).
//    Right-click a hotbar slot to empty it.
//  - Icons are drawn from the SAME 16×16 texture PNGs the world uses
//    (BLOCK_FACE_LAYERS → textureLayerUrl) as fake-isometric cubes — no
//    separate icon assets to maintain.
//  - Entries can expand to multiple world blocks on placement: doors place
//    their upper half, beds their head, 2-tall plants their upper cell, and
//    stair entries auto-orient to the player's facing (stairSet).
// ============================================================================
import { BLOCK_IDS, BLOCK_FACE_LAYERS, PLANTS, TEXTURE_LAYER } from './blockTypes';
import { textureLayerUrl } from './blockArrayMaterial';
import { assetUrl } from './assetBase';

const I = BLOCK_IDS;
const SLOTS = 9;

type IconKind = 'cube' | 'slab' | 'flat' | 'fence';

export type InvEntry = {
  key: string;                 // stable id (persisted in prefs)
  label: string;
  cat: string;
  blockId: number;             // primary world block placed (stairs: the PX variant)
  icon: IconKind;
  tint?: boolean;              // grayscale source texture → tint green (grass top, oak leaves, grass plants)
  stairSet?: readonly [number, number, number, number];   // [PX,NX,PZ,NZ] — auto-orient on place
  upperId?: number;            // block placed one cell above (door upper / 2-tall plant upper)
  bedPair?: boolean;           // bed: auto-place the matching half alongside
  aliasIds?: readonly number[];  // other world ids that "pick" back to this entry
};

// ---------------------------------------------------------------------------
//  CATALOG
// ---------------------------------------------------------------------------
const LABELS: Record<string, string> = {
  tree: 'Oak Log', leaves: 'Oak Leaves', strippedOakLog: 'Stripped Oak Log',
  mushroomRed: 'Red Mushroom Block', mushroomBrown: 'Brown Mushroom Block',
  smallMushroomRed: 'Red Mushroom', smallMushroomBrown: 'Brown Mushroom',
  furnaceLit: 'Lit Furnace', jackOLantern: "Jack o'Lantern",
  snowLayer: 'Snow Layer', redSand: 'Red Sand',
};
const pretty = (k: string) =>
  LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
    .replace(/^Flower /, '').replace(/^Wool (.+)$/, '$1 Wool').replace(/^Terracotta (.+)$/, '$1 Terracotta');

export const ENTRIES: InvEntry[] = [];
const add = (cat: string, idKey: keyof typeof I, over: Partial<InvEntry> = {}) => {
  const blockId = I[idKey];
  ENTRIES.push({
    key: idKey as string,
    label: over.label ?? pretty(idKey as string),
    cat, blockId,
    icon: over.icon ?? (PLANTS[blockId] ? 'flat' : 'cube'),
    ...over,
  });
};

{
  const N = 'Natural';
  add(N, 'grass', { tint: true });
  add(N, 'dirt'); add(N, 'podzol'); add(N, 'mycelium');
  add(N, 'sand'); add(N, 'redSand'); add(N, 'gravel'); add(N, 'clay'); add(N, 'mud');
  add(N, 'snow'); add(N, 'snowLayer', { icon: 'slab' });
  add(N, 'ice'); add(N, 'packedIce');
  add(N, 'stone'); add(N, 'deepslate'); add(N, 'andesite'); add(N, 'diorite'); add(N, 'granite');
  add(N, 'tuff'); add(N, 'calcite'); add(N, 'basalt'); add(N, 'blackstone');
  add(N, 'obsidian'); add(N, 'netherrack'); add(N, 'endStone'); add(N, 'magma'); add(N, 'lava'); add(N, 'bedrock');
  add(N, 'pumpkin'); add(N, 'cactus'); add(N, 'hayBale');
  add(N, 'mushroomRed'); add(N, 'mushroomBrown'); add(N, 'mushroomStem');

  const S = 'Stone & Brick';
  add(S, 'cobblestone'); add(S, 'mossyCobblestone'); add(S, 'smoothStone');
  add(S, 'stoneBricks'); add(S, 'mossyStoneBricks'); add(S, 'crackedStoneBricks'); add(S, 'chiseledStoneBricks');
  add(S, 'bricks'); add(S, 'polishedAndesite'); add(S, 'polishedDiorite'); add(S, 'polishedGranite');
  add(S, 'sandstone'); add(S, 'cutSandstone'); add(S, 'smoothSandstone'); add(S, 'chiseledSandstone');
  add(S, 'redSandstone'); add(S, 'cutRedSandstone');
  add(S, 'quartzBlock'); add(S, 'quartzPillar'); add(S, 'netherBricks');
  add(S, 'prismarine'); add(S, 'prismarineBricks');
  add(S, 'terracottaWhite'); add(S, 'terracottaLightGray'); add(S, 'terracottaYellow');
  add(S, 'terracottaOrange'); add(S, 'terracottaRed'); add(S, 'terracottaBrown');

  const W = 'Wood';
  add(W, 'tree'); add(W, 'strippedOakLog'); add(W, 'birchLog'); add(W, 'spruceLog'); add(W, 'darkOakLog');
  add(W, 'jungleLog'); add(W, 'acaciaLog'); add(W, 'mangroveLog'); add(W, 'cherryLog');
  add(W, 'oakPlanks'); add(W, 'birchPlanks'); add(W, 'sprucePlanks'); add(W, 'darkOakPlanks');
  add(W, 'junglePlanks'); add(W, 'acaciaPlanks'); add(W, 'mangrovePlanks'); add(W, 'cherryPlanks');
  add(W, 'leaves', { tint: true }); add(W, 'birchLeaves'); add(W, 'spruceLeaves'); add(W, 'darkOakLeaves');
  add(W, 'jungleLeaves'); add(W, 'acaciaLeaves'); add(W, 'mangroveLeaves'); add(W, 'cherryLeaves');

  const O = 'Ores & Minerals';
  add(O, 'coalOre'); add(O, 'ironOre'); add(O, 'copperOre'); add(O, 'goldOre');
  add(O, 'redstoneOre'); add(O, 'lapisOre'); add(O, 'diamondOre'); add(O, 'emeraldOre');
  add(O, 'coalBlock'); add(O, 'ironBlock'); add(O, 'copperBlock'); add(O, 'goldBlock');
  add(O, 'redstoneBlock'); add(O, 'lapisBlock'); add(O, 'diamondBlock'); add(O, 'emeraldBlock');

  const C = 'Wool';
  for (const k of ['woolWhite', 'woolLightGray', 'woolGray', 'woolBlack', 'woolBrown', 'woolRed', 'woolOrange',
    'woolYellow', 'woolLime', 'woolGreen', 'woolCyan', 'woolLightBlue', 'woolBlue', 'woolPurple',
    'woolMagenta', 'woolPink'] as const) add(C, k);

  const T = 'Slabs & Stairs';
  add(T, 'oakSlab', { icon: 'slab' }); add(T, 'cobbleSlab', { icon: 'slab' });
  add(T, 'stoneSlab', { icon: 'slab' }); add(T, 'sandstoneSlab', { icon: 'slab' });
  const stairs = (key: string, label: string, set: readonly [number, number, number, number]) =>
    ENTRIES.push({ key, label, cat: T, blockId: set[0], stairSet: set, icon: 'cube', aliasIds: set });
  stairs('oakStairs', 'Oak Stairs', [I.oakStairsPX, I.oakStairsNX, I.oakStairsPZ, I.oakStairsNZ]);
  stairs('cobbleStairs', 'Cobblestone Stairs', [I.cobbleStairsPX, I.cobbleStairsNX, I.cobbleStairsPZ, I.cobbleStairsNZ]);
  stairs('stoneStairs', 'Stone Stairs', [I.stoneStairsPX, I.stoneStairsNX, I.stoneStairsPZ, I.stoneStairsNZ]);
  stairs('sandstoneStairs', 'Sandstone Stairs', [I.sandstoneStairsPX, I.sandstoneStairsNX, I.sandstoneStairsPZ, I.sandstoneStairsNZ]);
  add(T, 'oakFence', { icon: 'fence' }); add(T, 'cobbleFence', { icon: 'fence' });

  const L = 'Lighting';
  add(L, 'torch'); add(L, 'lantern'); add(L, 'glowstone'); add(L, 'seaLantern');
  add(L, 'campfire'); add(L, 'jackOLantern'); add(L, 'furnaceLit');

  const U = 'Utility';
  ENTRIES.push({
    key: 'oakDoor', label: 'Oak Door', cat: U, blockId: I.oakDoorLowerClosed, upperId: I.oakDoorUpperClosed,
    icon: 'flat', aliasIds: [I.oakDoorUpperClosed, I.oakDoorLowerOpen, I.oakDoorUpperOpen],
  });
  ENTRIES.push({
    key: 'oakTrapdoor', label: 'Oak Trapdoor', cat: U, blockId: I.oakTrapdoorClosed,
    icon: 'flat', aliasIds: [I.oakTrapdoorOpen],
  });
  ENTRIES.push({ key: 'bed', label: 'Bed', cat: U, blockId: I.bedFoot, bedPair: true, icon: 'cube', aliasIds: [I.bedHead] });
  add(U, 'glass'); add(U, 'bookshelf'); add(U, 'craftingTable'); add(U, 'furnace');
  add(U, 'chest'); add(U, 'barrel'); add(U, 'flowerPot');

  const P = 'Plants';
  add(P, 'shortGrass', { tint: true }); add(P, 'fern', { tint: true });
  const tall = (key: keyof typeof I, upper: keyof typeof I, tint = false) => {
    const e: Partial<InvEntry> = { upperId: I[upper], aliasIds: [I[upper]] };
    if (tint) e.tint = true;
    add(P, key, e);
  };
  tall('tallGrassLower', 'tallGrassUpper', true);
  tall('largeFernLower', 'largeFernUpper', true);
  add(P, 'deadBush');
  add(P, 'flowerDandelion'); add(P, 'flowerPoppy'); add(P, 'flowerCornflower'); add(P, 'flowerOxeye');
  add(P, 'flowerAllium'); add(P, 'flowerTulip'); add(P, 'flowerBlueOrchid');
  tall('sunflowerLower', 'sunflowerUpper'); tall('lilacLower', 'lilacUpper');
  tall('roseBushLower', 'roseBushUpper'); tall('peonyLower', 'peonyUpper');
  add(P, 'smallMushroomRed'); add(P, 'smallMushroomBrown');
  add(P, 'sugarCane'); add(P, 'bamboo'); add(P, 'sweetBerryBush');
  add(P, 'vine', { tint: true }); add(P, 'lilyPad'); add(P, 'cherryPetals'); add(P, 'leafLitter');
  add(P, 'seagrass'); add(P, 'kelp', { aliasIds: [I.kelpTop] }); add(P, 'seaPickle');
}
// Tidy the auto 2-tall plant labels ("Tall Grass Lower" → "Tall Grass").
for (const e of ENTRIES) e.label = e.label.replace(/ Lower$/, '');

export const CATEGORIES = [...new Set(ENTRIES.map((e) => e.cat))];

// world block id → entry (primary ids + aliases) for middle-click pick.
const BY_BLOCK_ID = new Map<number, InvEntry>();
for (const e of ENTRIES) {
  if (!BY_BLOCK_ID.has(e.blockId)) BY_BLOCK_ID.set(e.blockId, e);
  for (const a of e.aliasIds ?? []) if (!BY_BLOCK_ID.has(a)) BY_BLOCK_ID.set(a, e);
}
const BY_KEY = new Map(ENTRIES.map((e) => [e.key, e]));
export const entryForBlockId = (id: number) => BY_BLOCK_ID.get(id);

// ---------------------------------------------------------------------------
//  ICONS — fake-isometric cubes from the world's own 16×16 face textures.
// ---------------------------------------------------------------------------
const GRASS_TINT = '#79c05a';   // plains-ish green for grayscale grass/leaf textures
const texCache = new Map<string, Promise<HTMLImageElement>>();
function loadTex(url: string): Promise<HTMLImageElement> {
  let p = texCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = assetUrl(url);
    });
    texCache.set(url, p);
  }
  return p;
}

// 16×16 face texture, optionally green-tinted and/or darkened — alpha preserved.
function shadeFace(img: HTMLImageElement, tint: string | null, brightness: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, 16, 16);
  if (tint) {
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = tint;
    g.fillRect(0, 0, 16, 16);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(img, 0, 0, 16, 16);   // restore the texture's alpha mask
  }
  if (brightness < 1) {
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = `rgba(0,0,0,${1 - brightness})`;
    g.fillRect(0, 0, 16, 16);
  }
  g.globalCompositeOperation = 'source-over';
  return c;
}

// Paint an entry's icon into `canvas` (async — fills when its textures decode).
export function paintEntryIcon(canvas: HTMLCanvasElement, entry: InvEntry) {
  const S = canvas.width;   // square
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, S, S);
  ctx.imageSmoothingEnabled = false;

  const plant = PLANTS[entry.blockId];
  const faces = BLOCK_FACE_LAYERS[entry.blockId];
  const tint = entry.tint ? GRASS_TINT : null;

  // FLAT icon: the texture itself (plants, doors, trapdoors).
  if (entry.icon === 'flat' || plant || !faces) {
    const layer = plant ? plant.layer : (faces ? faces[0] : TEXTURE_LAYER.white);
    const url = textureLayerUrl(layer);
    if (!url) return;
    loadTex(url).then((img) => {
      const face = shadeFace(img, tint ?? (plant?.tint === 'grass' ? GRASS_TINT : null), 1);
      const m = S * 0.08;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(face, m, m, S - 2 * m, S - 2 * m);
    }).catch(() => {});
    return;
  }

  // FENCE icon: post + cross-arm silhouette from the fence's texture.
  if (entry.icon === 'fence') {
    const url = textureLayerUrl(faces[0]);
    if (!url) return;
    loadTex(url).then((img) => {
      const face = shadeFace(img, tint, 1);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(face, S * 0.40, S * 0.10, S * 0.20, S * 0.80);   // post
      ctx.drawImage(face, S * 0.08, S * 0.34, S * 0.84, S * 0.14);   // upper arm
      ctx.drawImage(face, S * 0.08, S * 0.62, S * 0.84, S * 0.14);   // lower arm
    }).catch(() => {});
    return;
  }

  // CUBE / SLAB icon: classic MC isometric — top diamond + two shaded sides.
  // Face order [+x,-x,+y(top),-y,+z,-z]: top = faces[2], side = faces[0]/[5].
  const hf = entry.icon === 'slab' ? 0.5 : 1;   // slab = bottom-half height
  const topUrl = textureLayerUrl(faces[2]);
  const sideUrl = textureLayerUrl(faces[5]);    // -z face (furnace/chest fronts read better)
  const side2Url = textureLayerUrl(faces[0]);
  if (!topUrl || !sideUrl || !side2Url) return;
  Promise.all([loadTex(topUrl), loadTex(sideUrl), loadTex(side2Url)]).then(([topImg, frontImg, rightImg]) => {
    // grass-style blocks tint only the TOP (sides are pre-coloured PNGs)
    const top = shadeFace(topImg, tint, 1);
    const left = shadeFace(frontImg, entry.blockId === I.leaves ? tint : null, 0.80);
    const right = shadeFace(rightImg, entry.blockId === I.leaves ? tint : null, 0.62);
    const px = (S / 2) / 16, py = (S / 4) / 16, h = ((S / 2) / 16) * hf;
    const yTop = (1 - hf) * (S / 2);   // slabs sit lower
    ctx.imageSmoothingEnabled = false;
    // top diamond
    ctx.setTransform(px, py, -px, py, S / 2, yTop);
    ctx.drawImage(top, 0, 0);
    // left (front) face
    ctx.setTransform(px, py, 0, h, 0, S / 4 + yTop);
    ctx.drawImage(left, 0, 0);
    // right face
    ctx.setTransform(px, -py, 0, h, S / 2, S / 2 + yTop);
    ctx.drawImage(right, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
//  HOTBAR + INVENTORY UI
// ---------------------------------------------------------------------------
export type InventoryOptions = {
  onSelectionChange: (entry: InvEntry | null) => void,
  onOpen?: () => void,
  onClose?: () => void,
  persist?: (slotKeys: (string | null)[]) => void,
  restore?: (string | null)[] | undefined,
};

const DEFAULT_HOTBAR: (string | null)[] =
  ['grass', 'dirt', 'stone', 'cobblestone', 'oakPlanks', 'tree', 'glass', 'torch', 'oakStairs'];

export class Inventory {
  slots: (InvEntry | null)[] = new Array(SLOTS).fill(null);
  selected = 0;
  private opts: InventoryOptions;
  private hudSlots: HTMLElement[] = [];
  private mirrorSlots: HTMLElement[] = [];
  private overlay: HTMLElement;
  private grid: HTMLElement;
  private search: HTMLInputElement;
  private tabsEl: HTMLElement;
  private open = false;
  private activeCat = 'All';
  private hoveredEntry: InvEntry | null = null;
  private dragEntry: InvEntry | null = null;
  private dragGhost: HTMLElement | null = null;
  private dragStartX = 0;
  private dragStartY = 0;

  constructor(opts: InventoryOptions) {
    this.opts = opts;
    // Array.isArray (not just a length check): localStorage is user-editable —
    // a corrupted prefs value like a 9-char string would crash boot on .map.
    const restore = Array.isArray(opts.restore) && opts.restore.length === SLOTS ? opts.restore : DEFAULT_HOTBAR;
    this.slots = restore.map((k) => (typeof k === 'string' ? BY_KEY.get(k) ?? null : null));

    // --- HUD hotbar (inside the existing #toolbar-container) ---
    const container = document.getElementById('toolbar-container');
    const bar = document.createElement('div');
    bar.className = 'hotbar';
    this.hudSlots = this.buildSlotRow(bar, false);
    container?.replaceChildren(bar);

    // --- fullscreen inventory overlay ---
    this.overlay = document.createElement('div');
    this.overlay.className = 'inv';
    const panel = document.createElement('div');
    panel.className = 'inv__panel';

    const head = document.createElement('div');
    head.className = 'inv__head';
    const title = document.createElement('div');
    title.className = 'inv__title';
    title.textContent = 'Blocks';
    this.search = document.createElement('input');
    this.search.className = 'inv__search';
    this.search.placeholder = 'Search blocks…';
    this.search.addEventListener('keydown', (e) => {
      // Esc still closes; everything else stays out of the game's key handlers
      if (e.key === 'Escape') { this.close(); return; }
      e.stopPropagation();
    });
    this.search.addEventListener('input', () => this.renderGrid());
    const close = document.createElement('button');
    close.className = 'inv__close';
    close.textContent = '✕';
    close.addEventListener('click', () => this.close());
    head.append(title, this.search, close);

    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'inv__tabs';
    for (const cat of ['All', ...CATEGORIES]) {
      const b = document.createElement('button');
      b.className = 'inv__tab';
      b.textContent = cat;
      b.addEventListener('click', () => { this.activeCat = cat; this.syncTabs(); this.renderGrid(); });
      this.tabsEl.append(b);
    }

    this.grid = document.createElement('div');
    this.grid.className = 'inv__grid';

    const hint = document.createElement('div');
    hint.className = 'inv__hint';
    hint.textContent = 'Click: put in selected slot · drag to a slot · hover + 1-9: put in that slot · right-click a slot: clear · E/Esc: close';

    const mirrorBar = document.createElement('div');
    mirrorBar.className = 'hotbar hotbar--inv';
    this.mirrorSlots = this.buildSlotRow(mirrorBar, true);

    panel.append(head, this.tabsEl, this.grid, hint, mirrorBar);
    this.overlay.append(panel);
    document.body.append(this.overlay);

    // hover + number key = assign to that slot (MC creative behaviour)
    document.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.key >= '1' && e.key <= '9' && this.hoveredEntry) {
        this.setSlot(parseInt(e.key) - 1, this.hoveredEntry);
      }
    });
    // drag ghost follows the pointer; drop on a slot assigns. The ghost only
    // appears once the pointer actually moves (no flash on a plain click).
    document.addEventListener('pointermove', (e) => {
      if (this.dragGhost) {
        if (this.dragGhost.style.display === 'none'
          && Math.hypot(e.clientX - this.dragStartX, e.clientY - this.dragStartY) > 6) {
          this.dragGhost.style.display = '';
        }
        this.dragGhost.style.left = `${e.clientX}px`;
        this.dragGhost.style.top = `${e.clientY}px`;
      }
    });
    document.addEventListener('pointerup', (e) => {
      if (!this.dragEntry) return;
      const slotEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.hotbar-slot') as HTMLElement | null;
      if (slotEl?.dataset.slot !== undefined) {
        const i = Number(slotEl.dataset.slot);
        this.setSlot(i, this.dragEntry);
        this.select(i);
      }
      this.dragEntry = null;
      this.dragGhost?.remove();
      this.dragGhost = null;
    });
    // A cancelled pointer (browser gesture, window blur) must not strand the ghost.
    document.addEventListener('pointercancel', () => {
      this.dragEntry = null;
      this.dragGhost?.remove();
      this.dragGhost = null;
    });

    this.syncTabs();
    this.renderAllSlots();
    this.opts.onSelectionChange(this.selectedEntry);
  }

  get selectedEntry(): InvEntry | null { return this.slots[this.selected]; }
  isOpen() { return this.open; }

  // One row of 9 slot elements (HUD or overlay mirror — same state, two views).
  private buildSlotRow(parent: HTMLElement, interactive: boolean): HTMLElement[] {
    const els: HTMLElement[] = [];
    for (let i = 0; i < SLOTS; i++) {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      slot.dataset.slot = String(i);
      const cv = document.createElement('canvas');
      cv.width = cv.height = 48;
      const key = document.createElement('span');
      key.className = 'hotbar-key';
      key.textContent = String(i + 1);
      slot.append(cv, key);
      if (interactive) {
        slot.addEventListener('pointerdown', (e) => {
          if (e.button === 2) { e.preventDefault(); this.setSlot(i, null); }
          else this.select(i);
        });
        slot.addEventListener('contextmenu', (e) => e.preventDefault());
      }
      parent.append(slot);
      els.push(slot);
    }
    return els;
  }

  private renderSlot(i: number) {
    for (const row of [this.hudSlots, this.mirrorSlots]) {
      const el = row[i];
      if (!el) continue;
      el.classList.toggle('hotbar-slot--sel', i === this.selected);
      const cv = el.querySelector('canvas')!;
      const e = this.slots[i];
      el.title = e?.label ?? '';
      const ctx = cv.getContext('2d');
      ctx?.clearRect(0, 0, cv.width, cv.height);
      if (e) paintEntryIcon(cv, e);
    }
  }
  private renderAllSlots() { for (let i = 0; i < SLOTS; i++) this.renderSlot(i); }

  select(i: number) {
    if (i < 0 || i >= SLOTS) return;
    const prev = this.selected;
    this.selected = i;
    this.renderSlot(prev);
    this.renderSlot(i);
    this.opts.onSelectionChange(this.selectedEntry);
  }

  cycle(dir: number) { this.select((this.selected + Math.sign(dir) + SLOTS) % SLOTS); }

  setSlot(i: number, entry: InvEntry | null) {
    this.slots[i] = entry;
    this.renderSlot(i);
    if (i === this.selected) this.opts.onSelectionChange(this.selectedEntry);
    this.opts.persist?.(this.slots.map((s) => s?.key ?? null));
  }

  // MC pick-block: jump to the slot already holding it; else replace the selection.
  pickBlock(blockId: number): boolean {
    const entry = BY_BLOCK_ID.get(blockId);
    if (!entry) return false;
    const existing = this.slots.findIndex((s) => s?.key === entry.key);
    if (existing >= 0) this.select(existing);
    else this.setSlot(this.selected, entry);
    return true;
  }

  toggle() { this.open ? this.close() : this.openUI(); }

  openUI() {
    if (this.open) return;
    this.open = true;
    this.overlay.classList.add('inv--open');
    this.renderGrid();
    this.renderAllSlots();
    this.search.value = '';
    setTimeout(() => this.search.focus(), 0);
    this.opts.onOpen?.();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.overlay.classList.remove('inv--open');
    // The search input MUST drop focus: its stopPropagation keydown handler
    // would otherwise keep swallowing WASD after the overlay is hidden.
    this.search.blur();
    this.hoveredEntry = null;
    this.dragEntry = null;
    this.dragGhost?.remove();
    this.dragGhost = null;
    this.opts.onClose?.();
  }

  private syncTabs() {
    for (const b of Array.from(this.tabsEl.children)) {
      b.classList.toggle('inv__tab--on', (b as HTMLElement).textContent === this.activeCat);
    }
  }

  private renderGrid() {
    const q = this.search.value.trim().toLowerCase();
    this.grid.replaceChildren();
    for (const e of ENTRIES) {
      if (this.activeCat !== 'All' && e.cat !== this.activeCat) continue;
      if (q && !e.label.toLowerCase().includes(q)) continue;
      const cell = document.createElement('button');
      cell.className = 'inv-cell';
      cell.title = e.label;
      const cv = document.createElement('canvas');
      cv.width = cv.height = 40;
      paintEntryIcon(cv, e);
      cell.append(cv);
      cell.addEventListener('mouseenter', () => { this.hoveredEntry = e; });
      cell.addEventListener('mouseleave', () => { if (this.hoveredEntry === e) this.hoveredEntry = null; });
      cell.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        // arm a potential drag — the ghost shows only once the pointer moves,
        // so a plain click stays a click (assign to the selected slot below).
        this.dragEntry = e;
        this.dragStartX = ev.clientX;
        this.dragStartY = ev.clientY;
        const ghost = document.createElement('div');
        ghost.className = 'inv-ghost';
        ghost.style.display = 'none';
        const gcv = document.createElement('canvas');
        gcv.width = gcv.height = 40;
        paintEntryIcon(gcv, e);
        ghost.append(gcv);
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
        document.body.append(ghost);
        this.dragGhost = ghost;
      });
      cell.addEventListener('click', () => this.setSlot(this.selected, e));
      this.grid.append(cell);
    }
  }
}
