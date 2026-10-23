// SPDX-License-Identifier: GPL-3.0-or-later
// Game folder access: File System Access API (handle persisted in IndexedDB, permission re-requested on load)
// with a <input webkitdirectory> fallback. Files never leave the browser.

import { MPQ_ORDER } from './mpq';

export interface FsFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}
export interface FsDirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FsFileHandle | FsDirHandle>;
  queryPermission?(desc: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(desc: { mode: 'read' }): Promise<PermissionState>;
}

type PickerWindow = { showDirectoryPicker?: (opts?: Record<string, unknown>) => Promise<FsDirHandle> };

export function supportsDirectoryPicker(win: object = globalThis): boolean {
  return typeof (win as PickerWindow).showDirectoryPicker === 'function';
}

export async function pickGameDirectory(win: object = globalThis): Promise<FsDirHandle> {
  const f = (win as PickerWindow).showDirectoryPicker;
  if (!f) throw new Error('showDirectoryPicker is not available');
  return f.call(win, { id: 'd2-game', mode: 'read' });
}

/**
 * Current read permission. With `request` (needs a user gesture) a "prompt" is turned into a permission dialog.
 * Handles without the permission API count as granted.
 */
export async function readPermission(h: FsDirHandle, request: boolean): Promise<PermissionState> {
  if (!h.queryPermission) return 'granted';
  const q = await h.queryPermission({ mode: 'read' });
  if (q === 'granted' || !request || !h.requestPermission) return q;
  return h.requestPermission({ mode: 'read' });
}

const MPQ_NAME = new RegExp(`^(${MPQ_ORDER.join('|')})\\.mpq$`, 'i');

/** Known MPQ files in the folder (and one level of subfolders, e.g. a "Data" dir). */
export async function collectMpqFiles(dir: FsDirHandle, maxDepth = 1): Promise<File[]> {
  const out: File[] = [];
  for await (const e of dir.values()) {
    if (e.kind === 'file') {
      if (MPQ_NAME.test(e.name)) out.push(await e.getFile());
    } else if (maxDepth > 0) {
      out.push(...(await collectMpqFiles(e, maxDepth - 1)));
    }
  }
  return out;
}

// --- persistence -----------------------------------------------------------

export interface HandleStore {
  get(): Promise<FsDirHandle | null>;
  set(h: FsDirHandle): Promise<void>;
  clear(): Promise<void>;
}

const DB = 'd2-webgpu';
const STORE = 'handles';
const KEY = 'game-dir';

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error ?? new Error('indexedDB open failed'));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(req.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('indexedDB transaction failed'));
      };
    };
  });
}

/** IndexedDB-backed store; every method degrades to a no-op/null when IndexedDB is unavailable. */
export const idbHandleStore: HandleStore = {
  async get() {
    try {
      return ((await idb('readonly', (s) => s.get(KEY))) as FsDirHandle | undefined) ?? null;
    } catch {
      return null;
    }
  },
  async set(h) {
    try {
      await idb('readwrite', (s) => s.put(h, KEY));
    } catch {
      /* private mode etc.: the folder just is not remembered */
    }
  },
  async clear() {
    try {
      await idb('readwrite', (s) => s.delete(KEY));
    } catch {
      /* ignore */
    }
  },
};

export type RestoreResult =
  | { state: 'none' }
  | { state: 'granted'; handle: FsDirHandle }
  /** a stored handle that needs a click to re-grant read access */
  | { state: 'needs-permission'; handle: FsDirHandle }
  | { state: 'denied'; handle: FsDirHandle };

/** On load: look up the stored handle and check (without prompting) whether it is still readable. */
export async function restoreHandle(store: HandleStore): Promise<RestoreResult> {
  const handle = await store.get();
  if (!handle) return { state: 'none' };
  try {
    const p = await readPermission(handle, false);
    if (p === 'granted') return { state: 'granted', handle };
    return { state: p === 'denied' ? 'denied' : 'needs-permission', handle };
  } catch {
    return { state: 'none' };
  }
}

/** From a user gesture: ask again for read access to a stored handle. */
export async function reGrant(handle: FsDirHandle): Promise<boolean> {
  try {
    return (await readPermission(handle, true)) === 'granted';
  } catch {
    return false;
  }
}
