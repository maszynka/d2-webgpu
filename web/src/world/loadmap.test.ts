// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { decodeDs1, decodeDt1, type DecodedDs1, type DecodedDt1 } from '../core/abi';
import { ds1Result, dt1Result, type SynthTile } from '../core/synth';
import type { AtlasRect } from '../gpu/atlas';
import { DrawList } from '../gpu/drawlist';
import { loadMapData, type MapSource } from './loadmap';
import { MapScene } from './tilemap';

const floorTile: SynthTile = { type: 0, style: 1, sequence: 0, height: -80, width: 160, pixels: new Uint8Array(160 * 80).fill(2) };
const wallTile: SynthTile = { type: 1, style: 2, sequence: 0, height: 100, width: 160, pixels: new Uint8Array(160 * 100).fill(3) };

/** An "MPQ" of synthetic files, keyed by lower-cased path. */
function fakeSource(files: Record<string, Uint8Array>, dt1: Record<string, SynthTile[]>, ds1: Record<string, Uint8Array>): MapSource & { reads: string[] } {
  const reads: string[] = [];
  const k = (s: string): string => s.toLowerCase();
  const has = (n: string): boolean => k(n) in files || k(n) in dt1 || k(n) in ds1;
  return {
    reads,
    mpqHas: (n) => Promise.resolve(has(n)),
    readFile(n) {
      reads.push(n);
      const f = files[k(n)];
      return f ? Promise.resolve(f) : Promise.reject(new Error(`file not found: ${n}`));
    },
    loadDs1(n): Promise<DecodedDs1> {
      const b = ds1[k(n)];
      return b ? Promise.resolve(decodeDs1(b)) : Promise.reject(new Error('ds1 missing'));
    },
    loadDt1(n): Promise<DecodedDt1> {
      const t = dt1[k(n)];
      return t ? Promise.resolve(decodeDt1(dt1Result(t))) : Promise.reject(new Error('dt1 missing'));
    },
  };
}

const tinyDs1 = (files: string[]): Uint8Array =>
  ds1Result({
    width: 2,
    height: 2,
    files,
    floors: [Array.from({ length: 4 }, () => ({ prop1: 2, style: 1, sequence: 0 }))],
    walls: [[{ style: 2, sequence: 0, wallType: 1 }, undefined, undefined, undefined]],
  });

const up = {
  n: 0,
  uploadSprite(w: number, h: number): AtlasRect {
    return { x: this.n++, y: 0, w, h };
  },
};

describe('loadMapData', () => {
  it('loads the DT1s the DS1 lists and renders through MapScene (the whole real-map path on synthetic data)', async () => {
    const src = fakeSource(
      {},
      { 'data\\global\\tiles\\act1\\x\\floor.dt1': [floorTile], 'data\\global\\tiles\\act1\\x\\walls.dt1': [wallTile] },
      { 'data\\global\\tiles\\act1\\x\\a.ds1': tinyDs1(['\\d2\\data\\global\\tiles\\act1\\x\\floor.dt1', '\\d2\\data\\global\\tiles\\act1\\x\\walls.dt1', '\\d2\\data\\global\\tiles\\act1\\x\\gone.dt1', '\\d2\\data\\global\\tiles\\act1\\x\\t.tg1']) },
    );
    const m = await loadMapData(src, 'data\\global\\tiles\\ACT1\\X\\a.ds1');
    expect(m.loaded).toEqual(['data\\global\\tiles\\act1\\x\\floor.dt1', 'data\\global\\tiles\\act1\\x\\walls.dt1']);
    expect(m.missing).toEqual(['data\\global\\tiles\\act1\\x\\gone.dt1']);
    expect(m.usedExcel).toBe(false);
    expect(m.tiles.size).toBe(2);
    const scene = new MapScene(m.ds1, m.tiles, { ...up });
    expect(scene.stats).toMatchObject({ floors: 4, walls: 1 });
    const list = new DrawList();
    expect(scene.fill(list, -1e5, -1e5, 2e5, 2e5)).toBe(5);
  });

  it('falls back to LvlTypes/LvlPrest when the DS1 lists no usable DT1 (town .tg1 case)', async () => {
    const src = fakeSource(
      {
        'data\\global\\excel\\lvlprest.txt': new TextEncoder().encode('Def\tFile1\tDt1Mask\n1\tAct1\\Town\\townN1.ds1\t3\n'),
        'data\\global\\excel\\lvltypes.txt': new TextEncoder().encode('Id\tFile 1\tFile 2\n1\tAct1\\Town\\floor.dt1\tAct1\\Town\\walls.dt1\n'),
      },
      {
        'data\\global\\tiles\\act1\\town\\floor.dt1': [floorTile],
        'data\\global\\tiles\\act1\\town\\walls.dt1': [wallTile],
      },
      { 'data\\global\\tiles\\act1\\town\\townn1.ds1': tinyDs1(['\\d2\\data\\global\\tiles\\act1\\town\\objects.tg1']) },
    );
    const m = await loadMapData(src, 'data\\global\\tiles\\ACT1\\Town\\townN1.ds1');
    expect(m.usedExcel).toBe(true);
    expect(m.loaded).toHaveLength(2);
    expect(m.missing).toHaveLength(3); // Blank, InvisWal, Warp are not in this fake archive
    expect(src.reads.length).toBe(2);
    const scene = new MapScene(m.ds1, m.tiles, { ...up });
    expect(scene.stats.floors).toBe(4);
  });

  it('reports a missing DS1, and an empty tile set without Excel tables', async () => {
    const src = fakeSource({}, {}, { 'a.ds1': tinyDs1([]) });
    await expect(loadMapData(src, 'nope.ds1')).rejects.toThrow(/not found/);
    const m = await loadMapData(src, 'a.ds1');
    expect(m.tiles.size).toBe(0);
    expect(m.usedExcel).toBe(false);
    const scene = new MapScene(m.ds1, m.tiles, { ...up });
    expect(scene.sprites).toHaveLength(0);
    expect(scene.stats.missing.size).toBe(2);
  });

  it('records a DT1 that fails to decode and keeps going', async () => {
    const src = fakeSource({}, { 'good.dt1': [floorTile] }, { 'a.ds1': tinyDs1(['data\\good.dt1', 'data\\bad.dt1']) });
    src.mpqHas = (n) => Promise.resolve(['a.ds1', 'data\\good.dt1', 'data\\bad.dt1'].includes(n));
    const orig = src.loadDt1;
    src.loadDt1 = (n) => (n === 'data\\good.dt1' ? orig('good.dt1') : Promise.reject(new Error('DT1: unsupported version')));
    const m = await loadMapData(src, 'a.ds1');
    expect(m.loaded).toEqual(['data\\good.dt1']);
    expect(m.failed).toEqual([{ path: 'data\\bad.dt1', error: 'DT1: unsupported version' }]);
  });
});
