// SPDX-License-Identifier: GPL-3.0-or-later
// Node test of the built d2core module (docs/abi.md), on the fixtures that
// gen_fixtures writes. Env: D2CORE_JS (default build-wasm/d2core.js),
// D2CORE_FIXTURES (default build-native/wasm/tests/fixtures... see test.sh),
// optional D2_MPQ_DIR for the real-data test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const jsPath = process.env.D2CORE_JS ?? path.join(root, 'build-wasm/d2core.js');
const fixtures = process.env.D2CORE_FIXTURES ?? path.join(root, 'build-native/tests/fixtures');

const MAGIC = { raw: 0x57523244, palette: 0x4c503244, colormap: 0x4d433244, dc6: 0x36433244, dt1: 0x31543244, ds1: 0x31533244 };

let m;

// --- helpers: copy in, decode out ------------------------------------------
const heap = () => m.HEAPU8;
function withBytes(bytes, fn) {
  const ptr = m._d2core_alloc(bytes.length);
  heap().set(bytes, ptr);
  try { return fn(ptr, bytes.length); } finally { m._d2core_free(ptr); }
}
function withCString(s, fn) {
  const len = m.lengthBytesUTF8(s) + 1;
  const ptr = m._d2core_alloc(len);
  m.stringToUTF8(s, ptr, len);
  try { return fn(ptr); } finally { m._d2core_free(ptr); }
}
const lastError = () => m.UTF8ToString(m._d2core_last_error());

// A result copied out of WASM memory into its own ArrayBuffer, then freed.
class Result {
  constructor(ptr) {
    assert.notEqual(ptr, 0, `NULL result: ${lastError()}`);
    const total = m._d2core_result_size(ptr);
    this.buf = heap().slice(ptr, ptr + total).buffer;
    m._d2core_free(ptr);
    this.dv = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
    assert.equal(this.total, total);
    assert.equal(this.u32(4), 1, 'abi version');
    for (let i = 0; i < this.count; i++) {
      assert.equal(this.off(i) % 4, 0);
      assert.ok(this.off(i) >= 16 + 4 * this.count && this.off(i) <= total);
    }
  }
  u32(at) { return this.dv.getUint32(at, true); }
  i32(at) { return this.dv.getInt32(at, true); }
  get magic() { return this.u32(0); }
  get total() { return this.u32(8); }
  get count() { return this.u32(12); }
  off(i) { return this.u32(16 + 4 * i); }
  bytes(at, n) { return Array.from(this.u8.subarray(at, at + n)); }
}

const decode = (fn, bytes) => withBytes(bytes, (p, n) => new Result(m[fn](p, n)));
const failing = (fn, bytes) => withBytes(bytes, (p, n) => { assert.equal(m[fn](p, n), 0); return lastError(); });
const fx = (name) => new Uint8Array(fs.readFileSync(path.join(fixtures, name)));

before(async () => {
  const create = (await import(pathToFileURL(jsPath).href)).default;
  m = await create();
  m.FS.mkdir('/fx');
  m.FS.mount(m.NODEFS, { root: fixtures }, '/fx');
});

describe('core', () => {
  test('version and memory', () => {
    assert.match(m.UTF8ToString(m._d2core_version()), /^\d+\.\d+\.\d+$/);
    assert.equal(m._d2core_abi_version(), 1);
    assert.equal(m._d2core_result_size(0), 0);
  });
});

