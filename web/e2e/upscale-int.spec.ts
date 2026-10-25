// SPDX-License-Identifier: GPL-3.0-or-later
// Upscalers integration on the demo scene (no game data): the real stages (smooth, ScaleFX, Super-xBR, FSRCNNX) through
// the full renderer path (stage -> EASU/RCAS or downsample, plus the UI pass), async loading, the De-dither toggle, leaks.
// SwiftShader is a CPU rasteriser, so FSRCNNX frames are slow: the tests wait on state, not on frame counts.
import { expect, test, type Page } from '@playwright/test';
import type { PresentInfo } from '../src/gpu/renderer';

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|validation|GPU/i.test(m.text()))) errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function open(page: Page, url: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  test.skip(!(await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu)), 'WebGPU not available in this headless Chromium');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3, undefined, { timeout: 30_000 });
  await page.selectOption('#light-mode', 'off', { force: true });
}

async function present(page: Page): Promise<PresentInfo> {
  return (await page.evaluate(() => window.__d2!.present!))!;
}
const dedither = (page: Page): Promise<boolean> => page.evaluate(() => window.__d2!.ui!.present.dedither);

/** select a mode and wait until it presents through a stage (FSRCNNX loads its weights and pipelines first) */
async function useStage(page: Page, mode: string): Promise<PresentInfo> {
  await page.selectOption('#present', mode);
  await page.waitForFunction((m) => window.__d2!.present!.mode === m && window.__d2!.present!.pass === 'stage', mode, { timeout: 90_000 });
  // one more presented frame on the stage
  const f0 = await page.evaluate(() => window.__d2!.frames);
  await page.waitForFunction((k) => window.__d2!.frames > k + 1, f0, { timeout: 90_000 });
  return present(page);
}

const STAGE_MODES = ['smooth', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx'];

test.describe('real stages through the renderer', () => {
  test('every stage mode renders at DPR 1 without validation errors', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = watch(page);
    await open(page, '/');
    for (const id of STAGE_MODES) {
      await expect(page.locator(`#present option[value="${id}"]`)).toBeEnabled();
      const p = await useStage(page, id);
      expect(p.mode).toBe(id);
      expect(p.stage).toMatch(id === 'smooth' ? /^smooth-(scalefx|sxbr)$/ : new RegExp(`^${id}$`));
    }
    expect(errors).toEqual([]);
  });

  test.describe('at DPR 2', () => {
    test.use({ deviceScaleFactor: 2 });

    test('every stage mode runs stage -> EASU/RCAS or downsample + the UI pass; compare fsrcnnx vs fsr1', async ({ page }) => {
      test.setTimeout(300_000);
      const errors = watch(page);
      await open(page, '/?hud=1&ui=sharp');
      await page.evaluate(() => window.__d2!.setUi!({ screen: 1, rects: [{ x: 0, y: 500, w: 800, h: 100 }] }));
      for (const id of STAGE_MODES) {
        const p = await useStage(page, id);
        expect(p.rect.w).toBeGreaterThan(2 * p.srcW); // 3.2x output: ScaleFX 3x is downsampled-or-copied, the 2x stages are EASU-upscaled
        expect(p.ui).toMatchObject({ scaler: 'sharp', kind: 'rects', applied: true });
      }
      await page.click('#cmp-btn');
      await page.selectOption('#cmp-a', 'fsrcnnx');
      await page.selectOption('#cmp-b', 'fsr1');
      await page.waitForFunction(() => window.__d2!.present!.compare?.passA === 'stage', undefined, { timeout: 90_000 });
      const f0 = await page.evaluate(() => window.__d2!.frames);
      await page.waitForFunction((k) => window.__d2!.frames > k + 1, f0, { timeout: 90_000 });
      expect((await present(page)).compare).toMatchObject({ a: 'fsrcnnx', b: 'fsr1', passA: 'stage', passB: 'easu-rcas' });
      expect(errors).toEqual([]);
    });

    test('cycling real stages, sizes and density keeps the live texture count bounded', async ({ page }) => {
      test.setTimeout(420_000);
      const errors = watch(page);
      await open(page, '/');
      await page.evaluate(() => window.__d2!.setUi!({ screen: 1, rects: [{ x: 0, y: 500, w: 800, h: 100 }] }));
      const stats = (): Promise<{ created: number; destroyed: number; live: number; stages: number; resample: number }> => page.evaluate(() => window.__d2!.textures!());
      const modes = ['fsr1', 'smooth', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx', 'bilinear'];
      const sizes = [{ width: 1280, height: 800 }, { width: 900, height: 700 }];
      const cycle = async (): Promise<void> => {
        for (const size of sizes) {
          await page.setViewportSize(size);
          for (const m of modes) {
            await page.selectOption('#present', m);
            if (m !== 'fsr1' && m !== 'bilinear') await page.waitForFunction((x) => window.__d2!.present!.mode === x && window.__d2!.present!.pass === 'stage', m, { timeout: 90_000 });
            const f0 = await page.evaluate(() => window.__d2!.frames);
            await page.waitForFunction((k) => window.__d2!.frames > k + 1, f0, { timeout: 90_000 });
          }
        }
      };
      await cycle();
      const base = await stats();
      await cycle();
      await cycle();
      const after = await stats();
      expect(after.created).toBeGreaterThan(base.created);
      expect(after.live).toBeLessThanOrEqual(base.live + 12);
      await page.selectOption('#present', 'bilinear');
      await page.waitForFunction(() => window.__d2!.textures!().stages === 0, undefined, { timeout: 30_000 });
      const end = await stats();
      expect(end.stages).toBe(0);
      expect(end.resample).toBe(0);
      expect(errors).toEqual([]);
    });
  });
});

test.describe('async stage loading', () => {
  test('fsrcnnx shows "loading" and presents with FSR1 until its weights arrive', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watch(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/fsrcnnx-8-0-4-1.bin', async (route) => {
      await gate;
      await route.continue();
    });
    await open(page, '/');
    await page.selectOption('#present', 'fsrcnnx');
    await expect(page.locator('#present option[value="fsrcnnx"]')).toContainText('loading');
    await page.waitForFunction(() => window.__d2!.present!.mode === 'fsrcnnx');
    const loading = (await present(page));
    expect(loading.mode).toBe('fsrcnnx');
    expect(loading.pass).toBe('easu-rcas'); // FSR1 meanwhile
    expect(loading.stage).toBeNull();
    release();
    await page.waitForFunction(() => window.__d2!.present!.pass === 'stage', undefined, { timeout: 90_000 });
    await expect(page.locator('#present option[value="fsrcnnx"]')).not.toContainText('loading');
    expect(errors).toEqual([]);
  });

  test('a failed load makes the mode unavailable and keeps presenting with FSR1', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(e.message));
    await page.route('**/fsrcnnx-8-0-4-1.bin', (route) => route.abort());
    await open(page, '/');
    await page.selectOption('#present', 'fsrcnnx');
    await expect(page.locator('#present option[value="fsrcnnx"]')).toContainText('not available', { timeout: 30_000 });
    await page.waitForFunction(() => window.__d2!.present!.mode === 'fsrcnnx');
    const p = (await present(page));
    expect(p.pass).toBe('easu-rcas');
    expect(p.stage).toBeNull();
    // the other stages are unaffected
    const s = await useStage(page, 'smooth-sxbr');
    expect(s.stage).toBe('smooth-sxbr');
    expect(failures).toEqual([]);
  });
});

