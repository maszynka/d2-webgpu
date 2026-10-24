// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// Presentation modes and the FSR1 (EASU + RCAS) constant setup. The constants follow AMD's ffx_fsr1.h
// (FsrEasuCon / FsrRcasCon), Copyright (c) 2021 Advanced Micro Devices, Inc., MIT License
// (LICENSES/FidelityFX-FSR1-MIT.txt). The shaders are web/src/gpu/shaders/{easu,rcas}.wgsl.
import { fitRect, fitRectFree, type Rect } from './fit';

export type PresentMode = 'fsr1' | 'nearest' | 'bilinear';
export const PRESENT_MODES: readonly { id: PresentMode; label: string }[] = [
  { id: 'fsr1', label: 'FSR1' },
  { id: 'nearest', label: 'Nearest (integer)' },
  { id: 'bilinear', label: 'Bilinear' },
];
export const DEFAULT_PRESENT_MODE: PresentMode = 'fsr1';
/** RCAS sharpness in stops of attenuation: 0 = sharpest, 2 = softest. */
export const DEFAULT_SHARPNESS = 0.2;
export const MAX_SHARPNESS = 2;

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

export type PresentPass = 'easu-rcas' | 'bilinear' | 'nearest';
export interface PresentPlan {
  pass: PresentPass;
  rect: Rect;
}

/**
 * Which path presents a srcW x srcH frame on a dstW x dstH canvas.
 *  - nearest: integer scale (fractional below 1), letterboxed.
 *  - bilinear: fractional fit, letterboxed.
 *  - fsr1: fractional fit; EASU + RCAS only when the output is larger than the source, else a bilinear downscale.
 */
export function planPresent(mode: PresentMode, srcW: number, srcH: number, dstW: number, dstH: number): PresentPlan {
  if (mode === 'nearest') return { pass: 'nearest', rect: fitRect(srcW, srcH, dstW, dstH) };
  const rect = fitRectFree(srcW, srcH, dstW, dstH);
  if (mode === 'fsr1' && (rect.w > srcW || rect.h > srcH)) return { pass: 'easu-rcas', rect };
  return { pass: 'bilinear', rect };
}
