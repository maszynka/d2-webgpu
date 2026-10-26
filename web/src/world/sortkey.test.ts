// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Layer, Orientation, compareKeys, packSortKey, tileKey, unitKey, unpackSortKey, wallLayer, type SortFields } from './sortkey';

describe('sort key packing', () => {
  it('round-trips fields', () => {
    const f: SortFields = { diag: 17, layer: Layer.WallUpper, subtileDepth: 6, orientation: Orientation.FrontRight, seq: 12345 };
    expect(unpackSortKey(packSortKey(f))).toEqual(f);
  });
  it('orders by diag, layer, depth, orientation, seq lexicographically', () => {
    const base: SortFields = { diag: 5, layer: Layer.Unit, subtileDepth: 3, orientation: 2, seq: 10 };
    const k = (o: Partial<SortFields>): bigint => packSortKey({ ...base, ...o });
    expect(k({ diag: 6, layer: Layer.Floor, subtileDepth: 0, orientation: 0, seq: 0 })).toBeGreaterThan(k({ layer: Layer.Roof, subtileDepth: 9, orientation: 15, seq: 999 }));
    expect(k({ layer: Layer.WallUpper, subtileDepth: 0, seq: 0 })).toBeGreaterThan(k({ subtileDepth: 9, orientation: 15, seq: 999 }));
    expect(k({ subtileDepth: 4, orientation: 0, seq: 0 })).toBeGreaterThan(k({ orientation: 15, seq: 999 }));
    expect(k({ orientation: 3, seq: 0 })).toBeGreaterThan(k({ seq: 999 }));
    expect(k({ seq: 11 })).toBeGreaterThan(k({ seq: 10 }));
  });
  it('is a real u64-compatible bigint and rejects out-of-range fields', () => {
    const k = packSortKey({ diag: 16383, layer: Layer.Roof, subtileDepth: 1023, orientation: 15, seq: (1 << 24) - 1 });
    expect(typeof k).toBe('bigint');
    expect(k).toBeLessThan(1n << 64n);
    expect(() => packSortKey({ diag: -1, layer: 0, subtileDepth: 0, orientation: 0, seq: 0 })).toThrow(RangeError);
    expect(() => packSortKey({ diag: 0, layer: 0, subtileDepth: 1024, orientation: 0, seq: 0 })).toThrow(RangeError);
  });
});

describe('wall orientation classes', () => {
  it('back edges are lower, front edges are upper', () => {
    for (const o of [Orientation.Left, Orientation.Right, Orientation.NorthCorner]) expect(wallLayer(o)).toBe(Layer.WallLower);
    for (const o of [Orientation.FrontLeft, Orientation.FrontRight, Orientation.SouthCorner]) expect(wallLayer(o)).toBe(Layer.WallUpper);
    expect(wallLayer(Orientation.Roof)).toBe(Layer.Roof);
  });
});

