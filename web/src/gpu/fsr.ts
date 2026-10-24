// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// Presentation modes and the FSR1 (EASU + RCAS) constant setup. The constants follow AMD's ffx_fsr1.h
// (FsrEasuCon / FsrRcasCon), Copyright (c) 2021 Advanced Micro Devices, Inc., MIT License
// (LICENSES/FidelityFX-FSR1-MIT.txt). The shaders are web/src/gpu/shaders/{easu,rcas}.wgsl.
import { fitRect, fitRectFree, nativeRect, type Rect } from './fit';
import { isStageMode, resolveStageMode, stageAvailable } from './upscale/registry';

export type PresentMode = 'fsr1' | 'nearest' | 'bilinear' | 'nearest-stretch' | 'native' | 'easu' | 'fsr1-pixel' | 'smooth' | 'smooth-scalefx' | 'smooth-sxbr' | 'fsrcnnx';
export const PRESENT_MODES: readonly { id: PresentMode; label: string }[] = [
  { id: 'fsr1', label: 'FSR1' },
  { id: 'fsr1-pixel', label: 'FSR1 (pixel-art)' },
  { id: 'smooth', label: 'Smooth (auto)' },
  { id: 'smooth-scalefx', label: 'Smooth (ScaleFX)' },
  { id: 'smooth-sxbr', label: 'Smooth (Super-xBR)' },
  { id: 'fsrcnnx', label: 'FSRCNNX' },
  { id: 'easu', label: 'EASU only' },
  { id: 'bilinear', label: 'Bilinear' },
  { id: 'nearest', label: 'Nearest (integer)' },
  { id: 'nearest-stretch', label: 'Nearest (stretch)' },
  { id: 'native', label: 'Off (1:1)' },
];
export function presentLabel(mode: PresentMode): string {
  return PRESENT_MODES.find((m) => m.id === mode)?.label ?? mode;
}
export const DEFAULT_PRESENT_MODE: PresentMode = 'fsr1';
/** RCAS sharpness in stops of attenuation: 0 = sharpest, 2 = softest. */
export const DEFAULT_SHARPNESS = 0.2;
export const MAX_SHARPNESS = 2;

/** Whether a mode can be used now: the stage modes need a registered stage (upscale/registry.ts), the others always can. */
export function modeAvailable(mode: PresentMode): boolean {
  return !isStageMode(mode) || stageAvailable(mode);
}

export function parsePresentMode(v: unknown): PresentMode {
  return PRESENT_MODES.some((m) => m.id === v) ? (v as PresentMode) : DEFAULT_PRESENT_MODE;
}

export function clampSharpness(stops: number): number {
  return Number.isFinite(stops) ? Math.max(0, Math.min(MAX_SHARPNESS, stops)) : DEFAULT_SHARPNESS;
}

/**
 * FsrEasuCon: 4 x vec4 (con0..con3, 16 floats).
 * @param viewW,viewH  the input viewport inside the texture (here the whole frame)
 * @param texW,texH    input texture size
 * @param outW,outH    output size
 */
export function easuConstants(viewW: number, viewH: number, texW: number, texH: number, outW: number, outH: number): Float32Array {
  const c = new Float32Array(16);
  // output pixel -> viewport pixel
  c[0] = viewW / outW;
  c[1] = viewH / outH;
  c[2] = (0.5 * viewW) / outW - 0.5;
  c[3] = (0.5 * viewH) / outH - 0.5;
  // viewport pixel -> normalised texture space; centres of the gather4 footprints (kept for parity with the reference,
  // the WGSL uses textureLoad taps)
  c[4] = 1 / texW;
  c[5] = 1 / texH;
  c[6] = 1 / texW;
  c[7] = -1 / texH;
  c[8] = -1 / texW;
  c[9] = 2 / texH;
  c[10] = 1 / texW;
  c[11] = 2 / texH;
  c[12] = 0 / texW;
  c[13] = 4 / texH;
  return c;
}

/** FsrRcasCon: the attenuation applied to the sharpening lobe, exp2(-stops). */
export function rcasAttenuation(stops: number): number {
  return Math.pow(2, -clampSharpness(stops));
}

/** The uniform block shared by both passes: con0..con3, then (RCAS attenuation, rect x, rect y, 0). 20 floats. */
export function packParams(out: Float32Array, easu: Float32Array, stops: number, rect: Rect): Float32Array {
  out.set(easu, 0);
  out[16] = rcasAttenuation(stops);
  out[17] = rect.x;
  out[18] = rect.y;
  out[19] = 0;
  return out;
}
export const PARAMS_FLOATS = 20;

/** easu-rcas: both FSR1 passes; easu: the EASU upscale shown as is (no sharpening) */
export type PresentPass = 'easu-rcas' | 'easu' | 'bilinear' | 'nearest' | 'stage';
export interface PresentPlan {
  pass: PresentPass;
  rect: Rect;
  /** pass 'stage': the concrete registered stage that runs (smooth resolves to scalefx / sxbr by scale) */
  stage?: string | undefined;
}

/**
 * Which path presents a srcW x srcH frame on a dstW x dstH canvas.
 *  - nearest: integer scale (fractional below 1), letterboxed.
 *  - bilinear: fractional fit, letterboxed.
 *  - fsr1: fractional fit; EASU + RCAS only when the output is larger than the source, else a bilinear downscale.
 */
export function planPresent(mode: PresentMode, srcW: number, srcH: number, dstW: number, dstH: number): PresentPlan {
  if (mode === 'native') return { pass: 'nearest', rect: nativeRect(srcW, srcH, dstW, dstH) };
  if (mode === 'nearest-stretch') return { pass: 'nearest', rect: fitRectFree(srcW, srcH, dstW, dstH) };
  if (mode === 'nearest') return { pass: 'nearest', rect: fitRect(srcW, srcH, dstW, dstH) };
  const rect = fitRectFree(srcW, srcH, dstW, dstH);
  if (isStageMode(mode)) {
    // a stage needs an upscale; below 1x, or without a registered stage, FSR1's own path presents (bilinear below 1x)
    const stage = rect.w >= srcW && rect.h >= srcH ? resolveStageMode(mode, rect.w / srcW) : null;
    if (stage) return { pass: 'stage', rect, stage };
    return { pass: rect.w > srcW || rect.h > srcH ? 'easu-rcas' : 'bilinear', rect };
  }
  if (mode === 'fsr1-pixel') return { pass: rect.w > srcW || rect.h > srcH ? 'easu-rcas' : 'bilinear', rect };
  if (mode === 'easu') return { pass: rect.w > srcW || rect.h > srcH ? 'easu' : 'bilinear', rect };
  if (mode === 'fsr1' && (rect.w > srcW || rect.h > srcH)) return { pass: 'easu-rcas', rect };
  return { pass: 'bilinear', rect };
}

/**
 * "FSR1 (pixel-art)": integer nearest prescale factor before EASU + RCAS. floor of the fit scale (3.17x -> 3, then
 * EASU does the remaining 1.06x), at least 1 (= plain FSR1), capped so the prescaled texture fits `maxTex`.
 */
export function pixelPrescale(rect: Rect, srcW: number, srcH: number, maxTex = 8192): number {
  const scale = Math.min(rect.w / srcW, rect.h / srcH);
  const cap = Math.max(1, Math.floor(maxTex / Math.max(srcW, srcH)));
  return Math.max(1, Math.min(cap, Math.floor(scale + 1e-6)));
}
