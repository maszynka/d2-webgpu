// SPDX-License-Identifier: GPL-3.0-or-later
// Smooth upscale stages (dedither, ScaleFX 3x, Super-xBR 2x) on synthetic inputs through the standalone page test-pages/upscale.html.
// The page is served by a vite dev server started here (no change to the app's build inputs or main.ts).
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createServer, type ViteDevServer } from 'vite';
import { checkerboardDeditherReference, fromRgba8, stripeCheckerReference, superXbrReference, toRgba8 } from '../src/gpu/upscale/reference';
import { IMAGES } from '../test-pages/images';

const shotDir = process.env['D2_UP_SHOT_DIR'] ?? 'test-results/upscale-smooth';

interface Img {
  w: number;
  h: number;
  rgba: Uint8Array;
}
interface RunResult {
  width: number;
  height: number;
  ratio: number;
  passes: number;
  live: number;
  rgba: string;
  errors: string[];
}

let server: ViteDevServer;
let base = '';

test.beforeAll(async () => {
  server = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error', server: { port: 5199, strictPort: false, host: '127.0.0.1' }, optimizeDeps: { noDiscovery: true } });
  await server.listen();
  base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5199/';
  mkdirSync(shotDir, { recursive: true });
});
test.afterAll(async () => {
  await server.close();
});

