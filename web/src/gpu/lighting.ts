// SPDX-License-Identifier: GPL-3.0-or-later
// Lighting parameters: point lights, ambient, mode; the uniform-buffer layout shared with light.wgsl and a CPU
// reference of the same maths (tests; the shaders are the implementation, keep them in step).
//
// Light space: a point on the screen at (sx, sy) with height z above the ground (px) has ground position
// g = (sx, sy + z). True 3D position (2:1 dimetric view, ground foreshortened by sin 30 = 1/2, height by cos 30):
// P = (g.x, 2 * g.y, z / cos 30).

import { NORMALS, NORMAL_COUNT, SurfaceKind, isLitKind } from './surface';

export const MAX_LIGHTS = 32;
export const Y_STRETCH = 2;
export const Z_STRETCH = 1 / 0.8660254037844386;

export type LightMode = 'off' | 'smooth' | 'authentic';
export const MODE_ID: Record<LightMode, number> = { off: 0, smooth: 1, authentic: 2 };
export const LIGHT_MODES: readonly LightMode[] = ['off', 'smooth', 'authentic'];

export interface Light {
  /** ground position in world pixels (screen position of the point on the ground under the light) */
  x: number;
  y: number;
  /** height above the ground, px */
  z: number;
  /** reach in light-space px (distance at which the contribution reaches 0) */
  radius: number;
  color: readonly [number, number, number];
  intensity: number;
}

export interface LightingState {
  mode: LightMode;
  /** scalar or per-channel ambient light level, 0..1 */
  ambient: number | readonly [number, number, number];
  lights: readonly Light[];
  /** colormap rows for the authentic mode: brightest .. darkest (defaults: 0 .. last row) */
  brightRow?: number;
  darkRow?: number;
}

/** Uniform layout: head u32x4 (count, mode, brightRow, darkRow) | ambient f32x4 | normals f32x4[32] | lights (pos f32x4, colour f32x4)[32]. */
export const LIGHT_PARAMS_BYTES = 16 + 16 + NORMAL_COUNT * 16 + MAX_LIGHTS * 32;

export function ambientRgb(a: LightingState['ambient']): [number, number, number] {
  return typeof a === 'number' ? [a, a, a] : [a[0], a[1], a[2]];
}

export function packLightParams(s: LightingState, colormapRows: number, out = new ArrayBuffer(LIGHT_PARAMS_BYTES)): ArrayBuffer {
  const u = new Uint32Array(out, 0, 4);
  const f = new Float32Array(out);
  const n = Math.min(MAX_LIGHTS, s.lights.length);
  u[0] = n;
  u[1] = MODE_ID[s.mode];
  u[2] = s.brightRow ?? 0;
  u[3] = s.darkRow ?? Math.max(0, colormapRows - 1);
  const amb = ambientRgb(s.ambient);
  f.set([amb[0], amb[1], amb[2], 0], 4);
  for (let i = 0; i < NORMAL_COUNT; i++) {
    const nv = NORMALS[i]!;
    f.set([nv[0], nv[1], nv[2], 0], 8 + i * 4);
  }
  const base = 8 + NORMAL_COUNT * 4;
  f.fill(0, base);
  for (let i = 0; i < n; i++) {
    const l = s.lights[i]!;
    f.set([l.x, l.y, l.z, l.radius, l.color[0], l.color[1], l.color[2], l.intensity], base + i * 8);
  }
  return out;
}

// --- CPU reference ------------------------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Light multiplier at a surface point: screen position (sx, sy), height z (px), normal LUT slot. */
export function lightMultiplier(sx: number, sy: number, z: number, normal: number, lights: readonly Light[], ambient: LightingState['ambient']): Rgb {
  const a = ambientRgb(ambient);
  let r = a[0];
  let g = a[1];
  let b = a[2];
  const n = NORMALS[normal] ?? NORMALS[0]!;
  const gy = sy + z;
  for (const l of lights.slice(0, MAX_LIGHTS)) {
    const dx = l.x - sx;
    const dy = (l.y - gy) * Y_STRETCH;
    const dz = (l.z - z) * Z_STRETCH;
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= l.radius || dist < 1e-4) continue;
    const att = (1 - dist / l.radius) ** 2;
    const lam = Math.max(0, (n[0] * dx + n[1] * dy + n[2] * dz) / dist);
    const k = l.intensity * att * lam;
    r += l.color[0] * k;
    g += l.color[1] * k;
    b += l.color[2] * k;
  }
  return { r, g, b };
}

export function luma(m: Rgb): number {
  return 0.299 * m.r + 0.587 * m.g + 0.114 * m.b;
}

/** Colormap row for a light multiplier in the authentic mode (monochrome light level, quantised to a row). */
export function authenticRow(m: Rgb, brightRow: number, darkRow: number): number {
  const t = Math.min(1, Math.max(0, luma(m)));
  return Math.round(darkRow + (brightRow - darkRow) * t);
}

export interface ShadeInput {
  /** palette index after the sprite's own colormap row */
  index: number;
  kind: number;
  normal: number;
  sx: number;
  sy: number;
  z: number;
}

export interface ShadeTables {
  palette: (index: number) => Rgb; // 0..1
  /** colormap lookup: (row, index) -> index */
  colormap: (row: number, index: number) => number;
}

/** What the lighting pass outputs for a pixel (0..1 per channel). Mirrors `shade` in light.wgsl. */
export function shadePixel(p: ShadeInput, s: LightingState, t: ShadeTables, colormapRows: number): Rgb {
  const base = t.palette(p.index);
  if (s.mode === 'off' || !isLitKind(p.kind)) return base;
  const m = lightMultiplier(p.sx, p.sy, p.z, p.normal, s.lights, s.ambient);
  if (s.mode === 'smooth') return { r: Math.min(1, base.r * m.r), g: Math.min(1, base.g * m.g), b: Math.min(1, base.b * m.b) };
  const row = authenticRow(m, s.brightRow ?? 0, s.darkRow ?? Math.max(0, colormapRows - 1));
  return t.palette(t.colormap(row, p.index));
}

export { SurfaceKind };
