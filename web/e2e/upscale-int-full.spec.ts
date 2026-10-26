// SPDX-License-Identifier: GPL-3.0-or-later
// Upscalers integration on the user's own Diablo II files (D2_MPQ_DIR, never in CI): the camp at DPR 2 through fsr1 and
// each real stage, plus De-dither on/off. Screenshots go to D2_SHOT_DIR (up-int-*.png).
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { click, mpqDir, openAndPlay, shots, waitState } from './fullhelpers';

test.skip(!mpqDir, 'set D2_MPQ_DIR to run against real game files');
test.setTimeout(15 * 60_000);
test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });

async function newCharacter(page: Page, name: string): Promise<void> {
  await click(page, 400, 306);
  await page.waitForTimeout(800);
  await click(page, 117, 498);
  await page.waitForTimeout(1200);
  await page.keyboard.type(name, { delay: 80 });
  await page.waitForTimeout(400);
  await click(page, 689, 554);
  await waitState(page, (s) => s['screen'] === 'ingame', 120_000, 'in game');
}

async function setSelect(page: Page, id: string, value: string): Promise<void> {
  await page.evaluate(
    ([i, v]) => {
      const s = document.getElementById(i!) as HTMLSelectElement;
      s.value = v!;
      s.dispatchEvent(new Event('change'));
    },
    [id, value],
  );
}

async function setDedither(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => {
    const b = document.getElementById('dedither') as HTMLInputElement;
    b.checked = v;
    b.dispatchEvent(new Event('change'));
  }, on);
}

const png = async (page: Page, name: string): Promise<PNG> => PNG.sync.read(await page.locator('canvas#view').screenshot({ path: path.join(shots, name) }));

async function useMode(page: Page, mode: string): Promise<void> {
  await setSelect(page, 'present', mode);
  await page.waitForFunction((m) => window.__d2!.present!.mode === m && (m === 'fsr1' || window.__d2!.present!.pass === 'stage'), mode, { timeout: 120_000 });
  await page.waitForTimeout(2500);
}

test('camp at DPR 2: fsr1 and every stage render without errors; de-dither on/off screenshots', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => (m.type() === 'error' || (m.type() === 'warning' && /WebGPU|validation/i.test(m.text()))) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    localStorage.setItem('d2.present', 'fsr1');
    localStorage.setItem('d2.ui', 'sharp');
  });
  await openAndPlay(page);
  await page.waitForTimeout(1500);
  await newCharacter(page, 'UiInt');
  await page.waitForTimeout(3500);
  await page.mouse.move(5, 5);
  const info = await page.evaluate(() => window.__d2!.present!);
  console.log(`camp: ${info.srcW}x${info.srcH} -> ${info.rect.w}x${info.rect.h} in ${info.canvasW}x${info.canvasH} (dpr ${info.dprEffective})`);
  const out: Record<string, PNG> = {};
  for (const mode of ['fsr1', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx']) {
    await useMode(page, mode);
    const p = await page.evaluate(() => window.__d2!.present!);
    console.log(`${mode}: pass ${p.pass} stage ${p.stage} gpu ${p.gpuMs === null ? '-' : p.gpuMs.toFixed(2)} ms ${p.gpuParts.map((g) => `${g.label} ${g.ms.toFixed(2)}`).join('; ')}`);
    if (mode !== 'fsr1') expect(p.stage).toBe(mode);
    out[mode] = await png(page, `up-int-${mode}.png`);
  }
  for (const mode of ['smooth-scalefx', 'smooth-sxbr']) {
    await useMode(page, mode);
    await setDedither(page, false);
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => window.__d2!.ui!.present.dedither)).toBe(false);
    await png(page, `up-int-${mode}-nodedither.png`);
    await setDedither(page, true);
    await page.waitForTimeout(1000);
  }
  expect(errors.filter((e) => !/favicon|404/i.test(e))).toEqual([]);
});
