// SPDX-License-Identifier: GPL-3.0-or-later
// Render density: "Retina (auto)" renders at device pixels (canvas backing = CSS px * devicePixelRatio, the exact
// device-pixel box when the browser reports one); "1x" renders at CSS pixels and lets the compositor scale the canvas,
// so the upscalers run at a smaller scale (about a quarter of the pixels at DPR 2).
export type Density = 'auto' | '1';
export const DENSITIES: readonly { id: Density; label: string }[] = [
  { id: 'auto', label: 'Retina (auto)' },
  { id: '1', label: '1×' },
];
export const DEFAULT_DENSITY: Density = 'auto';
export function parseDensity(v: unknown): Density {
  return v === '1' || v === 1 ? '1' : v === 'auto' ? 'auto' : DEFAULT_DENSITY;
}

/**
 * Backing-store size for a density. `devPx` is the ResizeObserver's device-pixel box, `cssBox` its content box (CSS px),
 * both null until the observer reports. 1x: CSS px (content box, else clientWidth/Height); auto: the device box, else
 * round(client * dpr). Capped at the texture limit.
 */
export function densitySize(
  density: Density,
  devPx: { w: number; h: number } | null,
  cssBox: { w: number; h: number } | null,
  clientW: number,
  clientH: number,
  dpr: number,
  max: number,
): { w: number; h: number } {
  let w: number;
  let h: number;
  if (density === '1') {
    w = cssBox && cssBox.w > 0 ? cssBox.w : clientW;
    h = cssBox && cssBox.h > 0 ? cssBox.h : clientH;
  } else {
    // the observer's box is exact at fractional dpr / zoom (within a pixel or two of client * dpr); one that is far off
    // (emulated DPR in test browsers reports CSS pixels) is not trusted
    const tol = 1 + dpr;
    const ok = devPx && devPx.w > 0 && devPx.h > 0 && (clientW <= 0 || (Math.abs(devPx.w - clientW * dpr) <= tol && Math.abs(devPx.h - clientH * dpr) <= tol));
    w = ok ? devPx.w : Math.round(clientW * dpr);
    h = ok ? devPx.h : Math.round(clientH * dpr);
  }
  const c = (v: number): number => Math.min(max, Math.max(1, Math.round(v)));
  return { w: c(w), h: c(h) };
}

/** Backing pixels per CSS pixel actually in use (the HUD's "effective dpr"). */
export function effectiveDpr(backingW: number, clientW: number): number {
  return clientW > 0 ? backingW / clientW : 1;
}