describe('3x3 draw order with a unit probe', () => {
  const walls = [Orientation.Left, Orientation.Right, Orientation.NorthCorner, Orientation.FrontLeft, Orientation.FrontRight, Orientation.SouthCorner];
  let seq = 0;
  const wallKey = (tx: number, ty: number, o: Orientation): bigint => tileKey(tx, ty, wallLayer(o), o, seq++);
  // unit standing at the centre of centre tile (1,1): subtile (7,7)
  const unit = unitKey(7, 7, seq++);

  it('walls on the back edges of the unit tile are drawn before the unit', () => {
    for (const o of [Orientation.Left, Orientation.Right, Orientation.NorthCorner]) {
      expect(compareKeys(wallKey(1, 1, o), unit)).toBeLessThan(0);
    }
  });
  it('walls on the front edges, and roof, of the unit tile are drawn after the unit', () => {
    for (const o of [Orientation.FrontLeft, Orientation.FrontRight, Orientation.SouthCorner]) {
      expect(compareKeys(wallKey(1, 1, o), unit)).toBeGreaterThan(0);
    }
    const roof = tileKey(1, 1, Layer.Roof, Orientation.Roof, seq++);
    expect(roof).toBeGreaterThan(unit);
    for (const o of [Orientation.FrontLeft, Orientation.FrontRight, Orientation.SouthCorner]) expect(roof).toBeGreaterThan(wallKey(1, 1, o));
  });
  it('every wall class on a nearer diagonal is after, and on a farther diagonal before, the unit', () => {
    for (const o of walls) {
      for (const [tx, ty] of [[0, 0], [1, 0], [0, 1]] as const) expect(wallKey(tx, ty, o)).toBeLessThan(unit);
      for (const [tx, ty] of [[2, 1], [1, 2], [2, 2]] as const) expect(wallKey(tx, ty, o)).toBeGreaterThan(unit);
    }
  });
  it('floors precede everything on the same diagonal; shadow sits between floor and walls', () => {
    const floor = tileKey(1, 1, Layer.Floor, 0, seq++);
    const shadow = tileKey(1, 1, Layer.FloorShadow, 0, seq++);
    expect(floor).toBeLessThan(shadow);
    expect(shadow).toBeLessThan(wallKey(1, 1, Orientation.Left));
    expect(shadow).toBeLessThan(unit);
  });
  it('every floor sorts before any shadow/wall/unit/roof, even from a farther diagonal', () => {
    const floor = tileKey(3, 3, Layer.Floor, 0, seq++);
    expect(floor).toBeLessThan(tileKey(0, 0, Layer.FloorShadow, 0, seq++));
    expect(floor).toBeLessThan(tileKey(1, 0, Layer.FloorShadow, 0, seq++)); // floor diag 6 vs shadow diag 1
    expect(floor).toBeLessThan(tileKey(0, 0, Layer.WallLower, Orientation.Left, seq++));
    expect(floor).toBeLessThan(unitKey(0, 0, seq++));
    expect(tileKey(2, 1, Layer.Floor, 0, seq++)).toBeLessThan(tileKey(0, 0, Layer.FloorShadow, 0, seq++)); // d+1 vs d
    expect(tileKey(1, 1, Layer.Floor, 0, seq++)).toBeLessThan(tileKey(2, 1, Layer.Floor, 0, seq++)); // floors keep diagonal order
  });
  it('full 3x3 sort is a strict total order matching (diag, layer, orientation)', () => {
    const items: { key: bigint; diag: number; layer: number; o: number }[] = [];
    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        items.push({ key: tileKey(tx, ty, Layer.Floor, 0, seq++), diag: 0, layer: Layer.Floor, o: 0 });
        for (const o of walls) items.push({ key: wallKey(tx, ty, o), diag: tx + ty, layer: wallLayer(o), o });
      }
    }
    items.push({ key: unit, diag: 2, layer: Layer.Unit, o: 0 });
    const sorted = [...items].sort((a, b) => compareKeys(a.key, b.key));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      expect(a.key).not.toBe(b.key);
      expect([a.diag, a.layer, a.o] <= [b.diag, b.layer, b.o] || a.diag < b.diag || (a.diag === b.diag && (a.layer < b.layer || (a.layer === b.layer && a.o <= b.o)))).toBe(true);
    }
    const ui = sorted.findIndex((s) => s.key === unit);
    // everything before the unit is on a lower diagonal or a lower layer of the same one
    for (const s of sorted.slice(0, ui)) expect(s.diag < 2 || (s.diag === 2 && s.layer < Layer.Unit)).toBe(true);
    for (const s of sorted.slice(ui + 1)) expect(s.diag > 2 || (s.diag === 2 && s.layer > Layer.Unit)).toBe(true);
  });
  it('units on the same tile order by subtile depth (further back first)', () => {
    expect(unitKey(5, 5, 1)).toBeLessThan(unitKey(7, 7, 0));
    expect(unitKey(9, 5, 0)).toBeGreaterThan(unitKey(8, 5, 0));
  });
});
