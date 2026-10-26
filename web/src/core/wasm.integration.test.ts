// SPDX-License-Identifier: GPL-3.0-or-later
// End to end: the real built web/public/d2core.{js,wasm} loaded in node, decoding buffers through the
// TS readers (binding.ts + abi.ts). Skipped when d2core.wasm has not been built (wasm/build.sh).
// Fixture files (DT1/DS1/MPQs) come from wasm/tests/gen_fixtures (wasm/test.sh builds them into
// build-native/tests/fixtures; override with D2CORE_FIXTURES). Without them only the TS-built cases run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { D2Core, CoreError, type EmModule, type ModuleFactory } from './binding';
import { MAGIC, decodeColormap, decodeDc6, decodeDs1, decodeDt1, decodePalette, decodeRaw, readResult } from './abi';
import { cat, u32s } from './synth';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../../public');
const jsPath = process.env.D2CORE_JS ?? path.join(publicDir, 'd2core.js');
const wasmPath = path.join(path.dirname(jsPath), 'd2core.wasm');
const fixtures = process.env.D2CORE_FIXTURES ?? path.resolve(here, '../../../build-native/tests/fixtures');

const haveWasm = fs.existsSync(jsPath) && fs.existsSync(wasmPath);
const haveFixtures = fs.existsSync(path.join(fixtures, 'base.mpq')) && fs.existsSync(path.join(fixtures, 'tiny.ds1'));
const fx = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(fixtures, name)));

let core: D2Core;
let m: EmModule;

/** Minimal DC6: 2 directions x 1 frame (same bytes as wasm/tests/testdata.hpp dc6()). */
function tinyDc6(): Uint8Array {
  const rle0 = [2, 5, 6, 0x81, 0x80, 0x82, 1, 7, 0x80];
  const rle1 = [2, 1, 2, 0x80, 1, 3, 0x81, 0x80];
  const head = u32s(6, 1, 0, 0xeeeeeeee | 0, 2, 1);
  const frame = (flip: number, w: number, h: number, ox: number, oy: number, rle: number[]): Uint8Array =>
    cat(u32s(flip, w, h, ox, oy, 0, 0, rle.length), new Uint8Array([...rle, 0xee, 0xee, 0xee]));
  const f0 = frame(0, 3, 2, -1, 2, rle0);
  const f1 = frame(1, 2, 2, 4, -3, rle1);
  const ptrsAt = head.length;
  const p0 = ptrsAt + 8;
  const p1 = p0 + f0.length;
  return cat(head, u32s(p0, p1), f0, f1);
}

