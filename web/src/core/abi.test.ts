// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  AbiError,
  MAGIC,
  buildResult,
  decodeColormap,
  decodeDc6,
  decodeDs1,
  decodeDt1,
  decodePalette,
  decodeRaw,
  readResult,
} from './abi';
import { cat, dc6Result, ds1Result, dt1Result, u32s } from './synth';

describe('ABI container', () => {
  it('reads entries by relative offsets and keeps 4-alignment', () => {
    const buf = buildResult(MAGIC.raw, [new Uint8Array([1, 2, 3]), new Uint8Array([9])]);
    const r = readResult(buf, MAGIC.raw);
    expect(r.count).toBe(2);
    expect([...r.entryBytes(0).subarray(0, 3)]).toEqual([1, 2, 3]);
    expect(r.entryBytes(1)[0]).toBe(9);
    expect(new DataView(buf.buffer).getUint32(20, true) % 4).toBe(0);
  });
  it('works on a view at a non-zero offset', () => {
    const raw = buildResult(MAGIC.raw, [new Uint8Array([7, 7])]);
    const padded = new Uint8Array(raw.length + 5);
    padded.set(raw, 5);
    expect([...readResult(padded.subarray(5)).entryBytes(0).subarray(0, 2)]).toEqual([7, 7]);
  });
  it('rejects bad magic, version, truncation, bad and unaligned offsets', () => {
    const good = buildResult(MAGIC.raw, [new Uint8Array(4)]);
    expect(() => readResult(good, MAGIC.dc6)).toThrow(AbiError);
    const ver = good.slice();
    ver[4] = 9;
    expect(() => readResult(ver)).toThrow(/version/);
    expect(() => readResult(good.subarray(0, good.length - 1))).toThrow(/total_bytes/);
    expect(() => readResult(new Uint8Array(8))).toThrow(/shorter/);
    const off = good.slice();
    new DataView(off.buffer).setUint32(16, 9999, true);
    expect(() => readResult(off)).toThrow(/offset/);
    const odd = good.slice();
    new DataView(odd.buffer).setUint32(16, 21, true);
    expect(() => readResult(odd)).toThrow(/aligned/);
    expect(() => readResult(good).entry(3)).toThrow(/out of range/);
  });
});

