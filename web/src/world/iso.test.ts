// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { screenToTile, screenToTileF, subtileToScreen, subtileToTile, tileToScreen, TILE_H, TILE_W } from './iso';
import { Camera } from './camera';

describe('iso math', () => {
  it('maps tile to screen with 160x80 diamonds', () => {
    expect(tileToScreen(0, 0)).toEqual({ x: 0, y: 0 });
    expect(tileToScreen(1, 0)).toEqual({ x: TILE_W / 2, y: TILE_H / 2 });
    expect(tileToScreen(0, 1)).toEqual({ x: -TILE_W / 2, y: TILE_H / 2 });
    expect(tileToScreen(3, 3)).toEqual({ x: 0, y: 240 });
  });
  it('round-trips tile <-> screen', () => {
    for (const [tx, ty] of [[0, 0], [5, 2], [2, 7], [9, 9]] as const) {
      const p = tileToScreen(tx, ty);
      const f = screenToTileF(p.x, p.y);
      expect(f.x).toBeCloseTo(tx);
      expect(f.y).toBeCloseTo(ty);
      // centre of the diamond belongs to the same tile
      expect(screenToTile(p.x, p.y + TILE_H / 2)).toEqual({ tx, ty });
    }
  });
  it('subtiles are 5x5 per tile (32x16 px)', () => {
    expect(subtileToScreen(1, 0)).toEqual({ x: 16, y: 8 });
    expect(subtileToScreen(5, 0)).toEqual(tileToScreen(1, 0));
    expect(subtileToScreen(0, 5)).toEqual(tileToScreen(0, 1));
    expect(subtileToTile(13, 7)).toEqual({ tx: 2, ty: 1, lx: 3, ly: 2 });
  });
});

describe('camera', () => {
  it('uses integer zoom, clamped', () => {
    const c = new Camera();
    c.setZoom(2.6);
    expect(c.zoom).toBe(3);
    c.setZoom(99);
    expect(c.zoom).toBe(4);
    c.zoomBy(-10);
    expect(c.zoom).toBe(1);
  });
  it('pans in screen space inversely and respects zoom', () => {
    const c = new Camera(100, 100);
    c.setZoom(2);
    c.panByScreen(20, -10);
    expect(c).toMatchObject({ x: 90, y: 105 });
    expect(c.origin(800, 600)).toEqual({ x: 90 - 200, y: 105 - 150 });
  });
});
