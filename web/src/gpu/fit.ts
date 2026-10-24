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
