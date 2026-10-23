// SPDX-License-Identifier: GPL-3.0-or-later
// Procedural palette: 16 colour ramps x 16 shades. Index = ramp*16 + shade. Index 0 is transparent.

export const RAMPS = 16;
export const SHADES = 16;

export function ramp(r: number, shade: number): number {
  return r * SHADES + Math.max(0, Math.min(SHADES - 1, shade));
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** RGBA, 256 entries. `act` rotates hues so different palette rows are visibly different. */
export function makeDemoPalette(act = 0): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let r = 0; r < RAMPS; r++) {
    for (let s = 0; s < SHADES; s++) {
      const hue = (r * 22.5 + act * 40) % 360;
      const sat = r === 0 ? 0 : 0.55 + (s / SHADES) * 0.15;
      const light = 0.06 + (s / (SHADES - 1)) * 0.78;
      const [R, G, B] = hsl(hue, sat, light);
      const i = (r * SHADES + s) * 4;
      out[i] = R;
      out[i + 1] = G;
      out[i + 2] = B;
      out[i + 3] = i === 0 ? 0 : 255;
    }
  }
  return out;
}

/** Colormaps: row k darkens every non-zero index by 2*k shades (min shade 1 so it never becomes transparent). */
export function makeDemoColormaps(rows = 8): Uint8Array {
  const out = new Uint8Array(256 * rows);
  for (let k = 0; k < rows; k++) {
    for (let i = 0; i < 256; i++) {
      if (i === 0) {
        out[k * 256] = 0;
        continue;
      }
      const r = i >> 4;
      const s = Math.max(1, (i & 15) - 2 * k);
      out[k * 256 + i] = r * SHADES + s;
    }
  }
  return out;
}
