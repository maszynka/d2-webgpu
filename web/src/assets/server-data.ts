// SPDX-License-Identifier: GPL-3.0-or-later
// Private deploy (worker/data.ts): the game archives come from the server instead of a picked folder. They are copied
// once into this browser's origin-private storage (OPFS, folder "d2-data") and opened from there on every visit; a
// file is downloaded again only when the server's copy changes. The public site has no <meta name="d2-data">.

import { MPQ_ORDER } from './mpq';

export const DATA_META = 'd2-data';
export const DATA_PATH = '/data/';
/** only the archives the game knows (picker.ts collectMpqFiles takes the same names) */
export const MPQ_KEY = new RegExp(`^(${MPQ_ORDER.join('|')})\\.mpq$`, 'i');
const DIR = 'd2-data';
const ETAGS = 'etags.json';

export interface DataEntry {
  name: string;
  size: number;
  etag: string;
}

export interface SyncProgress {
  /** bytes downloaded so far / to download in this sync */
  done: number;
  total: number;
  file: string;
  /** the server could not be reached; the copy from an earlier visit is used */
  offline?: boolean;
}

/** the data URL the private deploy put in the page, or null (public site) */
export function serverDataUrl(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${DATA_META}"]`)?.content || null;
}

/** what to download: entries whose local copy is missing, has another size, or was saved from another server version */
export function toDownload(remote: DataEntry[], localSizes: ReadonlyMap<string, number>, savedEtags: Readonly<Record<string, string>>): DataEntry[] {
  return remote.filter((e) => localSizes.get(e.name) !== e.size || savedEtags[e.name] !== e.etag);
}

async function readEtags(dir: FileSystemDirectoryHandle): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await (await (await dir.getFileHandle(ETAGS)).getFile()).text());
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function writeEtags(dir: FileSystemDirectoryHandle, etags: Record<string, string>): Promise<void> {
  const w = await (await dir.getFileHandle(ETAGS, { create: true })).createWritable();
  await w.write(JSON.stringify(etags));
  await w.close();
}

async function localSizes(dir: FileSystemDirectoryHandle): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for await (const [name, h] of dir.entries()) if (h.kind === 'file' && MPQ_KEY.test(name)) out.set(name, (await (h as FileSystemFileHandle).getFile()).size);
  return out;
}

const mb = (n: number): string => (n / 1048576).toFixed(0);

/**
 * Brings the OPFS copy in line with the server's manifest and returns the folder (a directory handle like a picked
 * one). Archives the server no longer has are deleted. A download is written to a swap file by the browser and
 * replaces the old copy only when complete, so an interrupted visit leaves nothing half-written.
 */
export async function syncServerData(base: string, onProgress: (p: SyncProgress) => void, fetchFn: typeof fetch = fetch): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) throw new Error('This browser has no private file storage (OPFS); open the game folder instead.');
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
  const sync = async (): Promise<FileSystemDirectoryHandle> => {
    let remote: DataEntry[];
    try {
      const res = await fetchFn(`${base}manifest.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`The server's file list failed (${res.status}).`);
      remote = ((await res.json()) as { files?: DataEntry[] }).files ?? [];
    } catch (e) {
      // offline or a server hiccup: a copy saved on an earlier visit still plays
      if ((await localSizes(dir)).size > 0) {
        onProgress({ done: 0, total: 0, file: '', offline: true });
        return dir;
      }
      throw e;
    }
    if (remote.length === 0) throw new Error('The server has no game files.');
    return download(dir, base, remote, onProgress, fetchFn);
  };
  // one sync at a time across tabs: another tab replacing a file under a running game breaks its reads
  return navigator.locks ? navigator.locks.request('d2-data-sync', sync) : sync();
}

async function download(dir: FileSystemDirectoryHandle, base: string, remote: DataEntry[], onProgress: (p: SyncProgress) => void, fetchFn: typeof fetch): Promise<FileSystemDirectoryHandle> {
  const etags = await readEtags(dir);
  const local = await localSizes(dir);
  const gone = [...local.keys()].filter((name) => !remote.some((e) => e.name === name));
  for (const name of gone) {
    await dir.removeEntry(name);
    delete etags[name];
  }
  if (gone.length) await writeEtags(dir, etags);
  const todo = toDownload(remote, local, etags);
  const total = todo.reduce((a, e) => a + e.size, 0);
  if (total > 0) {
    if (typeof FileSystemFileHandle !== 'undefined' && !('createWritable' in FileSystemFileHandle.prototype)) throw new Error('This browser cannot write to its private file storage; open the game folder instead.');
    void navigator.storage.persist?.().catch(() => false); // ask the browser not to evict ~1 GB under storage pressure
    const est = await navigator.storage.estimate?.().catch(() => null);
    const free = est?.quota !== undefined && est.usage !== undefined ? est.quota - est.usage : Infinity;
    if (free < total) throw new Error(`Not enough browser storage for the game files: ${mb(total)} MB needed, ${mb(free)} MB free.`);
  }
  let done = 0;
  for (const e of todo) {
    onProgress({ done, total, file: e.name });
    const r = await fetchFn(`${base}${encodeURIComponent(e.name)}`, { cache: 'no-store' });
    if (!r.ok || !r.body) throw new Error(`Downloading ${e.name} failed (${r.status}).`);
    const fh = await dir.getFileHandle(e.name, { create: true });
    const w = await fh.createWritable();
    const reader = r.body.getReader();
    try {
      let last = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        await w.write(value);
        done += value.byteLength;
        if (done - last > 4 << 20) {
          last = done;
          onProgress({ done, total, file: e.name });
        }
      }
      await w.close();
    } catch (err) {
      await w.abort().catch(() => undefined);
      throw err;
    }
    const size = (await fh.getFile()).size;
    if (size !== e.size) throw new Error(`${e.name}: got ${size} bytes, expected ${e.size}.`);
    etags[e.name] = r.headers.get('ETag') ?? e.etag; // what was actually downloaded, should the file change meanwhile
    await writeEtags(dir, etags);
  }
  onProgress({ done: total, total, file: '' });
  return dir;
}
