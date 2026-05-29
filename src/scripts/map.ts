import { ChunkParams, ChunkSize } from './chunkGen';
import type { MapWorkerRequest, MapTileResponse } from './mapWorker';

const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;

// Map tiles are rendered by the worker at TILE_PX pixels and cached. Multiple
// world-sizes (zoom levels, like a slippy map) keep the number of visible tiles
// bounded at ANY zoom — without that, zooming far out needed thousands of tiles
// and thrashed the cache. A tile's world-size is chosen so it draws ~TILE_PX on
// screen (≈1 tile-pixel per screen-pixel).
const TILE_PX = 128;
const TILE_LEVELS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384];
const MAX_CACHE = 900;        // LRU cap on cached tile canvases (touch-on-use)
const MAX_TILE_OUTSTANDING = 8;

// Choose the world-size whose pixels are at-or-finer than the screen, so tiles
// are crisp (never upscaled into a muddy blur). Picking the *coarser* level was
// what made zoomed-out views muddy.
function pickTileWorld(worldPerPixel: number): number {
  const maxL = worldPerPixel * TILE_PX; // tile detail (L/TILE_PX) <= screen wpp
  let chosen = TILE_LEVELS[0];
  for (const L of TILE_LEVELS) {
    if (L <= maxL) chosen = L; else break;
  }
  return chosen;
}

export type WorldMapOptions = {
  getPlayer: () => { x: number, z: number, yaw: number },
  onTeleport: (worldX: number, worldZ: number) => void,
  onOpen?: () => void,
  onClose?: () => void,
};

type WantTile = { key: string, originX: number, originZ: number, tileWorld: number, d: number };

export class WorldMap {
  private opts: WorldMapOptions;
  private worker: Worker | null = null;

  // tile cache
  private cache = new Map<string, HTMLCanvasElement>();
  private requested = new Set<string>();
  private outstanding = 0;
  private want: WantTile[] = [];

  // minimap
  private mini: HTMLCanvasElement;
  private miniMarker: HTMLElement;
  private miniWpp = 4;

  // fullscreen map
  private overlay: HTMLElement;
  private big: HTMLCanvasElement;
  private open = false;
  private centerX = 0;
  private centerZ = 0;
  private wpp = 6;
  private dragging = false;
  private dragMoved = false;
  private px = 0;
  private py = 0;

  constructor(opts: WorldMapOptions) {
    this.opts = opts;
    this.initWorker();

    const miniWrap = document.createElement('div');
    miniWrap.className = 'minimap';
    this.mini = document.createElement('canvas');
    this.mini.width = this.mini.height = 160;
    this.miniMarker = document.createElement('div');
    this.miniMarker.className = 'minimap__marker';
    miniWrap.append(this.mini, this.miniMarker);
    document.body.append(miniWrap);

    this.overlay = document.createElement('div');
    this.overlay.className = 'worldmap';
    this.big = document.createElement('canvas');
    this.big.className = 'worldmap__canvas';
    const hint = document.createElement('div');
    hint.className = 'worldmap__hint';
    hint.textContent = 'Drag to pan · scroll to zoom · click to teleport · Esc/G to close';
    const close = document.createElement('button');
    close.className = 'worldmap__close';
    close.textContent = '✕';
    close.addEventListener('click', () => this.close());
    this.overlay.append(this.big, hint, close);
    document.body.append(this.overlay);

    this.bindMapEvents();
  }

