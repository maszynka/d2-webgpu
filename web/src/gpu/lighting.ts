// SPDX-License-Identifier: GPL-3.0-or-later
// Lighting parameters: point lights, ambient, mode; the uniform-buffer layout shared with light.wgsl and a CPU
// reference of the same maths (tests; the shaders are the implementation, keep them in step).
//
// Light space: a point on the screen at (sx, sy) with height z above the ground (px) has ground position
// g = (sx, sy + z). True 3D position (2:1 dimetric view, ground foreshortened by sin 30 = 1/2, height by cos 30):
// P = (g.x, 2 * g.y, z / cos 30).

import { AUX_DRAWN, HEIGHT_MAX, AUX_KIND_SHIFT, AUX_NORMAL_MASK, NORMALS, NORMAL_COUNT, NormalSlot, SurfaceKind, isLitKind } from './surface';

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
  const lastRow = Math.max(0, colormapRows - 1);
  u[0] = n;
  u[1] = MODE_ID[s.mode];
  u[2] = Math.min(lastRow, Math.max(0, Math.trunc(s.brightRow ?? 0)));
  u[3] = Math.min(lastRow, Math.max(0, Math.trunc(s.darkRow ?? lastRow)));
  const a = s.ambient;
  if (typeof a === 'number') {
    f[4] = a;
    f[5] = a;
    f[6] = a;
  } else {
    f[4] = a[0];
    f[5] = a[1];
    f[6] = a[2];
  }
  f[7] = 0;
  for (let i = 0; i < NORMAL_COUNT; i++) {
    const nv = NORMALS[i]!;
    const o = 8 + i * 4;
    f[o] = nv[0];
    f[o + 1] = nv[1];
    f[o + 2] = nv[2];
    f[o + 3] = 0;
  }
  const base = 8 + NORMAL_COUNT * 4;
  f.fill(0, base);
  for (let i = 0; i < n; i++) {
    const l = s.lights[i]!;
    const o = base + i * 8;
    f[o] = l.x;
    f[o + 1] = l.y;
    f[o + 2] = l.z;
    f[o + 3] = l.radius;
    f[o + 4] = l.color[0];
    f[o + 5] = l.color[1];
    f[o + 6] = l.color[2];
    f[o + 7] = l.intensity;
  }
  return out;
}

// --- CPU reference ------------------------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Normal LUT lookup; out-of-range slots clamp to the last slot, like `min(normal, NORMAL_COUNT - 1u)` in light.wgsl. */
export function normalVector(slot: number): readonly [number, number, number] {
  return NORMALS[Math.min(Math.max(0, Math.trunc(slot)), NORMAL_COUNT - 1)]!;
}

/** Light multiplier at a surface point: screen position (sx, sy), height z (px), normal LUT slot. */
export function lightMultiplier(sx: number, sy: number, z: number, normal: number, lights: readonly Light[], ambient: LightingState['ambient']): Rgb {
  const a = ambientRgb(ambient);
  let r = a[0];
  let g = a[1];
  let b = a[2];
  const n = normalVector(normal);
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
  // floor(x + 0.5) == Math.round for x >= 0; light.wgsl uses the same form (WGSL round() is half-to-even)
  return Math.floor(darkRow + (brightRow - darkRow) * t + 0.5);
}

// --- sprite-pass geometry (mirror of `geometry` in sprite.wgsl) -------------------------------------------------

export interface PixelGeometry {
  /** height above the ground, px, clamped to 0..HEIGHT_MAX (before the rounding of `heightTexel`) */
  z: number;
  /** normal slot actually stored in aux (corner / round markers resolved) */
  normal: number;
}

/**
 * Per-pixel height and normal of a sprite pixel. (px, py) = world position of the pixel centre, `left` = sprite's left
 * edge x, `width` = sprite width (the pixel's u inside the sprite is px - left). Walls assume the standard DT1 layout:
 * the tile's top vertex is at left + 80 and the 160-wide ground diamond spans left..left + 160.
 */
export function pixelGeometry(kind: number, normal: number, anchor: number, px: number, py: number, left: number, width: number): PixelGeometry {
  let z = 0;
  let n = normal;
  const topX = left + 80;
  const wall = kind === SurfaceKind.WallSw || kind === SurfaceKind.WallSe || kind === SurfaceKind.WallBlended;
  if (wall && (normal === NormalSlot.CornerNorth || normal === NormalSlot.CornerSouth)) {
    const isLeft = px < topX;
    if (normal === NormalSlot.CornerNorth) {
      if (isLeft) {
        n = NormalSlot.WallSe;
        z = anchor + 40 - (px - left) * 0.5 - py;
      } else {
        n = NormalSlot.WallSw;
        z = anchor + (px - topX) * 0.5 - py;
      }
    } else if (isLeft) {
      n = NormalSlot.WallSw;
      z = anchor + 40 + (px - left) * 0.5 - py;
    } else {
      n = NormalSlot.WallSe;
      z = anchor + 80 - (px - topX) * 0.5 - py;
    }
  } else if (kind === SurfaceKind.WallSw || (kind === SurfaceKind.WallBlended && normal === NormalSlot.WallSw)) {
    z = anchor + (px - left) * 0.5 - py;
  } else if (kind === SurfaceKind.WallSe || (kind === SurfaceKind.WallBlended && normal === NormalSlot.WallSe)) {
    z = anchor - (px - left) * 0.5 - py;
  } else if (kind === SurfaceKind.WallTop || kind === SurfaceKind.WallBlended) {
    z = anchor;
  } else if (kind === SurfaceKind.Card || kind === SurfaceKind.CardEmissive) {
    z = anchor - py;
    if (normal === NormalSlot.CardRound) {
      // tilt follows the pixel's x across the FULL sprite width
      n = NormalSlot.CardTilt0 + Math.min(Math.floor(((px - left) / Math.max(width, 1)) * 8), 7);
    }
  }
  return { z: Math.min(HEIGHT_MAX, Math.max(0, z)), normal: n };
}

