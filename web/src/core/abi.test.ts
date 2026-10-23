// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  AbiError,
  buildResult,
  decodeColormap,
  decodeDc6,
  decodeDs1,
  decodeDt1,
  decodePalette,
  readResult,
} from './abi';

function u32(...v: number[]): Uint8Array {
  const b = new Uint8Array(v.length * 4);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setInt32(i * 4, x, true));
  return b;
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('ABI container', () => {
  it('reads entries by relative offsets', () => {
    const buf = buildResult([new Uint8Array([1, 2, 3]), new Uint8Array([9])]);
    const r = readResult(buf);
    expect(r.count).toBe(2);
    expect([...r.entryBytes(0)]).toEqual([1, 2, 3]);
    expect([...r.entryBytes(1)]).toEqual([9]);
  });
  it('works on a copy at a non-zero view offset', () => {
    const raw = buildResult([new Uint8Array([7, 7])]);
    const padded = new Uint8Array(raw.length + 5);
    padded.set(raw, 5);
    expect([...readResult(padded.subarray(5)).entryBytes(0)]).toEqual([7, 7]);
  });
  it('rejects bad magic, version, truncation and bad offsets', () => {
    const good = buildResult([new Uint8Array(4)]);
    const bad = good.slice();
    bad[0] = 0;
    expect(() => readResult(bad)).toThrow(AbiError);
    const ver = good.slice();
    ver[4] = 9;
    expect(() => readResult(ver)).toThrow(/version/);
    expect(() => readResult(good.subarray(0, good.length - 1))).toThrow(/total_bytes/);
    expect(() => readResult(new Uint8Array(8))).toThrow(/shorter/);
    const off = good.slice();
    new DataView(off.buffer).setUint32(16, 9999, true);
    expect(() => readResult(off)).toThrow(/offset/);
    expect(() => readResult(good).entry(3)).toThrow(/out of range/);
  });
});

describe('format decoders (assumed layouts)', () => {
  it('decodes a palette and forces index 0 transparent', () => {
    const rgb = new Uint8Array(768);
    rgb.set([10, 20, 30], 0);
    rgb.set([40, 50, 60], 3);
    const p = decodePalette(buildResult([rgb]));
    expect([...p.rgba.slice(0, 8)]).toEqual([10, 20, 30, 0, 40, 50, 60, 255]);
    expect(p.rgba.length).toBe(1024);
  });
  it('decodes a colormap', () => {
    const data = new Uint8Array(512).map((_, i) => i & 255);
    const c = decodeColormap(buildResult([u32(2), data]));
    expect(c.rows).toBe(2);
    expect(c.data.length).toBe(512);
    expect(c.data[257]).toBe(1);
  });
  it('decodes DC6 frames', () => {
    const f0 = cat(u32(-3, 4, 2, 2), new Uint8Array([1, 2, 3, 4]));
    const f1 = cat(u32(0, 0, 1, 3), new Uint8Array([9, 8, 7]));
    const d = decodeDc6(buildResult([u32(1, 2), f0, f1]));
    expect(d.directions).toBe(1);
    expect(d.framesPerDirection).toBe(2);
    expect(d.frames[0]).toMatchObject({ offsetX: -3, offsetY: 4, width: 2, height: 2 });
    expect([...d.frames[0]!.pixels]).toEqual([1, 2, 3, 4]);
    expect([...d.frames[1]!.pixels]).toEqual([9, 8, 7]);
  });
  it('rejects DC6 with mismatched frame count or short pixels', () => {
    expect(() => decodeDc6(buildResult([u32(2, 2), cat(u32(0, 0, 0, 0))]))).toThrow(/mismatch/);
    expect(() => decodeDc6(buildResult([u32(1, 1), cat(u32(0, 0, 4, 4), new Uint8Array(3))]))).toThrow(/pixels/);
  });
  it('decodes DT1 tiles', () => {
    const t = cat(u32(1, 2, 3, 2, 1, 5, 6, 7, 8), new Uint8Array([4, 5]));
    const d = decodeDt1(buildResult([t]));
    expect(d.tiles).toHaveLength(1);
    expect(d.tiles[0]).toMatchObject({ direction: 1, roofHeight: 2, materialFlags: 3, width: 2, height: 1, orientation: 5, mainIndex: 6, subIndex: 7, rarity: 8 });
    expect([...d.tiles[0]!.pixels]).toEqual([4, 5]);
  });
  it('decodes DS1 layers', () => {
    // 2x1 map, 1 floor layer, 1 wall layer
    const meta = u32(18, 2, 1, 1, 1, 1);
    const floors = u32(11, 12);
    const walls = cat(u32(21, 22), u32(1, 4));
    const d = decodeDs1(buildResult([meta, floors, walls]));
    expect(d).toMatchObject({ version: 18, width: 2, height: 1, act: 1, floorLayers: 1, wallLayers: 1 });
    expect([...d.floors]).toEqual([11, 12]);
    expect([...d.walls]).toEqual([21, 22]);
    expect([...d.wallOrientations]).toEqual([1, 4]);
  });
});