describe('decoders', () => {
  test('palette (pal.dat, BGR -> RGBA)', () => {
    const r = decode('_palette_decode', fx('pal.dat'));
    assert.equal(r.magic, MAGIC.palette);
    assert.equal(r.count, 1);
    const e = r.off(0);
    assert.equal(r.total, 16 + 4 + 1024);
    assert.deepEqual(r.bytes(e, 4), [0, 255, 0, 0]);          // index 0: alpha 0 (rgb from source)
    assert.deepEqual(r.bytes(e + 40, 4), [10, 245, 5, 255]);
    assert.deepEqual(r.bytes(e + 255 * 4, 4), [255, 0, 127, 255]);
    assert.match(failing('_palette_decode', new Uint8Array(100)), /palette/);
  });

  test('colormap', () => {
    const cm = Uint8Array.from({ length: 768 }, (_, i) => (i * 7) & 255);
    const r = decode('_colormap_decode', cm);
    assert.equal(r.magic, MAGIC.colormap);
    assert.equal(r.count, 3);
    assert.equal(r.off(1) - r.off(0), 256);
    assert.deepEqual(r.bytes(r.off(2), 256), Array.from(cm.subarray(512, 768)));
    assert.match(failing('_colormap_decode', new Uint8Array(300)), /multiple of 256/);
    const s = withBytes(cm, (p, n) => new Result(m._colormap_slice(p, n, 100, 2)));
    assert.equal(s.count, 2);
    assert.deepEqual(s.bytes(s.off(1), 256), Array.from(cm.subarray(356, 612)));
    withBytes(cm, (p, n) => assert.equal(m._colormap_slice(p, n, 300, 2), 0));
  });

  test('dc6', () => {
    const r = decode('_dc6_decode', fx('tiny.dc6'));
    assert.equal(r.magic, MAGIC.dc6);
    assert.equal(r.count, 3);
    const info = r.off(0);
    assert.deepEqual([r.u32(info), r.u32(info + 4), r.u32(info + 8)], [2, 1, 2]);
    const f0 = r.off(1), f1 = r.off(2);
    assert.deepEqual([r.u32(f0), r.u32(f0 + 4), r.i32(f0 + 8), r.i32(f0 + 12), r.u32(f0 + 16)], [3, 2, -1, 2, 0]);
    assert.deepEqual(r.bytes(f0 + 20, 6), [0, 0, 7, 5, 6, 0]);
    assert.deepEqual([r.u32(f1), r.u32(f1 + 4), r.i32(f1 + 8), r.i32(f1 + 12), r.u32(f1 + 16)], [2, 2, 4, -3, 1]);
    assert.deepEqual(r.bytes(f1 + 20, 4), [1, 2, 3, 0]);
    const bad = fx('tiny.dc6').slice(); bad[0] = 5;
    assert.match(failing('_dc6_decode', bad), /DC6/);
  });

  test('dt1', () => {
    const r = decode('_dt1_decode', fx('tiny.dt1'));
    assert.equal(r.magic, MAGIC.dt1);
    assert.equal(r.count, 3);
    assert.equal(r.u32(r.off(0)), 2);
    let t = r.off(1);
    const hdr = (t) => ({
      direction: r.i32(t), roof: r.i32(t + 4), material: r.u32(t + 8), height: r.i32(t + 12), width: r.i32(t + 16),
      orientation: r.i32(t + 20), style: r.i32(t + 24), sequence: r.i32(t + 28), rarity: r.i32(t + 32),
      yShift: r.i32(t + 36), pixelHeight: r.u32(t + 40), pixelLength: r.u32(t + 44),
    });
    assert.deepEqual(hdr(t), { direction: 0, roof: 0, material: 0x1234, height: -15, width: 32, orientation: 0, style: 1, sequence: 0, rarity: 0, yShift: 0, pixelHeight: 15, pixelLength: 480 });
    let px = t + 76;
    assert.deepEqual(r.bytes(px + 13, 6), [0, 1, 2, 3, 4, 0]);
    assert.equal(r.u8[px + 7 * 32], 1 + (112 % 250));
    t = r.off(2);
    assert.deepEqual(hdr(t), { direction: 4, roof: -2, material: 1, height: 20, width: 8, orientation: 1, style: 3, sequence: 2, rarity: 5, yShift: 4, pixelHeight: 20, pixelLength: 160 });
    assert.deepEqual(r.bytes(t + 48, 25), Array.from({ length: 25 }, (_, k) => k));
    px = t + 76;
    assert.deepEqual(r.bytes(px, 12), [0, 0xaa, 0xbb, 0, 0, 0, 0, 0, 1, 2, 3, 0]);
    const bad = fx('tiny.dt1').slice(); bad[0] = 9;
    assert.match(failing('_dt1_decode', bad), /DT1/);
  });

  test('ds1', () => {
    const r = decode('_ds1_decode', fx('tiny.ds1'));
    assert.equal(r.magic, MAGIC.ds1);
    assert.equal(r.count, 7);
    const i = r.off(0);
    const info = Array.from({ length: 11 }, (_, k) => r.u32(i + 4 * k));
    assert.deepEqual(info, [18, 2, 2, 2, 1, 1, 1, 1, 1, 1, 2]);
    // files
    let p = r.off(1);
    assert.equal(r.u32(p), 2);
    const files = [];
    p += 4;
    for (let k = 0; k < 2; k++) {
      const len = r.u32(p);
      files.push(String.fromCharCode(...r.u8.subarray(p + 4, p + 4 + len)));
      p += 4 + ((len + 3) & ~3);
    }
    assert.deepEqual(files, ['a.dt1', 'bb.dt1']);
    // objects
    const o = r.off(2);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((k) => r.i32(o + 4 + 4 * k)), [1, 5, 3, 4, 7, 2]);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((k) => r.i32(o + 28 + 4 * k)), [10, 11, 1, 12, 13, 2]);
    // groups
    const g = r.off(3);
    assert.equal(r.u32(g), 1);
    assert.deepEqual([0, 1, 2, 3, 4].map((k) => r.i32(g + 4 + 4 * k)), [1, 2, 3, 4, 5]);
    // layers: wall, floor, shadow
    for (let l = 0; l < 3; l++) {
      const h = r.off(4 + l);
      assert.deepEqual([r.u32(h), r.u32(h + 4), r.u32(h + 8)], [l, 0, 4]);
      for (let n = 0; n < 4; n++) {
        const c = r.bytes(h + 12 + 12 * n, 8);   // prop1, sequence, style, hidden, unk1, unk2, wall_type, 0
        if (l === 0) {
          assert.deepEqual(c, [10 + n, n, 1, 0, 0, 0, 1 + n, 0]);
          assert.equal(r.u32(h + 12 + 12 * n + 8), 3);
        } else if (l === 1) {
          assert.deepEqual(c, [20 + n, n, 2, n === 3 ? 1 : 0, 0, 0, 0, 0]);
        } else {
          assert.deepEqual(c, [30 + n, 0, 3, 0, 0, 0, 0, 0]);
        }
      }
    }
    assert.ok(failing('_ds1_decode', fx('tiny.ds1').slice(0, 20)).length > 0);
  });
});

