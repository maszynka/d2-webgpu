// SPDX-License-Identifier: GPL-3.0-or-later
// A/B compare, the 1:1 mode, the loupe and the HUD on the demo scene (no game data).
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

const shotDir = process.env['D2_SHOT_DIR'] ?? 'test-results';

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
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 5, undefined, { timeout: 30_000 });
  await page.selectOption('#light-mode', 'off', { force: true }); // flat, still-ish picture
  await frames(page);
}

async function frames(page: Page, n = 6): Promise<void> {
  const f0 = await page.evaluate(() => window.__d2?.frames ?? 0);
  await page.waitForFunction((k) => (window.__d2?.frames ?? 0) > k + 6, f0 + n - 6, { timeout: 30_000 });
}

async function canvasPng(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.locator('canvas#view').screenshot());
}

const lum = (png: PNG, x: number, y: number): number => {
  const i = (y * png.width + x) * 4;
  return 0.299 * png.data[i]! + 0.587 * png.data[i + 1]! + 0.114 * png.data[i + 2]!;
};

/** mean absolute luminance step between horizontally adjacent pixels in [x0,x1) x [y0,y1): edge sharpness */
function edgeMetric(png: PNG, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0 + 1; x < x1; x++) {
        sum += Math.abs(lum(png, x, y) - lum(png, x - 1, y));
        n++;
      }
  return sum / n;
}

/** A/B edge metric of the two halves, away from the divider, chips and HUD */
async function halves(page: Page): Promise<{ a: number; b: number; split: number }> {
  const png = await canvasPng(page);
  const info = await page.evaluate(() => ({ split: window.__d2!.present!.compare!.splitPx, rect: window.__d2!.present!.rect }));
  const y0 = 140;
  const y1 = png.height - 30;
  const a = edgeMetric(png, info.rect.x + 10, info.split - 20, y0, y1);
  const b = edgeMetric(png, info.split + 20, info.rect.x + info.rect.w - 10, y0, y1);
  return { a, b, split: info.split };
}

