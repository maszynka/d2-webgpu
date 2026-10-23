// SPDX-License-Identifier: GPL-3.0-or-later
// Readers for the d2core binary result ABI (PLAN: "ABI wyników").
//
// Container (little-endian):
//   u32 magic   ('D2CR' = 0x52433244)
//   u32 version (1)
//   u32 total_bytes   (whole result incl. header)
//   u32 count
//   u32 offsets[count]   relative to the start of the result
//
// ASSUMED entry layouts (docs/abi.md did not exist when this was written; adapt the
// decode* functions below if the wasm side differs — the exported interfaces are the stable part):
//   Palette    : 1 entry  = 256 * 3 bytes RGB
//   Colormap   : entry0 = u32 rows; entry1 = rows*256 index bytes
//   DC6        : entry0 = u32 directions, u32 framesPerDirection; entry 1.. = frames:
//                  i32 offsetX, i32 offsetY, u32 width, u32 height, then width*height index bytes
//   DT1        : entry per tile: i32 direction, roofHeight, materialFlags, width, height,
//                  orientation, mainIndex, subIndex, rarity, then width*height index bytes
//   DS1        : entry0 = u32 version,width,height,act,floorLayers,wallLayers;
//                entry1 = u32 floor cells [floorLayers][height][width] (tile prop bytes packed as u32);
//                entry2 = u32 wall cells  [wallLayers][height][width] followed by u32 orientation cells (same shape)

export const ABI_MAGIC = 0x52433244;
export const ABI_VERSION = 1;

export interface Palette {
  /** 256 entries, RGBA bytes; entry 0 alpha forced to 0 */
  rgba: Uint8Array;
}
export interface Colormap {
  rows: number;
  /** rows*256 bytes */
  data: Uint8Array;
}
export interface DecodedFrame {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}
export interface DecodedDc6 {
  directions: number;
  framesPerDirection: number;
  frames: DecodedFrame[];
}
export interface DecodedTile {
  direction: number;
  roofHeight: number;
  materialFlags: number;
  width: number;
  height: number;
  orientation: number;
  mainIndex: number;
  subIndex: number;
  rarity: number;
  pixels: Uint8Array;
}
export interface DecodedDt1 {
  tiles: DecodedTile[];
}
export interface DecodedDs1 {
  version: number;
  width: number;
  height: number;
  act: number;
  floorLayers: number;
  wallLayers: number;
  floors: Uint32Array;
  walls: Uint32Array;
  wallOrientations: Uint32Array;
}

export class AbiError extends Error {
  constructor(message: string) {
    super(`ABI: ${message}`);
    this.name = 'AbiError';
  }
}

export interface AbiResult {
  count: number;
  /** returns a view into the buffer for entry i, ending at the next entry (or total_bytes) */
  entry(i: number): DataView;
  entryBytes(i: number): Uint8Array;
}

export function readResult(buf: ArrayBuffer | Uint8Array): AbiResult {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 16) throw new AbiError('buffer shorter than header');
  if (dv.getUint32(0, true) !== ABI_MAGIC) throw new AbiError('bad magic');
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
    offsets.push(o);
  }
  const range = (i: number): [number, number] => {
    const start = offsets[i];
    if (start === undefined) throw new AbiError(`entry ${i} out of range (count ${count})`);
    // entries need not be sorted: end = smallest offset greater than start, else total
    let end = total;
    for (const o of offsets) if (o > start && o < end) end = o;
    return [start, end];
  };
  return {
    count,
    entry(i) {
      const [s, e] = range(i);
      return new DataView(bytes.buffer, bytes.byteOffset + s, e - s);
    },
    entryBytes(i) {
      const [s, e] = range(i);
      return bytes.subarray(s, e);
    },
  };
}

/** Test/helper writer for the container. */
export function buildResult(entries: Uint8Array[]): Uint8Array {
  const headerBytes = 16 + entries.length * 4;
  let total = headerBytes;
  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(total);
    total += e.length;
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, ABI_MAGIC, true);
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