describe('mpq', () => {
  const has = (name) => withCString(name, (p) => m._mpq_has(p));
  const open = (list) => withCString(list, (p) => m._mpq_open(p));
  const readText = (name) => withCString(name, (p) => {
    const r = new Result(m._mpq_read(p));
    assert.equal(r.magic, MAGIC.raw);
    assert.equal(r.count, 1);
    const e = r.off(0);
    return Buffer.from(r.u8.subarray(e + 4, e + 4 + r.u32(e))).toString('latin1');
  });

  test('NODEFS: open, has, read (stored, zlib, bzip2), decode from MPQ bytes', () => {
    assert.equal(has('data\\global\\hello.txt'), 0);   // nothing open yet
    assert.equal(open('/fx/base.mpq'), 1);
    assert.equal(has('data\\global\\hello.txt'), 1);
    assert.equal(has('DATA/GLOBAL/HELLO.TXT'), 1);
    assert.equal(has('data\\global\\nope.txt'), 0);
    assert.equal(readText('data\\global\\hello.txt'), 'hello mpq');
    const z = readText('data\\global\\zlib.bin');
    assert.equal(z.length, 4000);
    assert.ok(z.startsWith('zlib!zlib!'));
    const b = readText('data\\global\\bzip2.bin');
    assert.equal(b.length, 4000);
    assert.ok(b.startsWith('bzip2bzip2'));
    withCString('data\\global\\nope.txt', (p) => assert.equal(m._mpq_read(p), 0));
    assert.match(lastError(), /not found/);
    // DT1 straight out of the MPQ
    const raw = withCString('data\\global\\tiles\\tiny.dt1', (p) => new Result(m._mpq_read(p)));
    const e = raw.off(0);
    const dt1 = decode('_dt1_decode', raw.u8.slice(e + 4, e + 4 + raw.u32(e)));
    assert.equal(dt1.count, 3);
  });

  test('later archives override earlier ones', () => {
    assert.equal(open('/fx/base.mpq\n/fx/patch.mpq\n'), 2);
    assert.equal(readText('data\\global\\hello.txt'), 'hello patch');
    assert.equal(readText('data\\global\\patch.txt'), 'only in patch');
    assert.equal(readText('data\\global\\zlib.bin').length, 4000);
    assert.equal(open('/fx/patch.mpq\n/fx/base.mpq'), 2);
    assert.equal(readText('data\\global\\hello.txt'), 'hello mpq');
  });

  test('MEMFS file', () => {
    m.FS.mkdir('/mem');
    m.FS.writeFile('/mem/copy.mpq', fs.readFileSync(path.join(fixtures, 'base.mpq')));
    assert.equal(open('/mem/copy.mpq'), 1);
    assert.equal(readText('data\\global\\hello.txt'), 'hello mpq');
  });

  test('bad path fails and closes everything; close', () => {
    assert.equal(open('/fx/base.mpq'), 1);
    assert.equal(open('/fx/base.mpq\n/fx/missing.mpq'), -1);
    assert.match(lastError(), /missing\.mpq/);
    assert.equal(has('data\\global\\hello.txt'), 0);
    assert.equal(open('/fx/base.mpq'), 1);
    m._mpq_close();
    assert.equal(has('data\\global\\hello.txt'), 0);
  });
});