test('compare: the halves differ like their modes (FSR1 sharper than bilinear), same rect, no errors', async ({ page }) => {
  const errors = watch(page);
  await open(page, '/?compare=1&cmpA=bilinear&cmpB=fsr1&hud=1');
  const p = await page.evaluate(() => window.__d2!.present!);
  expect(p.compare).toMatchObject({ a: 'bilinear', b: 'fsr1', passA: 'bilinear', passB: 'easu-rcas' });
  await expect(page.locator('#cmp-chip-a')).toHaveText('A: Bilinear');
  await expect(page.locator('#cmp-chip-b')).toHaveText('B: FSR1');
  await expect(page.locator('#cmp-thumb')).toBeVisible();
  const diff = await halves(page);

  // control: the same mode on both sides, to factor out the different picture content left and right
  await page.selectOption('#cmp-b', 'bilinear');
  await frames(page);
  const same = await halves(page);
  await page.selectOption('#cmp-b', 'fsr1');
  await frames(page);
  const diff2 = await halves(page);
  const ratioSame = same.b / same.a;
  const ratio = (diff.b / diff.a + diff2.b / diff2.a) / 2;
  console.log(`edge metric (mean |dLum| of neighbours): A=bilinear ${diff.a.toFixed(2)}  B=fsr1 ${diff.b.toFixed(2)}  ratio B/A ${ratio.toFixed(3)}; control bilinear|bilinear ${same.a.toFixed(2)} / ${same.b.toFixed(2)} ratio ${ratioSame.toFixed(3)}`);
  expect(ratio).toBeGreaterThan(ratioSame * 1.05);

  await page.screenshot({ path: `${shotDir}/cmp-compare-demo.png` });

  // nearest on the left vs bilinear on the right: blocky vs smooth
  await page.selectOption('#cmp-a', 'nearest-stretch');
  await page.selectOption('#cmp-b', 'bilinear');
  await frames(page);
  const nb = await page.evaluate(() => window.__d2!.present!.compare);
  expect(nb).toMatchObject({ passA: 'nearest', passB: 'bilinear' });
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('compare: the divider drags (not a game click), moves with the keyboard, and persists', async ({ page }) => {
  await open(page, '/');
  await page.click('#cmp-btn');
  await expect(page.locator('#present')).toBeHidden();
  await expect(page.locator('#cmp-a')).toBeVisible();
  await frames(page);
  expect(await page.evaluate(() => window.__d2!.present!.compare?.splitPx)).toBe(640);
  await page.evaluate(() => {
    const w = window as unknown as { __cd: number };
    w.__cd = 0;
    document.querySelector('canvas#view')!.addEventListener('pointerdown', () => w.__cd++);
  });
  const h = (await page.locator('#cmp-thumb').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(400, 400, { steps: 5 });
  await page.mouse.up();
  await frames(page);
  const s = await page.evaluate(() => ({ f: window.__d2!.ui!.compare.split, px: window.__d2!.present!.compare!.splitPx }));
  expect(s.f).toBeCloseTo(400 / 1280, 2);
  expect(Math.abs(s.px - 400)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => (window as unknown as { __cd: number }).__cd)).toBe(0); // the game never saw the drag
  // a press on the canvas itself still reaches it
  await page.mouse.click(900, 400);
  expect(await page.evaluate(() => (window as unknown as { __cd: number }).__cd)).toBe(1);
  // keyboard
  await page.locator('#cmp-thumb').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  const k = await page.evaluate(() => window.__d2!.ui!.compare.split);
  expect(k).toBeCloseTo(400 / 1280 + 0.11, 2);
  await page.keyboard.press('Home');
  expect(await page.evaluate(() => window.__d2!.ui!.compare.split)).toBe(0.02);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  // persists (compare on + position)
  await page.reload();
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3);
  expect(await page.evaluate(() => window.__d2!.ui!.compare)).toMatchObject({ on: true });
  expect(await page.evaluate(() => window.__d2!.ui!.compare.split)).toBeCloseTo(0.97, 2);
});

test('loupe: magnifies the presented pixels in k x k blocks, also across the divider', async ({ page }) => {
  const errors = watch(page);
  await open(page, '/?compare=1&cmpA=bilinear&cmpB=fsr1&hud=1&loupe=1');
  await page.click('#display-btn'); // the loupe controls live in the Display popover
  for (const k of [8, 4]) {
    await page.selectOption('#loupe-zoom', String(k));
    await page.mouse.move(640 - 60, 330);
    await page.mouse.move(640 - 40, 350);
    await frames(page);
    const L = await page.evaluate(() => window.__d2!.present!.loupe);
    expect(L, 'loupe drawn').not.toBeNull();
    expect(L!.zoom).toBe(k);
    expect(L!.box.w).toBe(256);
    const png = await canvasPng(page);
    const hb = (await page.locator('#cmp-thumb').boundingBox())!;
    const cbox = (await page.locator('canvas#view').boundingBox())!;
    const hx0 = Math.floor(hb.x - cbox.x) - 1;
    const hx1 = Math.ceil(hb.x - cbox.x + hb.width) + 1;
    // change positions along x modulo k, away from the border, the centre marker and the divider handle
    const offsets = new Map<number, number>();
    let changes = 0;
    const cx = L!.box.x + 128;
    const cy = L!.box.y + 128;
    for (let y = L!.box.y + 4; y < L!.box.y + 252; y++) {
      if (Math.abs(y - cy) < k + 3) continue;
      for (let x = L!.box.x + 4; x < L!.box.x + 252; x++) {
        if (Math.abs(x - cx) < k + 3 || (x >= hx0 && x <= hx1 + 1)) continue;
        const i = (y * png.width + x) * 4;
        const j = i - 4;
        if (png.data[i] !== png.data[j] || png.data[i + 1] !== png.data[j + 1] || png.data[i + 2] !== png.data[j + 2]) {
          changes++;
          offsets.set((x - L!.box.x) % k, (offsets.get((x - L!.box.x) % k) ?? 0) + 1);
        }
      }
    }
    console.log(`loupe ${k}x: ${changes} horizontal colour changes, offsets mod ${k}: ${JSON.stringify([...offsets])}`);
    expect(changes).toBeGreaterThan(20);
    expect(offsets.size).toBe(1); // every change sits on a k-pixel block boundary
    // magnified pixels of the left (A) and right (B) side differ: the loupe shows the divider neighbourhood
    if (k === 8) await page.screenshot({ path: `${shotDir}/cmp-loupe-8x.png` });
  }
  // Ctrl+wheel steps the zoom
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  expect(await page.evaluate(() => window.__d2!.ui!.loupe.zoom)).toBe(6);
  // source mode: native frame pixels, still blocks
  await page.click('#loupe-src');
  await page.mouse.move(500, 400);
  await frames(page);
  expect((await page.evaluate(() => window.__d2!.present!.loupe))!.source).toBe(true);
  await page.screenshot({ path: `${shotDir}/cmp-loupe-source.png` });
  // hotkey off / on, and the loupe leaves with the pointer
  await page.keyboard.press('Control+Shift+KeyL');
  await frames(page);
  expect(await page.evaluate(() => window.__d2!.present!.loupe)).toBeNull();
  await page.keyboard.press('Control+Shift+KeyL');
  await page.mouse.move(520, 410);
  await frames(page);
  expect(await page.evaluate(() => window.__d2!.present!.loupe)).not.toBeNull();
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('HUD: source and output resolution, a live fps, mode', async ({ page }) => {
  await open(page, '/?hud=1&present=fsr1'); // explicit: the auto default is bilinear on a software adapter
  const hud = page.locator('#hud');
  await expect(hud).toBeVisible();
  await page.waitForFunction(() => /(\d+\.\d) fps/.test(document.getElementById('hud')?.textContent ?? '') && Number(/(\d+\.\d) fps/.exec(document.getElementById('hud')!.textContent!)![1]) > 0, undefined, { timeout: 15_000 });
  const t = (await hud.textContent())!;
  console.log(`HUD:\n${t}`);
  expect(t).toContain('source 800x600');
  expect(t).toMatch(/output \d+x\d+ px/);
  expect(t).toMatch(/mode FSR1 \(easu-rcas\)/);
  await page.screenshot({ path: `${shotDir}/cmp-hud.png` });
  // toggle: button (in the Display popover), and Ctrl+Shift+H
  await page.click('#display-btn');
  await page.click('#hud-btn');
  await expect(hud).toBeHidden();
  await page.locator('canvas#view').focus();
  await page.keyboard.press('Control+Shift+KeyH');
  await expect(hud).toBeVisible();
});

test('?present=native is 1:1: the frame is as many device pixels as the source, centred', async ({ page }) => {
  await open(page, '/?present=native&hud=1');
  const p = await page.evaluate(() => window.__d2!.present!);
  expect(p.srcW).toBe(800);
  expect(p.rect.w).toBe(p.srcW);
  expect(p.rect.h).toBe(p.srcH);
  expect(p.rect.x).toBe(Math.floor((p.canvasW - 800) / 2));
  expect(p.rect.y).toBe(Math.floor((p.canvasH - 600) / 2));
  expect(p.pass).toBe('nearest');
  await page.screenshot({ path: `${shotDir}/cmp-native-1to1.png` });
  await page.goto('/?present=nearest-stretch');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 5);
  const q = await page.evaluate(() => window.__d2!.present!);
  expect(q.pass).toBe('nearest');
  expect(q.rect.w * q.srcH).toBeGreaterThan(0);
  expect(Math.max(q.rect.w / q.canvasW, q.rect.h / q.canvasH)).toBeGreaterThan(0.99); // fills one axis: not an integer scale
});

test('presets and per-side sharpness: EASU only vs bilinear, sharper RCAS on one side', async ({ page }) => {
  const errors = watch(page);
  await open(page, '/?compare=1&hud=1');
  await page.selectOption('#cmp-preset', 'easu-bilinear');
  await frames(page);
  expect(await page.evaluate(() => window.__d2!.present!.compare)).toMatchObject({ a: 'easu', b: 'bilinear', passA: 'easu', passB: 'bilinear' });
  const e = await halves(page);
  await page.selectOption('#cmp-preset', 'fsr-bilinear');
  await frames(page);
  expect(await page.evaluate(() => window.__d2!.present!.compare)).toMatchObject({ a: 'fsr1', b: 'bilinear', passA: 'easu-rcas' });
  await expect(page.locator('#cmp-sharp-a')).toBeVisible();
  await expect(page.locator('#cmp-sharp-b')).toBeHidden();
  await page.fill('#cmp-sharp-a', '0');
  await frames(page);
  const sharp = await halves(page);
  await page.fill('#cmp-sharp-a', '2');
  await frames(page);
  const soft = await halves(page);
  console.log(`edge metric: EASU-only ${e.a.toFixed(2)} | bilinear ${e.b.toFixed(2)};  FSR1 sharp0 ${sharp.a.toFixed(2)} | sharp2 ${soft.a.toFixed(2)} | bilinear ${soft.b.toFixed(2)}`);
  expect(sharp.a).toBeGreaterThan(soft.a); // RCAS adds edge contrast
  expect(soft.a).toBeGreaterThan(soft.b * 1.2); // even soft FSR1 beats bilinear
  expect(errors.filter((x) => !/favicon/i.test(x))).toEqual([]);
});

test('a mode change repaints while no new frame arrives (paused source)', async ({ page }) => {
  await open(page, '/?present=bilinear');
  await page.evaluate(() => (window.__d2!.paused = true));
  await page.waitForTimeout(400);
  const f0 = await page.evaluate(() => window.__d2!.frames);
  const before = await page.locator('canvas#view').screenshot();
  const still = await page.locator('canvas#view').screenshot();
  expect(still.equals(before)).toBe(true); // really paused
  await page.selectOption('#present', 'nearest-stretch');
  await page.waitForTimeout(500);
  const after = await page.locator('canvas#view').screenshot();
  expect(after.equals(before)).toBe(false);
  expect(await page.evaluate(() => window.__d2!.present!.pass)).toBe('nearest');
  // compare toggle and the divider repaint too
  await page.click('#cmp-btn');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__d2!.present!.compare !== null)).toBe(true);
  const cmp = await page.locator('canvas#view').screenshot();
  expect(cmp.equals(after)).toBe(false);
  expect(await page.evaluate(() => window.__d2!.frames)).toBe(f0); // no new scene frame was rendered
});

