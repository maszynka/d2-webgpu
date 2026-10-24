// SPDX-License-Identifier: GPL-3.0-or-later
// Upscalers stage A on the user's own Diablo II files (D2_MPQ_DIR, never in CI): the game's screen id and UI rects drive
// the menus/HUD scaler. Screenshots go to D2_SHOT_DIR (up-a-*.png).
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { click, gamePoint, mpqDir, openAndPlay, shots, waitState } from './fullhelpers';

test.skip(!mpqDir, 'set D2_MPQ_DIR to run against real game files');
test.setTimeout(10 * 60_000);

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

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

const png = async (page: Page, name?: string): Promise<PNG> => PNG.sync.read(await page.locator('canvas#view').screenshot(name ? { path: path.join(shots, name) } : {}));

/** fraction of pixels in [x0,x1) x [y0,y1) differing by more than tol in any channel */
function diffFrac(a: PNG, b: PNG, x0: number, y0: number, x1: number, y1: number, tol = 8): number {
  let n = 0;
  let d = 0;
  for (let y = Math.max(0, y0); y < Math.min(a.height, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(a.width, x1); x++) {
      const i = (y * a.width + x) * 4;
      n++;
      if (Math.abs(a.data[i]! - b.data[i]!) > tol || Math.abs(a.data[i + 1]! - b.data[i + 1]!) > tol || Math.abs(a.data[i + 2]! - b.data[i + 2]!) > tol) d++;
    }
  return n > 0 ? d / n : 0;
}

test('menu frame: the whole frame uses the UI scaler (ui=sharp vs ui=world differ everywhere)', async ({ page }) => {
  const errors = watch(page);
  await page.addInitScript(() => localStorage.setItem('d2.present', 'fsr1'));
  await openAndPlay(page);
  await page.waitForTimeout(1500);
  await setSelect(page, 'ui-scaler', 'sharp');
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => window.__d2!.present!);
  expect(info.ui).toMatchObject({ scaler: 'sharp', screen: 0, kind: 'all', applied: true });
  const sharpA = await png(page, 'up-a-title-sharp.png');
  await setSelect(page, 'ui-scaler', 'world');
  await page.waitForTimeout(500);
  const worldA = await png(page, 'up-a-title-world.png');
  expect((await page.evaluate(() => window.__d2!.present!)).ui.applied).toBe(false);
  await page.waitForTimeout(300);
  const worldB = await png(page);
  const r = info.rect;
  const noise = diffFrac(worldA, worldB, r.x, r.y, r.x + r.w, r.y + r.h);
  const signal = diffFrac(sharpA, worldA, r.x, r.y, r.x + r.w, r.y + r.h);
  console.log(`title: sharp vs world differ in ${(signal * 100).toFixed(1)}% of the frame (animation noise ${(noise * 100).toFixed(1)}%)`);
  expect(signal).toBeGreaterThan(0.15);
  expect(signal).toBeGreaterThan(noise * 2);
  // the corners of the frame differ too (not just a region): the mask is the whole frame
  for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]] as const) {
    const cx = Math.round(r.x + r.w * fx);
    const cy = Math.round(r.y + r.h * fy);
    expect(diffFrac(sharpA, worldA, cx - 40, cy - 40, cx + 40, cy + 40, 4), `corner ${fx},${fy}`).toBeGreaterThan(0.02);
  }
  expect(errors.filter((e) => !/favicon|404/i.test(e))).toEqual([]);
});

