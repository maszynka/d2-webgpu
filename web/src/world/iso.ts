// SPDX-License-Identifier: GPL-3.0-or-later
// Isometric math. D2 tile = 160x80 px diamond, 5x5 subtiles (32x16 px each).

export const TILE_W = 160;
export const TILE_H = 80;
export const SUBTILES = 5;
export const SUBTILE_W = TILE_W / SUBTILES; // 32
export const SUBTILE_H = TILE_H / SUBTILES; // 16

export interface Vec2 {
  x: number;
  y: number;
}

/** Screen position (world pixels) of the top vertex of tile (tx, ty). */
export function tileToScreen(tx: number, ty: number): Vec2 {
  return { x: (tx - ty) * (TILE_W / 2), y: (tx + ty) * (TILE_H / 2) };
}

/** Inverse of tileToScreen for a point; returns fractional tile coordinates measured from the top vertex. */
export function screenToTileF(x: number, y: number): Vec2 {
  const a = x / (TILE_W / 2); // tx - ty
  const b = y / (TILE_H / 2); // tx + ty
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Tile containing a screen point (point inside diamond whose top vertex is tileToScreen(tx,ty)). */
export function screenToTile(x: number, y: number): { tx: number; ty: number } {
  const f = screenToTileF(x, y);
  return { tx: Math.floor(f.x), ty: Math.floor(f.y) };
}

/** Screen position of the top vertex of subtile (sx, sy). */
export function subtileToScreen(sx: number, sy: number): Vec2 {
  return { x: (sx - sy) * (SUBTILE_W / 2), y: (sx + sy) * (SUBTILE_H / 2) };
}

export function subtileToTile(sx: number, sy: number): { tx: number; ty: number; lx: number; ly: number } {
  const tx = Math.floor(sx / SUBTILES);
  const ty = Math.floor(sy / SUBTILES);
  return { tx, ty, lx: sx - tx * SUBTILES, ly: sy - ty * SUBTILES };
}
