// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AUX_DRAWN, NORMALS, NORMAL_COUNT, NormalSlot, SurfaceKind, isLitKind, packAux, surfaceWgslConstants, unpackAux } from './surface';

describe('aux packing', () => {
  it('round-trips every kind and normal', () => {
    for (const kind of Object.values(SurfaceKind)) {
      for (let n = 0; n < NORMAL_COUNT; n++) {
        const a = packAux(kind, n);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(256);
        expect(unpackAux(a)).toEqual({ drawn: true, kind, normal: n });
      }
    }
  });
  it('is AUX_DRAWN | kind << 4 | normal', () => {
    expect(packAux(SurfaceKind.Card, 3)).toBe(0x80 | (5 << 4) | 3);
    expect(packAux(7, 15)).toBe(255);
  });
  it('never packs to 0: aux 0 is reserved for "nothing drawn" (even unlit kind + normal 0)', () => {
    expect(packAux(SurfaceKind.Unlit, 0)).toBe(AUX_DRAWN);
    for (const kind of Object.values(SurfaceKind)) for (let n = 0; n < NORMAL_COUNT; n++) expect(packAux(kind, n) & AUX_DRAWN).toBe(AUX_DRAWN);
    expect(unpackAux(0).drawn).toBe(false);
  });
  it('rejects out-of-range values', () => {
    expect(() => packAux(8, 0)).toThrow(RangeError);
    expect(() => packAux(0, NORMAL_COUNT)).toThrow(RangeError);
    expect(() => packAux(-1, 0)).toThrow(RangeError);
  });
});

describe('normals and kinds', () => {
  it('has 16 unit normals with the fixed slots', () => {
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
    expect(w).toContain('const NORMAL_COUNT: u32 = 16u;');
    expect(w).toContain('const AUX_DRAWN: u32 = 128u;');
    expect(w).toContain('const AUX_KIND_SHIFT: u32 = 4u;');
    expect(w).toContain('const AUX_NORMAL_MASK: u32 = 15u;');
  });
});
