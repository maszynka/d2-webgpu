// SPDX-License-Identifier: GPL-3.0-or-later
// Readers for the d2core binary result blocks. Layouts: docs/abi.md (ABI v1).
//
// Block (little-endian): u32 magic, u32 version (1), u32 total_bytes, u32 count,
// u32 offsets[count] (from block start); entries are 4-aligned and zero padded,
// so readers always use explicit lengths stored in the entries, never "until the next entry".

export const ABI_VERSION = 1;

/** Result magics: ASCII tags read as little-endian u32. */
export const MAGIC = {
  raw: 0x57523244, // "D2RW"
  palette: 0x4c503244, // "D2PL"
  colormap: 0x4d433244, // "D2CM"
  dc6: 0x36433244, // "D2C6"
  dt1: 0x31543244, // "D2T1"
  ds1: 0x31533244, // "D2S1"
} as const;
export type Magic = (typeof MAGIC)[keyof typeof MAGIC];

export interface Palette {
  /** 256 entries, RGBA bytes (index 0 has alpha 0, the rest 255) */
  rgba: Uint8Array;
}
export interface Colormap {
  rows: number;
  /** rows*256 palette indices, row-major */
  data: Uint8Array;
}
export interface DecodedFrame {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  /** bit 0: the file stored the frame top-down (informational) */
  flags: number;
  /** palette indices, top row first, 0 = transparent */
  pixels: Uint8Array;
}
export interface DecodedDc6 {
  directions: number;
  framesPerDirection: number;
  /** directions * framesPerDirection, index = dir * framesPerDirection + i */
  frames: DecodedFrame[];
}
export interface DecodedTile {
  direction: number;
  roofHeight: number;
  materialFlags: number;
  /** negative for floors, as in the file */
  height: number;
  width: number;
  /** the file's `type`: 0 floor, 1.. walls, 13 shadow, 15 roof ... */
  orientation: number;
  /** style = main_index */
  mainIndex: number;
  /** sequence = sub_index */
  subIndex: number;
  rarity: number;
  yShift: number;
  pixelHeight: number;
  /** 25 subtile flags, 5x5 row-major */
  subtileFlags: Uint8Array;
  /** width x pixelHeight palette indices, top row first, stride = width; 0 = transparent */
  pixels: Uint8Array;
}
export interface DecodedDt1 {
  tiles: DecodedTile[];
}

export interface Ds1Object {
  type: number;
  id: number;
  x: number;
  y: number;
  flags: number;
  path: { x: number; y: number; action: number }[];
}
export interface Ds1Group {
  x: number;
  y: number;
  width: number;
  height: number;
  variants: number;
}
export type Ds1LayerKind = 'wall' | 'floor' | 'shadow';
export interface Ds1Layer {
  kind: Ds1LayerKind;
  index: number;
  /** width*height cells, row-major, top-left origin; see Ds1Cells accessors */
  cells: Ds1Cells;
}
export interface DecodedDs1 {
  version: number;
  /** in tiles */
  width: number;
  height: number;
  /** 1-based */
  act: number;
  subType: number;
  /** DT1 paths as stored in the DS1 */
  files: string[];
  objects: Ds1Object[];
  groups: Ds1Group[];
  walls: Ds1Layer[];
  floors: Ds1Layer[];
  shadows: Ds1Layer[];
}

/** 12-byte cells of one layer, accessed without materialising objects. */
export class Ds1Cells {
  constructor(
    private readonly bytes: Uint8Array,
    readonly count: number,
  ) {}
  prop1(i: number): number {
    return this.bytes[i * 12] ?? 0;
  }
  sequence(i: number): number {
    return this.bytes[i * 12 + 1] ?? 0;
  }
  style(i: number): number {
    return this.bytes[i * 12 + 2] ?? 0;
  }
  hidden(i: number): boolean {
    return ((this.bytes[i * 12 + 3] ?? 0) & 1) !== 0;
  }
  /** orientation of a wall cell (0 in other layers) */
  wallType(i: number): number {
    return this.bytes[i * 12 + 6] ?? 0;
  }
  wallZero(i: number): number {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + i * 12 + 8, 4).getUint32(0, true);
  }
}

