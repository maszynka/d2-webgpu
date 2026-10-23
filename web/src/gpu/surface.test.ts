// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { NORMALS, NORMAL_COUNT, NormalSlot, SurfaceKind, isLitKind, packAux, surfaceWgslConstants, unpackAux } from './surface';

describe('aux packing', () => {
  it('round-trips every kind and normal', () => {
    for (const kind of Object.values(SurfaceKind)) {
      for (let n = 0; n < NORMAL_COUNT; n++) {
        const a = packAux(kind, n);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(256);
        expect(unpackAux(a)).toEqual({ kind, normal: n });
      }
    }
  });
  it('is kind << 5 | normal', () => {
    expect(packAux(SurfaceKind.Card, 3)).toBe((5 << 5) | 3);
    expect(packAux(7, 31)).toBe(255);
  });
  it('rejects out-of-range values', () => {
    expect(() => packAux(8, 0)).toThrow(RangeError);
    expect(() => packAux(0, 32)).toThrow(RangeError);
    expect(() => packAux(-1, 0)).toThrow(RangeError);
  });
});

describe('normals and kinds', () => {
  it('has 32 unit normals with the fixed slots', () => {
    expect(NORMALS).toHaveLength(NORMAL_COUNT);
    for (const n of NORMALS) expect(Math.hypot(...n)).toBeCloseTo(1, 6);
    expect(NORMALS[NormalSlot.Up]).toEqual([0, 0, 1]);
    expect(NORMALS[NormalSlot.WallSw]![0]).toBeLessThan(0);
    expect(NORMALS[NormalSlot.WallSe]![0]).toBeGreaterThan(0);
  });
  it('only unlit and card_emissive are unlit', () => {
    expect(Object.values(SurfaceKind).filter((k) => !isLitKind(k))).toEqual([SurfaceKind.Unlit, SurfaceKind.CardEmissive]);
  });
  it('generates WGSL consts matching the tables', () => {
    const w = surfaceWgslConstants(32);
    expect(w).toContain('const KIND_CARD_EMISSIVE: u32 = 6u;');
    expect(w).toContain('const KIND_WALL_BLENDED: u32 = 7u;');
    expect(w).toContain('const NORM_CORNER_NORTH: u32 = 4u;');
    expect(w).toContain('const NORM_CARD_TILT0: u32 = 8u;');
    expect(w).toContain('const MAX_LIGHTS: u32 = 32u;');
  });
});
