// SPDX-License-Identifier: GPL-3.0-or-later
// Upscalers stage A on the demo scene (no game data): world-stage seam with a fake 2x stage, the menus/HUD UI scaler
// and its mask, render density, texture leak counters.
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

async function open(page: Page, url: string, size = { width: 1280, height: 800 }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(url);
  test.skip(!(await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu)), 'WebGPU not available in this headless Chromium');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 5, undefined, { timeout: 30_000 });
  await page.selectOption('#light-mode', 'off', { force: true });
  await frames(page);
}

async function frames(page: Page, n = 6): Promise<void> {
  const f0 = await page.evaluate(() => window.__d2?.frames ?? 0);
  await page.waitForFunction((k) => (window.__d2?.frames ?? 0) > k + 6, f0 + n - 6, { timeout: 30_000 });
}

async function canvasPng(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.locator('canvas#view').screenshot());
}

/** the scene stops rendering new frames (window.__d2.frames stops counting); setting changes still repaint */
async function freeze(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__d2!.paused = true;
  });
  await page.waitForTimeout(400);
}

let frozen = false;
async function settle(page: Page, n = 3): Promise<void> {
  if (frozen) await page.waitForTimeout(400);
  else await frames(page, n);
}

/** the differing pixels between two same-size screenshots: count and bounding box */
function diffPixels(a: PNG, b: PNG, tol = 2): { count: number; x0: number; y0: number; x1: number; y1: number } {
  const r = { count: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (Math.abs(a.data[i]! - b.data[i]!) > tol || Math.abs(a.data[i + 1]! - b.data[i + 1]!) > tol || Math.abs(a.data[i + 2]! - b.data[i + 2]!) > tol) {
        r.count++;
        if (x < r.x0) r.x0 = x;
        if (x > r.x1) r.x1 = x;
        if (y < r.y0) r.y0 = y;
        if (y > r.y1) r.y1 = y;
      }
    }
  return r;
}

async function setMode(page: Page, mode: string): Promise<void> {
  await page.selectOption('#present', mode);
  await frames(page);
}

