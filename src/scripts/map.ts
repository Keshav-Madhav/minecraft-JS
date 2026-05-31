import { ChunkParams, ChunkSize } from './chunkGen';
import type { MapWorkerRequest, MapTileResponse } from './mapWorker';
import { idbGetTile, idbPutTile } from './mapTileCache';

const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;

// ---------------------------------------------------------------------------
//  MINIMAP — now rendered directly from the world's already-generated per-chunk
//  tiles (WorldChunk.getMapTileCanvas), blitted 1:1. No map-worker round-trip,
//  no chunk re-generation: it's always in sync with what's loaded and costs only
//  a handful of drawImage calls per frame. (The old path regenerated whole 128-
//  world tiles — ~64 chunks of full chunk-gen each — continuously as you walked,
//  which is what made the detailed view slow.)
//
//  FULLSCREEN MAP — still rendered by the map-worker pool (it can pan anywhere,
//  including unloaded terrain), but tiles are now persisted in IndexedDB keyed by
//  the world signature, so revisited areas load instantly and survive reloads.
// ---------------------------------------------------------------------------

// Fullscreen-map tiles are rendered by the worker at TILE_PX pixels and cached.
// Multiple world-sizes (zoom levels, like a slippy map) keep the number of
// visible tiles bounded at ANY zoom.
const TILE_PX = 128;
const TILE_LEVELS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384];
const MAX_CACHE = 1200;       // LRU cap on in-memory tile canvases (touch-on-use)
// The minimap no longer uses the worker pool, and the game's chunk workers are
// idle while the fullscreen map is open (the voxel world isn't rendered then), so
// we use a WIDE pool (≈ all cores) for snappy map loads.
const MAP_WORKERS = Math.max(3, Math.min(8, navigator.hardwareConcurrency || 4));
const MAX_TILE_OUTSTANDING = MAP_WORKERS * 6;   // queue a few per worker so none idles

// Choose the world-size whose pixels are at-or-finer than the screen, so tiles
// are crisp (never upscaled into a muddy blur).
function pickTileWorld(worldPerPixel: number): number {
  const maxL = worldPerPixel * TILE_PX;
  let chosen = TILE_LEVELS[0];
  for (const L of TILE_LEVELS) {
    if (L <= maxL) chosen = L; else break;
  }
  return chosen;
}

export type WorldMapOptions = {
  getPlayer: () => { x: number, z: number, yaw: number },
  // Cached top-down canvas for a loaded chunk, or null if not loaded (minimap).
  getChunkTile: (chunkX: number, chunkZ: number) => HTMLCanvasElement | null,
  // Monotonic counter bumped whenever a chunk's minimap tile changes (stream-in /
  // edit). Lets the minimap skip its stationary heartbeat repaint when nothing new.
  getMapEpoch?: () => number,
  onTeleport: (worldX: number, worldZ: number) => void,
  onOpen?: () => void,
  onClose?: () => void,
};

type WantTile = { key: string, originX: number, originZ: number, tileWorld: number, d: number };

export class WorldMap {
  private opts: WorldMapOptions;
  private workers: Worker[] = [];
  private nextWorker = 0;   // round-robin index for spreading tile requests

  // fullscreen-map tile cache
  private cache = new Map<string, HTMLCanvasElement>();
  private requested = new Set<string>();
  private outstanding = 0;
  private want: WantTile[] = [];
  private sig = '0';        // world signature — IDB key prefix + stale-result guard
  private chunkW = 16;      // chunk width in blocks (set in configure)

  // Minimap recomposite gate: the composite is pixel-identical until the integer
  // screen origin shifts (player moved ≥1px), so we cache the last origin and skip
  // redrawing the ~13×13 tile grid every frame while standing still / moving sub-
  // pixel. A low heartbeat still recomposites a few times/sec so freshly-streamed
  // tiles fill in even when stationary.
  private miniOx = NaN;
  private miniOz = NaN;
  private miniTick = 0;
  private lastMiniEpoch = -1;   // map-tile epoch at the last composite (M3 dirty gate)

  // minimap
  private miniWrap: HTMLElement;
  private mini: HTMLCanvasElement;
  private miniMarker: HTMLElement;

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

    this.miniWrap = document.createElement('div');
    this.miniWrap.className = 'minimap';
    this.mini = document.createElement('canvas');
    this.mini.width = this.mini.height = 192;   // 192 blocks across at 1 block/px
    this.miniMarker = document.createElement('div');
    this.miniMarker.className = 'minimap__marker';
    this.miniWrap.append(this.mini, this.miniMarker);
    // Click the minimap to open the fullscreen world map.
    this.miniWrap.title = 'Open map (M)';
    this.miniWrap.addEventListener('click', () => this.openMap());
    document.body.append(this.miniWrap);

