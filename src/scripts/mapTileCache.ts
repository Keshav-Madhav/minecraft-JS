// Tiny persistent tile cache (IndexedDB). Rendered fullscreen-map tiles are
// stored keyed by "<worldSig>|<level>,<tx>,<tz>" so revisited areas load
// instantly and survive page reloads — the "cache to persisted loaded tiles"
// the detailed map needs. Every op degrades gracefully (resolve null / no-op)
// when IndexedDB is unavailable (private mode, old browser, quota errors), so
// the map silently falls back to regenerating tiles via the worker pool.

const DB_NAME = 'mcjs-map';
const STORE = 'tiles';
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

export async function idbGetTile(key: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export function idbPutTile(key: string, buf: ArrayBuffer): void {
  // Fire-and-forget: a copy of `buf` is structured-cloned into IDB. Failures
  // (quota, closed db) are swallowed — persistence is best-effort.
  openDb().then((db) => {
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(buf, key); } catch { /* ignore */ }
  });
}