describe.skipIf(!haveWasm)('d2core.wasm through the TS readers', () => {
  beforeAll(async () => {
    const factory = (await import(/* @vite-ignore */ pathToFileURL(jsPath).href)).default as ModuleFactory;
    m = await factory();
    core = new D2Core(m);
    if (haveFixtures) {
      m.FS.mkdir('/fx');
      m.FS.mount(m.NODEFS, { root: fixtures }, '/fx');
    }
  });

  it('reports version and ABI', () => {
    expect(core.version()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m._d2core_abi_version()).toBe(1);
    expect(m._d2core_result_size(0)).toBe(0);
    expect(core.lastError()).toBeTypeOf('string');
  });

  it('palette_decode: 768-byte pal.dat (BGR) and >= 1024 byte RGBA input', () => {
    const dat = new Uint8Array(768);
    for (let i = 0; i < 256; i++) dat.set([i >> 1, 255 - i, i], i * 3); // b, g, r
    const p = decodePalette(core.paletteDecode(dat));
    expect([...p.rgba.subarray(40, 44)]).toEqual([10, 245, 5, 255]);
    expect(p.rgba[3]).toBe(0); // index 0 transparent
    expect(p.rgba[255 * 4 + 3]).toBe(255);
    const rgba = new Uint8Array(1024).map((_, i) => (i * 5) & 255);
    const q = decodePalette(core.paletteDecode(rgba));
    expect([...q.rgba.subarray(4, 7)]).toEqual([...rgba.subarray(4, 7)]);
    expect(() => core.paletteDecode(new Uint8Array(100))).toThrow(CoreError);
    expect(() => core.paletteDecode(new Uint8Array(100))).toThrow(/palette/);
  });

  it('colormap_decode and colormap_slice', () => {
    const data = Uint8Array.from({ length: 768 }, (_, i) => (i * 7) & 255);
    const c = decodeColormap(core.colormapDecode(data));
    expect(c.rows).toBe(3);
    expect([...c.data]).toEqual([...data]);
    const s = decodeColormap(core.colormapSlice(data, 100, 2));
    expect(s.rows).toBe(2);
    expect([...s.data]).toEqual([...data.subarray(100, 612)]);
    expect(() => core.colormapDecode(new Uint8Array(300))).toThrow(/multiple of 256/);
    expect(() => core.colormapSlice(data, 300, 2)).toThrow(CoreError);
  });

  it('dc6_decode on a TS-built DC6', () => {
    const d = decodeDc6(core.dc6Decode(tinyDc6()));
    expect([d.directions, d.framesPerDirection, d.frames.length]).toEqual([2, 1, 2]);
    expect(d.frames[0]).toMatchObject({ width: 3, height: 2, offsetX: -1, offsetY: 2, flags: 0 });
    expect([...d.frames[0]!.pixels]).toEqual([0, 0, 7, 5, 6, 0]);
    expect(d.frames[1]).toMatchObject({ width: 2, height: 2, offsetX: 4, offsetY: -3, flags: 1 });
    expect([...d.frames[1]!.pixels]).toEqual([1, 2, 3, 0]);
    const bad = tinyDc6();
    bad[0] = 5;
    expect(() => core.dc6Decode(bad)).toThrow(/DC6/);
  });

  describe.skipIf(!haveFixtures)('fixtures (build-native/tests/fixtures)', () => {
    it('dc6/dt1/ds1 files', () => {
      const dc6 = decodeDc6(core.dc6Decode(fx('tiny.dc6')));
      expect(dc6.frames).toHaveLength(2);
      const dt1 = decodeDt1(core.dt1Decode(fx('tiny.dt1')));
      expect(dt1.tiles).toHaveLength(2);
      expect(dt1.tiles[0]).toMatchObject({ materialFlags: 0x1234, height: -15, width: 32, orientation: 0, mainIndex: 1, subIndex: 0, pixelHeight: 15, yShift: 0 });
      expect(dt1.tiles[0]!.pixels.length).toBe(480);
      expect(dt1.tiles[1]).toMatchObject({ direction: 4, roofHeight: -2, orientation: 1, mainIndex: 3, subIndex: 2, rarity: 5, yShift: 4, pixelHeight: 20 });
      expect([...dt1.tiles[1]!.subtileFlags]).toEqual(Array.from({ length: 25 }, (_, k) => k));
      expect([...dt1.tiles[1]!.pixels.subarray(0, 12)]).toEqual([0, 0xaa, 0xbb, 0, 0, 0, 0, 0, 1, 2, 3, 0]);

      const ds1 = decodeDs1(core.ds1Decode(fx('tiny.ds1')));
      expect(ds1).toMatchObject({ version: 18, width: 2, height: 2, act: 2, subType: 1 });
      expect(ds1.files).toEqual(['a.dt1', 'bb.dt1']);
      expect(ds1.objects).toEqual([{ type: 1, id: 5, x: 3, y: 4, flags: 7, path: [{ x: 10, y: 11, action: 1 }, { x: 12, y: 13, action: 2 }] }]);
      expect(ds1.groups).toEqual([{ x: 1, y: 2, width: 3, height: 4, variants: 5 }]);
      expect([ds1.walls.length, ds1.floors.length, ds1.shadows.length]).toEqual([1, 1, 1]);
      const w = ds1.walls[0]!.cells;
      for (let i = 0; i < 4; i++) {
        expect([w.prop1(i), w.sequence(i), w.style(i), w.wallType(i), w.wallZero(i)]).toEqual([10 + i, i, 1, 1 + i, 3]);
        expect([ds1.floors[0]!.cells.prop1(i), ds1.floors[0]!.cells.style(i), ds1.floors[0]!.cells.hidden(i)]).toEqual([20 + i, 2, i === 3]);
        expect([ds1.shadows[0]!.cells.prop1(i), ds1.shadows[0]!.cells.style(i)]).toEqual([30 + i, 3]);
      }
      expect(() => core.ds1Decode(fx('tiny.ds1').slice(0, 20))).toThrow(CoreError);
    });

    it('pal.dat fixture', () => {
      const p = decodePalette(core.paletteDecode(fx('pal.dat')));
      expect([...p.rgba.subarray(0, 4)]).toEqual([0, 255, 0, 0]);
      expect([...p.rgba.subarray(255 * 4, 255 * 4 + 4)]).toEqual([255, 0, 127, 255]);
    });

    it('mpq_open / mpq_has / mpq_read on NODEFS, with override order', () => {
      expect(core.mpqHas('data\\global\\hello.txt')).toBe(false); // nothing open
      expect(core.mpqOpen(['/fx/base.mpq'])).toBe(1);
      expect(core.mpqHas('data\\global\\hello.txt')).toBe(true);
      expect(core.mpqHas('DATA/GLOBAL/HELLO.TXT')).toBe(true);
      expect(core.mpqHas('data\\global\\nope.txt')).toBe(false);
      const text = (name: string): string => Buffer.from(decodeRaw(core.mpqReadResult(name))).toString('latin1');
      expect(text('data\\global\\hello.txt')).toBe('hello mpq');
      expect(text('data\\global\\zlib.bin')).toHaveLength(4000);
      expect(text('data\\global\\bzip2.bin').startsWith('bzip2bzip2')).toBe(true);
      expect(() => core.mpqReadResult('data\\global\\nope.txt')).toThrow(/not found/);

      // a DT1 straight out of the archive, through the readers
      const dt1 = decodeDt1(core.dt1Decode(decodeRaw(core.mpqReadResult('data\\global\\tiles\\tiny.dt1'))));
      expect(dt1.tiles).toHaveLength(2);
      const raw = readResult(core.mpqReadResult('data\\global\\hello.txt'), MAGIC.raw);
      expect(raw.count).toBe(1);

      expect(core.mpqOpen(['/fx/base.mpq', '/fx/patch.mpq'])).toBe(2);
      expect(text('data\\global\\hello.txt')).toBe('hello patch');
      expect(text('data\\global\\patch.txt')).toBe('only in patch');
      expect(core.mpqOpen(['/fx/patch.mpq', '/fx/base.mpq'])).toBe(2);
      expect(text('data\\global\\hello.txt')).toBe('hello mpq');
    });

    it('MEMFS archive; a bad path fails and leaves nothing open; mpq_close', () => {
      m.FS.mkdir('/mem');
      m.FS.writeFile('/mem/copy.mpq', fs.readFileSync(path.join(fixtures, 'base.mpq')));
      expect(core.mpqOpen(['/mem/copy.mpq'])).toBe(1);
      expect(core.mpqHas('data\\global\\hello.txt')).toBe(true);
      expect(() => core.mpqOpen(['/mem/copy.mpq', '/mem/missing.mpq'])).toThrow(/missing\.mpq/);
      expect(core.mpqHas('data\\global\\hello.txt')).toBe(false);
      core.mpqOpen(['/mem/copy.mpq']);
      core.mpqClose();
      expect(core.mpqHas('data\\global\\hello.txt')).toBe(false);
    });
  });
});
