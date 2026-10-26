// SPDX-License-Identifier: GPL-3.0-or-later
// Known Diablo II archives, their override order and the path presets of the viewer.

/** Archive base names (without .mpq) in mount order: later ones override earlier ones, patch last. */
export const MPQ_ORDER = [
  'd2data',
  'd2exp',
  'd2char',
  'd2sfx',
  'd2music',
  'd2video',
  'd2speech',
  'd2xmusic',
  'd2xtalk',
  'd2xvideo',
  'patch_d2',
] as const;

/**
 * Archives the game cannot start without (upstream opens d2data unconditionally; d2exp, d2char and patch_d2 carry the
 * LoD tables, the character animations and the 1.14d data). Every other archive is optional: without d2sfx / d2speech /
 * d2music / d2video (and the x-variants) the game runs without that sound / video.
 */
export const REQUIRED_MPQS = ['d2data.mpq', 'd2exp.mpq', 'd2char.mpq', 'patch_d2.mpq'] as const;

/** Missing archives (from MpqSelection.missing) that block Play, and the optional ones that only cost sound / video. */
export function splitMissing(missing: readonly string[]): { required: string[]; optional: string[] } {
  const req = REQUIRED_MPQS as readonly string[];
  return { required: missing.filter((m) => req.includes(m)), optional: missing.filter((m) => !req.includes(m)) };
}

export interface NamedFile {
  name: string;
  webkitRelativePath?: string;
}

export interface MpqSelection<T extends NamedFile> {
  /** the recognised archives (one per known name) */
  files: T[];
  /** their File.name values in override order (index 0 = lowest priority) */
  order: string[];
  /** known archives not found */
  missing: string[];
}

const depth = (f: NamedFile): number => (f.webkitRelativePath ? f.webkitRelativePath.split('/').length : 1);

/** Pick the known MPQs (case-insensitive) from a folder listing; the shallowest copy wins a duplicate. */
export function selectMpqs<T extends NamedFile>(all: Iterable<T>): MpqSelection<T> {
  const byBase = new Map<string, T>();
  for (const f of all) {
    const m = /^(.*)\.mpq$/i.exec(f.name);
    const base = m?.[1]?.toLowerCase();
    if (!base || !(MPQ_ORDER as readonly string[]).includes(base)) continue;
    const prev = byBase.get(base);
    if (!prev || depth(f) < depth(prev)) byBase.set(base, f);
  }
  const files: T[] = [];
  const missing: string[] = [];
  for (const base of MPQ_ORDER) {
    const f = byBase.get(base);
    if (f) files.push(f);
    else missing.push(`${base}.mpq`);
  }
  return { files, order: files.map((f) => f.name), missing };
}

export const ACT1_PALETTE = 'data\\global\\palette\\ACT1\\pal.dat';
export const DEFAULT_MAP = 'data\\global\\tiles\\ACT1\\Town\\townN1.ds1';

export const KNOWN_PATHS = [
  'data\\global\\ui\\FrontEnd\\TitleScreen.dc6',
  'data\\global\\ui\\FrontEnd\\gamelogo.dc6',
  'data\\global\\palette\\ACT1\\pal.dat',
  'data\\global\\tiles\\ACT1\\TOWN\\floor.dt1',
  DEFAULT_MAP,
];

export const KNOWN_PALETTES = [
  ACT1_PALETTE,
  'data\\global\\palette\\ACT2\\pal.dat',
  'data\\global\\palette\\ACT3\\pal.dat',
  'data\\global\\palette\\ACT4\\pal.dat',
  'data\\global\\palette\\ACT5\\pal.dat',
  'data\\global\\palette\\Loading\\pal.dat',
  'data\\global\\palette\\Static\\pal.dat',
  'data\\global\\palette\\Trademark\\pal.dat',
];

/** One identity colormap row (index -> index) per requested row. */
export function identityColormap(rows = 1): Uint8Array {
  const out = new Uint8Array(256 * rows);
  for (let r = 0; r < rows; r++) for (let i = 0; i < 256; i++) out[r * 256 + i] = i;
  return out;
}

export function kindOfPath(path: string): 'dc6' | 'ds1' | 'dt1' | 'pal' | 'unknown' {
  const m = /\.([a-z0-9]+)$/i.exec(path.trim());
  switch (m?.[1]?.toLowerCase()) {
    case 'dc6':
      return 'dc6';
    case 'ds1':
      return 'ds1';
    case 'dt1':
      return 'dt1';
    case 'dat':
      return 'pal';
    default:
      return 'unknown';
  }
}
