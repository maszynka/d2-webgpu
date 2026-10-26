// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ShelfPacker, type AtlasRect } from './atlas';
import { fitRect } from './renderer';

function overlaps(a: AtlasRect, b: AtlasRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('ShelfPacker', () => {
  it('packs along a shelf then opens a new one', () => {
    const p = new ShelfPacker(100, 100);
    expect(p.pack(40, 10)).toEqual({ x: 0, y: 0, w: 40, h: 10 });
    expect(p.pack(40, 8)).toEqual({ x: 40, y: 0, w: 40, h: 8 });
    expect(p.pack(40, 8)).toEqual({ x: 0, y: 10, w: 40, h: 8 });
  });
  it('rejects oversize and full cases', () => {
    const p = new ShelfPacker(16, 16);
    expect(p.pack(17, 1)).toBeNull();
    expect(p.pack(16, 16)).not.toBeNull();
    expect(p.pack(1, 1)).toBeNull();
  });
  it('never overlaps and stays in bounds for many random sizes', () => {
    const p = new ShelfPacker(256, 256);
    const placed: AtlasRect[] = [];
    let s = 12345;
    const rnd = (n: number): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % n) + 1;
    for (let i = 0; i < 300; i++) {
      const r = p.pack(rnd(40), rnd(40));
      if (!r) continue;
      expect(r.x + r.w).toBeLessThanOrEqual(256);
      expect(r.y + r.h).toBeLessThanOrEqual(256);
      for (const o of placed) expect(overlaps(r, o)).toBe(false);
      placed.push(r);
    }
    expect(placed.length).toBeGreaterThan(50);
  });
  it('gives zero-sized sprites a 1x1 slot', () => {
    expect(new ShelfPacker(8, 8).pack(0, 0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('fitRect', () => {
  it('uses integer scaling when it fits and centres', () => {
    expect(fitRect(800, 600, 1700, 1300)).toEqual({ x: 50, y: 50, w: 1600, h: 1200 });
  });
  it('falls back to fractional fit when smaller than native', () => {
    const r = fitRect(800, 600, 400, 400);
    expect(r.w).toBe(400);
    expect(r.h).toBe(300);
    expect(r.y).toBe(50);
  });
});
