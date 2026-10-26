// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { decodeDs1, decodeDt1 } from '../core/abi';
import { dt1Result, ds1Result, type SynthCell, type SynthTile } from '../core/synth';
import { DrawList } from '../gpu/drawlist';
import type { AtlasRect } from '../gpu/atlas';
import { tileToScreen } from './iso';
import { NormalSlot, SurfaceKind, UNLIT } from '../gpu/surface';
import { Layer, Orientation, unitKey, unpackSortKey } from './sortkey';
import {
  MapScene,
  TileSet,
  cellHash,
  ds1PathToMpq,
  dt1PathsForDs1,
  levelTypeDt1Files,
  presetDt1Mask,
  surfaceForDt1Type,
  wallClass,
  type SpriteUploader,
} from './tilemap';

class FakeUploader implements SpriteUploader {
  uploads: { w: number; h: number }[] = [];
  limit = Infinity;
  uploadSprite(w: number, h: number): AtlasRect {
    if (this.uploads.length >= this.limit) throw new Error('Atlas full');
    this.uploads.push({ w, h });
    return { x: this.uploads.length, y: 0, w, h };
  }
}

const px = (n: number): Uint8Array => new Uint8Array(n).fill(1);
const floor = (style: number, sequence: number, rarity = 0): SynthTile => ({ type: 0, style, sequence, rarity, height: -80, width: 160, pixels: px(160 * 80) });
const wall = (type: number, style: number, sequence: number, h = 120, roof = 0): SynthTile => ({ type, style, sequence, height: h, width: 160, roofHeight: roof, pixels: px(160 * h) });
const shadow = (style: number, sequence: number): SynthTile => ({ type: 13, style, sequence, height: 60, width: 160, pixels: px(160 * 60) });

function tileset(...dt1s: SynthTile[][]): TileSet {
  const ts = new TileSet();
  for (const t of dt1s) ts.add(decodeDt1(dt1Result(t)));
  return ts;
}

const F: SynthCell = { prop1: 2, style: 1, sequence: 0 };

describe('DS1 file list -> MPQ paths', () => {
  it('strips \\d2\\ and normalises slashes', () => {
    expect(ds1PathToMpq('\\d2\\data\\global\\tiles\\act1\\town\\floor.dt1')).toBe('data\\global\\tiles\\act1\\town\\floor.dt1');
    expect(ds1PathToMpq('/d2/data/global/tiles/x.dt1')).toBe('data\\global\\tiles\\x.dt1');
    expect(ds1PathToMpq('\\data\\a.dt1')).toBe('data\\a.dt1');
  });
  it('keeps .dt1 only, dedupes, completes relative names', () => {
    expect(
      dt1PathsForDs1([
        '\\d2\\data\\global\\tiles\\ACT1\\TOWN\\floor.dt1',
        '\\d2\\data\\global\\tiles\\act1\\town\\FLOOR.DT1',
        '\\d2\\data\\global\\tiles\\act1\\town\\objects.tg1',
        'Act1/Outdoors/Blank.dt1',
      ]),
    ).toEqual(['data\\global\\tiles\\ACT1\\TOWN\\floor.dt1', 'data\\global\\tiles\\Act1\\Outdoors\\Blank.dt1']);
  });
  it('Excel fallback: LvlTypes files by Dt1Mask + the always-loaded three; LvlPrest row by DS1 path or Def', () => {
    const types = ['Id\tFile 1\tFile 2\tFile 3', '1\tAct1\\Town\\floor.dt1\t0\tAct1\\Town\\wall.dt1', '2\tx\ty\tz'].join('\n');
    expect(levelTypeDt1Files(types, 1, 0b101)).toEqual([
      'data\\global\\tiles\\Act1\\Town\\floor.dt1',
      'data\\global\\tiles\\Act1\\Town\\wall.dt1',
      'data\\global\\tiles\\Act1\\Outdoors\\Blank.dt1',
      'data\\global\\tiles\\Act1\\Barracks\\InvisWal.dt1',
      'data\\global\\tiles\\Act1\\Barracks\\Warp.dt1',
    ]);
    expect(levelTypeDt1Files(types, 1, 0b010)).toHaveLength(3); // bit 1 names "0": skipped
    const prest = ['Def\tFile1\tFile2\tDt1Mask', '1\tAct1\\Town\\townN1.ds1\t0\t5', '2\tAct1\\Town\\townE1.ds1\t0\t7'].join('\n');
    expect(presetDt1Mask(prest, 'data\\global\\tiles\\ACT1\\TOWN\\townE1.ds1')).toEqual({ def: 2, mask: 7 });
    expect(presetDt1Mask(prest, 'data\\global\\tiles\\nope.ds1')).toEqual({ def: 1, mask: 5 });
    expect(presetDt1Mask('Def\tDt1Mask', 'x.ds1')).toBeNull();
  });
});

