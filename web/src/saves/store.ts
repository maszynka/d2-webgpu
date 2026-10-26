// SPDX-License-Identifier: GPL-3.0-or-later
// The game's user dir as Emscripten's IDBFS keeps it in IndexedDB: database "/idb" (the mount point), object store
// "FILE_DATA", key = absolute path, value = { timestamp: Date, mode, contents?: Uint8Array } (directories have no
// contents). The game writes /idb/d2d/save/<name>.d2s, <name>.key and /idb/d2d/d2d.cfg (game.worker.ts).
// Writes are only safe while no game worker runs: its next sync would delete entries it does not have.

export const IDB_NAME = '/idb';
const STORE = 'FILE_DATA';
/** IDBFS DB_VERSION in Emscripten 6 (the upgrade handler creates the same store + index) */
const DB_VERSION = 21;
export const ROOT = '/idb';
export const SAVE_DIR = '/idb/d2d/save';
const DIR_MODE = 0o40777; // FS.mkdir default
const FILE_MODE = 0o100666; // FS.writeFile default

export interface StoredFile {
  path: string;
  data: Uint8Array;
  date: Date;
}

interface Entry {
  timestamp: Date;
  mode: number;
  contents?: Uint8Array;
}

const isDir = (mode: number): boolean => (mode & 0o170000) === 0o40000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.objectStoreNames.contains(STORE) ? req.transaction!.objectStore(STORE) : db.createObjectStore(STORE);
      if (!store.indexNames.contains('timestamp')) store.createIndex('timestamp', 'timestamp', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB is in use by another tab'));
  });
}

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

/** Every file under the user dir. */
export async function listFiles(): Promise<StoredFile[]> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const files: StoredFile[] = [];
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const key = String(c.key);
      const e = c.value as Entry;
      if (key.startsWith(`${ROOT}/`) && !isDir(e.mode) && e.contents) files.push({ path: key, data: new Uint8Array(e.contents), date: new Date(e.timestamp) });
      c.continue();
    };
    await done(tx);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  } finally {
    db.close();
  }
}

/** Write files (absolute paths under ROOT), creating missing parent directory entries; existing files are replaced. */
export async function writeFiles(files: readonly { path: string; data: Uint8Array }[]): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const now = new Date();
    const dirs = new Set<string>();
    for (const f of files) {
      if (!f.path.startsWith(`${ROOT}/`) || f.path.split('/').includes('..')) throw new Error(`refusing to write ${f.path}`);
      const parts = f.path.split('/');
      for (let i = 3; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); // /idb/d2d, /idb/d2d/save, ...
    }
    for (const d of dirs) {
      const req = store.get(d);
      req.onsuccess = () => {
        if (!req.result) store.put({ timestamp: now, mode: DIR_MODE } satisfies Entry, d);
      };
    }
    // a new timestamp makes IDBFS copy the file into the game's file system on the next start (reconcile)
    for (const f of files) store.put({ timestamp: now, mode: FILE_MODE, contents: f.data } satisfies Entry, f.path);
    await done(tx);
  } finally {
    db.close();
  }
}
