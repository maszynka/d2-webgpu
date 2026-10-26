// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { UNLIT, SurfaceKind, packAux } from './surface';
import { DrawList, INSTANCE_WORDS, type BlendMode, type DrawRecord } from './drawlist';

function rec(sortKey: bigint, blend: BlendMode, x = 0): DrawRecord {
  return { atlasRect: { x: 1, y: 2, w: 3, h: 4 }, x, y: -7, w: 3, h: 4, sortKey, blend, colormapRow: 5, paletteRow: 6, surface: UNLIT };
}

describe('DrawList', () => {
  it('sorts by key and keeps insertion order for ties', () => {
    const l = new DrawList();
    l.add(rec(5n, 'opaque', 0));
    l.add(rec(1n, 'opaque', 1));
    l.add(rec(5n, 'opaque', 2));
    l.add(rec(3n, 'opaque', 3));
    expect(l.sorted().map((r) => r.x)).toEqual([1, 3, 0, 2]);
  });
  it('batches runs of equal blend and preserves global order', () => {
    const l = new DrawList();
    const blends: BlendMode[] = ['opaque', 'opaque', 'additive', 'opaque', 'alpha50', 'alpha50', 'darken', 'opaque'];
    blends.forEach((b, i) => l.add(rec(BigInt(i), b, i)));
    const { batches, order } = l.build();
    expect(order.map((r) => r.x)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(batches).toEqual([
      { blend: 'opaque', first: 0, count: 2 },
      { blend: 'additive', first: 2, count: 1 },
      { blend: 'opaque', first: 3, count: 1 },
      { blend: 'alpha50', first: 4, count: 2 },
      { blend: 'darken', first: 6, count: 1 },
      { blend: 'opaque', first: 7, count: 1 },
    ]);
  });
  it('does not merge same-blend records separated by a different blend after sorting', () => {
    const l = new DrawList();
    l.add(rec(10n, 'opaque'));
    l.add(rec(5n, 'additive'));
    l.add(rec(1n, 'opaque'));
    expect(l.build().batches.map((b) => b.blend)).toEqual(['opaque', 'additive', 'opaque']);
  });
  it('encodes instance data', () => {
    const l = new DrawList();
    l.add(rec(0n, 'opaque', 42));
    const { data } = l.build();
    const u = new Uint32Array(data);
    const s = new Int32Array(data);
    expect(data.byteLength).toBe(INSTANCE_WORDS * 4);
    expect([...u.slice(0, 4)]).toEqual([1, 2, 3, 4]);
    expect([s[4], s[5]]).toEqual([42, -7]);
    expect([...u.slice(6, 10)]).toEqual([3, 4, 5, 6]);
  });
  it('encodes the surface: packed aux byte and anchor (default = sprite bottom)', () => {
    const l = new DrawList();
    l.add({ ...rec(0n, 'opaque'), surface: { kind: SurfaceKind.WallSe, normal: 2, anchor: 123 } });
    l.add({ ...rec(1n, 'opaque'), surface: { kind: SurfaceKind.Card, normal: 3 } });
    const s = new Int32Array(l.build().data);
    expect([s[10], s[11]]).toEqual([packAux(SurfaceKind.WallSe, 2), 123]);
    expect([s[22], s[23]]).toEqual([packAux(SurfaceKind.Card, 3), -7 + 4]);
  });
  it('does not let the surface change the sort order', () => {
    const l = new DrawList();
    l.add({ ...rec(2n, 'opaque', 0), surface: { kind: SurfaceKind.Card, normal: 3 } });
    l.add({ ...rec(1n, 'opaque', 1), surface: { kind: SurfaceKind.Floor, normal: 0 } });
    expect(l.sorted().map((r) => r.x)).toEqual([1, 0]);
  });
  it('handles an empty list', () => {
    expect(new DrawList().build()).toMatchObject({ batches: [], order: [] });
  });
});
