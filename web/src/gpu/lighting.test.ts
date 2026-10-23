// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  LIGHT_PARAMS_BYTES,
  MAX_LIGHTS,
  authenticRow,
  lightMultiplier,
  luma,
  packLightParams,
  shadePixel,
  type Light,
  type LightingState,
  type ShadeTables,
} from './lighting';
import { NORMALS, NormalSlot, SurfaceKind } from './surface';
import { makeDemoColormaps, makeDemoPalette } from '../demo/palette';

const light = (x: number, y: number, z = 40, radius = 400, intensity = 1): Light => ({ x, y, z, radius, color: [1, 1, 1], intensity });

describe('light buffer packing', () => {
  it('lays out head, ambient, normals and lights', () => {
    const lights: Light[] = [
      { x: 1, y: 2, z: 3, radius: 4, color: [0.5, 0.25, 0.125], intensity: 2 },
      light(9, 8),
    ];
    const buf = packLightParams({ mode: 'authentic', ambient: [0.1, 0.2, 0.3], lights }, 8);
    expect(buf.byteLength).toBe(LIGHT_PARAMS_BYTES);
    expect(LIGHT_PARAMS_BYTES).toBe(16 + 16 + 32 * 16 + 32 * 32);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    expect([...u.slice(0, 4)]).toEqual([2, 2, 0, 7]);
    expect([...f.slice(4, 7)].map((v) => +v.toFixed(3))).toEqual([0.1, 0.2, 0.3]);
    expect([...f.slice(8 + NormalSlot.WallSe * 4, 8 + NormalSlot.WallSe * 4 + 3)]).toEqual([...NORMALS[NormalSlot.WallSe]!].map(Math.fround));
    const base = 8 + 32 * 4;
    expect([...f.slice(base, base + 8)]).toEqual([1, 2, 3, 4, 0.5, 0.25, 0.125, 2]);
    expect(f[base + 8]).toBe(9);
  });
  it('clamps to MAX_LIGHTS and honours explicit rows; scalar ambient is replicated', () => {
    const many = Array.from({ length: 40 }, (_, i) => light(i, 0));
    const buf = packLightParams({ mode: 'smooth', ambient: 0.4, lights: many, brightRow: 1, darkRow: 5 }, 8);
    const u = new Uint32Array(buf);
    expect([u[0], u[1], u[2], u[3]]).toEqual([MAX_LIGHTS, 1, 1, 5]);
    const f = new Float32Array(buf);
    expect([f[4]!, f[5]!, f[6]!].map((v) => +v.toFixed(3))).toEqual([0.4, 0.4, 0.4]);
  });
});

