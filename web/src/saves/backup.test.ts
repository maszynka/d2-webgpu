// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { backupName, backupZip, characterNames, isSaveEntry, overwrites, planImport, readD2s } from './backup';
import { readZip, writeZip, crc32 } from './zip';

/** A minimal .d2s header (enough for readD2s): magic, version, name at 0x14. */
function d2s(name: string, version = 96, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0xaa55aa55, true);
  v.setUint32(4, version, true);
  v.setUint32(8, size, true);
  b.set(new TextEncoder().encode(name), 0x14);
  return b;
}

describe('zip', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips stored entries with UTF-8 names', async () => {
    const entries = [
      { name: 'd2d/save/Foo.d2s', data: d2s('Foo') },
      { name: 'd2d/żółw.txt', data: new Uint8Array([1, 2, 3]) },
      { name: 'empty', data: new Uint8Array() },
    ];
    const back = await readZip(writeZip(entries));
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    back.forEach((e, i) => expect([...e.data]).toEqual([...entries[i]!.data]));
  });

  it('reads deflated entries (an archive re-zipped by the OS)', async () => {
    const data = new TextEncoder().encode('Diablo '.repeat(200));
    const zip = writeZip([{ name: 'a.txt', data }]);
    // turn the stored entry into a deflated one: method 8, compressed bytes, new sizes and offsets
    const deflated = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const name = new TextEncoder().encode('a.txt');
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, deflated.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, deflated.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true);
    central.set(name, 46);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
    ev.setUint32(12, central.length, true); ev.setUint32(16, local.length + deflated.length, true);
    const buf = new Uint8Array([...local, ...deflated, ...central, ...end]);
    expect(zip.length).toBeGreaterThan(buf.length);
    const [e] = await readZip(buf);
    expect(new TextDecoder().decode(e!.data)).toBe('Diablo '.repeat(200));
  });

  it('rejects garbage and corrupt data', async () => {
    await expect(readZip(new Uint8Array(100))).rejects.toThrow(/not a ZIP/);
    const zip = writeZip([{ name: 'x', data: new Uint8Array([1, 2, 3, 4]) }]);
    zip[30 + 1] = zip[30 + 1]! ^ 0xff; // flip a data byte
    await expect(readZip(zip)).rejects.toThrow(/checksum/);
  });
});

describe('zip limits', () => {
  const deflate = async (data: Uint8Array) => new Uint8Array(await new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  /** one deflated entry whose header declares `declared` bytes */
  async function deflatedZip(name: string, data: Uint8Array, declared = data.length): Promise<Uint8Array> {
    const z = await deflate(data);
    const n = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, z.length, true); lv.setUint32(22, declared, true); lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, z.length, true); cv.setUint32(24, declared, true); cv.setUint16(28, n.length, true);
    central.set(n, 46);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
    ev.setUint32(12, central.length, true); ev.setUint32(16, local.length + z.length, true);
    return new Uint8Array([...local, ...z, ...central, ...end]);
  }

  it('stops inflating at the declared size (a bomb that lies about its size)', async () => {
    const bomb = await deflatedZip('Hero.d2s', new Uint8Array(4 << 20), 1000);
    await expect(readZip(bomb)).rejects.toThrow(/beyond its declared size/);
  });

  it('refuses entries declared larger than the cap, and skips unwanted entries unread', async () => {
    const big = await deflatedZip('Hero.d2s', new Uint8Array(2 << 20));
    await expect(readZip(big, { maxEntry: 1 << 20 })).rejects.toThrow(/per file/);
    expect(await readZip(big, { accept: (n) => n.endsWith('.key') })).toEqual([]);
    await expect(readZip(big, { maxTotal: 1 << 20 })).rejects.toThrow(/too large/);
  });
});

describe('save import plan', () => {
  it('reads the name and version from a .d2s header', () => {
    expect(readD2s(d2s('Amazonka'))).toEqual({ name: 'Amazonka', version: 96 });
    expect(readD2s(d2s('Old', 92))).toEqual({ name: 'Old', version: 92 });
    expect(readD2s(d2s('Ancient', 71))).toMatch(/version 71/);
    expect(readD2s(new Uint8Array(64))).toMatch(/not a Diablo II/);
    expect(readD2s(d2s('../x'))).toMatch(/not valid/);
    expect(readD2s(d2s('Cut').subarray(0, 40))).toMatch(/damaged/);
  });

  it('places loose saves by the character name inside and keeps companions', () => {
    const plan = planImport([
      { name: 'renamed copy.d2s', data: d2s('Paladyn') },
      { name: 'Paladyn.key', data: new Uint8Array([1]) },
      { name: 'Paladyn.ma0', data: new Uint8Array([2]) },
      { name: 'readme.txt', data: new Uint8Array([3]) },
      { name: 'bad.d2s', data: new Uint8Array(64) },
    ]);
    expect(plan.writes.map((w) => w.path).sort()).toEqual(['/idb/d2d/save/Paladyn.d2s', '/idb/d2d/save/Paladyn.key', '/idb/d2d/save/Paladyn.ma0']);
    expect(plan.characters).toEqual(['Paladyn']);
    expect(plan.skipped.map((s) => s.name)).toEqual(['readme.txt', 'bad.d2s']);
  });

  it('companions of a renamed .d2s follow it; settings only from a backup root', () => {
    const plan = planImport([
      { name: 'copy of hero.d2s', data: d2s('Paladyn') },
      { name: 'copy of hero.key', data: new Uint8Array([1]) },
      { name: 'other/d2d/d2d.cfg', data: new Uint8Array([2]) },
    ]);
    expect(plan.writes.map((w) => w.path).sort()).toEqual(['/idb/d2d/save/Paladyn.d2s', '/idb/d2d/save/Paladyn.key']);
    expect(plan.skipped.map((x) => x.name)).toEqual(['other/d2d/d2d.cfg']);
    expect(isSaveEntry('d2d/save/A.d2s') && isSaveEntry('d2d/d2d.cfg') && !isSaveEntry('__MACOSX/x.txt')).toBe(true);
  });

  it('restores a backup in place and refuses unsafe paths', () => {
    const plan = planImport([
      { name: 'd2d/save/Foo.d2s', data: d2s('Foo') },
      { name: 'd2d/d2d.cfg', data: new Uint8Array([9]) },
      { name: 'd2d/../../etc/x.d2s', data: d2s('Bar') },
      { name: 'Saves\\Baz.d2s', data: d2s('Baz') },
    ]);
    expect(plan.writes.map((w) => w.path).sort()).toEqual(['/idb/d2d/d2d.cfg', '/idb/d2d/save/Baz.d2s', '/idb/d2d/save/Foo.d2s']);
    expect(plan.skipped).toEqual([{ name: 'd2d/../../etc/x.d2s', reason: 'unsafe path' }]);
  });

  it('backup archive, overwrite list, names', async () => {
    const date = new Date(2026, 9, 26, 12, 0, 0);
    const files = [
      { path: '/idb/d2d/d2d.cfg', data: new Uint8Array([1]), date },
      { path: '/idb/d2d/save/Foo.d2s', data: d2s('Foo'), date },
    ];
    const back = await readZip(backupZip(files));
    expect(back.map((e) => e.name)).toEqual(['d2d/d2d.cfg', 'd2d/save/Foo.d2s']);
    expect(characterNames(files)).toEqual(['Foo']);
    expect(overwrites(planImport(back), files)).toEqual(['d2d/d2d.cfg', 'd2d/save/Foo.d2s']);
    expect(backupName(date)).toBe('d2-webgpu-saves-2026-10-26.zip');
  });
});
