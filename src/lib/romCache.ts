// src/lib/romCache.ts
//
// Caches a user's own ROM files in their OWN browser (IndexedDB) so they
// don't have to re-pick the same file from disk every time they want to
// patch a different hack that shares the same base ROM. This is purely
// local storage — nothing here ever sends a ROM's bytes anywhere, which
// is the entire point: it's the same "HackHash never touches a ROM"
// principle every other patch-related piece of this project has been
// built around (sections 2as onward), just applied to the browser's own
// storage instead of HackHash's server.
//
// Keyed by SHA-1 (lowercased) — the same canonical identifier BaseRom
// already uses. One cached ROM per distinct piece of content; dropping
// the same ROM again for a different hack that needs the same base just
// overwrites the same entry with an identical copy, harmlessly.
//
// Every function here is designed to fail SOFT: caching is a convenience
// on top of the actual patching flow, never a requirement for it. A full
// IndexedDB (quota exceeded), a browser in private/incognito mode that
// restricts it, or any other storage failure should degrade to "just ask
// the person to pick the file again this time" — never break the flow
// that got them here. Callers should treat every function's return value
// as "best effort" and keep working if it comes back empty/false.

const DB_NAME = 'hackhash-rom-cache';
const DB_VERSION = 1;
const STORE_NAME = 'roms';

export interface CachedRomMeta {
  sha1: string;
  filename: string;
  size: number;
  crc32: string;
  md5: string;
  cachedAt: number;
}

interface CachedRomRecord extends CachedRomMeta {
  blob: Blob;
}

function isAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isAvailable()) {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sha1' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Looks up a cached ROM by its SHA-1. Returns null if it isn't cached, or
 * if the cache genuinely can't be used right now (private browsing, quota
 * issues, an older browser without IndexedDB) — indistinguishable to the
 * caller on purpose, since either way the answer is the same: fall back
 * to asking the person to pick a file.
 */
export async function getCachedRom(sha1: string): Promise<{ meta: CachedRomMeta; bytes: Uint8Array } | null> {
  try {
    const db = await openDb();
    const record = await new Promise<CachedRomRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(sha1.toLowerCase());
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!record) return null;
    const bytes = new Uint8Array(await record.blob.arrayBuffer());
    const { blob: _blob, ...meta } = record;
    return { meta, bytes };
  } catch {
    return null;
  }
}

/**
 * Stores a ROM in the cache. Stored as a Blob, not a Uint8Array — browsers
 * generally handle large Blobs in IndexedDB more efficiently than large
 * typed arrays (backed by disk rather than held in memory the whole time
 * a cache entry just sits there unused), which matters here since ROMs
 * can run from a few hundred KB up to several hundred MB. Never throws —
 * a caching failure is logged and swallowed, not surfaced to the caller,
 * since it should never block the patching flow that's actually in
 * progress.
 */
export async function cacheRom(meta: Omit<CachedRomMeta, 'cachedAt'>, bytes: Uint8Array): Promise<void> {
  try {
    const db = await openDb();
    const record: CachedRomRecord = {
      ...meta,
      sha1: meta.sha1.toLowerCase(),
      cachedAt: Date.now(),
      blob: new Blob([bytes as BlobPart]),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[romCache] failed to cache this ROM — continuing without caching it:', err);
  }
}

export async function deleteCachedRom(sha1: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(sha1.toLowerCase());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Nothing meaningful for a caller to do differently either way —
    // failing to clear a cache entry isn't something worth surfacing.
  }
}