describe('CPU reference lighting', () => {
  // Wall pixel at screen (0, 0), height 30. Light to its SE (screen right-down) in the ground plane.
  const seLight = light(60, 30, 30); // 60 right, 30 down on screen = 60 down in light space
  it('a wall facing the light is brighter than one facing away', () => {
    const facing = lightMultiplier(0, 0, 30, NormalSlot.WallSe, [seLight], 0.1);
    const away = lightMultiplier(0, 0, 30, NormalSlot.WallSw, [seLight], 0.1); // perpendicular: no direct light
    const back = lightMultiplier(0, 0, 30, NormalSlot.WallSe, [light(-60, -30, 30)], 0.1); // light behind the wall
    expect(luma(facing)).toBeGreaterThan(luma(away) + 0.1);
    expect(luma(away)).toBeCloseTo(0.1, 5);
    expect(luma(back)).toBeCloseTo(0.1, 5);
  });
  it('SW and SE walls pick the matching side of a light', () => {
    const swLight = light(-60, 30, 30);
    const a = luma(lightMultiplier(0, 0, 30, NormalSlot.WallSw, [swLight], 0));
    const b = luma(lightMultiplier(0, 0, 30, NormalSlot.WallSe, [swLight], 0));
    expect(a).toBeGreaterThan(0.1);
    expect(b).toBeCloseTo(0, 5);
  });
  it('falls off monotonically with distance and is 0 at the radius', () => {
    let prev = Infinity;
    for (let d = 0; d <= 400; d += 20) {
      const v = luma(lightMultiplier(d, 0, 0, NormalSlot.Up, [light(0, 0, 60, 400)], 0));
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
    expect(prev).toBe(0);
    expect(luma(lightMultiplier(1000, 0, 0, NormalSlot.Up, [light(0, 0, 60, 400)], 0.2))).toBeCloseTo(0.2, 6);
  });
  it('floor is lit more from above than from the side, ambient adds, lights add', () => {
    const above = luma(lightMultiplier(0, 0, 0, NormalSlot.Up, [light(0, 0, 100)], 0));
    const side = luma(lightMultiplier(0, 0, 0, NormalSlot.Up, [light(100, 0, 5)], 0));
    expect(above).toBeGreaterThan(side);
    const one = luma(lightMultiplier(0, 0, 0, NormalSlot.Up, [light(0, 0, 100)], 0.1));
    const two = luma(lightMultiplier(0, 0, 0, NormalSlot.Up, [light(0, 0, 100), light(0, 0, 100)], 0.1));
    expect(two - 0.1).toBeCloseTo(2 * (one - 0.1), 6);
  });
  it('reconstructs the ground point as (x, y + z): same ground point, different height, different light', () => {
    const l = light(0, 160, 60, 500);
    const low = lightMultiplier(0, 100, 0, NormalSlot.CardFlat, [l], 0); // pixel at the feet
    const high = lightMultiplier(0, 50, 50, NormalSlot.CardFlat, [l], 0); // 50 px above the same feet
    expect(high.r).not.toBeCloseTo(low.r, 3);
    // a card pixel at the same screen spot but with feet further away (larger z) is lit as a different point
    const farther = lightMultiplier(0, 100, 50, NormalSlot.CardFlat, [l], 0);
    expect(farther.r).not.toBeCloseTo(high.r, 3);
  });
  it('coloured lights tint', () => {
    const m = lightMultiplier(0, 0, 0, NormalSlot.Up, [{ ...light(0, 0, 60), color: [1, 0.2, 0] }], 0);
    expect(m.r).toBeGreaterThan(m.g);
    expect(m.b).toBe(0);
  });
});

describe('shadePixel (the lighting pass per pixel)', () => {
  const pal = makeDemoPalette(0);
  const cm = makeDemoColormaps(8);
  const tables: ShadeTables = {
    palette: (i) => ({ r: (pal[i * 4] ?? 0) / 255, g: (pal[i * 4 + 1] ?? 0) / 255, b: (pal[i * 4 + 2] ?? 0) / 255 }),
    colormap: (row, i) => cm[row * 256 + i] ?? 0,
  };
  const idx = 6 * 16 + 12;
  const px = (kind: number, normal: number = NormalSlot.WallSe) => ({ index: idx, kind, normal, sx: 0, sy: 0, z: 30 });
  const st = (mode: LightingState['mode'], ambient = 0.15): LightingState => ({ mode, ambient, lights: [light(60, 30, 30)] });

  it('off, unlit and card_emissive return the palette colour unchanged', () => {
    const base = tables.palette(idx);
    expect(shadePixel(px(SurfaceKind.WallSe), st('off'), tables, 8)).toEqual(base);
    expect(shadePixel(px(SurfaceKind.Unlit), st('smooth'), tables, 8)).toEqual(base);
    expect(shadePixel(px(SurfaceKind.CardEmissive), st('smooth'), tables, 8)).toEqual(base);
    expect(shadePixel(px(SurfaceKind.Unlit), st('authentic'), tables, 8)).toEqual(base);
    expect(shadePixel(px(SurfaceKind.CardEmissive), st('authentic'), tables, 8)).toEqual(base);
  });
  it('smooth multiplies the palette colour by the light and clamps to 1', () => {
    const base = tables.palette(idx);
    const m = lightMultiplier(0, 0, 30, NormalSlot.WallSe, st('smooth').lights, 0.15);
    const out = shadePixel(px(SurfaceKind.WallSe), st('smooth'), tables, 8);
    expect(out.r).toBeCloseTo(Math.min(1, base.r * m.r), 9);
    const bright = shadePixel(px(SurfaceKind.WallSe), { ...st('smooth'), ambient: 5 }, tables, 8);
    expect(bright).toEqual({ r: Math.min(1, base.r * 5), g: Math.min(1, base.g * 5), b: Math.min(1, base.b * 5) });
  });
  it('wall facing the light is brighter than facing away, in both modes', () => {
    for (const mode of ['smooth', 'authentic'] as const) {
      const facing = luma(shadePixel(px(SurfaceKind.WallSe, NormalSlot.WallSe), st(mode), tables, 8));
      const away = luma(shadePixel(px(SurfaceKind.WallSw, NormalSlot.WallSw), st(mode), tables, 8));
      expect(facing).toBeGreaterThan(away);
    }
  });
  it('authentic quantises light to a colormap row (monochrome)', () => {
    expect(authenticRow({ r: 1, g: 1, b: 1 }, 0, 7)).toBe(0);
    expect(authenticRow({ r: 0, g: 0, b: 0 }, 0, 7)).toBe(7);
    expect(authenticRow({ r: 9, g: 9, b: 9 }, 0, 7)).toBe(0);
    const rows = new Set<number>();
    for (let l = 0; l <= 100; l++) rows.add(authenticRow({ r: l / 100, g: l / 100, b: l / 100 }, 0, 7));
    expect([...rows].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // output is exactly one of the palette entries reachable through a colormap row
    const reachable = new Set<number>();
    for (let r = 0; r < 8; r++) reachable.add(JSON.stringify(tables.palette(tables.colormap(r, idx))) as unknown as number);
    const out = shadePixel(px(SurfaceKind.WallSe), { ...st('authentic'), lights: [light(60, 30, 30, 400, 0.5)] }, tables, 8);
    expect(reachable.has(JSON.stringify(out) as unknown as number)).toBe(true);
    // coloured light does not tint in authentic mode
    const tinted = shadePixel(px(SurfaceKind.WallSe), { ...st('authentic'), lights: [{ ...light(60, 30, 30), color: [1, 0, 0] }] }, tables, 8);
    const white = shadePixel(px(SurfaceKind.WallSe), { ...st('authentic'), lights: [{ ...light(60, 30, 30), color: [0.299, 0.299, 0.299] }] }, tables, 8);
    expect(tinted).toEqual(white);
  });
});