async function openPage(page: Page): Promise<{ timestamps: boolean; adapter: string }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}test-pages/upscale.html`);
  test.skip(!(await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu)), 'WebGPU not available in this headless Chromium');
  return page.evaluate(() => window.upscaleTest.info());
}

async function run(page: Page, stage: string, image: string): Promise<Img & { raw: RunResult }> {
  const r = await page.evaluate(([s, i]) => window.upscaleTest.run(s!, i!), [stage, image] as const);
  expect(r.errors, `${stage}/${image}: WebGPU errors`).toEqual([]);
  return { w: r.width, h: r.height, rgba: Uint8Array.from(Buffer.from(r.rgba, 'base64')), raw: r };
}

function input(name: string): Img {
  const t = IMAGES[name]!();
  return { w: t.w, h: t.h, rgba: t.data };
}

function savePng(name: string, img: Img, scale = 1): void {
  const png = new PNG({ width: img.w * scale, height: img.h * scale });
  for (let y = 0; y < img.h * scale; y++) {
    for (let x = 0; x < img.w * scale; x++) {
      const s = (Math.floor(y / scale) * img.w + Math.floor(x / scale)) * 4;
      const d = (y * img.w * scale + x) * 4;
      png.data[d] = img.rgba[s]!;
      png.data[d + 1] = img.rgba[s + 1]!;
      png.data[d + 2] = img.rgba[s + 2]!;
      png.data[d + 3] = 255;
    }
  }
  writeFileSync(join(shotDir, `up-b-${name}.png`), PNG.sync.write(png));
}

test.describe.configure({ mode: 'serial' });

test('smoke: every stage runs on every synthetic input', async ({ page }) => {
  const info = await openPage(page);
  console.log('adapter:', info.adapter, 'timestamps:', info.timestamps);
  const expected: Record<string, number> = { dedither: 1, 'dedither-cbd': 1, 'dedither-lines': 1, scalefx: 3, superxbr: 2, 'smooth-scalefx': 3, 'smooth-sxbr': 2 };
  for (const [stage, ratio] of Object.entries(expected)) {
    for (const name of Object.keys(IMAGES)) {
      const out = await run(page, stage, name);
      const inp = input(name);
      expect(out.w).toBe(inp.w * ratio);
      expect(out.h).toBe(inp.h * ratio);
      expect(out.raw.ratio).toBe(ratio);
      if (name === 'disc' || name === 'checker') savePng(`${stage}-${name}`, out, ratio === 1 ? 4 : 1);
    }
  }
  for (const name of Object.keys(IMAGES)) savePng(`input-${name}`, input(name), 4);
});

// ---- helpers -------------------------------------------------------------------------------------------------------------

function nearest(img: Img, r: number): Img {
  const w = img.w * r;
  const h = img.h * r;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / r) * img.w + Math.floor(x / r)) * 4;
      rgba.set(img.rgba.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return { w, h, rgba };
}

const lumaOf = (img: Img, x: number, y: number): number => {
  const i = (y * img.w + x) * 4;
  return 0.2126 * img.rgba[i]! + 0.7152 * img.rgba[i + 1]! + 0.0722 * img.rgba[i + 2]!;
};

/** RMS (input px) of the area-estimated edge position of "light below the line y = a x + b" against the ideal line. */
function edgeRms(img: Img, r: number, a: number, b: number, margin = 8): number {
  const inW = img.w / r;
  let sum = 0;
  let n = 0;
  for (let X = margin * r; X < (inW - margin) * r; X++) {
    let light = 0;
    for (let Y = 0; Y < img.h; Y++) light += Math.min(1, Math.max(0, (lumaOf(img, X, Y) - 30) / 200));
    const edge = (img.h - light) / r;
    const ideal = a * ((X + 0.5) / r) + b;
    sum += (edge - ideal) ** 2;
    n++;
  }
  return Math.sqrt(sum / n);
}

/** mean squared (pixel - mean of its 4 neighbours) of the green channel over a rectangle (input px) */
function hfEnergy(img: Img, x0: number, x1: number, y0: number, y1: number): number {
  const g = (x: number, y: number): number => img.rgba[(y * img.w + x) * 4 + 1]!;
  let e = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const l = g(x, y) - 0.25 * (g(x - 1, y) + g(x + 1, y) + g(x, y - 1) + g(x, y + 1));
      e += l * l;
      n++;
    }
  }
  return e / n;
}

function diffStats(a: Uint8Array, b: Uint8Array): { max: number; mean: number; over2: number } {
  let max = 0;
  let sum = 0;
  let over = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!);
      max = Math.max(max, d);
      sum += d;
      if (d > 2) over++;
      n++;
    }
  }
  return { max, mean: sum / n, over2: over / n };
}

// ---- CPU references --------------------------------------------------------------------------------------------------------

for (const name of ['disc', 'stairs04', 'lines', 'checker']) {
  test(`Super-xBR matches the CPU reference (${name})`, async ({ page }) => {
    await openPage(page);
    const out = await run(page, 'superxbr', name);
    const inp = input(name);
    const ref = superXbrReference(fromRgba8(inp.rgba, inp.w, inp.h));
    const st = diffStats(out.rgba, toRgba8(ref));
    console.log(`superxbr/${name}: max ${st.max}, mean ${st.mean.toFixed(4)}, >2 levels ${(st.over2 * 100).toFixed(3)}%`);
    expect(st.max).toBeLessThanOrEqual(3);
    expect(st.mean).toBeLessThan(0.1);
  });
}

for (const name of ['disc', 'checker', 'stripes', 'stairs06']) {
  test(`checkerboard dedither matches the CPU reference (${name})`, async ({ page }) => {
    await openPage(page);
    const out = await run(page, 'dedither-cbd', name);
    const inp = input(name);
    const ref = checkerboardDeditherReference(fromRgba8(inp.rgba, inp.w, inp.h));
    const st = diffStats(out.rgba, toRgba8(ref));
    console.log(`dedither-cbd/${name}: max ${st.max}, mean ${st.mean.toFixed(4)}, >2 levels ${(st.over2 * 100).toFixed(3)}%`);
    // the GPU keeps the intermediates in rgba16float, the reference in f64: allow rounding noise, not pattern flips
    expect(st.mean).toBeLessThan(0.25);
    expect(st.over2).toBeLessThan(0.01);
  });
}

for (const name of ['stripes', 'checker', 'lines', 'disc']) {
  test(`stripe/checker detector matches the CPU reference (${name})`, async ({ page }) => {
    await openPage(page);
    const out = await run(page, 'dedither-lines', name);
    const inp = input(name);
    const st = diffStats(out.rgba, toRgba8(stripeCheckerReference(fromRgba8(inp.rgba, inp.w, inp.h))));
    console.log(`dedither-lines/${name}: max ${st.max}, mean ${st.mean.toFixed(4)}`);
    expect(st.max).toBeLessThanOrEqual(1);
  });
}

// ---- behaviour -------------------------------------------------------------------------------------------------------------

test('staircase edges are smoother than nearest (ScaleFX 3x, Super-xBR 2x, smooth chains)', async ({ page }) => {
  await openPage(page);
  const rows: string[] = [];
  for (const [name, a, b] of [['stairs04', 0.4, 12], ['stairs06', 0.6, 6]] as const) {
    const inp = input(name);
    const rNearest3 = edgeRms(nearest(inp, 3), 3, a, b);
    const rNearest2 = edgeRms(nearest(inp, 2), 2, a, b);
    for (const [stage, r, base] of [['scalefx', 3, rNearest3], ['smooth-scalefx', 3, rNearest3], ['superxbr', 2, rNearest2], ['smooth-sxbr', 2, rNearest2]] as const) {
      const out = await run(page, stage, name);
      const rms = edgeRms(out, r, a, b);
      rows.push(`${name} ${stage}: edge RMS ${rms.toFixed(3)} px vs nearest ${base.toFixed(3)} px`);
      savePng(`${stage}-${name}`, out);
      if (stage === 'scalefx') savePng(`nearest-${name}`, nearest(inp, 3));
      expect(rms, `${stage}/${name}`).toBeLessThan(base * 0.75);
    }
  }
  console.log(rows.join('\n'));
});

test('ScaleFX only emits colours present in the input; flat areas stay flat; the lone dot survives', async ({ page }) => {
  await openPage(page);
  const out = await run(page, 'scalefx', 'disc');
  const inp = input('disc');
  const have = new Set<number>();
  for (let i = 0; i < inp.rgba.length; i += 4) have.add((inp.rgba[i]! << 16) | (inp.rgba[i + 1]! << 8) | inp.rgba[i + 2]!);
  for (let i = 0; i < out.rgba.length; i += 4) expect(have.has((out.rgba[i]! << 16) | (out.rgba[i + 1]! << 8) | out.rgba[i + 2]!)).toBe(true);
  const flat = await run(page, 'scalefx', 'flat');
  expect(new Set(Array.from({ length: flat.rgba.length / 4 }, (_, i) => flat.rgba[i * 4]! * 65536 + flat.rgba[i * 4 + 1]! * 256 + flat.rgba[i * 4 + 2]!)).size).toBe(1);
  const lines = await run(page, 'scalefx', 'lines');
  // the isolated dot at (50,50) is still bright somewhere in its 3x3 block
  let bright = 0;
  for (let y = 150; y < 153; y++) for (let x = 150; x < 153; x++) if (lines.rgba[(y * lines.w + x) * 4]! > 200) bright++;
  expect(bright).toBeGreaterThan(0);
  savePng('scalefx-lines', lines);
});

test('dedither cuts checkerboard high-frequency energy by >= 50% and preserves flat areas', async ({ page }) => {
  await openPage(page);
  const rows: string[] = [];
  for (const stage of ['dedither', 'dedither-cbd', 'dedither-lines', 'smooth-scalefx', 'smooth-sxbr']) {
    const r = stage.startsWith('smooth') ? (stage === 'smooth-scalefx' ? 3 : 2) : 1;
    const out = await run(page, stage, 'checker');
    const inp = input('checker');
    // energy measured on the stage's own output scale, normalised by the ratio (interior of the dither block)
    const before = hfEnergy(inp, 8, 26, 8, 56);
    const after = hfEnergy(out, 8 * r, 26 * r, 8 * r, 56 * r);
    rows.push(`${stage}: checker HF energy ${before.toFixed(1)} -> ${after.toFixed(1)} (${((after / before) * 100).toFixed(1)}%)`);
    if (r === 1) {
      savePng(`${stage}-checker-x4`, out, 4);
      // flat block and background far from the pattern are bit-exact (+-1)
      let worst = 0;
      for (const [x, y] of [[40, 20], [50, 40], [45, 55], [2, 2], [61, 61], [2, 61]] as const) {
        const i = (y * out.w + x) * 4;
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out.rgba[i + c]! - inp.rgba[i + c]!));
      }
      expect(worst, `${stage}: flat areas`).toBeLessThanOrEqual(1);
    }
    expect(after / before, `${stage}: checker energy`).toBeLessThan(0.5);
  }
  console.log(rows.join('\n'));
});

test('dedither on vertical stripes, and thin lines are not blurred by our detector', async ({ page }) => {
  await openPage(page);
  const inp = input('stripes');
  const before = hfEnergy(inp, 8, 26, 8, 56);
  const rows: string[] = [];
  for (const stage of ['dedither-cbd', 'dedither-lines', 'dedither']) {
    const out = await run(page, stage, 'stripes');
    const after = hfEnergy(out, 8, 26, 8, 56);
    rows.push(`${stage}: stripes HF energy ${before.toFixed(1)} -> ${after.toFixed(1)} (${((after / before) * 100).toFixed(1)}%)`);
    savePng(`${stage}-stripes-x4`, out, 4);
    // libretro checkerboard-dedither alone leaves vertical stripes untouched (reported, not asserted: it is the reason for our detector)
    if (stage !== 'dedither-cbd') expect(after / before, `${stage}: stripes`).toBeLessThan(0.5);
  }
  const lines = input('lines');
  for (const stage of ['dedither-lines', 'dedither-cbd', 'dedither']) {
    const out = await run(page, stage, 'lines');
    const st = diffStats(out.rgba, lines.rgba);
    rows.push(`${stage}: thin lines changed: max ${st.max}, mean ${st.mean.toFixed(3)}`);
    savePng(`${stage}-lines-x4`, out, 4);
    if (stage === 'dedither-lines') expect(st.max).toBe(0);
  }
  console.log(rows.join('\n'));
});

test('texture lifecycle on the GPU: sizes cycle, live textures stay bounded, destroy releases', async ({ page }) => {
  await openPage(page);
  const sizes: [number, number][] = [[64, 64], [128, 64], [64, 64], [200, 100], [64, 64]];
  for (const [stage, per] of [['scalefx', 4], ['superxbr', 3], ['dedither', 3], ['smooth-scalefx', 7], ['smooth-sxbr', 6]] as const) {
    const r = await page.evaluate(([s, z]) => window.upscaleTest.lifecycle(s!, z as [number, number][]), [stage, sizes] as const);
    expect(r.errors).toEqual([]);
    expect(r.live, stage).toEqual(sizes.map(() => per));
    expect(r.afterDestroy, stage).toBe(0);
  }
});

test('GPU time per stage at 1066x600 (SwiftShader: not representative of real GPUs)', async ({ page }) => {
  test.setTimeout(300_000);
  const info = await openPage(page);
  const rows: string[] = [`adapter: ${info.adapter}, timestamp-query: ${info.timestamps}`];
  for (const stage of ['dedither', 'scalefx', 'superxbr', 'smooth-scalefx', 'smooth-sxbr']) {
    const r = await page.evaluate(([s]) => window.upscaleTest.time(s!, 1066, 600, 3), [stage] as const);
    expect(r.errors, stage).toEqual([]);
    expect(r.wallMs).toBeGreaterThan(0);
    const per = r.passMs ? Object.entries(r.passMs).map(([k, v]) => `${k.split('.').pop()}=${v.toFixed(2)}`).join(' ') : 'n/a';
    rows.push(`${stage}: total ${r.totalMs === null ? 'n/a' : r.totalMs.toFixed(2)} ms GPU, wall ${r.wallMs.toFixed(1)} ms/frame; ${per}`);
  }
  console.log(rows.join('\n'));
});