describe('lighting surfaces from DT1 types', () => {
  it('assigns kind and normal per type group', () => {
    expect(surfaceForDt1Type(0, 100)).toEqual({ kind: SurfaceKind.Floor, normal: NormalSlot.Up });
    expect(surfaceForDt1Type(13, 100)).toBe(UNLIT);
    for (const t of [1, 5, 8, 10, 16, 18]) expect(surfaceForDt1Type(t, 100)).toMatchObject({ kind: SurfaceKind.WallSe, normal: NormalSlot.WallSe, anchor: 140 });
    for (const t of [2, 6, 9, 11, 17, 19]) expect(surfaceForDt1Type(t, 100)).toMatchObject({ kind: SurfaceKind.WallSw, normal: NormalSlot.WallSw, anchor: 60 });
    for (const t of [3, 4]) expect(surfaceForDt1Type(t, 100)).toMatchObject({ normal: NormalSlot.CornerNorth, anchor: 100 });
    for (const t of [7, 12]) expect(surfaceForDt1Type(t, 100)).toMatchObject({ normal: NormalSlot.CornerSouth, anchor: 100 });
    expect(surfaceForDt1Type(15, 100, 24)).toEqual({ kind: SurfaceKind.WallTop, normal: NormalSlot.Up, anchor: 24 });
    expect(surfaceForDt1Type(14, 100)).toMatchObject({ kind: SurfaceKind.Card });
    expect(surfaceForDt1Type(30, 100)).toBe(UNLIT);
    // wall tiles whose width is not the standard 160 stay unlit until verified on real data
    for (const t of [1, 2, 3, 7, 12, 19]) expect(surfaceForDt1Type(t, 100, 0, 80)).toBe(UNLIT);
    expect(surfaceForDt1Type(0, 100, 0, 80)).toMatchObject({ kind: SurfaceKind.Floor });
    expect(surfaceForDt1Type(15, 100, 24, 80)).toMatchObject({ kind: SurfaceKind.WallTop });
  });
  it('MapScene stamps records with them', () => {
    const W = 2;
    const ds1 = decodeDs1(
      ds1Result({
        width: W,
        height: W,
        floors: [Array.from({ length: 4 }, () => F)],
        walls: [[{ style: 2, sequence: 1, wallType: 1 }, undefined, { style: 2, sequence: 3, wallType: 15 }, undefined]],
        shadows: [[{ style: 5, sequence: 1 }, undefined, undefined, undefined]],
      }),
    );
    const ts = tileset([floor(1, 0), wall(1, 2, 1), wall(15, 2, 3, 40, 24), shadow(5, 1)]);
    const m = new MapScene(ds1, ts, new FakeUploader());
    const rec = (tx: number, ty: number, type: number) => m.sprites.find((s) => s.tx === tx && s.ty === ty && s.type === type)!.record;
    expect(rec(1, 1, 0).surface.kind).toBe(SurfaceKind.Floor);
    expect(rec(0, 0, 13).surface).toBe(UNLIT);
    expect(rec(0, 0, 13).blend).toBe('darken');
    const w = rec(0, 0, 1);
    expect(w.surface).toMatchObject({ kind: SurfaceKind.WallSe, anchor: tileToScreen(0, 0).y + 40 });
    expect(rec(0, 1, 15).surface).toEqual({ kind: SurfaceKind.WallTop, normal: NormalSlot.Up, anchor: 24 });
  });
});