  private initWorker() {
    try {
      this.worker = new Worker(new URL('./mapWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<MapTileResponse>) => this.onTile(e.data);
      this.worker.onerror = () => { this.worker = null; };
    } catch {
      this.worker = null;
    }
  }

  // (Re)point the map worker at the current world; clears cached tiles.
  configure(params: ChunkParams, size: ChunkSize, sea: number) {
    this.cache.clear();
    this.requested.clear();
    this.outstanding = 0;
    if (this.worker) {
      const msg: MapWorkerRequest = { type: 'config', params, size, sea };
      this.worker.postMessage(msg);
    }
  }

  private onTile(res: MapTileResponse) {
    this.outstanding = Math.max(0, this.outstanding - 1);
    this.requested.delete(res.key);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = res.tilePx;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(res.buffer), res.tilePx, res.tilePx), 0, 0);
    this.cache.set(res.key, canvas);
    if (this.cache.size > MAX_CACHE) {
      // evict oldest (Map preserves insertion order) that isn't pending
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest) this.cache.delete(oldest);
    }
  }

  private bindMapEvents() {
    this.big.addEventListener('pointerdown', (e) => {
      this.dragging = true; this.dragMoved = false;
      this.px = e.clientX; this.py = e.clientY;
      this.big.setPointerCapture(e.pointerId);
    });
    this.big.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.px, dy = e.clientY - this.py;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.dragMoved = true;
      this.px = e.clientX; this.py = e.clientY;
      const sx = this.big.width / this.big.clientWidth;
      const sy = this.big.height / this.big.clientHeight;
      this.centerX -= dx * sx * this.wpp;
      this.centerZ -= dy * sy * this.wpp;
    });
    this.big.addEventListener('pointerup', (e) => {
      this.dragging = false;
      try { this.big.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (!this.dragMoved) {
        const { wx, wz } = this.screenToWorld(e.clientX, e.clientY);
        this.opts.onTeleport(wx, wz);
        this.close();
      }
    });
    // Gentle, proportional zoom (exp of scroll delta) — the old 1.15-per-event
    // step was far too sensitive, especially on trackpads.
    this.big.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.wpp = clamp(this.wpp * Math.exp(e.deltaY * 0.0012), 1.5, 64);
    }, { passive: false });
  }

  private screenToWorld(clientX: number, clientY: number) {
    const rect = this.big.getBoundingClientRect();
    const sx = this.big.width / rect.width;
    const sy = this.big.height / rect.height;
    const cx = (clientX - rect.left) * sx;
    const cy = (clientY - rect.top) * sy;
    return {
      wx: Math.floor(this.centerX + (cx - this.big.width / 2) * this.wpp),
      wz: Math.floor(this.centerZ + (cy - this.big.height / 2) * this.wpp),
    };
  }

  isOpen() { return this.open; }
  toggle() { this.open ? this.close() : this.openMap(); }

  openMap() {
    const p = this.opts.getPlayer();
    this.centerX = p.x; this.centerZ = p.z;
    const aspect = window.innerHeight / window.innerWidth;
    this.big.width = 640;
    this.big.height = Math.max(2, Math.round(640 * aspect));
    this.overlay.classList.add('worldmap--open');
    this.open = true;
    this.opts.onOpen?.();
  }

  close() {
    this.overlay.classList.remove('worldmap--open');
    this.open = false;
    this.opts.onClose?.();
  }

  // Composite cached tiles for a view; queues any missing tiles (nearest first).
  private composite(canvas: HTMLCanvasElement, cx: number, cz: number, wpp: number) {
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#0b0f17';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const L = pickTileWorld(wpp);
    const leftW = cx - canvas.width / 2 * wpp;
    const topW = cz - canvas.height / 2 * wpp;
    const rightW = cx + canvas.width / 2 * wpp;
    const botW = cz + canvas.height / 2 * wpp;
    const ss = L / wpp; // on-screen tile size

    for (let tz = Math.floor(topW / L); tz <= Math.floor(botW / L); tz++) {
      for (let tx = Math.floor(leftW / L); tx <= Math.floor(rightW / L); tx++) {
        const key = `${L},${tx},${tz}`;
        const ox = tx * L, oz = tz * L;
        const sx = (ox - leftW) / wpp;
        const sy = (oz - topW) / wpp;
        const tile = this.cache.get(key);
        if (tile) {
          // Touch on use (move to most-recent) so a visible tile is never the
          // LRU eviction victim — that was causing visible tiles to be evicted,
          // re-requested and re-rendered in a flickering loop.
          this.cache.delete(key);
          this.cache.set(key, tile);
          ctx.drawImage(tile, sx, sy, ss, ss);
        } else if (!this.requested.has(key)) {
          const dxc = ox + L / 2 - cx, dzc = oz + L / 2 - cz;
          this.want.push({ key, originX: ox, originZ: oz, tileWorld: L, d: dxc * dxc + dzc * dzc });
        }
      }
    }
  }

  // Drain the want-list to the worker, nearest first, gated by outstanding.
  private pumpRequests() {
    if (!this.worker || this.want.length === 0) return;
    this.want.sort((a, b) => a.d - b.d);
    for (const t of this.want) {
      if (this.outstanding >= MAX_TILE_OUTSTANDING) break;
      if (this.requested.has(t.key) || this.cache.has(t.key)) continue;
      this.requested.add(t.key);
      this.outstanding++;
      const msg: MapWorkerRequest = {
        type: 'tile', key: t.key,
        originX: t.originX, originZ: t.originZ,
        tileWorld: t.tileWorld, tilePx: TILE_PX,
      };
      this.worker.postMessage(msg);
    }
    this.want.length = 0;
  }

  // Called every frame.
  update() {
    const p = this.opts.getPlayer();
    this.want.length = 0;

    this.miniMarker.style.transform = `translate(-50%, -50%) rotate(${-p.yaw}rad)`;
    this.composite(this.mini, p.x, p.z, this.miniWpp);

    if (this.open) {
      this.composite(this.big, this.centerX, this.centerZ, this.wpp);
      this.drawPlayerOnMap(p.x, p.z);
    }
    this.pumpRequests();
  }

  private drawPlayerOnMap(px: number, pz: number) {
    const ctx = this.big.getContext('2d')!;
    const sx = this.big.width / 2 + (px - this.centerX) / this.wpp;
    const sy = this.big.height / 2 + (pz - this.centerZ) / this.wpp;
    ctx.fillStyle = '#ff3b3b';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
