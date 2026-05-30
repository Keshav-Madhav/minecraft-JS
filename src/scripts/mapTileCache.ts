// Tiny persistent tile cache (IndexedDB). Rendered fullscreen-map tiles are
// stored keyed by "<worldSig>|<level>,<tx>,<tz>" so revisited areas load
// instantly and survive page reloads — the "cache to persisted loaded tiles"
// the detailed map needs. Every op degrades gracefully (resolve null / no-op)
// when IndexedDB is unavailable (private mode, old browser, quota errors), so
// the map silently falls back to regenerating tiles via the worker pool.

const DB_NAME = 'mcjs-map';
const STORE = 'tiles';
let dbPromise: Promise<IDBDatabase | null> | null = null;

// Wrap any IDB promise so it can NEVER hang the caller: if the underlying request
// neither succeeds nor errors within the timeout (a blocked/locked transaction —
// observed in rapid headless runs), resolve `fallback` so the map falls through to
// the worker instead of deadlocking (resolveTile awaits this before requesting a
// tile; a hang there would saturate `outstanding` and freeze the whole map).
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    p.then((v) => { if (!done) { done = true; clearTimeout(to); resolve(v); } },
           () => { if (!done) { done = true; clearTimeout(to); resolve(fallback); } });
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = withTimeout(new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  }), 3000, null);
  return dbPromise;
}

export async function idbGetTile(key: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  if (!db) return null;
  // Short timeout: idbGet sits on the tile critical path (resolveTile awaits it
  // before falling through to the worker). A healthy DB returns in <5ms; if it's
  // slow/locked, we bail to the worker after 300ms rather than stalling the map.
  return withTimeout(new Promise<ArrayBuffer | null>((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  }), 300, null);
}

export function idbPutTile(key: string, buf: ArrayBuffer): void {
  // Fire-and-forget: a copy of `buf` is structured-cloned into IDB. Failures
  // (quota, closed db) are swallowed — persistence is best-effort.
  openDb().then((db) => {
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(buf, key); } catch { /* ignore */ }
  });
}
