// SPDX-License-Identifier: LGPL-3.0-or-later
// CPU reference of FSRCNNX 8-0-4-1 (igv, LGPL-3.0-or-later; LICENSES/FSRCNNX-LGPL-3.0.txt). It interprets fsrcnnx-layout.ts
// literally, pass by pass with mpv's hook semantics (named textures saved by each pass, clamp-to-edge taps), independently of
// the merged WGSL passes, so it also checks the GPU port's hard-coded structure. f64 arithmetic, no fp16 rounding.
// Colour handling is the same as fsrcnnx.ts: BT.709 luma through the network, bilinear 2x chroma, recombined.
import { FSRCNNX_PASSES, type FsrcnnxConvPass } from './fsrcnnx-layout';

const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;

export interface RefImage {
  width: number;
  height: number;
  /** RGBA8, row-major */
  data: ArrayLike<number>;
}
export interface RefResult {
  width: number;
  height: number;
  /** network luma at 2x (unclamped) */
  luma: Float64Array;
  /** RGB at 2x, 3 floats per pixel in 0..1 (clamped, not quantised) */
  rgb: Float64Array;
}

/** Runs one conv pass. `inputs` are 4-channel maps (w*h*4) by name, or the luma plane (w*h) when the pass kind is 'luma-conv'. */
function runPass(p: FsrcnnxConvPass, w: number, h: number, weights: Float32Array, maps: Map<string, Float64Array>): Float64Array {
  const out = new Float64Array(w * h * 4);
  const bias = weights.subarray(p.bias, p.bias + 4);
  const alpha = p.prelu === null ? null : weights.subarray(p.prelu, p.prelu + 4);
  const skip = p.skip === null ? null : maps.get(p.skip)!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const acc = [bias[0]!, bias[1]!, bias[2]!, bias[3]!];
      for (const t of p.terms) {
        const sx = Math.min(w - 1, Math.max(0, x + t.dx));
        const sy = Math.min(h - 1, Math.max(0, y + t.dy));
        const src = maps.get(t.src)!;
        if (p.kind === 'luma-conv') {
          const v = src[sy * w + sx]!;
          for (let i = 0; i < 4; i++) acc[i]! += weights[t.offset + i]! * v;
        } else {
          const si = (sy * w + sx) * 4;
          // GLSL mat4 * vec4, column-major: out[i] += m[j*4+i] * in[j]
          for (let j = 0; j < 4; j++) {
            const v = src[si + j]!;
            for (let i = 0; i < 4; i++) acc[i]! += weights[t.offset + j * 4 + i]! * v;
          }
        }
      }
      for (let i = 0; i < 4; i++) {
        let v = acc[i]!;
        if (skip) v += skip[o + i]!;
        if (alpha) v = Math.max(v, 0) + alpha[i]! * Math.min(v, 0);
        out[o + i] = v;
      }
    }
  }
  return out;
}

/** Upscales an RGBA8 image 2x with the network (weights from parseFsrcnnxWeights). Intended for small patches. */
export function fsrcnnxReference(img: RefImage, weights: Float32Array): RefResult {
  const { width: w, height: h } = img;
  const px = (i: number): number => img.data[i]! / 255;
  const luma = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) luma[i] = KR * px(i * 4) + KG * px(i * 4 + 1) + KB * px(i * 4 + 2);
  const maps = new Map<string, Float64Array>([['LUMA', luma]]);
  for (const p of FSRCNNX_PASSES) {
    if (p.kind === 'aggregate') continue;
    maps.set(p.out!, runPass(p, w, h, weights, maps));
  }
  const sub = maps.get('SUBCONV1')!;
  const W2 = w * 2;
  const H2 = h * 2;
  const outLuma = new Float64Array(W2 * H2);
  const rgb = new Float64Array(W2 * H2 * 3);
  const at = (x: number, y: number, c: number): number => px((Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + c);
  for (let oy = 0; oy < H2; oy++) {
    for (let ox = 0; ox < W2; ox++) {
      // aggregation: texel (ox>>1, oy>>1), channel (ox&1)*2 + (oy&1)
      const yNet = sub[((oy >> 1) * w + (ox >> 1)) * 4 + (ox & 1) * 2 + (oy & 1)]!;
      outLuma[oy * W2 + ox] = yNet;
      const fx = (ox + 0.5) * 0.5 - 0.5;
      const fy = (oy + 0.5) * 0.5 - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const wx = fx - x0;
      const wy = fy - y0;
      const bil = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const top = at(x0, y0, c) * (1 - wx) + at(x0 + 1, y0, c) * wx;
        const bot = at(x0, y0 + 1, c) * (1 - wx) + at(x0 + 1, y0 + 1, c) * wx;
        bil[c] = top * (1 - wy) + bot * wy;
      }
      const d = yNet - (KR * bil[0]! + KG * bil[1]! + KB * bil[2]!);
      for (let c = 0; c < 3; c++) rgb[(oy * W2 + ox) * 3 + c] = Math.min(1, Math.max(0, bil[c]! + d));
    }
  }
  return { width: W2, height: H2, luma: outLuma, rgb };
}

/** Plain bilinear 2x (same sampling as the stage's chroma path), RGB floats 0..1: the baseline for sharpness comparisons. */
export function bilinear2x(img: RefImage): Float64Array {
  const { width: w, height: h } = img;
  const out = new Float64Array(w * 2 * h * 2 * 3);
  const at = (x: number, y: number, c: number): number => img.data[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + c]! / 255;
  for (let oy = 0; oy < h * 2; oy++)
    for (let ox = 0; ox < w * 2; ox++) {
      const fx = (ox + 0.5) * 0.5 - 0.5;
      const fy = (oy + 0.5) * 0.5 - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const wx = fx - x0;
      const wy = fy - y0;
      for (let c = 0; c < 3; c++) {
        const top = at(x0, y0, c) * (1 - wx) + at(x0 + 1, y0, c) * wx;
        const bot = at(x0, y0 + 1, c) * (1 - wx) + at(x0 + 1, y0 + 1, c) * wx;
        out[(oy * w * 2 + ox) * 3 + c] = top * (1 - wy) + bot * wy;
      }
    }
  return out;
}
