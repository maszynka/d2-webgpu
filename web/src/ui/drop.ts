// SPDX-License-Identifier: GPL-3.0-or-later
// Files from a drag & drop of the game folder: a directory handle (File System Access API) when the browser gives one,
// else the webkit entry tree (one level deep), else the plain file list.
import { MPQ_ORDER } from '../assets/mpq';
import { collectMpqFiles, type FsDirHandle } from '../assets/picker';

const MPQ_NAME = new RegExp(`^(${MPQ_ORDER.join('|')})\\.mpq$`, 'i');

interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (e: Entry[]) => void, err: (e: unknown) => void): void };
}

async function walk(entry: Entry, depth: number): Promise<File[]> {
  if (entry.isFile) {
    if (!MPQ_NAME.test(entry.name) || !entry.file) return [];
    const f = await new Promise<File>((ok, err) => entry.file!(ok, err));
    return [f];
  }
  if (!entry.isDirectory || depth < 0 || !entry.createReader) return [];
  const reader = entry.createReader();
  const out: File[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
    if (batch.length === 0) break;
    for (const e of batch) out.push(...(await walk(e, depth - 1)));
  }
  return out;
}

export function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files');
}

/** Resolve a drop to candidate game files and a label. Never throws: an unreadable drop gives no files. */
export async function filesFromDrop(dt: DataTransfer): Promise<{ files: File[]; label: string; handle?: FsDirHandle }> {
  const item = dt.items?.[0] as (DataTransferItem & { getAsFileSystemHandle?: () => Promise<unknown> }) | undefined;
  try {
    const h = (await item?.getAsFileSystemHandle?.()) as FsDirHandle | { kind: 'file' } | null | undefined;
    if (h && h.kind === 'directory') return { files: await collectMpqFiles(h), label: h.name, handle: h };
  } catch {
    /* fall through */
  }
  try {
    const entries = Array.from(dt.items ?? [])
      .map((i) => i.webkitGetAsEntry?.() as unknown as Entry | null | undefined)
      .filter((e): e is Entry => !!e);
    if (entries.length > 0) {
      const files = (await Promise.all(entries.map((e) => walk(e, 1)))).flat();
      return { files, label: entries.length === 1 ? entries[0]!.name : 'dropped files' };
    }
  } catch {
    /* fall through */
  }
  return { files: Array.from(dt.files ?? []), label: 'dropped files' };
}
