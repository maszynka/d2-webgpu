// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FSRCNNX_FLOAT_COUNT, FSRCNNX_HEADER_BYTES, FSRCNNX_PASSES } from './fsrcnnx-layout';
import { bilinear2x, fsrcnnxReference, type RefImage } from './fsrcnnx-ref';
import { parseFsrcnnxWeights } from './fsrcnnx-weights';

const bytes = readFileSync(new URL('../../../public/fsrcnnx-8-0-4-1.bin', import.meta.url));
const weights = parseFsrcnnxWeights(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

/** vertical step edge (dark left, light right) with a slight 1px antialias ramp, RGBA8 grey */
function stepEdge(w: number, h: number, lo = 40, hi = 215): RefImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = x < w / 2 ? lo : hi;
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

describe('fsrcnnx layout and weights', () => {
  it('file size matches the layout and header carries the licence notice', () => {
    expect(bytes.length).toBe(FSRCNNX_HEADER_BYTES + FSRCNNX_FLOAT_COUNT * 4);
    expect(bytes.subarray(0, FSRCNNX_HEADER_BYTES).toString('ascii')).toContain('Lesser General Public License v3.0');
    expect(weights.length).toBe(FSRCNNX_FLOAT_COUNT);
  });
  it('has the 14 hook passes with the expected shapes', () => {
    expect(FSRCNNX_PASSES.length).toBe(14);
    const kinds = FSRCNNX_PASSES.map((p) => p.kind);
    expect(kinds.filter((k) => k === 'luma-conv').length).toBe(2);
    expect(kinds.filter((k) => k === 'conv').length).toBe(11);
    for (const p of FSRCNNX_PASSES) {
      if (p.kind === 'luma-conv') expect(p.terms.length).toBe(25);
      if (p.kind === 'conv') expect(p.terms.length).toBe(p.radius === 1 ? 18 : 2);
    }
  });
});

describe('fsrcnnx CPU reference', () => {
  it('outputs 2x size, finite, within 0..1', () => {
    const r = fsrcnnxReference(stepEdge(12, 10), weights);
    expect(r.width).toBe(24);
    expect(r.height).toBe(20);
    expect(r.rgb.length).toBe(24 * 20 * 3);
    expect(r.rgb.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
  });
  it('keeps flat areas flat (no DC shift beyond a few levels)', () => {
    const r = fsrcnnxReference(stepEdge(16, 16, 128, 128), weights);
    const mid = r.rgb[(16 * 32 + 16) * 3]!;
    expect(Math.abs(mid - 128 / 255)).toBeLessThan(4 / 255);
  });
  it('is sharper than bilinear on a step edge', () => {
    const img = stepEdge(16, 16);
    const r = fsrcnnxReference(img, weights);
    const bil = bilinear2x(img);
    const row = 16;
    const n = 32;
    // transition width: output pixels strictly between 10% and 90% of the contrast
    const lo = 40 / 255;
    const hi = 215 / 255;
    const width = (get: (x: number) => number): number => {
      let k = 0;
      for (let x = 0; x < n; x++) {
        const t = (get(x) - lo) / (hi - lo);
        if (t > 0.1 && t < 0.9) k++;
      }
      return k;
    };
    const wRef = width((x) => r.rgb[(row * n + x) * 3]!);
    const wBil = width((x) => bil[(row * n + x) * 3]!);
    expect(wBil).toBeGreaterThanOrEqual(2);
    expect(wRef).toBeLessThan(wBil);
  });
});
