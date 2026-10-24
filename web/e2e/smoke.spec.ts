// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

test('demo scene renders without console errors', async ({ page }) => {
  const errors: string[] = [];
  const logs: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    else logs.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto('/');
  const hasGpu = await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu);
  test.skip(!hasGpu, 'WebGPU not available in this headless Chromium');

  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 5, undefined, { timeout: 30_000 });
  const state = await page.evaluate(() => window.__d2);
  console.log('adapter:', JSON.stringify(state?.adapter), 'core:', JSON.stringify(state?.core), 'error:', state?.error);
  expect(state?.ready, `renderer failed: ${state?.error ?? ''}`).toBe(true);

  const shot = await page.locator('canvas#view').screenshot();
  const png = PNG.sync.read(shot);
  const colours = new Set<number>();
  for (let i = 0; i < png.data.length; i += 4) {
    colours.add(((png.data[i] ?? 0) << 16) | ((png.data[i + 1] ?? 0) << 8) | (png.data[i + 2] ?? 0));
  }
  console.log(`canvas ${png.width}x${png.height}, distinct colours: ${colours.size}`);
  expect(colours.size).toBeGreaterThan(8);

  await expect(page.locator('#debug')).toContainText('adapter:');
  await expect(page.locator('#about')).toContainText('GPL-3.0-or-later');
  expect(logs.some((l) => l.includes('WebGPU adapter'))).toBe(true);
  // missing /d2core.js must not be an error (demo mode)
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('lighting modes render without WebGPU errors and change the picture', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    // errors always fail; warnings only when they look like WebGPU / validation / GPU problems
    if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|validation|GPU/i.test(m.text()))) errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto('/');
  const hasGpu = await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu);
  test.skip(!hasGpu, 'WebGPU not available in this headless Chromium');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 5, undefined, { timeout: 30_000 });

  const shots: Record<string, { mean: number; data: Buffer }> = {};
  for (const mode of ['off', 'smooth', 'authentic']) {
    await page.selectOption('#light-mode', mode, { force: true });
    const f0 = await page.evaluate(() => window.__d2?.frames ?? 0);
    await page.waitForFunction((n) => (window.__d2?.frames ?? 0) > n + 6, f0, { timeout: 30_000 });
    expect(await page.evaluate(() => window.__d2?.lighting?.mode)).toBe(mode);
    const data = await page.locator('canvas#view').screenshot();
    const png = PNG.sync.read(data);
    let sum = 0;
    for (let i = 0; i < png.data.length; i += 4) sum += (png.data[i] ?? 0) + (png.data[i + 1] ?? 0) + (png.data[i + 2] ?? 0);
    shots[mode] = { mean: sum / (png.data.length / 4) / 3, data };
    if (process.env['LIGHT_SHOTS']) await page.locator('canvas#view').screenshot({ path: `${process.env['LIGHT_SHOTS']}/light-${mode}.png` });
  }
  console.log('mean brightness:', Object.entries(shots).map(([k, v]) => `${k}=${v.mean.toFixed(1)}`).join(' '));
  expect(await page.evaluate(() => window.__d2?.lighting?.lights)).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#debug')).toContainText('lights:');
  expect(shots['off']!.data.equals(shots['smooth']!.data)).toBe(false);
  // dark ambient + a few small lights: the lit scene is clearly darker than the unlit one
  expect(shots['smooth']!.mean).toBeLessThan(shots['off']!.mean * 0.85);
  expect(shots['authentic']!.mean).toBeLessThan(shots['off']!.mean * 0.95);
  expect(shots['authentic']!.mean).toBeGreaterThan(5);
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

function watchErrors(page: import('@playwright/test').Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|validation|GPU/i.test(m.text()))) errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function framesAfter(page: import('@playwright/test').Page, n = 6): Promise<void> {
  const f0 = await page.evaluate(() => window.__d2?.frames ?? 0);
  await page.waitForFunction((k) => (window.__d2?.frames ?? 0) > k + 6, f0 + n - 6, { timeout: 30_000 });
}

test('presentation modes (FSR1, nearest, bilinear) render without WebGPU errors and differ', async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  test.skip(!(await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu)), 'WebGPU not available in this headless Chromium');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 5, undefined, { timeout: 30_000 });
  await page.selectOption('#light-mode', 'off', { force: true }); // a still picture: modes differ by filtering only
  const expected: Record<string, string> = { fsr1: 'easu-rcas', nearest: 'nearest', bilinear: 'bilinear' };
  const shots: Record<string, Buffer> = {};
  for (const mode of ['fsr1', 'nearest', 'bilinear']) {
    await page.selectOption('#present', mode);
    await framesAfter(page);
    const p = await page.evaluate(() => window.__d2?.present);
    expect(p?.pass, mode).toBe(expected[mode]);
    expect(p?.srcW).toBe(800);
    // device-pixel-correct backing store
    const dims = await page.evaluate(() => {
      const c = document.querySelector('canvas#view') as HTMLCanvasElement;
      return { cw: c.width, ch: c.height, w: c.clientWidth, h: c.clientHeight, dpr: window.devicePixelRatio };
    });
    expect(dims.cw).toBe(Math.round(dims.w * dims.dpr));
    expect(dims.ch).toBe(Math.round(dims.h * dims.dpr));
    shots[mode] = await page.locator('canvas#view').screenshot();
  }
  expect(shots['fsr1']!.equals(shots['nearest']!)).toBe(false);
  expect(shots['bilinear']!.equals(shots['nearest']!)).toBe(false);
  expect(shots['fsr1']!.equals(shots['bilinear']!)).toBe(false);
  // sharpness only matters for FSR1
  await page.selectOption('#present', 'fsr1');
  await page.fill('#sharp', '0');
  await framesAfter(page);
  const sharp = await page.locator('canvas#view').screenshot();
  await page.fill('#sharp', '2');
  await framesAfter(page);
  const soft = await page.locator('canvas#view').screenshot();
  expect(sharp.equals(soft)).toBe(false);
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('the canvas fills the viewport (letterboxed frame, 1920x1080)', async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  test.skip(!(await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu)), 'WebGPU not available in this headless Chromium');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 5, undefined, { timeout: 30_000 });
  const box = (await page.locator('canvas#view').boundingBox())!;
  console.log(`canvas box ${box.width}x${box.height} in 1920x1080`);
  expect(box.width >= 0.9 * 1920 || box.height >= 0.9 * 1080).toBe(true);
  expect(box.width).toBeGreaterThanOrEqual(0.9 * 1920);
  expect(box.height).toBeGreaterThanOrEqual(1080 - 32 - 1); // all but the 32 px bar
  const p = await page.evaluate(() => window.__d2?.present);
  // the frame uses the canvas's long axis (aspect kept): one side exactly fills it
  expect(p!.rect.w === p!.canvasW || p!.rect.h === p!.canvasH).toBe(true);
  expect(p!.pass).toBe('easu-rcas');
  const dir = process.env['D2_SHOT_DIR'];
  if (dir) await page.screenshot({ path: `${dir}/res-fill-1920x1080.png` });
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('the Fullscreen button requests fullscreen on the app wrapper (mocked API)', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __fs: string[] };
    w.__fs = [];
    Element.prototype.requestFullscreen = function (this: Element) {
      w.__fs.push(this.id);
      return Promise.resolve();
    };
  });
  await page.goto('/');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 2, undefined, { timeout: 30_000 }).catch(() => undefined);
  await page.click('#fs-btn');
  expect(await page.evaluate(() => (window as unknown as { __fs: string[] }).__fs)).toEqual(['app']);
});
