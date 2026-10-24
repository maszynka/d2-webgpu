// SPDX-License-Identifier: GPL-3.0-or-later
// Page chrome without game data: the bar, the surface, the debug overlay, presentation controls, fullscreen, hotkeys,
// drop zone (docs/design/ui.md section 6.4).
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|validation|GPU/i.test(m.text()))) errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function ready(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  test.skip(!(await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu)), 'WebGPU not available in this headless Chromium');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 5, undefined, { timeout: 30_000 });
}

function colours(buf: Buffer): number {
  const png = PNG.sync.read(buf);
  const seen = new Set<number>();
  for (let i = 0; i < png.data.length; i += 4) seen.add(((png.data[i] ?? 0) << 16) | ((png.data[i + 1] ?? 0) << 8) | (png.data[i + 2] ?? 0));
  return seen.size;
}

test('layout: a 32 px bar and a surface that fills the rest, no scrollbars', async ({ page }) => {
  await ready(page);
  const bar = (await page.locator('#bar').boundingBox())!;
  const stage = (await page.locator('#stage').boundingBox())!;
  const canvas = (await page.locator('canvas#view').boundingBox())!;
  expect(bar.height).toBe(32);
  expect(stage.y).toBe(32);
  expect(canvas).toEqual(stage);
  expect(await page.evaluate(() => [document.documentElement.scrollHeight, innerHeight, document.documentElement.scrollWidth, innerWidth])).toEqual([
    await page.evaluate(() => innerHeight),
    await page.evaluate(() => innerHeight),
    await page.evaluate(() => innerWidth),
    await page.evaluate(() => innerWidth),
  ]);
  expect(await page.evaluate(() => window.__d2?.ui?.state)).toBe('nofiles');
  expect(await page.evaluate(() => window.__d2?.ui?.bar)).toBe('inflow');
  await expect(page.locator('#game-status')).toContainText('No game folder');
});

test('debug overlay: hidden by default, ?debug=1 / F9 / button, remembered', async ({ page }) => {
  await ready(page);
  await expect(page.locator('#debug')).toBeHidden();
  await page.goto('/?debug=1');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 40);
  await expect(page.locator('#debug')).toBeVisible();
  await expect(page.locator('#debug')).toContainText('adapter:');
  await expect(page.locator('#debug')).toContainText('present:');
  await page.screenshot({ path: `${process.env['D2_SHOT_DIR'] ?? 'test-results'}/res-debug-overlay.png` });
  await page.keyboard.press('F9');
  await expect(page.locator('#debug')).toBeHidden();
  await expect(page.locator('#debug-btn')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('F9');
  await expect(page.locator('#debug')).toBeVisible();
  await page.goto('/');
  await expect(page.locator('#debug')).toBeVisible();
  await page.reload();
  await expect(page.locator('#debug')).toBeVisible(); // remembered
  await page.click('#debug-btn');
  await expect(page.locator('#debug')).toBeHidden();
  await page.reload();
  await expect(page.locator('#debug')).toBeHidden();
});

test('mode select and the tools popover', async ({ page }) => {
  await ready(page);
  for (const m of ['view', 'map', 'play']) await expect(page.locator(`#mode option[value=${m}]`)).toBeDisabled();
  await expect(page.locator('#mode')).toHaveValue('demo');
  await expect(page.locator('#game-tools')).toBeHidden();
  await page.click('#tools-btn');
  await expect(page.locator('#game-tools')).toBeVisible();
  await expect(page.locator('#tools-btn')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#path').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-tools')).toBeHidden();
  await expect(page.locator('#tools-btn')).toBeFocused();
  await page.click('#brand');
  await expect(page.locator('#about')).toBeVisible();
  await expect(page.locator('#about')).toContainText('GPL-3.0-or-later');
});

test('presentation controls apply and survive a reload', async ({ page }) => {
  await ready(page);
  await page.selectOption('#present', 'nearest');
  expect(await page.evaluate(() => window.__d2?.ui?.present.mode)).toBe('nearest');
  await expect(page.locator('#sharp')).toBeHidden();
  await page.selectOption('#present', 'fsr1');
  await expect(page.locator('#sharp')).toBeVisible();
  await page.locator('#sharp').fill('1');
  expect(await page.evaluate(() => window.__d2?.ui?.present.sharpness)).toBe(1);
  await page.reload();
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3);
  expect(await page.evaluate(() => window.__d2?.ui?.present)).toEqual({ mode: 'fsr1', sharpness: 1 });
  await page.selectOption('#present', 'bilinear');
  await page.reload();
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3);
  expect(await page.evaluate(() => window.__d2?.ui?.present.mode)).toBe('bilinear');
  // the URL wins for that load and is not written back
  await page.goto('/?present=nearest&sharp=0.5');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3);
  expect(await page.evaluate(() => window.__d2?.ui?.present)).toEqual({ mode: 'nearest', sharpness: 0.5 });
  await page.goto('/');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3);
  expect(await page.evaluate(() => window.__d2?.ui?.present.mode)).toBe('bilinear');
});