export class AbiError extends Error {
  constructor(message: string) {
    super(`ABI: ${message}`);
    this.name = 'AbiError';
  }
}

export interface AbiResult {
  magic: number;
  count: number;
  /** from entry i's start to the end of the block (entries carry their own lengths) */
  entry(i: number): DataView;
  entryBytes(i: number): Uint8Array;
}

/** Parse and validate a result block (a self-contained copy). Optionally check the magic. */
export function readResult(buf: ArrayBuffer | Uint8Array, expectMagic?: number): AbiResult {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 16) throw new AbiError('buffer shorter than header');
  const magic = dv.getUint32(0, true);
  if (expectMagic !== undefined && magic !== expectMagic) {
    throw new AbiError(`bad magic 0x${magic.toString(16)} (expected 0x${expectMagic.toString(16)})`);
  }
  const version = dv.getUint32(4, true);
  if (version !== ABI_VERSION) throw new AbiError(`unsupported version ${version}`);
  const total = dv.getUint32(8, true);
  if (total > bytes.byteLength) throw new AbiError(`total_bytes ${total} exceeds buffer ${bytes.byteLength}`);
  const count = dv.getUint32(12, true);
  if (16 + count * 4 > total) throw new AbiError('offset table exceeds total_bytes');
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    const o = dv.getUint32(16 + i * 4, true);
    if (o < 16 + count * 4 || o > total) throw new AbiError(`offset[${i}]=${o} out of range`);
    if (o % 4 !== 0) throw new AbiError(`offset[${i}]=${o} not 4-aligned`);
    offsets.push(o);
  }
  const start = (i: number): number => {
    const s = offsets[i];
    if (s === undefined) throw new AbiError(`entry ${i} out of range (count ${count})`);
    return s;
  };
  return {
    magic,
    count,
    entry(i) {
      const s = start(i);
      return new DataView(bytes.buffer, bytes.byteOffset + s, total - s);
    },
    entryBytes(i) {
      const s = start(i);
      return bytes.subarray(s, total);
    },
  };
}

/** Test helper: writes a block like the C side (entries 4-aligned, zero padded). */
export function buildResult(magic: number, entries: Uint8Array[]): Uint8Array {
  const headerBytes = 16 + entries.length * 4;
  let total = headerBytes;
  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(total);
    total += (e.length + 3) & ~3;
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, magic, true);
  dv.setUint32(4, ABI_VERSION, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, entries.length, true);
  offsets.forEach((o, i) => dv.setUint32(16 + i * 4, o, true));
  entries.forEach((e, i) => out.set(e, offsets[i] ?? 0));
  return out;
}

function need(dv: DataView, bytes: number, what: string): void {
  if (dv.byteLength < bytes) throw new AbiError(`${what}: entry too short (${dv.byteLength} < ${bytes})`);
}

/** Copy `n` bytes at `at` from an entry view. */
function slice(dv: DataView, at: number, n: number, what: string): Uint8Array {
  need(dv, at + n, what);
  return new Uint8Array(dv.buffer, dv.byteOffset + at, n).slice();
}

/** mpq_read result: the file bytes (copy). */
export function decodeRaw(buf: ArrayBuffer | Uint8Array): Uint8Array {
  const r = readResult(buf, MAGIC.raw);
  if (r.count !== 1) throw new AbiError('raw: expected 1 entry');
  const e = r.entry(0);
  need(e, 4, 'raw length');
  return slice(e, 4, e.getUint32(0, true), 'raw data');
}

