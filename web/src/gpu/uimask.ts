// SPDX-License-Identifier: GPL-3.0-or-later
// UI scaler for menus / HUD / panels: which pixels of the native frame are "UI" (a mask rasterised from the game's UI
// rects), and the sharp-bilinear sampling math the UI pass (shaders/ui.wgsl) mirrors.
import type { UiInfo, UiRect } from '../full/uitrailer';

export type UiScaler = 'sharp' | 'world' | 'nearest';
export const UI_SCALERS: readonly { id: UiScaler; label: string }[] = [
  { id: 'sharp', label: 'Sharp bilinear' },
  { id: 'world', label: 'Same as world' },
  { id: 'nearest', label: 'Nearest' },
];
export const DEFAULT_UI_SCALER: UiScaler = 'sharp';
export function parseUiScaler(v: unknown): UiScaler {
  return UI_SCALERS.some((m) => m.id === v) ? (v as UiScaler) : DEFAULT_UI_SCALER;
}

/** Source pixels a UI rect is grown by before rasterising (bilinear taps reach one texel past the edge). */
export const MASK_EXPAND = 1;

/** Integer nearest prescale factor of sharp bilinear: floor of the scale, at least 1. */
export function sharpPrescale(scale: number): number {
  return Math.max(1, Math.floor(scale + 1e-6));
}

export interface AxisTaps {
  /** source texels blended (clamped to [0, n-1]) and the weight of the second */
  a: number;
  b: number;
  f: number;
}
/**
 * One axis of sharp bilinear for output pixel `o` (centre o + 0.5) at scale `S` (output px per source px), integer
 * prescale `k` <= S, source size `n`. Equals "nearest prescale by k, then bilinear to S" tap for tap:
 * prescaled texel j holds source texel floor(j / k), and the bilinear taps at p = t * k are j = floor(p - 0.5), j + 1.
 */
export function sharpTaps(o: number, S: number, k: number, n: number): AxisTaps {
  const t = (o + 0.5) / S;
  const q = t * k - 0.5;
  const j = Math.floor(q);
  const clamp = (v: number): number => Math.max(0, Math.min(n - 1, v));
  return { a: clamp(Math.floor(j / k)), b: clamp(Math.floor((j + 1) / k)), f: q - j };
}

/** Reference: nearest prescale by k then bilinear (clamp to edge) to `outN` samples, on one channel. */
export function sharpBilinearRef(src: ArrayLike<number>, k: number, outN: number): number[] {
  const pre: number[] = [];
  for (let i = 0; i < src.length; i++) for (let j = 0; j < k; j++) pre.push(src[i]!);
  const S = outN / src.length;
  const out: number[] = [];
  for (let o = 0; o < outN; o++) {
    const p = ((o + 0.5) / S) * k - 0.5;
    const j = Math.floor(p);
    const f = p - j;
    const at = (x: number): number => pre[Math.max(0, Math.min(pre.length - 1, x))]!;
    out.push(at(j) * (1 - f) + at(j + 1) * f);
  }
  return out;
}

/** The sharp-bilinear value computed from taps (what the shader does) on one channel. */
export function sharpBilinearTaps(src: ArrayLike<number>, k: number, outN: number): number[] {
  const S = outN / src.length;
  const out: number[] = [];
  for (let o = 0; o < outN; o++) {
    const t = sharpTaps(o, S, k, src.length);
    out.push(src[t.a]! * (1 - t.f) + src[t.b]! * t.f);
  }
  return out;
}

export type MaskKind = 'none' | 'all' | 'rects';
export interface MaskPlan {
  kind: MaskKind;
  rects: UiRect[];
}

/** Which part of a w x h native frame is UI: menus / unknown-in-menu = all; in game = the rects; video / no info = none. */
export function planMask(info: UiInfo | null): MaskPlan {
  if (!info) return { kind: 'none', rects: [] };
  if (info.screen === 0) return { kind: 'all', rects: [] };
  if (info.screen === 1 && info.rects.length > 0) return { kind: 'rects', rects: info.rects };
  return { kind: 'none', rects: [] };
}

/** Cheap equality key of a plan at a frame size (the mask is re-uploaded only when it changes). */
export function maskKey(plan: MaskPlan, w: number, h: number): string {
  return `${plan.kind}:${w}x${h}:${plan.rects.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join(';')}`;
}

/** Rasterise rects (grown by `expand`, clipped to the frame) into a w*h coverage mask: 255 = UI, 0 = world. */
export function rasterizeMask(out: Uint8Array, w: number, h: number, rects: readonly UiRect[], expand = MASK_EXPAND): Uint8Array {
  out.fill(0, 0, w * h);
  for (const r of rects) {
    const x0 = Math.max(0, r.x - expand);
    const y0 = Math.max(0, r.y - expand);
    const x1 = Math.min(w, r.x + r.w + expand);
    const y1 = Math.min(h, r.y + r.h + expand);
    if (r.w <= 0 || r.h <= 0 || x1 <= x0 || y1 <= y0) continue;
    for (let y = y0; y < y1; y++) out.fill(255, y * w + x0, y * w + x1);
  }
  return out;
}