/** The r16uint height texel the sprite pass writes (`u32(z + 0.5)`). */
export function heightTexel(z: number): number {
  return Math.floor(z + 0.5);
}

export interface ShadeInput {
  /** palette index after the sprite's own colormap row */
  index: number;
  /** palette row of the record (G channel of the index target); default 0 */
  paletteRow?: number;
  kind: number;
  normal: number;
  sx: number;
  sy: number;
  z: number;
}

export interface ShadeTables {
  palette: (index: number, row: number) => Rgb; // 0..1
  /** colormap lookup: (row, index) -> index */
  colormap: (row: number, index: number) => number;
}

/** What the lighting pass outputs for a pixel (0..1 per channel). Mirrors `shade` in light.wgsl. */
export function shadePixel(p: ShadeInput, s: LightingState, t: ShadeTables, colormapRows: number): Rgb {
  const row0 = p.paletteRow ?? 0;
  const base = t.palette(p.index, row0);
  if (s.mode === 'off' || !isLitKind(p.kind)) return base;
  const m = lightMultiplier(p.sx, p.sy, p.z, p.normal, s.lights, s.ambient);
  if (s.mode === 'smooth') return { r: Math.min(1, base.r * m.r), g: Math.min(1, base.g * m.g), b: Math.min(1, base.b * m.b) };
  const row = authenticRow(m, s.brightRow ?? 0, s.darkRow ?? Math.max(0, colormapRows - 1));
  return t.palette(t.colormap(row, p.index), row0);
}

/** Colour of an empty (cleared) G-buffer texel, mirrors BACKGROUND in lighting.wgsl. */
export const BACKGROUND: Rgb = { r: 0.02, g: 0.02, b: 0.03 };

/**
 * One G-buffer texel -> colour (the opaque part of the lighting pass, mirrors `fs` in lighting.wgsl; `index`/`paletteRow` = R/G of the rg8uint index target). `aux === 0` means
 * nothing was drawn; any drawn pixel has AUX_DRAWN set, so palette index 0 is an ordinary colour.
 */
export function shadeGBufferTexel(index: number, paletteRow: number, aux: number, height: number, sx: number, sy: number, s: LightingState, t: ShadeTables, colormapRows: number): Rgb {
  if ((aux & AUX_DRAWN) === 0) return BACKGROUND;
  return shadePixel({ index, paletteRow, kind: (aux >> AUX_KIND_SHIFT) & 7, normal: aux & AUX_NORMAL_MASK, sx, sy, z: height }, s, t, colormapRows);
}

// --- blend layer (mirror of the blend targets in sprite.wgsl + the composite in lighting.wgsl) -------------------

export type BlendKind = 'alpha50' | 'additive' | 'darken';
export interface Rgba extends Rgb {
  a: number;
}

/** Premultiplied value a blended record writes to the blend target (`shade` colour `rgb`; darken ignores it). */
export function blendSource(mode: BlendKind, rgb: Rgb): Rgba {
  if (mode === 'alpha50') return { r: rgb.r * 0.5, g: rgb.g * 0.5, b: rgb.b * 0.5, a: 0.5 };
  if (mode === 'additive') return { r: rgb.r, g: rgb.g, b: rgb.b, a: 0 };
  return { r: 0, g: 0, b: 0, a: 0.5 };
}

/** GPU blend of one record onto the accumulator: "over" (one, one-minus-src-alpha) or additive (one, one). */
export function accumulateBlend(dst: Rgba, src: Rgba, mode: BlendKind): Rgba {
  const k = mode === 'additive' ? 1 : 1 - src.a;
  return { r: src.r + dst.r * k, g: src.g + dst.g * k, b: src.b + dst.b * k, a: src.a + dst.a * k };
}

/** Final pixel: blend layer over the lit surface (mirrors `b.rgb + base * (1 - b.a)` in lighting.wgsl). */
export function compositeTexel(base: Rgb, blend: Rgba): Rgb {
  const k = 1 - blend.a;
  return { r: blend.r + base.r * k, g: blend.g + base.g * k, b: blend.b + base.b * k };
}

export { SurfaceKind };