describe('TileSet lookup by (style, sequence, type)', () => {
  it('matches all three fields', () => {
    const ts = tileset([floor(1, 2), wall(1, 1, 2), floor(3, 4)]);
    expect(ts.size).toBe(3);
    expect(ts.pick(1, 2, 0, 0, 0)?.orientation).toBe(0);
    expect(ts.pick(1, 2, 1, 0, 0)?.orientation).toBe(1);
    expect(ts.pick(1, 2, 2, 0, 0)).toBeUndefined();
    expect(ts.pick(2, 2, 0, 0, 0)).toBeUndefined();
    expect(ts.pick(3, 4, 0, 0, 0)?.mainIndex).toBe(3);
  });
  it('picks variants by rarity, stable per cell; first one when all rarities are 0', () => {
    const ts = tileset([floor(1, 0, 1), floor(1, 0, 3)]);
    const counts = [0, 0];
    for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) counts[ts.pick(1, 0, 0, x, y)!.rarity === 1 ? 0 : 1]!++;
    expect(counts[1]).toBeGreaterThan(counts[0]! * 2); // about 3:1
    expect(counts[0]).toBeGreaterThan(100);
    expect(ts.pick(1, 0, 0, 5, 9)).toBe(ts.pick(1, 0, 0, 5, 9));
    const zero = tileset([floor(1, 0, 0), floor(1, 0, 0)]);
    expect(zero.pick(1, 0, 0, 3, 3)).toBe(zero.variants(1, 0, 0)[0]);
    expect(cellHash(1, 2)).toBe(cellHash(1, 2));
    expect(cellHash(1, 2)).not.toBe(cellHash(2, 1));
  });
  it('earlier DT1s win a tie when rarities are 0', () => {
    const ts = new TileSet();
    ts.add(decodeDt1(dt1Result([{ ...floor(1, 0), pixels: px(160 * 80).fill(7) }])));
    ts.add(decodeDt1(dt1Result([{ ...floor(1, 0), pixels: px(160 * 80).fill(9) }])));
    expect(ts.pick(1, 0, 0, 0, 0)!.pixels[0]).toBe(7);
  });
});

