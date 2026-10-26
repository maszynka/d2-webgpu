// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// CPU reference implementations of the Super-xBR 2x stage and the dedither stage (f64 maths, same sampling and clamping as the
// WGSL), used by the unit tests and by e2e/upscale-smooth.spec.ts to check the GPU output. The Super-xBR part follows Hyllian's
// Super-xBR (MIT, LICENSES/Super-xBR-MIT.txt) and the checkerboard-dedither part follows Hyllian's Checkerboard Dedither (MIT,
// LICENSES/checkerboard-dedither-MIT.txt); see the headers of the WGSL files for the notices. Images are RGB in 0..1.

export interface RgbImage {
  w: number;
  h: number;
  /** r, g, b per pixel, 0..1 */
  d: Float64Array;
}

export function fromRgba8(rgba: ArrayLike<number>, w: number, h: number): RgbImage {
  const d = new Float64Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    d[i * 3] = rgba[i * 4]! / 255;
    d[i * 3 + 1] = rgba[i * 4 + 1]! / 255;
    d[i * 3 + 2] = rgba[i * 4 + 2]! / 255;
  }
  return { w, h, d };
}

export function toRgba8(img: RgbImage): Uint8Array {
  const o = new Uint8Array(img.w * img.h * 4);
  for (let i = 0; i < img.w * img.h; i++) {
    for (let c = 0; c < 3; c++) o[i * 4 + c] = Math.round(Math.min(1, Math.max(0, img.d[i * 3 + c]!)) * 255);
    o[i * 4 + 3] = 255;
  }
  return o;
}

type V3 = [number, number, number];
const px = (img: RgbImage, x: number, y: number): V3 => {
  const cx = Math.min(img.w - 1, Math.max(0, x));
  const cy = Math.min(img.h - 1, Math.max(0, y));
  const i = (cy * img.w + cx) * 3;
  return [img.d[i]!, img.d[i + 1]!, img.d[i + 2]!];
};
const add = (...v: V3[]): V3 => v.reduce<V3>((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0]);
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const mix = (a: V3, b: V3, t: number): V3 => [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];
const lum = (c: V3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const df = (a: number, b: number): number => Math.abs(a - b);
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// 8-bit storage with the sRGB transfer (rgba8unorm-srgb render target + sampling)
const srgbEnc = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const srgbDec = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const storeSrgb = (c: V3): V3 => c.map((v) => srgbDec(Math.round(Math.min(1, Math.max(0, srgbEnc(Math.min(1, Math.max(0, v))))) * 255) / 255)) as V3;
const store8 = (c: V3): V3 => c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255) / 255) as V3;

interface Taps {
  P0: V3; P1: V3; P2: V3; P3: V3; B: V3; C: V3; H5: V3; I5: V3;
  D: V3; F4: V3; G: V3; I4: V3; E: V3; F: V3; H: V3; I: V3;
}

function dwd(w: number[], b0: number, b1: number, c0: number, c1: number, c2: number, d0: number, d1: number, d2: number, d3: number, e1: number, e2: number, e3: number, f2: number, f3: number): number {
  return w[0]! * (df(c1, c2) + df(c1, c0) + df(e2, e1) + df(e2, e3)) + w[1]! * (df(d2, d3) + df(d0, d1)) + w[2]! * (df(d1, d3) + df(d0, d2)) + w[3]! * df(d1, d2) + w[4]! * (df(c0, c2) + df(e1, e3)) + w[5]! * (df(b0, b1) + df(f2, f3));
}
function hvwd(w: number[], i1: number, i2: number, i3: number, i4: number, e1: number, e2: number, e3: number, e4: number): number {
  return w[3]! * (df(i1, i2) + df(i3, i4)) + w[0]! * (df(i1, e1) + df(i2, e2) + df(i3, e3) + df(i4, e4)) + w[2]! * (df(i1, e2) + df(i3, e4) + df(e1, i2) + df(e3, i4));
}