export function decodePalette(buf: ArrayBuffer | Uint8Array): Palette {
  const r = readResult(buf);
  const e = r.entryBytes(0);
  if (e.length < 768) throw new AbiError('palette: entry too short');
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    rgba[i * 4] = e[i * 3] ?? 0;
    rgba[i * 4 + 1] = e[i * 3 + 1] ?? 0;
    rgba[i * 4 + 2] = e[i * 3 + 2] ?? 0;
    rgba[i * 4 + 3] = i === 0 ? 0 : 255;
  }
  return { rgba };
}

export function decodeColormap(buf: ArrayBuffer | Uint8Array): Colormap {
  const r = readResult(buf);
  const meta = r.entry(0);
  need(meta, 4, 'colormap meta');
  const rows = meta.getUint32(0, true);
  const data = r.entryBytes(1);
  if (data.length < rows * 256) throw new AbiError('colormap: data too short');
  return { rows, data: data.slice(0, rows * 256) };
}

export function decodeDc6(buf: ArrayBuffer | Uint8Array): DecodedDc6 {
  const r = readResult(buf);
  const meta = r.entry(0);
  need(meta, 8, 'dc6 meta');
  const directions = meta.getUint32(0, true);
  const framesPerDirection = meta.getUint32(4, true);
  if (r.count - 1 !== directions * framesPerDirection) throw new AbiError('dc6: frame count mismatch');
  const frames: DecodedFrame[] = [];
  for (let i = 1; i < r.count; i++) {
    const dv = r.entry(i);
    need(dv, 16, 'dc6 frame');
    const width = dv.getUint32(8, true);
    const height = dv.getUint32(12, true);
    need(dv, 16 + width * height, 'dc6 frame pixels');
    frames.push({
      offsetX: dv.getInt32(0, true),
      offsetY: dv.getInt32(4, true),
      width,
      height,
      pixels: new Uint8Array(dv.buffer, dv.byteOffset + 16, width * height).slice(),
    });
  }
  return { directions, framesPerDirection, frames };
}

export function decodeDt1(buf: ArrayBuffer | Uint8Array): DecodedDt1 {
  const r = readResult(buf);
  const tiles: DecodedTile[] = [];
  for (let i = 0; i < r.count; i++) {
    const dv = r.entry(i);
    need(dv, 36, 'dt1 tile');
    const width = dv.getInt32(12, true);
    const height = dv.getInt32(16, true);
    if (width < 0 || height < 0) throw new AbiError('dt1: negative size');
    need(dv, 36 + width * height, 'dt1 tile pixels');
    tiles.push({
      direction: dv.getInt32(0, true),
      roofHeight: dv.getInt32(4, true),
      materialFlags: dv.getInt32(8, true),
      width,
      height,
      orientation: dv.getInt32(20, true),
      mainIndex: dv.getInt32(24, true),
      subIndex: dv.getInt32(28, true),
      rarity: dv.getInt32(32, true),
      pixels: new Uint8Array(dv.buffer, dv.byteOffset + 36, width * height).slice(),
    });
  }
  return { tiles };
}

function u32s(dv: DataView, byteOffset: number, n: number, what: string): Uint32Array {
  need(dv, byteOffset + n * 4, what);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getUint32(byteOffset + i * 4, true);
  return out;
}

export function decodeDs1(buf: ArrayBuffer | Uint8Array): DecodedDs1 {
  const r = readResult(buf);
  if (r.count < 3) throw new AbiError('ds1: expected 3 entries');
  const meta = r.entry(0);
  need(meta, 24, 'ds1 meta');
  const version = meta.getUint32(0, true);
  const width = meta.getUint32(4, true);
  const height = meta.getUint32(8, true);
  const act = meta.getUint32(12, true);
  const floorLayers = meta.getUint32(16, true);
  const wallLayers = meta.getUint32(20, true);
  const cells = width * height;
  const floors = u32s(r.entry(1), 0, cells * floorLayers, 'ds1 floors');
  const wdv = r.entry(2);
  const walls = u32s(wdv, 0, cells * wallLayers, 'ds1 walls');
  const wallOrientations = u32s(wdv, cells * wallLayers * 4, cells * wallLayers, 'ds1 wall orientations');
  return { version, width, height, act, floorLayers, wallLayers, floors, walls, wallOrientations };
}