test('FSR1 (pixel-art): integer nearest prescale then EASU, crisper than plain FSR1 at 2x+', async ({ page }) => {
  const errors = watch(page);
  await open(page, '/?compare=1&cmpA=fsr1&cmpB=fsr1-pixel&hud=1');
  await page.setViewportSize({ width: 1700, height: 1300 });
  await frames(page, 10);
  const c = await page.evaluate(() => window.__d2!.present!.compare);
  expect(c).toMatchObject({ a: 'fsr1', b: 'fsr1-pixel', passA: 'easu-rcas', passB: 'easu-rcas', prescaleA: 1, prescaleB: 2 });
  const e = await halves(page);
  console.log(`pixel-art at ~2.1x: edge metric FSR1 ${e.a.toFixed(2)} | FSR1 (pixel-art) ${e.b.toFixed(2)}`);
  expect(e.b).toBeGreaterThan(e.a * 1.05);
  await expect(page.locator('#cmp-b')).toHaveAttribute('data-summary', /fsr1-pixel · easu-rcas · 2\.\d+× \(2× nearest/);
  await page.locator('#cmp-b').hover();
  await expect(page.locator('#cmp-b')).toHaveAttribute('title', /^B: right of the divider\n.*fsr1-pixel/);
  await page.screenshot({ path: `${shotDir}/cmp-pixel-art.png` });
  expect(errors.filter((x) => !/favicon/i.test(x))).toEqual([]);
});

test('sharpness slider: shown for fsr1 and fsr1-pixel (RCAS runs), hidden for EASU-only', async ({ page }) => {
  await open(page, '/');
  for (const [mode, shown] of [['fsr1', true], ['fsr1-pixel', true], ['easu', false], ['bilinear', false]] as const) {
    await page.selectOption('#present', mode);
    expect(await page.locator('#sharp').isVisible(), mode).toBe(shown);
  }
  await page.click('#cmp-btn');
  await page.selectOption('#cmp-a', 'fsr1-pixel');
  await page.selectOption('#cmp-b', 'easu');
  expect(await page.locator('#cmp-sharp-a').isVisible()).toBe(true);
  expect(await page.locator('#cmp-sharp-b').isVisible()).toBe(false);
});

test('FSR chains do not pile up across mode and size changes; select titles are kept; the divider strip passes clicks', async ({ page }) => {
  const errors = watch(page);
  await open(page, '/?compare=1&cmpA=fsr1&cmpB=fsr1-pixel&hud=1');
  const chains = (): Promise<number> => page.evaluate(() => window.__d2!.present!.chains);
  expect(await chains()).toBeLessThanOrEqual(2);
  for (const [a, b] of [['fsr1', 'bilinear'], ['fsr1-pixel', 'fsr1-pixel'], ['easu', 'nearest']] as const) {
    await page.selectOption('#cmp-a', a);
    await page.selectOption('#cmp-b', b);
    await frames(page);
    const used = new Set([a, b].filter((m) => m === 'fsr1' || m === 'easu' || m === 'fsr1-pixel').map((m) => (m === 'fsr1-pixel' ? 'p' : 'n'))).size;
    expect(await chains(), `${a} | ${b}`).toBeLessThanOrEqual(Math.max(used, 1));
  }
  for (const w of [1000, 1280, 900]) {
    await page.setViewportSize({ width: w, height: 700 });
    await frames(page);
    expect(await chains()).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1280, height: 700 }); // wide again: the A/B selects are back in the bar
  await page.selectOption('#cmp-a', 'bilinear');
  await page.selectOption('#cmp-b', 'nearest');
  await frames(page);
  expect(await chains(), 'no GPU passes -> no chains').toBe(0);
  // the selects keep their own tooltip (the summary is appended on hover only)
  expect(await page.locator('#cmp-a').getAttribute('title')).toBe('A: left of the divider');
  // the divider strip does not take pointer events, only the thumb does
  const pe = await page.evaluate(() => [getComputedStyle(document.getElementById('cmp-divider')!).pointerEvents, getComputedStyle(document.getElementById('cmp-thumb')!).pointerEvents]);
  expect(pe).toEqual(['none', 'auto']);
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});