/** The shared Super-xBR interpolation (preset: MODE 1, XBR_WEIGHT 0). */
export function xbr(t: Taps, w: number[], edge: number): V3 {
  const [p0, p1, p2, p3, b, c, h5, i5, d, f4, g, i4, e, f, h, i] = [t.P0, t.P1, t.P2, t.P3, t.B, t.C, t.H5, t.I5, t.D, t.F4, t.G, t.I4, t.E, t.F, t.H, t.I].map(lum) as number[] as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  const dEdge = dwd(w, d, b, g, e, c, p2, h, f, p1, h5, i, f4, i5, i4) - dwd(w, c, f4, b, f, i4, p0, e, i, p3, d, h, i5, g, h5);
  const hvEdge = hvwd(w, f, i, e, h, c, i5, b, h5) - hvwd(w, e, f, h, i, d, f4, g, i4);
  const strength = smoothstep(0, edge + 0.000001, Math.abs(dEdge));
  const c3 = add(mul(add(t.E, t.H), 0.25), mul(add(t.F, t.I), 0.25));
  const c4 = add(mul(add(t.F, t.E), 0.25), mul(add(t.I, t.H), 0.25));
  const c1 = add(mul(t.H, 0.5), mul(t.F, 0.5));
  const c2 = add(mul(t.E, 0.5), mul(t.I, 0.5));
  const col = mix(mix(c1, c2, dEdge >= 0 ? 1 : 0), mix(c3, c4, hvEdge >= 0 ? 1 : 0), 1 - strength);
  const q = [t.E, t.F, t.H, t.I];
  return [0, 1, 2].map((k) => Math.min(Math.max(col[k]!, Math.min(...q.map((v) => v[k]!))), Math.max(...q.map((v) => v[k]!)))) as V3;
}

/** Super-xBR 2x of an RGB image, including the 8-bit sRGB intermediates and the 8-bit output of the GPU stage. */
export function superXbrReference(src: RgbImage): RgbImage {
  const { w, h } = src;
  // pass 0
  const t1: RgbImage = { w, h, d: new Float64Array(w * h * 3) };
  const w0 = [2, 1, -1, 4, -1, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t: Taps = {
        P0: px(src, x - 1, y - 1), P1: px(src, x + 2, y - 1), P2: px(src, x - 1, y + 2), P3: px(src, x + 2, y + 2),
        B: px(src, x, y - 1), C: px(src, x + 1, y - 1), H5: px(src, x, y + 2), I5: px(src, x + 1, y + 2),
        D: px(src, x - 1, y), F4: px(src, x + 2, y), G: px(src, x - 1, y + 1), I4: px(src, x + 2, y + 1),
        E: px(src, x, y), F: px(src, x + 1, y), H: px(src, x, y + 1), I: px(src, x + 1, y + 1),
      };
      t1.d.set(storeSrgb(xbr(t, w0, 3)), (y * w + x) * 3);
    }
  }
  // pass 1
  const W = w * 2;
  const H = h * 2;
  const t2: RgbImage = { w: W, h: H, d: new Float64Array(W * H * 3) };
  const X = (qx: number, qy: number): V3 => px(src, qx >> 1, qy >> 1);
  const S = (qx: number, qy: number): V3 => px(t1, qx >> 1, qy >> 1);
  const w1 = [1, 0, 0, 0, 0, 0];
  for (let oy = 0; oy < H; oy++) {
    for (let ox = 0; ox < W; ox++) {
      const ex = (ox & 1) === 0;
      const ey = (oy & 1) === 0;
      let c: V3;
      if (ex && ey) c = X(ox, oy);
      else if (!ex && !ey) c = S(ox, oy);
      else {
        const g1: [number, number] = ex ? [0, 1] : [1, 0];
        const g2: [number, number] = ex ? [1, 0] : [0, 1];
        const o = (a: number, b: number): [number, number] => [ox + a * g1[0] + b * g2[0], oy + a * g1[1] + b * g2[1]];
        const x = (a: number, b: number): V3 => X(...o(a, b));
        const s = (a: number, b: number): V3 => S(...o(a, b));
        const t: Taps = {
          P0: x(-3, 0), P1: s(0, -3), P2: s(0, 3), P3: x(3, 0),
          B: s(-2, -1), C: x(-1, -2), D: s(-2, 1), E: x(-1, 0),
          F: s(0, -1), G: x(-1, 2), H: s(0, 1), I: x(1, 0),
          F4: x(1, -2), I4: s(2, -1), H5: x(1, 2), I5: s(2, 1),
        };
        c = xbr(t, w1, 3);
      }
      t2.d.set(storeSrgb(c), (oy * W + ox) * 3);
    }
  }
  // pass 2
  const out: RgbImage = { w: W, h: H, d: new Float64Array(W * H * 3) };
  const w2 = [0, 0, 0, 1, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t: Taps = {
        P0: px(t2, x - 2, y - 2), P1: px(t2, x + 1, y - 2), P2: px(t2, x - 2, y + 1), P3: px(t2, x + 1, y + 1),
        B: px(t2, x - 1, y - 2), C: px(t2, x, y - 2), H5: px(t2, x - 1, y + 1), I5: px(t2, x, y + 1),
        D: px(t2, x - 2, y - 1), F4: px(t2, x + 1, y - 1), G: px(t2, x - 2, y), I4: px(t2, x + 1, y),
        E: px(t2, x - 1, y - 1), F: px(t2, x, y - 1), H: px(t2, x - 1, y), I: px(t2, x, y),
      };
      out.d.set(store8(xbr(t, w2, 3)), (y * W + x) * 3);
    }
  }
  return out;
}