    this.overlay = document.createElement('div');
    this.overlay.className = 'worldmap';
    this.big = document.createElement('canvas');
    this.big.className = 'worldmap__canvas';
    const hint = document.createElement('div');
    hint.className = 'worldmap__hint';
    hint.textContent = 'Drag to pan · scroll to zoom · click to teleport · Esc/M to close';
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
      for (let i = 0; i < MAP_WORKERS; i++) {
        const w = new Worker(new URL('./mapWorker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<MapTileResponse>) => this.onTile(e.data);
        w.onerror = () => { /* keep the rest of the pool alive */ };
        this.workers.push(w);
      }
    } catch {
      this.workers = [];
    }
  }

  // (Re)point the map workers at the current world; clears the in-memory cache and
  // sets the world signature (IDB key prefix), so a regenerated/loaded world never
  // shows another world's persisted tiles.
  configure(params: ChunkParams, size: ChunkSize, sea: number) {
    this.cache.clear();
    this.requested.clear();
    this.outstanding = 0;
    this.chunkW = size.width;
    const t = params.terrain;
    this.sig = `${params.seed}_${t.scale}_${t.magnitude}_${t.offset}_${t.waterOffset}`;
    const msg: MapWorkerRequest = { type: 'config', params, size, sea };
    for (const w of this.workers) w.postMessage(msg);   // every worker needs the world config
  }

  // Worker finished a tile → adopt it and persist to IDB for next time.
  private onTile(res: MapTileResponse) {
    this.adoptTile(res.key, res.buffer, res.tilePx, true);
  }

