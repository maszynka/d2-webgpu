// SPDX-License-Identifier: GPL-3.0-or-later
// Where a frame of a given size sits on a canvas (device pixels).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fit src into dst keeping the aspect: integer scale when >= 1 ("nearest (integer)"), else a fractional fit. */
export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number): Rect {
  const f = Math.min(dstW / srcW, dstH / srcH);
  const s = f >= 1 ? Math.floor(f) : f;
  const w = Math.max(1, Math.floor(srcW * s));
  const h = Math.max(1, Math.floor(srcH * s));
  return { x: Math.floor((dstW - w) / 2), y: Math.floor((dstH - h) / 2), w, h };
}

/** Fit src into dst keeping the aspect at any (fractional) scale: letterbox, one axis fills the destination exactly. */
export function fitRectFree(srcW: number, srcH: number, dstW: number, dstH: number): Rect {
  let w: number;
  let h: number;
  if (dstW * srcH <= dstH * srcW) {
    w = dstW;
    h = Math.max(1, Math.round((srcH * dstW) / srcW));
  } else {
    h = dstH;
    w = Math.max(1, Math.round((srcW * dstH) / srcH));
  }
  w = Math.min(w, dstW);
  h = Math.min(h, dstH);
  return { x: Math.floor((dstW - w) / 2), y: Math.floor((dstH - h) / 2), w, h };
}

/** "Off (1:1)": the source unscaled (one source pixel = one device pixel), centred; downscaled to fit only when it is larger than the canvas. */
export function nativeRect(srcW: number, srcH: number, dstW: number, dstH: number): Rect {
  if (srcW > dstW || srcH > dstH) return fitRect(srcW, srcH, dstW, dstH);
  return { x: Math.floor((dstW - srcW) / 2), y: Math.floor((dstH - srcH) / 2), w: srcW, h: srcH };
}

/**
 * Canvas backing-store size: the browser's exact device-pixel box when it reported one (no compositor resample at
 * fractional DPR / page zoom), else round(client * dpr); both capped at the texture limit.
 */
export function backingSize(devPx: { w: number; h: number } | null, clientW: number, clientH: number, dpr: number, max: number): { w: number; h: number } {
  const w = devPx && devPx.w > 0 ? devPx.w : Math.round(clientW * dpr);
  const h = devPx && devPx.h > 0 ? devPx.h : Math.round(clientH * dpr);
  return { w: Math.min(max, Math.max(1, Math.round(w))), h: Math.min(max, Math.max(1, Math.round(h))) };
}
