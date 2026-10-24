// SPDX-License-Identifier: GPL-3.0-or-later
// FSRCNNX stage: GPU vs CPU reference on a 64x64 synthetic patch, GPU timing on 1066x600, and screenshots.
// SwiftShader (the headless default here) is a CPU rasteriser: its timings are NOT representative of a real GPU.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { bilinear2x, fsrcnnxReference } from '../src/gpu/upscale/fsrcnnx-ref';
import { parseFsrcnnxWeights } from '../src/gpu/upscale/fsrcnnx-weights';

const shotDir = process.env['D2_SHOT_DIR'] ?? 'test-results';
const PAGE = '/test-pages/fsrcnnx.html';

const bytes = readFileSync(new URL('../public/fsrcnnx-8-0-4-1.bin', import.meta.url));
const weights = parseFsrcnnxWeights(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

async function ready(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PAGE);
  test.skip(!(await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu)), 'WebGPU not available in this headless Chromium');
  await page.waitForFunction(() => !!(window as unknown as { __fsrcnnx?: unknown }).__fsrcnnx, undefined, { timeout: 30_000 });
}

function pngOf(rgba: ArrayLike<number>, w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h * 4; i++) png.data[i] = rgba[i]!;
  return PNG.sync.write(png);
}
const nearest2x = (src: ArrayLike<number>, w: number, h: number): Uint8Array => {
  const o = new Uint8Array(w * 2 * h * 2 * 4);
  for (let y = 0; y < h * 2; y++)
    for (let x = 0; x < w * 2; x++) for (let c = 0; c < 4; c++) o[(y * w * 2 + x) * 4 + c] = src[((y >> 1) * w + (x >> 1)) * 4 + c]!;
  return o;
};
const toRgba8 = (rgb: Float64Array, w: number, h: number): Uint8Array => {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) o[i * 4 + c] = Math.round(rgb[i * 3 + c]! * 255);
    o[i * 4 + 3] = 255;
  }
  return o;
};

test('GPU stage matches the CPU reference on a 64x64 patch', async ({ page }) => {
  await ready(page);
  const r = await page.evaluate(() => (window as unknown as { __fsrcnnx: { patch(w: number, h: number): Promise<{ input: number[]; output: number[]; errors: string[]; liveTextures: number }> } }).__fsrcnnx.patch(64, 64));
  expect(r.errors).toEqual([]);
  expect(r.liveTextures).toBe(4);
  expect(r.output.length).toBe(128 * 128 * 4);
  const ref = fsrcnnxReference({ width: 64, height: 64, data: r.input }, weights);
  expect(ref.width).toBe(128);
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 128 * 128; i++)
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(r.output[i * 4 + c]! - ref.rgb[i * 3 + c]! * 255);
      max = Math.max(max, d);
      sum += d;
      n++;
    }
  const mean = sum / n;
  console.log(`fsrcnnx GPU vs CPU ref (64x64 -> 128x128): max |diff| = ${max.toFixed(3)}/255, mean = ${mean.toFixed(4)}/255`);
  // quantisation to rgba8 alone contributes up to 0.5; rgba16float intermediates add a little
  expect(max).toBeLessThanOrEqual(2);
  expect(mean).toBeLessThanOrEqual(0.5);
  // it is not just bilinear: the network output differs visibly from plain bilinear
  const bil = bilinear2x({ width: 64, height: 64, data: r.input });
  let dBil = 0;
  for (let i = 0; i < 128 * 128 * 3; i++) dBil += Math.abs(r.output[Math.floor(i / 3) * 4 + (i % 3)]! - bil[i]! * 255);
  expect(dBil / (128 * 128 * 3)).toBeGreaterThan(0.5);
});

test('1066x600 timing and screenshots', async ({ page }) => {
  test.setTimeout(240_000);
  await ready(page);
  const W = 1066;
  const H = 600;
  const res = await page.evaluate(
    ([w, h]) => (window as unknown as { __fsrcnnx: { bench(w: number, h: number, it: number): Promise<{ png: string; passes: { label: string; ms: number | null }[]; totalMs: number | null; wallMs: number; adapter: string; fallback: boolean; timestamps: boolean; errors: string[]; liveTextures: number; width: number; height: number }> } }).__fsrcnnx.bench(w!, h!, 3),
    [W, H] as const,
  );
  expect(res.errors).toEqual([]);
  expect(res.liveTextures).toBe(4);
  console.log(
    `fsrcnnx ${W}x${H} -> ${W * 2}x${H * 2} on "${res.adapter}" (fallback adapter: ${res.fallback}, timestamp-query: ${res.timestamps}): total GPU ${res.totalMs?.toFixed(2) ?? 'n/a'} ms, wall ${res.wallMs.toFixed(1)} ms` +
      (res.fallback ? ' [SwiftShader/CPU adapter: not representative of a real GPU]' : '') +
      '\n  ' + res.passes.map((p) => `${p.label}: ${p.ms?.toFixed(2) ?? 'n/a'}`).join(', '),
  );
  const gpuPng = PNG.sync.read(Buffer.from(res.png.split(',')[1]!, 'base64'));
  expect(gpuPng.width).toBe(W * 2);
  expect(gpuPng.height).toBe(H * 2);

  const input = await page.evaluate(([w, h]) => Array.from((window as unknown as { __fsrcnnx: { synth(w: number, h: number): Uint8Array } }).__fsrcnnx.synth(w!, h!)), [W, H] as const);
  mkdirSync(shotDir, { recursive: true });
  const bil = toRgba8(bilinear2x({ width: W, height: H, data: input }), W * 2, H * 2);
  writeFileSync(`${shotDir}/up-c-input-nearest.png`, pngOf(nearest2x(input, W, H), W * 2, H * 2));
  writeFileSync(`${shotDir}/up-c-bilinear.png`, pngOf(bil, W * 2, H * 2));
  writeFileSync(`${shotDir}/up-c-fsrcnnx.png`, PNG.sync.write(gpuPng));

  // sharpness: mean |horizontal step| of luma over the whole output; the network must beat bilinear
  const edge = (d: ArrayLike<number>): number => {
    let s = 0;
    for (let y = 0; y < H * 2; y++)
      for (let x = 1; x < W * 2; x++) {
        const a = (y * W * 2 + x) * 4;
        s += Math.abs(0.2126 * (d[a]! - d[a - 4]!) + 0.7152 * (d[a + 1]! - d[a - 3]!) + 0.0722 * (d[a + 2]! - d[a - 2]!));
      }
    return s / (H * 2 * (W * 2 - 1));
  };
  const eBil = edge(bil);
  const eNet = edge(gpuPng.data);
  console.log(`mean |dx| luma: bilinear ${eBil.toFixed(3)}, fsrcnnx ${eNet.toFixed(3)}`);
  expect(eNet).toBeGreaterThan(eBil);
});
