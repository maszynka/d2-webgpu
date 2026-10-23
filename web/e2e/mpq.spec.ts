// SPDX-License-Identifier: GPL-3.0-or-later
// Game-folder path with a synthetic MPQ (wasm/test.sh builds build-native/tests/fixtures/base.mpq: our own bytes,
// no Blizzard data): fallback folder input -> WORKERFS mount -> mpq_open -> DC6 viewer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = process.env['D2CORE_FIXTURES'] ?? path.resolve(here, '../../build-native/tests/fixtures');
const mpq = path.join(fixture, 'base.mpq');
const haveWasm = fs.existsSync(path.resolve(here, '../public/d2core.wasm'));

test('synthetic MPQ through the folder input and the DC6 viewer', async ({ page }) => {
  test.skip(!fs.existsSync(mpq) || !haveWasm, 'needs wasm/build.sh and wasm/test.sh fixtures');
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2game-'));
  fs.mkdirSync(path.join(dir, 'Diablo II'));
  fs.copyFileSync(mpq, path.join(dir, 'Diablo II', 'D2DATA.MPQ'));

  await page.goto('/');
  const hasGpu = await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu);
  test.skip(!hasGpu, 'WebGPU not available in this headless Chromium');
  await page.waitForFunction(() => window.__d2?.core !== null && window.__d2?.core !== undefined, undefined, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__d2?.core?.mode)).toBe('wasm');

  await page.setInputFiles('#folder', path.join(dir, 'Diablo II'));
  await expect(page.locator('#game-tools')).toBeVisible();
  await expect(page.locator('#game-status')).toContainText('opened 1 MPQ');

  await page.fill('#path', 'data\\global\\ui\\tiny.dc6');
  await page.fill('#pal', 'data\\global\\palette\\pal.dat');
  await page.click('#view-btn');
  await expect(page.locator('#game-status')).toContainText('tiny.dc6: 2 dir x 1 frames');
  expect(await page.evaluate(() => window.__d2?.mode)).toBe('view');

  await page.check('#mosaic');
  await page.click('#view-btn');
  await expect(page.locator('#game-status')).toContainText('(all frames)');
  const frames0 = await page.evaluate(() => window.__d2?.frames ?? 0);
  await page.waitForFunction((n) => (window.__d2?.frames ?? 0) > n + 3, frames0);
  const png = PNG.sync.read(await page.locator('canvas#view').screenshot());
  const colours = new Set<number>();
  for (let i = 0; i < png.data.length; i += 4) colours.add(((png.data[i] ?? 0) << 16) | ((png.data[i + 1] ?? 0) << 8) | (png.data[i + 2] ?? 0));
  expect(colours.size).toBeGreaterThan(3);

  // a missing file is reported, not thrown
  await page.fill('#path', 'data\\global\\ui\\nope.dc6');
  await page.click('#view-btn');
  await expect(page.locator('#game-status')).toContainText('not found');

  // Load map without an act 1 palette in this synthetic archive: a clear message, no crash
  await page.fill('#path', 'data\\global\\tiles\\tiny.ds1');
  await page.click('#map-btn');
  await expect(page.locator('#game-status')).toContainText('Act 1 palette');

  await page.click('#demo-btn');
  expect(await page.evaluate(() => window.__d2?.mode)).toBe('demo');
  expect(errors.filter((e) => !/favicon|not found|404/i.test(e))).toEqual([]);
});