test('camp: HUD uses the UI scaler regardless of the world scaler; inventory rect is UI', async ({ page }) => {
  const errors = watch(page);
  await page.addInitScript(() => {
    localStorage.setItem('d2.present', 'fsr1');
    localStorage.setItem('d2.ui', 'sharp');
  });
  await openAndPlay(page);
  await page.waitForTimeout(1500);
  await newCharacter(page, 'UiA');
  await page.waitForTimeout(3500);
  await page.mouse.move(5, 5); // off the canvas / off the game's hover texts
  const uiState = async (): Promise<{ screen: number; rects: { x: number; y: number; w: number; h: number }[] }> => (await page.evaluate(() => window.__d2!.getUi!()))!;
  const ui = await uiState();
  console.log(`camp UI: screen ${ui.screen}, ${ui.rects.length} rects: ${JSON.stringify(ui.rects)}`);
  expect(ui.screen).toBe(1);
  expect(ui.rects.length).toBeGreaterThan(0);
  expect(ui.rects.length).toBeLessThanOrEqual(64);
  const p = await page.evaluate(() => window.__d2!.present!);
  expect(p.ui).toMatchObject({ screen: 1, kind: 'rects', applied: true });
  const off = (p.srcW - 800) / 2;
  // a rect covers the control-panel band (bottom centre)
  const hudRect = ui.rects.find((r) => r.y + r.h >= 598 && r.x <= off + 300 && r.x + r.w >= off + 500);
  expect(hudRect, 'the control panel band is a UI rect').toBeDefined();
  // the world (screen centre, above the panel) is not
  const inRect = (x: number, y: number): boolean => ui.rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  expect(inRect(p.srcW / 2, 250), 'the world is not UI').toBe(false);

  await page.screenshot({ path: path.join(shots, 'up-a-camp-fsr1-sharp.png') });
  const k = p.rect.w / p.srcW;
  const toC = (gx: number, gy: number): [number, number] => [Math.round(p.rect.x + gx * k), Math.round(p.rect.y + gy * k)];
  const A = await png(page, 'up-a-camp-fsr1-sharp-canvas.png');
  await setSelect(page, 'present', 'bilinear');
  await page.waitForTimeout(700);
  const B = await png(page, 'up-a-camp-bilinear-sharp-canvas.png');
  await setSelect(page, 'ui-scaler', 'world');
  await page.waitForTimeout(700);
  const C = await png(page, 'up-a-camp-bilinear-world-canvas.png');
  await setSelect(page, 'present', 'fsr1');
  await page.waitForTimeout(700);
  const D = await png(page, 'up-a-camp-fsr1-world-canvas.png');
  // HUD band, inside the mask away from its edges (centre part of the panel, 6 source px in)
  const [hx0, hy0] = toC(hudRect!.x + 60, hudRect!.y + 18);
  const [hx1, hy1] = toC(hudRect!.x + hudRect!.w - 60, 596);
  const hudSame = diffFrac(A, B, hx0, hy0, hx1, hy1);
  const hudWorld = diffFrac(C, D, hx0, hy0, hx1, hy1);
  const worldBand = diffFrac(A, B, ...toC(p.srcW * 0.3, 120), ...toC(p.srcW * 0.7, 380));
  console.log(`HUD band differs: sharp/sharp ${(hudSame * 100).toFixed(2)}% (fsr1 vs bilinear world), world/world ${(hudWorld * 100).toFixed(1)}%; world region fsr1 vs bilinear ${(worldBand * 100).toFixed(1)}%`);
  expect(hudSame, 'HUD band equal for world=fsr1 and world=bilinear with ui=sharp').toBeLessThan(0.01);
  expect(hudWorld, 'with ui=world the HUD band follows the world scaler').toBeGreaterThan(hudSame * 5 + 0.01);
  expect(worldBand, 'the world region differs between the world scalers').toBeGreaterThan(0.03);

  // loupe at 4x on the HUD: ui=sharp vs ui=world
  const hudPt = await gamePoint(page, 400, 575);
  await page.evaluate(() => {
    const b = document.getElementById('loupe-btn') as HTMLButtonElement;
    if (b.getAttribute('aria-pressed') !== 'true') b.click();
    const z = document.getElementById('loupe-zoom') as HTMLSelectElement;
    z.value = '4';
    z.dispatchEvent(new Event('change'));
  });
  await page.mouse.move(hudPt.x, hudPt.y);
  await page.waitForTimeout(800);
  expect((await page.evaluate(() => window.__d2!.present!.loupe))!.zoom).toBe(4);
  await page.screenshot({ path: path.join(shots, 'up-a-loupe-hud-ui-world.png') });
  await setSelect(page, 'ui-scaler', 'sharp');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'up-a-loupe-hud-ui-sharp.png') });

  // inventory open: its rect is UI
  await page.evaluate(() => {
    const b = document.getElementById('loupe-btn') as HTMLButtonElement;
    if (b.getAttribute('aria-pressed') === 'true') b.click();
  });
  await page.mouse.move(5, 5);
  await page.locator('canvas#view').focus();
  const probe = { x: off + 600, y: 180 }; // the inventory's body on the right half
  expect(inRect(probe.x, probe.y), 'before: not UI').toBe(false);
  await page.keyboard.press('KeyI');
  await page.waitForTimeout(1200);
  const ui2 = await uiState();
  console.log(`inventory open: ${ui2.rects.length} rects: ${JSON.stringify(ui2.rects)}`);
  const inRect2 = (x: number, y: number): boolean => ui2.rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  expect(inRect2(probe.x, probe.y), 'the inventory panel is UI').toBe(true);
  await page.screenshot({ path: path.join(shots, 'up-a-camp-inventory.png') });
  await page.keyboard.press('KeyI');
  await page.waitForTimeout(800);
  expect(errors.filter((e) => !/favicon|404/i.test(e))).toEqual([]);
});