export function decodePalette(buf: ArrayBuffer | Uint8Array): Palette {
  const r = readResult(buf, MAGIC.palette);
  const dv = r.entry(0);
  return { rgba: slice(dv, 0, 1024, 'palette') };
}

export function decodeColormap(buf: ArrayBuffer | Uint8Array): Colormap {
  const r = readResult(buf, MAGIC.colormap);
  const rows = r.count;
  if (rows === 0) return { rows: 0, data: new Uint8Array(0) };
  // rows are contiguous (docs/abi.md): entry 0 .. rows*256 is one table
  const first = r.entry(0);
  const data = slice(first, 0, rows * 256, 'colormap');
  return { rows, data };
}

export function decodeDc6(buf: ArrayBuffer | Uint8Array): DecodedDc6 {
  const r = readResult(buf, MAGIC.dc6);
  if (r.count < 1) throw new AbiError('dc6: missing info entry');
  const info = r.entry(0);
  need(info, 12, 'dc6 info');
  const directions = info.getUint32(0, true);
  const framesPerDirection = info.getUint32(4, true);
  const frameCount = info.getUint32(8, true);
  if (r.count - 1 !== frameCount || frameCount !== directions * framesPerDirection) throw new AbiError('dc6: frame count mismatch');
  const frames: DecodedFrame[] = [];
  for (let k = 0; k < frameCount; k++) {
    const dv = r.entry(1 + k);
    need(dv, 20, 'dc6 frame');
    const width = dv.getUint32(0, true);
    const height = dv.getUint32(4, true);
    frames.push({
      width,
      height,
      offsetX: dv.getInt32(8, true),
      offsetY: dv.getInt32(12, true),
      flags: dv.getUint32(16, true),
      pixels: slice(dv, 20, width * height, 'dc6 pixels'),
    });
  }
  return { directions, framesPerDirection, frames };
}

export function decodeDt1(buf: ArrayBuffer | Uint8Array): DecodedDt1 {
  const r = readResult(buf, MAGIC.dt1);
  if (r.count < 1) throw new AbiError('dt1: missing info entry');
  const info = r.entry(0);
  need(info, 4, 'dt1 info');
  const tileCount = info.getUint32(0, true);
  if (r.count - 1 !== tileCount) throw new AbiError('dt1: tile count mismatch');
  const tiles: DecodedTile[] = [];
  for (let k = 0; k < tileCount; k++) {
    const dv = r.entry(1 + k);
    need(dv, 76, 'dt1 tile');
    const pixelLength = dv.getUint32(44, true);
    tiles.push({
      direction: dv.getInt32(0, true),
      roofHeight: dv.getInt32(4, true),
      materialFlags: dv.getUint32(8, true),
      height: dv.getInt32(12, true),
      width: dv.getInt32(16, true),
      orientation: dv.getInt32(20, true),
      mainIndex: dv.getInt32(24, true),
      subIndex: dv.getInt32(28, true),
      rarity: dv.getInt32(32, true),
      yShift: dv.getInt32(36, true),
      pixelHeight: dv.getUint32(40, true),
      subtileFlags: slice(dv, 48, 25, 'dt1 subtile flags'),
      pixels: slice(dv, 76, pixelLength, 'dt1 pixels'),
    });
  }
  return { tiles };
}

function layerKind(k: number): Ds1LayerKind {
  if (k === 0) return 'wall';
  if (k === 1) return 'floor';
  if (k === 2) return 'shadow';
  throw new AbiError(`ds1: unexpected layer kind ${k}`);
}