test.describe('world stage seam (fake 2x stage)', () => {
  test('stage modes are listed but disabled until a stage is registered, then run without validation errors', async ({ page }) => {
    const errors = watch(page);
    await open(page, '/');
    await page.evaluate(() => window.__d2!.unregisterStages!()); // the app registers the real stages at startup
    for (const id of ['smooth', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx']) {
      const o = page.locator(`#present option[value="${id}"]`);
      await expect(o).toHaveCount(1);
      expect(await o.evaluate((e) => (e as HTMLOptionElement).disabled)).toBe(true);
      expect(await o.evaluate((e) => e.textContent)).toContain('not available');
    }
    // unavailable: planPresent falls back to FSR1
    await page.evaluate(() => {
      const s = document.getElementById('present') as HTMLSelectElement;
      s.value = 'fsrcnnx'; // programmatic selection of a disabled option still sets the mode through the change handler
      s.dispatchEvent(new Event('change'));
    });
    await frames(page);
    expect((await page.evaluate(() => window.__d2!.present!)).pass).toBe('easu-rcas');

    await page.evaluate(() => {
      window.__d2!.registerFakeStage!('smooth-scalefx');
      window.__d2!.registerFakeStage!('smooth-sxbr');
      window.__d2!.registerFakeStage!('fsrcnnx');
    });
    for (const id of ['smooth', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx']) {
      expect(await page.locator(`#present option[value="${id}"]`).evaluate((e) => (e as HTMLOptionElement).disabled)).toBe(false);
      await setMode(page, id);
      const p = await page.evaluate(() => window.__d2!.present!);
      expect(p.mode).toBe(id);
      expect(p.pass).toBe('stage'); // 1280x800 canvas, 800x600 source: 1.6x output < the stage's 2x -> area downsample
      expect(p.stage).toMatch(/smooth-|fsrcnnx/);
      const png = await canvasPng(page);
      expect(png.width).toBeGreaterThan(100);
    }
    expect(errors).toEqual([]);
  });

  test.describe('at DPR 2 (an upscale after the stage: EASU + RCAS)', () => {
    test.use({ deviceScaleFactor: 2 });
    test('stage output smaller than the target goes through EASU+RCAS; compare mixes stage and FSR1', async ({ page }) => {
      const errors = watch(page);
      await open(page, '/?hud=1');
      await page.evaluate(() => window.__d2!.registerFakeStage!('smooth-sxbr'));
      await setMode(page, 'smooth-sxbr');
      const p = await page.evaluate(() => window.__d2!.present!);
      expect(p.pass).toBe('stage');
      expect(p.rect.w).toBeGreaterThan(2 * p.srcW); // 3.2x: the 2x stage output is EASU-upscaled
      await expect(page.locator('#hud')).toContainText('stage smooth-sxbr');
      await page.click('#cmp-btn');
      await page.selectOption('#cmp-a', 'smooth-sxbr');
      await page.selectOption('#cmp-b', 'fsr1');
      await frames(page);
      const c = await page.evaluate(() => window.__d2!.present!);
      expect(c.compare).toMatchObject({ a: 'smooth-sxbr', b: 'fsr1', passA: 'stage', passB: 'easu-rcas' });
      expect(errors).toEqual([]);
    });

    test('render density 1x halves the backing store at DPR 2; the loupe and rect stay consistent', async ({ page }) => {
      const errors = watch(page);
      await open(page, '/?loupe=1&hud=1');
      const size = async (): Promise<{ cw: number; ch: number; css: number; eff: number }> =>
        page.evaluate(() => {
          const c = document.querySelector('canvas#view') as HTMLCanvasElement;
          return { cw: c.width, ch: c.height, css: c.clientWidth, eff: window.__d2!.present!.dprEffective };
        });
      const auto = await size();
      expect(auto.cw).toBe(auto.css * 2);
      expect(auto.eff).toBeCloseTo(2, 2);
      await page.locator('#display-btn').click();
      await page.selectOption('#density', '1');
      await page.keyboard.press('Escape');
      await frames(page);
      const one = await size();
      expect(one.cw).toBe(one.css);
      expect(one.cw * 2).toBe(auto.cw);
      expect(one.eff).toBeCloseTo(1, 2);
      const p = await page.evaluate(() => window.__d2!.present!);
      expect(p.density).toBe('1');
      expect(p.canvasW).toBe(one.cw);
      expect(p.rect.w).toBeLessThanOrEqual(one.cw);
      await expect(page.locator('#hud')).toContainText('density 1');
      // the loupe square follows the pointer at the new density
      const box = (await page.locator('canvas#view').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await frames(page);
      const l = await page.evaluate(() => window.__d2!.present!.loupe);
      expect(l).not.toBeNull();
      expect(Math.abs(l!.center.x - one.cw / 2)).toBeLessThanOrEqual(2);
      // ?density=1 and the stored value
      await page.goto('/?density=1');
      await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3);
      expect(await page.evaluate(() => (window.__d2!.ui!.present as { density: string }).density)).toBe('1');
      expect(errors).toEqual([]);
    });
  });
});

test.describe('menus / HUD UI scaler', () => {
  test('with a synthetic UI rect, ui=sharp vs ui=world differs only inside the mask', async ({ page }) => {
    const errors = watch(page);
    await open(page, '/?ui=world&present=fsr1'); // explicit: the auto default is bilinear on a software adapter
    await freeze(page);
    frozen = true;
    await page.evaluate(() => window.__d2!.setUi!({ screen: 1, rects: [{ x: 120, y: 200, w: 200, h: 150 }] }));
    await settle(page);
    const world = await canvasPng(page);
    await page.selectOption('#ui-scaler', 'sharp', { force: true });
    await settle(page);
    const sharp = await canvasPng(page);
    const p = await page.evaluate(() => window.__d2!.present!);
    expect(p.ui).toMatchObject({ scaler: 'sharp', kind: 'rects', rects: 1, applied: true });
    const k = p.rect.w / p.srcW;
    const dpr = world.width / (await page.locator('canvas#view').evaluate((c) => (c as HTMLCanvasElement).clientWidth));
    const toCanvas = (sx: number, sy: number): [number, number] => [p.rect.x + sx * k, p.rect.y + sy * k];
    const [x0, y0] = toCanvas(120 - 1, 200 - 1);
    const [x1, y1] = toCanvas(120 + 200 + 1, 200 + 150 + 1);
    const d = diffPixels(world, sharp);
    expect(d.count).toBeGreaterThan(200); // the UI scaler changed pixels...
    const m = 2 * dpr;
    // ...all of them inside the mask (grown by 1 source px, plus a little for the 2 px blend / rounding)
    expect([d.x0 >= x0 - m, d.x1 <= x1 + m, d.y0 >= y0 - m, d.y1 <= y1 + m]).toEqual([true, true, true, true]);
    // "nearest" differs from sharp too, in the same region only
    await page.selectOption('#ui-scaler', 'nearest', { force: true });
    await settle(page);
    const near = await canvasPng(page);
    const d2 = diffPixels(sharp, near);
    expect(d2.count).toBeGreaterThan(50);
    expect([d2.x0 >= x0 - m, d2.x1 <= x1 + m, d2.y0 >= y0 - m, d2.y1 <= y1 + m]).toEqual([true, true, true, true]);
    // a menu screen: the whole frame is UI
    await page.evaluate(() => window.__d2!.setUi!({ screen: 0, rects: [] }));
    await page.selectOption('#ui-scaler', 'sharp', { force: true });
    await settle(page);
    const menu = await canvasPng(page);
    expect((await page.evaluate(() => window.__d2!.present!)).ui).toMatchObject({ kind: 'all', applied: true });
    const dm = diffPixels(world, menu);
    expect(dm.count).toBeGreaterThan(d.count * 3);
    // video / no info: no UI pass
    await page.evaluate(() => window.__d2!.setUi!(null));
    await settle(page);
    expect((await page.evaluate(() => window.__d2!.present!)).ui.applied).toBe(false);
    frozen = false;
    expect(errors).toEqual([]);
  });

  test('works in compare mode (both sides) and with the loupe', async ({ page }) => {
    const errors = watch(page);
    await open(page, '/?compare=1&cmpA=bilinear&cmpB=fsr1&loupe=1&hud=1');
    await page.evaluate(() => window.__d2!.setUi!({ screen: 0, rects: [] }));
    await frames(page, 4);
    const p = await page.evaluate(() => window.__d2!.present!);
    expect(p.ui).toMatchObject({ scaler: 'sharp', kind: 'all', applied: true });
    // with the whole frame UI both halves are the same picture
    const png = await canvasPng(page);
    const y = Math.floor(png.height / 2);
    const left = (p.compare!.splitPx - 40) >> 0;
    const right = (p.compare!.splitPx + 40) >> 0;
    let same = 0;
    for (let x = 0; x < 20; x++) {
      const a = (y * png.width + left - x) * 4;
      const b = (y * png.width + right + x) * 4;
      if (Math.abs(png.data[a]! - png.data[b]!) < 255) same++;
    }
    expect(same).toBeGreaterThan(0);
    const box = (await page.locator('canvas#view').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await frames(page, 3);
    expect(await page.evaluate(() => window.__d2!.present!.loupe)).not.toBeNull();
    expect(errors).toEqual([]);
  });

  test('settings: the select, ?ui= and localStorage', async ({ page }) => {
    await open(page, '/?ui=nearest');
    expect(await page.evaluate(() => (window.__d2!.ui!.present as { ui: string }).ui)).toBe('nearest');
    await page.goto('/');
    await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3);
    expect(await page.evaluate(() => (window.__d2!.ui!.present as { ui: string }).ui)).toBe('sharp'); // default
    await page.locator('#display-btn').click();
    await page.selectOption('#ui-scaler', 'world');
    expect(await page.evaluate(() => localStorage.getItem('d2.ui'))).toBe('world');
    await page.reload();
    await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3);
    expect(await page.evaluate(() => (window.__d2!.ui!.present as { ui: string }).ui)).toBe('world');
  });
});

test.describe('texture leaks', () => {
  test.use({ deviceScaleFactor: 2 });
  test('cycling modes, sizes and density keeps the live texture count bounded', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watch(page);
    await open(page, '/');
    await page.evaluate(() => {
      window.__d2!.registerFakeStage!('smooth-scalefx');
      window.__d2!.registerFakeStage!('smooth-sxbr');
      window.__d2!.registerFakeStage!('fsrcnnx');
      window.__d2!.setUi!({ screen: 1, rects: [{ x: 0, y: 500, w: 800, h: 100 }] });
    });
    const stats = (): Promise<{ created: number; destroyed: number; live: number; stages: number; resample: number }> => page.evaluate(() => window.__d2!.textures!());
    // warm up every path once, then measure
    const modes = ['fsr1', 'fsr1-pixel', 'smooth', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx', 'easu', 'bilinear', 'nearest', 'native'];
    const sizes = [{ width: 1280, height: 800 }, { width: 900, height: 700 }, { width: 1500, height: 900 }];
    const cycle = async (): Promise<void> => {
      for (const size of sizes) {
        await page.setViewportSize(size);
        for (const density of ['auto', '1']) {
          await page.evaluate((d) => {
            const s = document.getElementById('density') as HTMLSelectElement;
            s.value = d;
            s.dispatchEvent(new Event('change'));
          }, density);
          for (const m of modes) await setMode(page, m);
        }
      }
    };
    await cycle();
    const base = await stats();
    for (let i = 0; i < 2; i++) await cycle();
    const after = await stats();
    expect(after.created).toBeGreaterThan(base.created); // textures were recreated on size changes...
    expect(after.live).toBeLessThanOrEqual(base.live + 12); // ...and released: live count does not grow
    expect(after.live).toBeLessThan(60);
    expect(after.stages).toBeLessThanOrEqual(2);
    expect(after.resample).toBeLessThanOrEqual(2);
    // leaving the stage modes drops the stage and its resampler
    await setMode(page, 'bilinear');
    const end = await stats();
    expect(end.stages).toBe(0);
    expect(end.resample).toBe(0);
    expect(errors).toEqual([]);
  });
});