  private adoptTile(key: string, buffer: ArrayBuffer, tilePx: number, persist: boolean) {
    this.outstanding = Math.max(0, this.outstanding - 1);
    this.requested.delete(key);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = tilePx;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;   // context-limit / OOM — slot already freed above, tile re-requests
    try {
      // A truncated/wrong-length persisted tile would make ImageData throw
      // IndexSizeError in the per-frame map update — validate + isolate it.
      if (buffer.byteLength !== tilePx * tilePx * 4) throw new Error('bad tile length ' + buffer.byteLength);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), tilePx, tilePx), 0, 0);
    } catch (e) {
      console.warn('map tile decode failed, dropping', key, e);
      return;   // don't cache/persist a broken tile (slot already freed → re-requested)
    }
    this.cache.set(key, canvas);
    if (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest && oldest !== key) this.cache.delete(oldest);
    }
    if (persist) idbPutTile(this.sig + '|' + key, buffer);
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
    // Gentle, proportional zoom (exp of scroll delta).
    this.big.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.wpp = clamp(this.wpp * Math.exp(e.deltaY * 0.0012), 1, 64);
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
    if (this.open) return;
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
    if (!this.open) return;
    this.overlay.classList.remove('worldmap--open');
    this.open = false;
    this.opts.onClose?.();
  }

  // ---- minimap: blit loaded chunk tiles directly (fast, in-sync) ------------
  private compositeMini(px: number, pz: number) {
    const ctx = this.mini.getContext('2d'); if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0b0f17';
    ctx.fillRect(0, 0, this.mini.width, this.mini.height);

    const W = this.chunkW;
    const half = this.mini.width / 2;
    // Integer screen origin so adjacent tiles abut perfectly (no seams/gaps).
    const ox = Math.round(half - px), oz = Math.round(half - pz);
    const cx0 = Math.floor((px - half) / W), cx1 = Math.floor((px + half) / W);
    const cz0 = Math.floor((pz - half) / W), cz1 = Math.floor((pz + half) / W);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const tile = this.opts.getChunkTile(cx, cz);
        if (tile) ctx.drawImage(tile, ox + cx * W, oz + cz * W, W, W);
      }
    }
  }

  // ---- fullscreen map: composite cached tiles; queue missing ones -----------
  private composite(canvas: HTMLCanvasElement, cx: number, cz: number, wpp: number) {
    const ctx = canvas.getContext('2d'); if (!ctx) return;
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
          // Touch on use (LRU) so a visible tile is never the eviction victim.
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

  // Drain the want-list, nearest first, gated by outstanding. Each tile is first
  // looked up in the persistent IDB cache; only a miss hits the worker pool.
  private pumpRequests() {
    if (this.want.length === 0) return;
    this.want.sort((a, b) => a.d - b.d);
    for (const t of this.want) {
      if (this.outstanding >= MAX_TILE_OUTSTANDING) break;
      if (this.requested.has(t.key) || this.cache.has(t.key)) continue;
      this.requested.add(t.key);
      this.outstanding++;
      this.resolveTile(t);
    }
    this.want.length = 0;
  }

  private async resolveTile(t: WantTile) {
    const sigAtRequest = this.sig;
    let buf: ArrayBuffer | null = null;
    try { buf = await idbGetTile(this.sig + '|' + t.key); } catch { buf = null; }
    // World may have regenerated while we awaited IDB — drop the stale result.
    if (this.sig !== sigAtRequest) {
      this.outstanding = Math.max(0, this.outstanding - 1);
      this.requested.delete(t.key);
      return;
    }
    if (buf) { this.adoptTile(t.key, buf, TILE_PX, false); return; }
    if (this.workers.length === 0) {
      this.outstanding = Math.max(0, this.outstanding - 1);
      this.requested.delete(t.key);
      return;
    }
    const msg: MapWorkerRequest = {
      type: 'tile', key: t.key,
      originX: t.originX, originZ: t.originZ,
      tileWorld: t.tileWorld, tilePx: TILE_PX,
    };
    this.workers[this.nextWorker++ % this.workers.length].postMessage(msg);   // reply lands in onTile
  }

  // Called every frame.
  update() {
    const p = this.opts.getPlayer();
    this.miniMarker.style.transform = `translate(-50%, -50%) rotate(${p.yaw}rad)`;
    // Only recomposite when the result would actually differ: the integer screen
    // origin (same maths as compositeMini) MOVED, or the heartbeat fired AND a tile
    // actually changed since the last paint (epoch). So a stationary player over
    // fully-loaded terrain costs ZERO composites (was a full ~169-tile repaint 5×/s).
    // The marker rotation above stays per-frame so the compass still turns smoothly.
    const half = this.mini.width / 2;
    const ox = Math.round(half - p.x), oz = Math.round(half - p.z);
    const epoch = this.opts.getMapEpoch ? this.opts.getMapEpoch() : 0;
    const moved = ox !== this.miniOx || oz !== this.miniOz;
    const heartbeat = (this.miniTick++ % 12) === 0 && epoch !== this.lastMiniEpoch;
    if (moved || heartbeat) {
      this.miniOx = ox; this.miniOz = oz; this.lastMiniEpoch = epoch;
      this.compositeMini(p.x, p.z);
    }

    if (this.open) {
      this.want.length = 0;
      this.composite(this.big, this.centerX, this.centerZ, this.wpp);
      this.overlayLoadedChunks(p.x, p.z);   // instant + in-sync over the (slower) worker tiles
      this.drawPlayerOnMap(p.x, p.z);
      this.pumpRequests();
    }
  }

  // Overlay the game's already-generated chunk tiles onto the fullscreen map.
  // The area around the player is loaded, so its tiles draw instantly and exactly
  // match the world (no worker round-trip / regeneration) — the map opens crisp at
  // the centre while distant/panned tiles stream in behind. Only when zoomed in
  // enough that a chunk is a couple of pixels, and bounded to the loaded radius.
  private overlayLoadedChunks(px: number, pz: number) {
    if (this.wpp > 8) return;
    const ctx = this.big.getContext('2d'); if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    const W = this.chunkW, wpp = this.wpp, ss = W / wpp;
    const leftW = this.centerX - this.big.width / 2 * wpp;
    const topW = this.centerZ - this.big.height / 2 * wpp;
    const pcx = Math.floor(px / W), pcz = Math.floor(pz / W), RAD = 20;   // > max draw distance
    const cx0 = Math.max(Math.floor(leftW / W), pcx - RAD);
    const cx1 = Math.min(Math.floor((leftW + this.big.width * wpp) / W), pcx + RAD);
    const cz0 = Math.max(Math.floor(topW / W), pcz - RAD);
    const cz1 = Math.min(Math.floor((topW + this.big.height * wpp) / W), pcz + RAD);
    for (let chz = cz0; chz <= cz1; chz++) {
      for (let chx = cx0; chx <= cx1; chx++) {
        const tile = this.opts.getChunkTile(chx, chz);
        if (tile) ctx.drawImage(tile, (chx * W - leftW) / wpp, (chz * W - topW) / wpp, ss, ss);
      }
    }
  }

  private drawPlayerOnMap(px: number, pz: number) {
    const ctx = this.big.getContext('2d'); if (!ctx) return;
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
