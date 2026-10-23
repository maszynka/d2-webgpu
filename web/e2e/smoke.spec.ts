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
    await page.selectOption('#light-mode', mode);
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