// ---- dedither ----------------------------------------------------------------------------------------------------------

const Yw: V3 = [0.299, 0.587, 0.114];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sq = (c: V3): V3 => [c[0] * c[0], c[1] * c[1], c[2] * c[2]];

interface Lin {
  w: number;
  h: number;
  c: Float64Array; // linear-light rgb
  a: Float64Array; // luma difference
}

/** libretro checkerboard-dedither with the preset defaults (3 passes, linear light in f64, gamma 2). Returns display-referred RGB. */
export function checkerboardDeditherReference(src: RgbImage): RgbImage {
  const { w, h } = src;
  const at = (x: number, y: number): number => Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x));
  const lin = (x: number, y: number): V3 => sq(px(src, x, y));
  // pass 1
  const p1: Lin = { w, h, c: new Float64Array(w * h * 3), a: new Float64Array(w * h) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const C = lin(x, y), L = lin(x - 1, y), R = lin(x + 1, y), U = lin(x, y - 1), D = lin(x, y + 1);
      const mx = (a: V3, b: V3, c: V3): V3 => a.map((_, k) => Math.max(a[k]!, Math.min(b[k]!, c[k]!))) as V3;
      const mn = (a: V3, b: V3, c: V3): V3 => a.map((_, k) => Math.min(a[k]!, Math.max(b[k]!, c[k]!))) as V3;
      const minS = [0, 1, 2].map((k) => Math.max(mn(C, L, R)[k]!, mn(C, U, D)[k]!));
      const maxS = [0, 1, 2].map((k) => Math.min(mx(C, L, R)[k]!, mx(C, U, D)[k]!));
      const sum = add(L, R, U, D);
      const col = [0, 1, 2].map((k) => Math.min(Math.max(0.5 * C[k]! + 0.125 * sum[k]!, minS[k]!), maxS[k]!)) as V3;
      p1.c.set(col, (y * w + x) * 3);
      p1.a[y * w + x] = Math.abs(dot3(C, Yw) - dot3(col, Yw));
    }
  }
  const A = (p: Lin, x: number, y: number): number => p.a[at(x, y)]!;
  const step = (v: number): number => (v >= 1e-9 ? 1 : 0);
  // pass 2
  const p2: Lin = { w, h, c: new Float64Array(w * h * 3), a: new Float64Array(w * h) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (dx: number, dy: number): number => A(p1, x + dx, y + dy);
      const L = a(-1, 0), R = a(1, 0), U = a(0, -1), D = a(0, 1), UL = a(-1, -1), UR = a(1, -1), DL = a(-1, 1), DR = a(1, 1);
      const L2 = a(-2, 0), R2 = a(2, 0), U2 = a(0, -2), D2 = a(0, 2);
      const UL2 = a(-2, -1), UR2 = a(2, -1), DL2 = a(-2, 1), DR2 = a(2, 1), LU2 = a(-1, -2), RU2 = a(1, -2), LD2 = a(-1, 2);
      const RD2 = a(2, -1); // upstream typo kept
      let c1 = 0;
      c1 += step(L * D * R);
      c1 += step(L * U * R);
      c1 += step(L * UL * R * UR + L * DL * R * DR);
      c1 += step(U * D2 * (UL * LD2 + UR * RD2) + U2 * D * (LU2 * DL + RU2 * DR));
      let c2 = 0;
      c2 += step(U * L * D);
      c2 += step(U * R * D);
      c2 += step(U * UR * D * DR + D * DL * U * UL);
      c2 += step(L * R2 * (DL * DR2 + UL * UR2) + L2 * R * (DL2 * DR + UL2 * UR));
      const i = y * w + x;
      let col: V3 = [p1.c[i * 3]!, p1.c[i * 3 + 1]!, p1.c[i * 3 + 2]!];
      const oC = lin(x, y), oL = lin(x - 1, y), oR = lin(x + 1, y), oU = lin(x, y - 1), oD = lin(x, y + 1);
      if (c1 * c2 > 0 && c1 === c2) col = add(mul(oC, 0.5), mul(add(oL, oR, oU, oD), 0.125));
      else if (c1 > 0 && c1 > c2) col = add(mul(oC, 0.5), mul(add(oL, oR), 0.25));
      else if (c2 > 0 && c2 > c1) col = add(mul(oC, 0.5), mul(add(oU, oD), 0.25));
      p2.c.set(col, i * 3);
      p2.a[i] = Math.abs(dot3(oC, Yw) - dot3(col, Yw));
    }
  }
  // pass 3
  const out: RgbImage = { w, h, d: new Float64Array(w * h * 3) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (dx: number, dy: number): number => A(p2, x + dx, y + dy);
      const count = step(a(-1, 0)) + step(a(1, 0)) + step(a(0, -1)) + step(a(0, 1)) + step(a(-1, -1) * a(1, -1) * a(-1, 1) * a(1, 1));
      const L = a(-1, 0), R = a(1, 0), U = a(0, -1), D = a(0, 1), UL = a(-1, -1), UR = a(1, -1), DL = a(-1, 1), DR = a(1, 1);
      const count2 = step(L * UL * U + U * UR * R + R * DR * D + D * DL * L);
      const i = y * w + x;
      let col: V3 = [p2.c[i * 3]!, p2.c[i * 3 + 1]!, p2.c[i * 3 + 2]!];
      if (count < 1 && count2 < 1) col = lin(x, y);
      out.d.set(col.map((v) => Math.sqrt(Math.max(0, v))), i * 3);
    }
  }
  return out;
}

