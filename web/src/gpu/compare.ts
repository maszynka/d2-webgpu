// SPDX-License-Identifier: GPL-3.0-or-later
// A/B compare: both modes present the same frame at the SAME rect (the fractional fit) so pixels line up; a vertical
// divider splits the canvas, mode A on the left, mode B on the right (one scissor per side).
import { fitRectFree, type Rect } from './fit';
import type { PresentMode, PresentPass } from './fsr';

export const SPLIT_MIN = 0.02;
export const SPLIT_MAX = 0.98;
export const DEFAULT_SPLIT = 0.5;

export function clampSplit(v: number): number {
  return Number.isFinite(v) ? Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, v)) : DEFAULT_SPLIT;
}

/** Divider position in canvas device pixels. */
export function splitPx(split: number, dstW: number): number {
  return Math.max(0, Math.min(dstW, Math.round(clampSplit(split) * dstW)));
}

/** Which pass a mode uses in compare mode (the shared rect is always the fractional fit). */
export function comparePass(mode: PresentMode, rect: Rect, srcW: number, srcH: number): PresentPass {
  if (mode === 'fsr1' || mode === 'fsr1-pixel') return rect.w > srcW || rect.h > srcH ? 'easu-rcas' : 'bilinear';
  if (mode === 'easu') return rect.w > srcW || rect.h > srcH ? 'easu' : 'bilinear';
  if (mode === 'bilinear') return 'bilinear';
  return 'nearest'; // nearest, nearest-stretch, native: nearest sampling in the shared rect
}

/** The part of `rect` inside [x0, x1) (canvas columns), or null when empty. */
export function clipColumns(rect: Rect, x0: number, x1: number): Rect | null {
  const l = Math.max(rect.x, x0);
  const r = Math.min(rect.x + rect.w, x1);
  if (r <= l || rect.h <= 0) return null;
  return { x: l, y: rect.y, w: r - l, h: rect.h };
}

export interface CompareSide {
  mode: PresentMode;
  pass: PresentPass;
  /** scissor on the canvas (null: nothing of the frame on this side) */
  scissor: Rect | null;
}
export interface ComparePlan {
  rect: Rect;
  splitPx: number;
  a: CompareSide;
  b: CompareSide;
}

export function planCompare(a: PresentMode, b: PresentMode, split: number, srcW: number, srcH: number, dstW: number, dstH: number): ComparePlan {
  const rect = fitRectFree(srcW, srcH, dstW, dstH);
  const sp = splitPx(split, dstW);
  return {
    rect,
    splitPx: sp,
    a: { mode: a, pass: comparePass(a, rect, srcW, srcH), scissor: clipColumns(rect, 0, sp) },
    b: { mode: b, pass: comparePass(b, rect, srcW, srcH), scissor: clipColumns(rect, sp, dstW) },
  };
}