describe('real data (D2_MPQ_DIR)', { skip: !process.env.D2_MPQ_DIR && 'D2_MPQ_DIR not set' }, () => {
  test('decodes a palette, DC6, DT1 and DS1 from the real MPQs', () => {
    const dir = process.env.D2_MPQ_DIR;
    m.FS.mkdir('/d2');
    m.FS.mount(m.NODEFS, { root: dir }, '/d2');
    const list = ['d2data.mpq', 'd2exp.mpq', 'patch_d2.mpq'].filter((f) => fs.existsSync(path.join(dir, f))).map((f) => `/d2/${f}`);
    assert.ok(list.length > 0, 'no MPQs in D2_MPQ_DIR');
    assert.equal(open(list.join('\n')), list.length);
    const cases = [
      ['data\\global\\palette\\ACT1\\Pal.dat', '_palette_decode', MAGIC.palette],
      ['data\\global\\ui\\FrontEnd\\TitleScreen.dc6', '_dc6_decode', MAGIC.dc6],
      ['data\\global\\tiles\\ACT1\\Town\\floor.dt1', '_dt1_decode', MAGIC.dt1],
      ['data\\global\\tiles\\ACT1\\Town\\townN1.ds1', '_ds1_decode', MAGIC.ds1],
    ];
    for (const [name, fn, magic] of cases) {
      if (!has(name)) continue;
      const raw = withCString(name, (p) => new Result(m._mpq_read(p)));
      const e = raw.off(0);
      const r = decode(fn, raw.u8.slice(e + 4, e + 4 + raw.u32(e)));
      assert.equal(r.magic, magic, name);
    }
  });
});