/** Our stripe/checker detector (dedither.wgsl fsLines). */
export function stripeCheckerReference(src: RgbImage): RgbImage {
  const { w, h } = src;
  const EPS = 2.5 / 255;
  const MAXD = 0.4;
  const far = (a: V3, b: V3): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  const same = (a: V3, b: V3): boolean => far(a, b) <= EPS;
  const out: RgbImage = { w, h, d: new Float64Array(src.d) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const g = (dx: number, dy: number): V3 => px(src, x + dx, y + dy);
      const C = g(0, 0), L = g(-1, 0), R = g(1, 0), U = g(0, -1), D = g(0, 1), UL = g(-1, -1), UR = g(1, -1), DL = g(-1, 1), DR = g(1, 1);
      let o = C;
      const s1 = far(C, L);
      if (s1 > EPS && s1 < MAXD) {
        const vert = same(C, U) && same(C, D) && same(L, R) && same(L, UL) && same(L, DL) && same(R, UR) && same(R, DR);
        const repX = same(C, g(-2, 0)) || same(C, g(2, 0));
        if (vert && repX) o = add(mul(C, 0.5), mul(add(L, R), 0.25));
        else {
          const chk = same(C, UL) && same(C, UR) && same(C, DL) && same(C, DR) && same(L, R) && same(U, D) && same(L, U);
          const repC = same(C, g(-2, 0)) || same(C, g(2, 0)) || same(C, g(0, -2)) || same(C, g(0, 2));
          if (chk && repC) o = add(mul(C, 0.5), mul(add(L, R, U, D), 0.125));
        }
      }
      const sv = far(C, U);
      if (sv > EPS && sv < MAXD && same(C, L) && same(C, R) && same(U, D) && same(U, UL) && same(U, UR) && same(D, DL) && same(D, DR)) {
        if (same(C, g(0, -2)) || same(C, g(0, 2))) o = add(mul(C, 0.5), mul(add(U, D), 0.25));
      }
      out.d.set(o, (y * w + x) * 3);
    }
  }
  return out;
}