export function decodeDs1(buf: ArrayBuffer | Uint8Array): DecodedDs1 {
  const r = readResult(buf, MAGIC.ds1);
  if (r.count < 4) throw new AbiError('ds1: expected at least 4 entries');
  const info = r.entry(0);
  need(info, 44, 'ds1 info');
  const u = (i: number): number => info.getUint32(i * 4, true);
  const [version, width, height, act, subType, wallN, floorN, shadowN, objectN, groupN, fileN] = [
    u(0), u(1), u(2), u(3), u(4), u(5), u(6), u(7), u(8), u(9), u(10),
  ] as [number, number, number, number, number, number, number, number, number, number, number];
  if (r.count !== 4 + wallN + floorN + shadowN) throw new AbiError('ds1: entry count mismatch');

  // files
  const fdv = r.entry(1);
  need(fdv, 4, 'ds1 files');
  const nFiles = fdv.getUint32(0, true);
  if (nFiles !== fileN) throw new AbiError('ds1: file count mismatch');
  const files: string[] = [];
  const td = new TextDecoder('latin1');
  let p = 4;
  for (let i = 0; i < nFiles; i++) {
    need(fdv, p + 4, 'ds1 file length');
    const len = fdv.getUint32(p, true);
    files.push(td.decode(slice(fdv, p + 4, len, 'ds1 file name')));
    p += 4 + ((len + 3) & ~3);
  }

  // objects
  const odv = r.entry(2);
  need(odv, 4, 'ds1 objects');
  const nObj = odv.getUint32(0, true);
  if (nObj !== objectN) throw new AbiError('ds1: object count mismatch');
  const objects: Ds1Object[] = [];
  const pathCounts: number[] = [];
  for (let i = 0; i < nObj; i++) {
    const b = 4 + i * 24;
    need(odv, b + 24, 'ds1 object');
    objects.push({
      type: odv.getInt32(b, true),
      id: odv.getInt32(b + 4, true),
      x: odv.getInt32(b + 8, true),
      y: odv.getInt32(b + 12, true),
      flags: odv.getInt32(b + 16, true),
      path: [],
    });
    pathCounts.push(odv.getUint32(b + 20, true));
  }
  let pp = 4 + nObj * 24;
  objects.forEach((o, i) => {
    for (let k = 0; k < (pathCounts[i] ?? 0); k++) {
      need(odv, pp + 12, 'ds1 path point');
      o.path.push({ x: odv.getInt32(pp, true), y: odv.getInt32(pp + 4, true), action: odv.getInt32(pp + 8, true) });
      pp += 12;
    }
  });

  // groups
  const gdv = r.entry(3);
  need(gdv, 4, 'ds1 groups');
  const nGroups = gdv.getUint32(0, true);
  if (nGroups !== groupN) throw new AbiError('ds1: group count mismatch');
  const groups: Ds1Group[] = [];
  for (let i = 0; i < nGroups; i++) {
    const b = 4 + i * 20;
    need(gdv, b + 20, 'ds1 group');
    groups.push({
      x: gdv.getInt32(b, true),
      y: gdv.getInt32(b + 4, true),
      width: gdv.getInt32(b + 8, true),
      height: gdv.getInt32(b + 12, true),
      variants: gdv.getInt32(b + 16, true),
    });
  }

  // layers: walls, floors, shadows
  const walls: Ds1Layer[] = [];
  const floors: Ds1Layer[] = [];
  const shadows: Ds1Layer[] = [];
  for (let e = 4; e < r.count; e++) {
    const dv = r.entry(e);
    need(dv, 12, 'ds1 layer header');
    const kind = layerKind(dv.getUint32(0, true));
    const index = dv.getUint32(4, true);
    const cellCount = dv.getUint32(8, true);
    if (cellCount !== width * height) throw new AbiError('ds1: layer cell count mismatch');
    const layer: Ds1Layer = { kind, index, cells: new Ds1Cells(slice(dv, 12, cellCount * 12, 'ds1 cells'), cellCount) };
    (kind === 'wall' ? walls : kind === 'floor' ? floors : shadows).push(layer);
  }
  if (walls.length !== wallN || floors.length !== floorN || shadows.length !== shadowN) {
    throw new AbiError('ds1: layer counts do not match the info entry');
  }
  return { version, width, height, act, subType, files, objects, groups, walls, floors, shadows };
}
