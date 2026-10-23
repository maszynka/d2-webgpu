// SPDX-License-Identifier: GPL-3.0-or-later
// Builders for synthetic ABI result blocks (docs/abi.md) and raw DS1/DT1-like inputs.
// Used by unit tests and by the synthetic map path; contains no game data.

import { MAGIC, buildResult } from './abi';

export function u32s(...v: number[]): Uint8Array {
  const b = new Uint8Array(v.length * 4);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setInt32(i * 4, x, true));
  return b;
}

export function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function paletteResult(rgba: Uint8Array): Uint8Array {
  return buildResult(MAGIC.palette, [rgba]);
}

export function dc6Result(directions: number, framesPerDirection: number, frames: SynthFrame[]): Uint8Array {
  const entries = [u32s(directions, framesPerDirection, frames.length)];
  for (const f of frames) {
    entries.push(cat(u32s(f.w, f.h, f.ox, f.oy, f.flags ?? 0), f.pixels));
  }
  return buildResult(MAGIC.dc6, entries);
}
export interface SynthFrame {
  w: number;
  h: number;
  ox: number;
  oy: number;
  flags?: number;
  pixels: Uint8Array;
}

export interface SynthTile {
  /** orientation (the file's `type`) */
  type: number;
  style: number;
  sequence: number;
  rarity?: number;
  /** negative for floors */
  height: number;
  width: number;
  roofHeight?: number;
  pixels: Uint8Array;
}

export function dt1Result(tiles: SynthTile[]): Uint8Array {
  const entries = [u32s(tiles.length)];
  for (const t of tiles) {
    const ph = Math.abs(t.height);
    const len = t.width > 0 && t.height !== 0 ? t.width * ph : 0;
    if (t.pixels.length !== len) throw new Error(`synthetic tile pixel length ${t.pixels.length} != ${len}`);
    const head = cat(
      u32s(0, t.roofHeight ?? 0, 0, t.height, t.width, t.type, t.style, t.sequence, t.rarity ?? 0, 0, ph, len),
      new Uint8Array(25),
      new Uint8Array(3),
    );
    entries.push(cat(head, t.pixels));
  }
  return buildResult(MAGIC.dt1, entries);
}

export interface SynthCell {
  prop1?: number;
  sequence?: number;
  style?: number;
  hidden?: boolean;
  wallType?: number;
}
export interface SynthDs1 {
  width: number;
  height: number;
  act?: number;
  files?: string[];
  /** each layer: width*height cells (undefined cell = empty) */
  walls?: (SynthCell | undefined)[][];
  floors?: (SynthCell | undefined)[][];
  shadows?: (SynthCell | undefined)[][];
}

function cellBytes(c: SynthCell | undefined): Uint8Array {
  const b = new Uint8Array(12);
  if (!c) return b;
  b[0] = c.prop1 ?? 0;
  b[1] = (c.sequence ?? 0) & 0x3f;
  b[2] = (c.style ?? 0) & 0x3f;
  b[3] = c.hidden ? 1 : 0;
  b[6] = c.wallType ?? 0;
  return b;
}

export function ds1Result(d: SynthDs1): Uint8Array {
  const walls = d.walls ?? [];
  const floors = d.floors ?? [];
  const shadows = d.shadows ?? [];
  const files = d.files ?? [];
  const info = u32s(18, d.width, d.height, d.act ?? 1, 0, walls.length, floors.length, shadows.length, 0, 0, files.length);
  const enc = new TextEncoder();
  const fparts: Uint8Array[] = [u32s(files.length)];
  for (const f of files) {
    const bytes = enc.encode(f);
    const padded = new Uint8Array((bytes.length + 3) & ~3);
    padded.set(bytes);
    fparts.push(u32s(bytes.length), padded);
  }
  const entries: Uint8Array[] = [info, cat(...fparts), u32s(0), u32s(0)];
  const layer = (kind: number, index: number, cells: (SynthCell | undefined)[]): Uint8Array => {
    if (cells.length !== d.width * d.height) throw new Error('synthetic layer needs width*height cells');
    return cat(u32s(kind, index, cells.length), ...cells.map(cellBytes));
  };
  walls.forEach((l, i) => entries.push(layer(0, i, l)));
  floors.forEach((l, i) => entries.push(layer(1, i, l)));
  shadows.forEach((l, i) => entries.push(layer(2, i, l)));
  return buildResult(MAGIC.ds1, entries);
}
