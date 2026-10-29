// SPDX-License-Identifier: GPL-3.0-or-later
// A browser with WebGPU but no WebAssembly JSPI (iOS / iPadOS 26 WebKit): the welcome card says so, and with real game
// files (D2_MPQ_DIR) Play explains it instead of crashing in the Emscripten glue; Copy log puts the reason on the clipboard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { mpqDir } from './fullhelpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (WebAssembly as { Suspending?: unknown }).Suspending;
    delete (WebAssembly as { promising?: unknown }).promising;
  });
});

test('welcome card: the JSPI check fails with the reason', async ({ page }) => {
  await page.goto('/');
  test.skip(!(await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu)), 'WebGPU not available in this headless Chromium');
  await expect(page.locator('#chk-jspi')).toHaveAttribute('data-state', 'fail');
  await expect(page.locator('#chk-jspi .why')).toContainText('no WebAssembly JSPI');
  await expect(page.locator('#chk-gpu')).toHaveAttribute('data-state', 'ok');
});

test('real game files: Play explains the missing JSPI, Copy log copies it', async ({ page, context }) => {
  test.skip(!mpqDir, 'set D2_MPQ_DIR to run against real game files');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__d2?.core?.mode === 'wasm', undefined, { timeout: 30_000 });
  const link = fs.mkdtempSync(path.join(os.tmpdir(), 'd2links-'));
  for (const n of fs.readdirSync(mpqDir!).filter((n) => /\.mpq$/i.test(n))) fs.linkSync(path.join(mpqDir!, n), path.join(link, n));
  await page.setInputFiles('#folder', link);
  // autoplay starts the game right after the folder opens; press Play only when it has not
  await page.locator('#game-failed').waitFor({ state: 'visible', timeout: 60_000 }).catch(() => page.click('#play-btn'));
  await expect(page.locator('#game-failed-reason')).toContainText('no WebAssembly JSPI');
  expect(await page.evaluate(() => window.__d2?.mode)).not.toBe('full');
  await page.click('#game-copylog');
  await expect(page.locator('#game-copylog')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('JSPI no');
  expect(errors).toEqual([]);
});