test('resizing keeps the backing store at device pixels and the picture alive', async ({ page }) => {
  const errors = watch(page);
  await ready(page);
  for (const [w, h] of [[1600, 900], [800, 600], [1600, 900]] as const) {
    await page.setViewportSize({ width: w, height: h });
    const f0 = await page.evaluate(() => window.__d2?.frames ?? 0);
    await page.waitForFunction((n) => (window.__d2?.frames ?? 0) > n + 4, f0);
    const d = await page.evaluate(() => {
      const c = document.querySelector('canvas#view') as HTMLCanvasElement;
      return { cw: c.width, ch: c.height, w: c.clientWidth, h: c.clientHeight, dpr: devicePixelRatio };
    });
    expect(d.cw).toBe(Math.round(d.w * d.dpr));
    expect(d.ch).toBe(Math.round(d.h * d.dpr));
    expect(colours(await page.locator('canvas#view').screenshot())).toBeGreaterThan(8);
  }
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('fullscreen: the bar becomes an auto-hiding overlay, F11 toggles', async ({ page }) => {
  await page.addInitScript(() => {
    // headless Chromium may refuse real fullscreen: emulate the element + event
    const w = window as unknown as { __fsEl: Element | null };
    w.__fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', { get: () => w.__fsEl, configurable: true });
    Element.prototype.requestFullscreen = function (this: Element) {
      w.__fsEl = this;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
    document.exitFullscreen = () => {
      w.__fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
  });
  await ready(page);
  await page.click('#fs-btn');
  await page.mouse.move(400, 400); // off the bar
  await expect.poll(() => page.evaluate(() => window.__d2?.ui?.fullscreen)).toBe(true);
  await expect(page.locator('#fs-btn')).toHaveAttribute('aria-pressed', 'true');
  // overlay: the surface now covers the viewport; the bar hides itself after 1.5 s
  await expect.poll(() => page.evaluate(() => window.__d2?.ui?.bar), { timeout: 5000 }).toBe('overlay-hidden');
  await expect(page.locator('#bar')).toHaveClass(/hidden/);
  const box = (await page.locator('#stage').boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.y).toBe(0);
  expect(box.height).toBe(vp.height);
  await page.mouse.move(400, 1);
  await expect.poll(() => page.evaluate(() => window.__d2?.ui?.bar), { timeout: 3000 }).toBe('overlay-visible');
  await page.mouse.move(400, 300);
  await expect.poll(() => page.evaluate(() => window.__d2?.ui?.bar), { timeout: 5000 }).toBe('overlay-hidden');
  await page.keyboard.press('F11');
  await expect.poll(() => page.evaluate(() => window.__d2?.ui?.fullscreen)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__d2?.ui?.bar)).toBe('inflow');
  await page.keyboard.press('Alt+Enter');
  await expect.poll(() => page.evaluate(() => window.__d2?.ui?.fullscreen)).toBe(true);
});

test('keyboard: F10 reveals the bar and focuses the mode select', async ({ page }) => {
  await ready(page);
  await page.locator('canvas#view').focus();
  await page.keyboard.press('F10');
  await expect(page.locator('#mode')).toBeFocused();
});

test('without WebGPU: the notice, a disabled file picker, About still reachable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await page.goto('/');
  await expect(page.locator('#nogpu')).toBeVisible();
  await expect(page.locator('#nogpu')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#folder')).toBeDisabled();
  await expect(page.locator('#pick')).toBeDisabled();
  await page.click('#brand');
  await expect(page.locator('#about')).toContainText('GPL-3.0-or-later');
});

test('the drop zone shows while files are dragged over the page', async ({ page }) => {
  await ready(page);
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['x'], 'd2data.mpq'));
    return d;
  });
  await page.dispatchEvent('#stage', 'dragenter', { dataTransfer: dt });
  await expect(page.locator('#drop')).toBeVisible();
  await page.dispatchEvent('#stage', 'dragleave', { dataTransfer: dt });
  await expect(page.locator('#drop')).toBeHidden();
});

test('screenshot of the bar in the no-files state', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await ready(page);
  await page.screenshot({ path: `${process.env['D2_SHOT_DIR'] ?? 'test-results'}/res-bar-nofiles.png` });
});