describe('format decoders (docs/abi.md layouts)', () => {
  it('decodes RAW', () => {
    const raw = buildResult(MAGIC.raw, [cat(u32s(3), new Uint8Array([5, 6, 7]))]);
    expect([...decodeRaw(raw)]).toEqual([5, 6, 7]);
    expect(() => decodeRaw(buildResult(MAGIC.raw, [u32s(99)]))).toThrow(/too short/);
  });
  it('decodes a palette (1024 RGBA bytes)', () => {
    const rgba = new Uint8Array(1024).map((_, i) => i & 255);
    const p = decodePalette(buildResult(MAGIC.palette, [rgba]));
    expect(p.rgba.length).toBe(1024);
    expect([...p.rgba.subarray(0, 8)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(() => decodePalette(buildResult(MAGIC.palette, [new Uint8Array(100)]))).toThrow(/too short/);
  });
  it('decodes a colormap as contiguous rows', () => {
    const data = new Uint8Array(512).map((_, i) => (i * 3) & 255);
    const entries = [data.slice(0, 256), data.slice(256)];
    const c = decodeColormap(buildResult(MAGIC.colormap, entries));
    expect(c.rows).toBe(2);
    expect(c.data.length).toBe(512);
    expect([...c.data]).toEqual([...data]);
  });
  it('decodes DC6 frames (info + width,height,ox,oy,flags,pixels)', () => {
    const d = decodeDc6(
      dc6Result(1, 2, [
        { w: 2, h: 2, ox: -3, oy: 4, flags: 1, pixels: new Uint8Array([1, 2, 3, 4]) },
        { w: 1, h: 3, ox: 0, oy: 0, pixels: new Uint8Array([9, 8, 7]) },
      ]),
    );
    expect(d.directions).toBe(1);
    expect(d.framesPerDirection).toBe(2);
    expect(d.frames[0]).toMatchObject({ offsetX: -3, offsetY: 4, width: 2, height: 2, flags: 1 });
    expect([...d.frames[0]!.pixels]).toEqual([1, 2, 3, 4]);
    expect([...d.frames[1]!.pixels]).toEqual([9, 8, 7]);
  });
  it('rejects DC6 with mismatched counts or short pixels', () => {
    const bad = buildResult(MAGIC.dc6, [u32s(2, 2, 4), cat(u32s(0, 0, 0, 0, 0))]);
    expect(() => decodeDc6(bad)).toThrow(/mismatch/);
    const short = buildResult(MAGIC.dc6, [u32s(1, 1, 1), cat(u32s(4, 4, 0, 0, 0), new Uint8Array(3))]);
    expect(() => decodeDc6(short)).toThrow(/too short|pixels/);
  });
  it('decodes DT1 tiles', () => {
    const d = decodeDt1(
      dt1Result([
        { type: 1, style: 3, sequence: 2, rarity: 5, height: 2, width: 2, roofHeight: -2, pixels: new Uint8Array([4, 5, 6, 7]) },
        { type: 0, style: 1, sequence: 0, height: -1, width: 3, pixels: new Uint8Array([1, 2, 3]) },
      ]),
    );
    expect(d.tiles).toHaveLength(2);
    expect(d.tiles[0]).toMatchObject({ orientation: 1, mainIndex: 3, subIndex: 2, rarity: 5, height: 2, width: 2, roofHeight: -2, pixelHeight: 2 });
    expect([...d.tiles[0]!.pixels]).toEqual([4, 5, 6, 7]);
    expect(d.tiles[1]).toMatchObject({ orientation: 0, height: -1, pixelHeight: 1 });
    expect(d.tiles[1]!.subtileFlags.length).toBe(25);
  });
  it('decodes DS1 info, files and layers', () => {
    const buf = ds1Result({
      width: 2,
      height: 1,
      act: 2,
      files: ['\\d2\\data\\global\\tiles\\act1\\town\\floor.dt1', 'a.dt1'],
      walls: [[{ prop1: 9, sequence: 5, style: 4, wallType: 3 }, undefined]],
      floors: [[{ prop1: 2, sequence: 1, style: 2 }, { hidden: true, style: 7 }]],
      shadows: [],
    });
    const d = decodeDs1(buf);
    expect(d).toMatchObject({ version: 18, width: 2, height: 1, act: 2 });
    expect(d.files).toEqual(['\\d2\\data\\global\\tiles\\act1\\town\\floor.dt1', 'a.dt1']);
    expect(d.walls).toHaveLength(1);
    expect(d.floors).toHaveLength(1);
    expect(d.shadows).toHaveLength(0);
    const w = d.walls[0]!.cells;
    expect([w.prop1(0), w.sequence(0), w.style(0), w.wallType(0), w.hidden(0)]).toEqual([9, 5, 4, 3, false]);
    expect(d.floors[0]!.cells.hidden(1)).toBe(true);
    expect(d.floors[0]!.cells.style(1)).toBe(7);
    expect(d.walls[0]!.kind).toBe('wall');
  });
  it('rejects a DS1 whose layer entries disagree with the info entry', () => {
    const r = readResult(ds1Result({ width: 1, height: 1, floors: [[undefined]] }));
    expect(r.count).toBe(5);
    const bytes = ds1Result({ width: 1, height: 1, floors: [[undefined]] }).slice();
    // claim 2 floor layers in the info entry
    const off = new DataView(bytes.buffer).getUint32(16, true);
    new DataView(bytes.buffer).setUint32(off + 24, 2, true);
    expect(() => decodeDs1(bytes)).toThrow(/mismatch/);
  });
});
