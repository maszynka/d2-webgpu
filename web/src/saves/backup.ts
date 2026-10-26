// SPDX-License-Identifier: GPL-3.0-or-later
// Save backup and import: which files a backup holds and where imported files go. Pure (no IndexedDB, no DOM);
// main.ts reads/writes them with store.ts.
//  - Backup: a ZIP of the whole user dir, paths relative to /idb (d2d/save/<name>.d2s, d2d/save/<name>.key, d2d/d2d.cfg).
//  - Import: our backups (entries under d2d/) restore in place; loose .d2s (also from the original game, 1.09-1.14d) and
//    their .key / .ma0-.ma3 companions go to the save dir. A .d2s is named after the character inside it, since the game
//    opens <name>.d2s.

import { ROOT, SAVE_DIR, type StoredFile } from './store';
import { writeZip, type ZipEntry } from './zip';

/** .d2s versions upstream's reader takes (1.09 = 92, 1.10-1.14d = 96) */
export const D2S_VERSIONS = [92, 93, 94, 95, 96] as const;
const D2S_MAGIC = 0xaa55aa55;
const COMPANION = /\.(key|ma[0-3])$/i;
/** a character file is a few KB (1.14d tops out well under 16 KB); companions are smaller */
export const MAX_SAVE_FILE = 1 << 20;
/** a backup ZIP, or one picked file */
export const MAX_IMPORT_FILE = 64 << 20;

/** ZIP entries worth reading for an import (others are skipped unread). */
export function isSaveEntry(name: string): boolean {
  const n = name.replace(/\\/g, '/');
  return /\.(d2s|key|ma[0-3])$/i.test(n) || /^d2d\/d2d\.cfg$/i.test(n);
}

export interface D2sInfo {
  name: string;
  version: number;
}

/** The character name and version from a .d2s header, or an error message. */
export function readD2s(data: Uint8Array): D2sInfo | string {
  if (data.length < 36) return 'too short for a Diablo II character file';
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint32(0, true) !== D2S_MAGIC) return 'not a Diablo II character file';
  const version = v.getUint32(4, true);
  if (!(D2S_VERSIONS as readonly number[]).includes(version)) return `character file version ${version} is not supported (needs Diablo II 1.09 or newer)`;
  // 1.09+ headers carry the file size: a truncated or padded copy would replace a good character with one the game rejects
  if (v.getUint32(8, true) !== data.length) return 'character file is damaged (size does not match its header)';
  const raw = data.subarray(20, 36);
  const end = raw.indexOf(0);
  const name = new TextDecoder('latin1').decode(end < 0 ? raw : raw.subarray(0, end));
  if (!/^[A-Za-z][A-Za-z_-]{1,14}$/.test(name)) return 'character name in the file is not valid';
  return { name, version };
}

export interface ImportPlan {
  writes: { path: string; data: Uint8Array }[];
  /** characters (from .d2s files) in the plan */
  characters: string[];
  skipped: { name: string; reason: string }[];
}

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** Decide where each imported file goes. `name` may be a ZIP path; later files win over earlier ones with the same target. */
export function planImport(files: readonly { name: string; data: Uint8Array }[]): ImportPlan {
  const byPath = new Map<string, Uint8Array>();
  const characters = new Set<string>();
  const skipped: ImportPlan['skipped'] = [];
  // a renamed .d2s ("copy of hero.d2s") takes its companions ("copy of hero.key") along to the character's name
  const renamed = new Map<string, string>();
  const stem = (p: string): string => p.slice(0, p.lastIndexOf('.')).toLowerCase();
  const items = files.map((f) => ({ ...f, name: f.name.replace(/\\/g, '/') }));
  for (const f of items) {
    if (!f.name.toLowerCase().endsWith('.d2s')) continue;
    const info = readD2s(f.data);
    if (typeof info !== 'string') renamed.set(stem(f.name), info.name);
  }
  for (const f of items) {
    const name = f.name;
    if (name.split('/').some((s) => s === '..')) {
      skipped.push({ name, reason: 'unsafe path' });
      continue;
    }
    const lower = name.toLowerCase();
    const leaf = base(name);
    if (leaf.startsWith('.') || leaf === '') {
      skipped.push({ name, reason: 'not a save file' });
      continue;
    }
    if (f.data.length > MAX_SAVE_FILE) {
      skipped.push({ name, reason: 'too large for a save file' });
      continue;
    }
    if (lower.endsWith('.d2s')) {
      const info = readD2s(f.data);
      if (typeof info === 'string') {
        skipped.push({ name, reason: info });
        continue;
      }
      characters.add(info.name);
      byPath.set(`${SAVE_DIR}/${info.name}.d2s`, f.data);
    } else if (COMPANION.test(lower)) {
      const owner = renamed.get(stem(name));
      byPath.set(`${SAVE_DIR}/${owner ? owner + leaf.slice(leaf.lastIndexOf('.')) : leaf}`, f.data);
    } else if (/^d2d\/d2d\.cfg$/i.test(name)) {
      byPath.set(`${ROOT}/d2d/d2d.cfg`, f.data); // the game's settings, only from the root of one of our backups
    } else {
      skipped.push({ name, reason: 'not a save file' });
    }
  }
  return { writes: [...byPath].map(([path, data]) => ({ path, data })), characters: [...characters].sort(), skipped };
}

/** Targets of a plan that already exist (to confirm before overwriting). */
export function overwrites(plan: ImportPlan, existing: readonly StoredFile[]): string[] {
  const have = new Set(existing.map((f) => f.path));
  return plan.writes.filter((w) => have.has(w.path)).map((w) => w.path.slice(ROOT.length + 1));
}

/** The backup archive of the user dir. */
export function backupZip(files: readonly StoredFile[]): Uint8Array {
  const entries: ZipEntry[] = files.map((f) => ({ name: f.path.slice(ROOT.length + 1), data: f.data, date: f.date }));
  return writeZip(entries);
}

export function backupName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `d2-webgpu-saves-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.zip`;
}

/** Character names in a list of stored files. */
export function characterNames(files: readonly StoredFile[]): string[] {
  return files.filter((f) => f.path.startsWith(`${SAVE_DIR}/`) && f.path.endsWith('.d2s')).map((f) => base(f.path).slice(0, -4));
}