describe('MapScene (synthetic DS1 + DT1 through the real decoders)', () => {
  // 3x3: floor everywhere except (2,2) hidden; wall layer: left wall at (1,1), corner (type 3) at (0,0), roof at (2,0), unknown at (0,2); shadow at (1,0)
  const W = 3;
  const cells = (f: (x: number, y: number) => SynthCell | undefined): (SynthCell | undefined)[] => Array.from({ length: W * W }, (_, i) => f(i % W, Math.floor(i / W)));
  const ds1 = decodeDs1(
    ds1Result({
      width: W,
      height: W,
      floors: [cells((x, y) => (x === 2 && y === 2 ? { ...F, hidden: true } : F))],
      walls: [
        cells((x, y) => {
          if (x === 1 && y === 1) return { style: 2, sequence: 1, wallType: 1 };
          if (x === 0 && y === 0) return { style: 2, sequence: 2, wallType: 3 };
          if (x === 2 && y === 0) return { style: 2, sequence: 3, wallType: 15 };
          if (x === 0 && y === 2) return { style: 9, sequence: 9, wallType: 1 };
          return undefined;
        }),
      ],
      shadows: [cells((x, y) => (x === 1 && y === 0 ? { style: 5, sequence: 1 } : x === 0 && y === 1 ? { style: 0, sequence: 0 } : undefined))],
    }),
  );
  const tiles = tileset([
    floor(1, 0),
    wall(1, 2, 1),
    wall(3, 2, 2, 100),
    wall(4, 2, 2, 100),
    wall(15, 2, 3, 40, 24),
    shadow(5, 1),
  ]);

  it('generates floors, walls (corner = 2 tiles), roof and shadow records; counts the missing tile', () => {
    const up = new FakeUploader();
    const m = new MapScene(ds1, tiles, up, { paletteRow: 3, colormapRow: 2 });
    expect(m.stats).toMatchObject({ floors: 8, walls: 3, roofs: 1, shadows: 1, atlasFull: 0 });
    expect([...m.stats.missing]).toEqual([['9/9/1', 1]]);
    expect(m.sprites).toHaveLength(8 + 3 + 1 + 1);
    // each distinct tile is uploaded once (floor shared by 8 cells)
    expect(up.uploads).toHaveLength(6);
    expect(m.sprites.every((s) => s.record.paletteRow === 3 && s.record.colormapRow === 2)).toBe(true);
  });

  it('places tiles on the iso grid like upstream (x - 80, bottom aligned to the diamond, roof lifted)', () => {
    const m = new MapScene(ds1, tiles, new FakeUploader());
    const find = (tx: number, ty: number, type: number) => m.sprites.find((s) => s.tx === tx && s.ty === ty && s.type === type)!.record;
    const f = find(2, 1, 0);
    expect([f.x, f.y]).toEqual([tileToScreen(2, 1).x - 80, tileToScreen(2, 1).y]);
    expect([f.w, f.h]).toEqual([160, 80]);
    const w = find(1, 1, 1);
    expect([w.x, w.y]).toEqual([tileToScreen(1, 1).x - 80, tileToScreen(1, 1).y - (120 - 80)]);
    const r = find(2, 0, 15);
    expect(r.y).toBe(tileToScreen(2, 0).y - 24 - (40 - 80));
    const c3 = find(0, 0, 3);
    const c4 = find(0, 0, 4);
    expect(c3.y).toBe(tileToScreen(0, 0).y - 20);
    expect(c4.y).toBe(c3.y);
    expect(find(1, 0, 13).blend).toBe('darken');
    expect(find(2, 1, 0).blend).toBe('opaque');
  });

  it('skips hidden floors and an all-zero shadow cell', () => {
    const m = new MapScene(ds1, tiles, new FakeUploader());
    expect(m.sprites.some((s) => s.tx === 2 && s.ty === 2 && s.type === 0)).toBe(false);
    expect(m.sprites.some((s) => s.tx === 0 && s.ty === 1 && s.type === 13)).toBe(false);
  });

  it('survives a full atlas', () => {
    const up = new FakeUploader();
    up.limit = 2;
    const m = new MapScene(ds1, tiles, up);
    expect(m.stats.atlasFull).toBeGreaterThan(0);
    expect(m.sprites.length).toBeGreaterThan(0);
  });

  it('draw order: diagonal first, then floor < shadow < back walls < unit < front walls < roof', () => {
    const m = new MapScene(ds1, tiles, new FakeUploader());
    const list = new DrawList();
    m.fill(list, -1e6, -1e6, 2e6, 2e6);
    const keys = list.sorted().map((r) => unpackSortKey(r.sortKey));
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1]!.diag).toBeLessThanOrEqual(keys[i]!.diag);
    // tile (1,1): its floor comes before its wall; the back wall (type 1) is before a unit in that tile
    const sorted = list.sorted();
    const wallRec = m.sprites.find((s) => s.tx === 1 && s.ty === 1 && s.type === 1)!.record;
    const floorRec = m.sprites.find((s) => s.tx === 1 && s.ty === 1 && s.type === 0)!.record;
    expect(sorted.indexOf(floorRec)).toBeLessThan(sorted.indexOf(wallRec));
    const unit = unitKey(1 * 5 + 2, 1 * 5 + 2, 0);
    expect(wallRec.sortKey).toBeLessThan(unit);
    // a front wall (type 7) of the same tile sorts after the unit, and a back wall of the next diagonal after both
    expect(wallClass(7).layer).toBe(Layer.WallUpper);
    expect(wallClass(1).layer).toBe(Layer.WallLower);
    expect(wallClass(15)).toEqual({ layer: Layer.Roof, orientation: Orientation.Roof });
  });

  it('culls records outside the view', () => {
    const m = new MapScene(ds1, tiles, new FakeUploader());
    const list = new DrawList();
    const all = m.fill(list, -1e6, -1e6, 2e6, 2e6);
    expect(all).toBe(m.sprites.length);
    expect(list.length).toBe(all);
    const none = m.fill(list, 50000, 50000, 800, 600);
    expect(none).toBe(0);
    const some = m.fill(list, tileToScreen(2, 0).x + 75, 85, 10, 10);
    expect(some).toBeGreaterThan(0);
    expect(some).toBeLessThan(all);
  });
});