test.describe('De-dither toggle', () => {
  test('on by default, ?dedither=0 turns it off, the checkbox is only shown for the smooth modes and rebuilds the stage', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watch(page);
    await open(page, '/');
    await page.locator('#tools-btn').click();
    const box = page.locator('#dedither');
    await expect(box).toBeHidden(); // fsr1
    await useStage(page, 'smooth-scalefx');
    await expect(box).toBeVisible();
    await expect(box).toBeChecked();
    expect(await dedither(page)).toBe(true);
    const withDd = (await page.evaluate(() => window.__d2!.textures!())).stages;
    await box.uncheck();
    await page.waitForFunction(() => window.__d2!.ui!.present.dedither === false);
    await page.waitForFunction(() => window.__d2!.present!.pass === 'stage');
    const f0 = await page.evaluate(() => window.__d2!.frames);
    await page.waitForFunction((k) => window.__d2!.frames > k + 2, f0, { timeout: 60_000 });
    const without = (await page.evaluate(() => window.__d2!.textures!())).stages;
    expect(without).toBeLessThan(withDd); // the dedither passes' textures are gone
    await page.selectOption('#present', 'fsrcnnx');
    await expect(box).toBeHidden();

    await page.goto('/?dedither=0&present=smooth-sxbr');
    await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3);
    expect(await dedither(page)).toBe(false);
    await page.locator('#tools-btn').click();
    await expect(page.locator('#dedither')).not.toBeChecked();
    expect(errors).toEqual([]);
  });
});

test.describe('default upscaler', () => {
  test('with no pick the page chooses for the GPU; ?present= and the select win', async ({ page }) => {
    const errors = watch(page);
    await open(page, '/');
    const fallback = await page.evaluate(() => !!(window.__d2!.adapter as { isFallback?: boolean } | null)?.isFallback);
    const p = await present(page);
    // a software adapter (SwiftShader here, normally) starts on bilinear; a real GPU starts on FSR1 and keeps it under budget
    expect(p.mode).toBe(fallback ? 'bilinear' : 'fsr1');
    if (fallback) expect(await page.getAttribute('#present', 'title')).toMatch(/Auto: bilinear/);
    // the viewer's pick is not overridden
    await page.selectOption('#present', 'fsr1');
    await page.waitForFunction(() => window.__d2!.present!.mode === 'fsr1');
    const f0 = await page.evaluate(() => window.__d2!.frames);
    await page.waitForFunction((k) => window.__d2!.frames > k + 40, f0, { timeout: 60_000 });
    expect((await present(page)).mode).toBe('fsr1');
    // and an explicit ?present= is kept from the start
    await open(page, '/?present=fsr1');
    expect((await present(page)).mode).toBe('fsr1');
    expect(errors).toEqual([]);
  });
});
