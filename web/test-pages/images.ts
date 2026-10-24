// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic RGBA test inputs for the smooth upscale stages (shared by the standalone test page and the e2e spec).

export interface TestImage {
  w: number;
  h: number;
  /** RGBA8, row-major */
  data: Uint8Array;
}

type RGB = readonly [number, number, number];

function make(w: number, h: number, f: (x: number, y: number) => RGB): TestImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { w, h, data };
}

export const BG: RGB = [50, 45, 40];
export const DITHER_A: RGB = [200, 130, 70];
export const DITHER_B: RGB = [160, 100, 50];
export const FLAT: RGB = [180, 115, 60];
export const DARK: RGB = [30, 30, 30];
export const LIGHT: RGB = [230, 230, 230];

/** Left block: a 2-colour checkerboard (a dithered 50% mix); right block: the flat mix colour; background flat. 64x64. */
export function checkerSprite(): TestImage {
  return make(64, 64, (x, y) => {
    if (y >= 4 && y < 60 && x >= 4 && x < 30) return (x + y) % 2 === 0 ? DITHER_A : DITHER_B;
    if (y >= 4 && y < 60 && x >= 34 && x < 60) return FLAT;
    return BG;
  });
}

/** Same layout with vertical stripes (alternating columns) instead of the checkerboard. */
export function stripeSprite(): TestImage {
  return make(64, 64, (x, y) => {
    if (y >= 4 && y < 60 && x >= 4 && x < 30) return x % 2 === 0 ? DITHER_A : DITHER_B;
    if (y >= 4 && y < 60 && x >= 34 && x < 60) return FLAT;
    return BG;
  });
}

/** A disc with four brightness bands whose transitions are checkerboard-dithered, on a dark background: what D2's pre-rendered shading looks like. 64x64. */
export function ditheredDisc(): TestImage {
  const bands: RGB[] = [
    [60, 40, 30],
    [110, 70, 45],
    [160, 100, 60],
    [210, 140, 80],
  ];
  return make(64, 64, (x, y) => {
    const dx = x + 0.5 - 32;
    const dy = y + 0.5 - 32;
    const r = Math.hypot(dx, dy);
    if (r > 26) return [20, 20, 28];
    // brightness falls off with the distance from a light at the upper left
    const t = Math.min(0.999, Math.max(0, 1 - Math.hypot(dx + 8, dy + 8) / 40)) * 3; // 0..3
    const lo = Math.floor(t);
    const frac = t - lo;
    const hi = Math.min(3, lo + 1);
    // 50% band: checkerboard between two neighbouring bands
    const pick = frac < 0.25 ? lo : frac > 0.75 ? hi : (x + y) % 2 === 0 ? lo : hi;
    return bands[pick]!;
  });
}

/** Light below a straight edge y = a*x + b (pixel-centre rule, aliased), dark above. 64x64. */
export function staircase(a: number, b: number): TestImage {
  return make(64, 64, (x, y) => (y + 0.5 > a * (x + 0.5) + b ? LIGHT : DARK));
}

/** One-pixel lines (horizontal, vertical, diagonal) and a dot on a dark background. 64x64. */
export function thinLines(): TestImage {
  return make(64, 64, (x, y) => {
    if (y === 10 || x === 10 || x === y + 20 || (x === 50 && y === 50)) return LIGHT;
    return DARK;
  });
}

export function flat(w = 32, h = 32, c: RGB = FLAT): TestImage {
  return make(w, h, () => c);
}

/** Deterministic noisy-ish content for timing / smoke at a given size (blocks, gradient, thin lines). */
export function busy(w: number, h: number): TestImage {
  return make(w, h, (x, y) => {
    const bx = (x >> 4) & 7;
    const by = (y >> 4) & 7;
    const g = 40 + ((bx * 37 + by * 61) % 160);
    if ((x + y) % 2 === 0 && bx % 2 === 0) return [g, g * 0.6, 30];
    if (x % 17 === 0 || y % 23 === 0) return [235, 235, 235];
    return [g, g * 0.8, g * 0.5 + 20];
  });
}

export const IMAGES: Record<string, () => TestImage> = {
  checker: checkerSprite,
  stripes: stripeSprite,
  disc: ditheredDisc,
  stairs04: () => staircase(0.4, 12),
  stairs06: () => staircase(0.6, 6),
  lines: thinLines,
  flat: () => flat(),
};
