// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { maskKey, parseUiScaler, planMask, rasterizeMask, sharpBilinearRef, sharpBilinearTaps, sharpPrescale, sharpTaps } from './uimask';

describe('sharp bilinear', () => {
  it('prescale is the floor of the scale, at least 1', () => {
    expect(sharpPrescale(3.17)).toBe(3);
    expect(sharpPrescale(3)).toBe(3);
    expect(sharpPrescale(2.9999999)).toBe(3); // float noise just under an integer
    expect(sharpPrescale(1.75)).toBe(1);
    expect(sharpPrescale(0.6)).toBe(1);
  });

  it('the 4-tap form equals "nearest prescale by k, then bilinear" (several scales, with a hard edge)', () => {
    const src = [0, 0, 10, 250, 250, 40, 0, 90];
    for (const outN of [16, 24, 25, 26, 28, 20, 9, 8]) {
      const S = outN / src.length;
      const k = sharpPrescale(S);
      const ref = sharpBilinearRef(src, k, outN);
      const got = sharpBilinearTaps(src, k, outN);
      got.forEach((v, i) => expect(v).toBeCloseTo(ref[i]!, 6));
    }
  });

  it('keeps texel interiors flat and blends only a band at the edges', () => {
    // 4 source px -> 13 output px (3.25x, k = 3): interior of each texel is the pure texel colour
    const src = [0, 100, 0, 100];
    const out = sharpBilinearTaps(src, 3, 13);
    const flat = out.filter((v) => v === 0 || v === 100).length;
    expect(flat).toBeGreaterThanOrEqual(8); // plain bilinear at 3.25x would have almost none
    expect(out[0]).toBe(0);
    expect(out[12]).toBe(100);
    // monotone across each edge, no overshoot
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('is exactly nearest at an integer scale', () => {
    const src = [5, 80, 200];
    expect(sharpBilinearTaps(src, 3, 9)).toEqual([5, 5, 5, 80, 80, 80, 200, 200, 200]);
  });

  it('clamps the taps at the frame edges', () => {
    const t = sharpTaps(0, 3.2, 3, 8);
    expect(t.a).toBe(0);
    const e = sharpTaps(25, 3.2, 3, 8);
    expect(e.b).toBeLessThanOrEqual(7);
  });

  it('parses the setting (default sharp)', () => {
    expect(parseUiScaler('world')).toBe('world');
    expect(parseUiScaler('nearest')).toBe('nearest');
    expect(parseUiScaler('junk')).toBe('sharp');
    expect(parseUiScaler(null)).toBe('sharp');
  });
});

describe('UI mask', () => {
  const at = (m: Uint8Array, w: number, x: number, y: number): number => m[y * w + x]!;

  it('rasterises a rect grown by one source pixel', () => {
    const w = 20;
    const m = rasterizeMask(new Uint8Array(w * 10), w, 10, [{ x: 5, y: 3, w: 4, h: 2 }]);
    expect(at(m, w, 5, 3)).toBe(255);
    expect(at(m, w, 8, 4)).toBe(255);
    expect(at(m, w, 4, 2)).toBe(255); // expansion
    expect(at(m, w, 9, 5)).toBe(255);
    expect(at(m, w, 3, 3)).toBe(0);
    expect(at(m, w, 10, 4)).toBe(0);
    expect(at(m, w, 5, 6)).toBe(0);
  });

  it('clips to the frame and ignores empty / outside rects', () => {
    const w = 8;
    const h = 6;
    const m = rasterizeMask(new Uint8Array(w * h), w, h, [
      { x: -5, y: -5, w: 7, h: 7 },
      { x: 100, y: 100, w: 5, h: 5 },
      { x: 3, y: 3, w: 0, h: 4 },
    ]);
    expect(at(m, w, 0, 0)).toBe(255);
    expect(at(m, w, 2, 2)).toBe(255);
    expect(at(m, w, 3, 3)).toBe(0); // 7 - 5 = 2, +1 expansion: cols/rows 0..2
    expect(at(m, w, 7, 5)).toBe(0);
    expect(m.reduce((a, v) => a + (v ? 1 : 0), 0)).toBe(9);
  });

  it('clears the previous frame\'s coverage (the buffer is reused)', () => {
    const buf = new Uint8Array(16).fill(255);
    rasterizeMask(buf, 4, 4, []);
    expect(buf.every((v) => v === 0)).toBe(true);
  });

  it('plans: menu = whole frame, game = rects, video / unknown = none', () => {
    expect(planMask({ screen: 0, rects: [] }).kind).toBe('all');
    expect(planMask({ screen: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] }).kind).toBe('rects');
    expect(planMask({ screen: 1, rects: [] }).kind).toBe('none');
    expect(planMask({ screen: 2, rects: [] }).kind).toBe('none');
    expect(planMask(null).kind).toBe('none');
  });

  it('keys change with kind, size and rects only', () => {
    const a = planMask({ screen: 1, rects: [{ x: 1, y: 2, w: 3, h: 4 }] });
    const b = planMask({ screen: 1, rects: [{ x: 1, y: 2, w: 3, h: 5 }] });
    expect(maskKey(a, 800, 600)).toBe(maskKey(a, 800, 600));
    expect(maskKey(a, 800, 600)).not.toBe(maskKey(b, 800, 600));
    expect(maskKey(a, 800, 600)).not.toBe(maskKey(a, 1000, 600));
  });
});
