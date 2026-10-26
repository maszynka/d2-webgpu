// SPDX-License-Identifier: GPL-3.0-or-later
// Loupe geometry: a square that follows the pointer and shows the composed output under it, nearest-magnified.
import type { Rect } from './fit';

export const LOUPE_ZOOMS: readonly number[] = [2, 3, 4, 6, 8, 12, 16];
export const DEFAULT_LOUPE_ZOOM = 8;
export const DEFAULT_LOUPE_SIZE = 256; // CSS px
export const LOUPE_SIZES: readonly number[] = [128, 192, 256, 384];
export const LOUPE_GAP = 24; // device px between the pointer and the square

export function clampLoupeZoom(z: number): number {
  if (!Number.isFinite(z)) return DEFAULT_LOUPE_ZOOM;
  return LOUPE_ZOOMS.reduce((best, c) => (Math.abs(c - z) < Math.abs(best - z) ? c : best), DEFAULT_LOUPE_ZOOM);
}
/** Next zoom step (dir +1 / -1) from the current one, clamped to the list. */
export function stepLoupeZoom(z: number, dir: number): number {
  const i = LOUPE_ZOOMS.indexOf(clampLoupeZoom(z));
  return LOUPE_ZOOMS[Math.max(0, Math.min(LOUPE_ZOOMS.length - 1, i + (dir > 0 ? 1 : -1)))]!;
}
export function clampLoupeSize(s: number): number {
  return Number.isFinite(s) ? Math.max(64, Math.min(768, Math.round(s))) : DEFAULT_LOUPE_SIZE;
}

export interface LoupeLayout {
  /** the square on the canvas, device px */
  box: Rect;
  /** the canvas pixel under the pointer (the centre of the magnified area) */
  center: { x: number; y: number };
}

/** Square placed bottom-right of the pointer, flipped to the other side near an edge, always inside the canvas. */
export function loupeLayout(px: number, py: number, size: number, cw: number, ch: number, gap = LOUPE_GAP): LoupeLayout {
  const s = Math.max(1, Math.min(Math.round(size), cw, ch));
  const cx = Math.max(0, Math.min(cw - 1, Math.floor(px)));
  const cy = Math.max(0, Math.min(ch - 1, Math.floor(py)));
  let x = px + gap;
  if (x + s > cw) x = px - gap - s;
  let y = py + gap;
  if (y + s > ch) y = py - gap - s;
  x = Math.max(0, Math.min(cw - s, Math.round(x)));
  y = Math.max(0, Math.min(ch - s, Math.round(y)));
  return { box: { x, y, w: s, h: s }, center: { x: cx, y: cy } };
}

/** The canvas pixel index shown at loupe pixel `l` (0-based along one axis): the centre pixel `c` sits in the middle. Mirrors loupe.wgsl. */
export function loupeSourceIndex(l: number, size: number, zoom: number, c: number): number {
  return Math.floor(c + 0.5 + (l - Math.floor(size / 2)) / zoom);
}

/** How many canvas pixels the loupe covers along one axis. */
export function loupeCoverage(size: number, zoom: number): number {
  return size / zoom;
}
