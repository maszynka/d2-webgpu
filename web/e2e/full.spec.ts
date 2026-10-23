// SPDX-License-Identifier: GPL-3.0-or-later
// The whole game on the user's own Diablo II files (never in CI, never in the repo): only runs with
// D2_MPQ_DIR=<folder with d2data.mpq ...>. Folder input -> Play -> title screen -> character select/create.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

const dir = process.env['D2_MPQ_DIR'];
const shots = process.env['D2_SHOT_DIR'] ?? '/private/tmp/claude-501/-Users-danielbogusz-projects/8d63eb78-aef8-433a-9d2e-12e9bacdc5f2/scratchpad';

test.skip(!dir, 'set D2_MPQ_DIR to run against real game files');
test.setTimeout(10 * 60_000);

/** distinct colours / non-black pixels of a screenshot */
function stats(buf: Buffer): { colours: number; lit: number } {
  const png = PNG.sync.read(buf);
  const seen = new Set<number>();
  let lit = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const c = ((png.data[i] ?? 0) << 16) | ((png.data[i + 1] ?? 0) << 8) | (png.data[i + 2] ?? 0);
    seen.add(c);
    if (c > 0x202020) lit++;
  }
  return { colours: seen.size, lit };
}

/** game pixel (800x600 space) -> page coordinates, replicating the renderer's letterbox */
async function gamePoint(page: Page, x: number, y: number, fbW = 800, fbH = 600): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas#view').boundingBox())!;
  const f = Math.min(box.width / fbW, box.height / fbH);
  const s = f >= 1 ? Math.floor(f) : f;
  const w = Math.floor(fbW * s);
  const h = Math.floor(fbH * s);
  return { x: box.x + (box.width - w) / 2 + (x + 0.5) * s, y: box.y + (box.height - h) / 2 + (y + 0.5) * s };
}

async function click(page: Page, x: number, y: number): Promise<void> {
  const p = await gamePoint(page, x, y);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

async function shownFrames(page: Page): Promise<number> {
  return page.evaluate(() => window.__d2?.full?.shown ?? 0);
}

test('full game: title screen, then character screens', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'debug' && m.text().startsWith('[d2]')) process.stdout.write(`${m.text()}\n`);
  });

  await page.goto('/');
  expect(await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu), 'WebGPU').toBe(true);
  await page.waitForFunction(() => window.__d2?.core?.mode === 'wasm', undefined, { timeout: 30_000 });

  // only the archives, as plain files (Playwright hands local Chromium the paths, nothing is copied)
  // (a scratch folder of hard links, no copy; Playwright skips symlinks: the real folder also holds multi-GB extras)
  const names = fs.readdirSync(dir!).filter((n) => /\.mpq$/i.test(n));
  expect(names.length).toBeGreaterThan(3);
  const link = fs.mkdtempSync(path.join(os.tmpdir(), 'd2links-'));
  for (const n of names) fs.linkSync(path.join(dir!, n), path.join(link, n));
  await page.setInputFiles('#folder', link);
  await expect(page.locator('#game-status')).toContainText('opened', { timeout: 60_000 });

  const t0 = Date.now();
  await page.click('#play-btn');
  await page.waitForFunction(() => (window.__d2?.full?.shown ?? 0) > 5, undefined, { timeout: 240_000 });
  const loadSeconds = (Date.now() - t0) / 1000;
  const info = await page.evaluate(() => ({ heap: window.__d2?.full?.heapMiB, w: window.__d2?.full?.width, h: window.__d2?.full?.height }));
  console.log(`first frames after ${loadSeconds.toFixed(1)} s, wasm heap ${info.heap} MiB, frame ${info.w}x${info.h}`);
  await page.waitForTimeout(1500); // the fire animation moves
  const title = await page.locator('canvas#view').screenshot({ path: path.join(shots, 'full-title.png') });
  const s = stats(title);
  console.log(`title: ${s.colours} colours, ${s.lit} lit pixels`);
  expect(s.colours).toBeGreaterThan(200);
  expect(s.lit).toBeGreaterThan(20_000);
  const before = await shownFrames(page);
  await page.waitForTimeout(1000);
  expect(await shownFrames(page)).toBeGreaterThan(before + 5);

  // SINGLE PLAYER -> character select
  await click(page, 400, 306);
  await page.waitForTimeout(800);
  await page.locator('canvas#view').screenshot({ path: path.join(shots, 'full-select.png') });
  // CREATE NEW CHARACTER (bottom left) -> class selection screen
  await click(page, 117, 498);
  await page.waitForTimeout(1200);
  const chars = await page.locator('canvas#view').screenshot({ path: path.join(shots, 'full-chars.png') });
  const c = stats(chars);
  console.log(`chars: ${c.colours} colours, ${c.lit} lit pixels`);
  expect(c.colours).toBeGreaterThan(100);

  // text input reaches the name field (SDL_EVENT_TEXT_INPUT path)
  await page.keyboard.type('Hero', { delay: 80 });
  await page.waitForTimeout(500);
  const typed = await page.locator('canvas#view').screenshot({ path: path.join(shots, 'full-name.png') });
  expect(Buffer.compare(typed, chars)).not.toBe(0);

  const mem = await page.evaluate(() => window.__d2?.full?.heapMiB);
  console.log(`wasm heap after menus: ${mem} MiB`);
  expect(errors.filter((e) => !/favicon|404/i.test(e))).toEqual([]);

  // Beyond F1 (informational, not asserted): OK -> into the Rogue Encampment, to measure memory and look at it.
  await click(page, 689, 554);
  const t1 = Date.now();
  await page.waitForTimeout(20_000);
  await page.locator('canvas#view').screenshot({ path: path.join(shots, 'full-town.png') });
  const st = await page.evaluate(() => ({ heap: window.__d2?.full?.heapMiB, shown: window.__d2?.full?.shown, status: window.__d2?.full?.status }));
  console.log(`after OK (+${((Date.now() - t1) / 1000).toFixed(0)} s): heap ${st.heap} MiB, shown ${st.shown}, ${st.status}`);
});
