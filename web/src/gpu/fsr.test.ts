// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fitRect, fitRectFree } from './fit';
import { DEFAULT_SHARPNESS, clampSharpness, easuConstants, packParams, parsePresentMode, planPresent, rcasAttenuation } from './fsr';

describe('EASU constants (FsrEasuCon from ffx_fsr1.h)', () => {
  const c = easuConstants(800, 600, 800, 600, 1600, 1200);
  it('maps output pixels to input pixels with the half-pixel shift', () => {
    expect([c[0], c[1]]).toEqual([0.5, 0.5]); // viewport / output
    expect(c[2]).toBeCloseTo(0.5 * 0.5 - 0.5); // 0.5 * view/out - 0.5 = -0.25
    expect(c[3]).toBeCloseTo(-0.25);
  });
  it('has the reciprocal texture size and gather offsets', () => {
    const rx = Math.fround(1 / 800);
    const ry = Math.fround(1 / 600);
    expect([c[4], c[5]]).toEqual([rx, ry]);
    expect([c[6], c[7]]).toEqual([rx, -ry]);
    expect([c[8], c[9]]).toEqual([-rx, Math.fround(2 / 600)]);
    expect([c[10], c[11]]).toEqual([rx, Math.fround(2 / 600)]);
    expect([c[12], c[13]]).toEqual([0, Math.fround(4 / 600)]);
    expect([c[14], c[15]]).toEqual([0, 0]);
  });
  it('uses the viewport (not the texture) for the position ratio when they differ', () => {
    const d = easuConstants(400, 300, 800, 600, 1000, 750);
    expect(d[0]).toBeCloseTo(0.4);
    expect(d[4]).toBeCloseTo(1 / 800);
  });
});

describe('RCAS sharpness (FsrRcasCon: attenuation = exp2(-stops))', () => {
  it('0 stops is the sharpest, 2 stops a quarter, default 0.2', () => {
    expect(rcasAttenuation(0)).toBe(1);
    expect(rcasAttenuation(1)).toBe(0.5);
    expect(rcasAttenuation(2)).toBe(0.25);
    expect(rcasAttenuation(DEFAULT_SHARPNESS)).toBeCloseTo(0.8706, 3);
  });
  it('clamps to 0..2', () => {
    expect(clampSharpness(-1)).toBe(0);
    expect(clampSharpness(5)).toBe(2);
    expect(clampSharpness(NaN)).toBe(DEFAULT_SHARPNESS);
    expect(rcasAttenuation(9)).toBe(0.25);
  });
  it('packs the uniform block: 16 EASU floats, attenuation, rect origin', () => {
    const out = packParams(new Float32Array(20), easuConstants(2, 2, 2, 2, 4, 4), 1, { x: 7, y: 9, w: 4, h: 4 });
    expect(out[0]).toBe(0.5);
    expect([out[16], out[17], out[18]]).toEqual([0.5, 7, 9]);
  });
});

describe('fit', () => {
  it('integer fit: scale floor, centred', () => {
    expect(fitRect(800, 600, 1700, 1300)).toEqual({ x: 50, y: 50, w: 1600, h: 1200 });
  });
  it('free fit fills one axis exactly and letterboxes the other', () => {
    expect(fitRectFree(800, 600, 1950, 1000)).toEqual({ x: 308, y: 0, w: 1333, h: 1000 });
    expect(fitRectFree(1066, 600, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1919, h: 1080 });
    const r = fitRectFree(800, 600, 400, 400);
    expect(r).toEqual({ x: 0, y: 50, w: 400, h: 300 });
  });
  it('never exceeds the destination', () => {
    for (const [w, h] of [[1, 1], [3, 2000], [2000, 3], [1951, 999]] as const) {
      const r = fitRectFree(1067, 600, w, h);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(w);
      expect(r.y + r.h).toBeLessThanOrEqual(h);
    }
  });
});

describe('presentation mode selection', () => {
  it('fsr1 uses EASU + RCAS when the output is larger than the source', () => {
    expect(planPresent('fsr1', 800, 600, 1950, 1000).pass).toBe('easu-rcas');
    expect(planPresent('fsr1', 1067, 600, 1920, 1080).pass).toBe('easu-rcas');
  });
  it('fsr1 falls back to bilinear when the output is not larger (downscale or 1:1)', () => {
    expect(planPresent('fsr1', 800, 600, 640, 480).pass).toBe('bilinear');
    expect(planPresent('fsr1', 800, 600, 800, 600).pass).toBe('bilinear');
    expect(planPresent('fsr1', 1400, 600, 1000, 500).pass).toBe('bilinear');
  });
  it('nearest is integer scaled, bilinear and fsr1 fill the canvas', () => {
    const n = planPresent('nearest', 800, 600, 1950, 1000);
    expect(n.pass).toBe('nearest');
    expect(n.rect).toEqual({ x: 575, y: 200, w: 800, h: 600 });
    const b = planPresent('bilinear', 800, 600, 1950, 1000);
    expect(b.pass).toBe('bilinear');
    expect(b.rect.h).toBe(1000);
  });
  it('parses stored modes, defaulting to fsr1', () => {
    expect(parsePresentMode('nearest')).toBe('nearest');
    expect(parsePresentMode('bilinear')).toBe('bilinear');
    expect(parsePresentMode('weird')).toBe('fsr1');
    expect(parsePresentMode(null)).toBe('fsr1');
  });
});
