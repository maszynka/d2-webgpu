// SPDX-License-Identifier: GPL-3.0-or-later
// Touch controls with real game files (D2_MPQ_DIR): a finger shows the column, a tap is a left click, the RMB toggle
// turns taps into right clicks, a second finger is ignored, keys and the soft keyboard reach the game.
import { expect, test, type Page } from '@playwright/test';
import { gamePoint, mpqDir, openAndPlay, shots } from './fullhelpers';
import path from 'node:path';

test.skip(!mpqDir, 'set D2_MPQ_DIR to run against real game files');
test.use({ hasTouch: true, viewport: { width: 1180, height: 820 } }); // iPad Air, landscape
test.setTimeout(300_000);

type Rec = [number, number, number, number, number, number];
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __recs: Rec[] };
    w.__recs = [];
    const g = window.__d2!.fullGame! as unknown as { queue(r: Rec): void };
    const q = g.queue.bind(g);
    g.queue = (r) => {
      w.__recs.push(r);
      q(r);
    };
  });
}
const take = (page: Page): Promise<Rec[]> =>
  page.evaluate(() => {
    const w = window as unknown as { __recs: Rec[] };
    const r = w.__recs;
    w.__recs = [];
    return r;
  });
const buttons = (recs: Rec[]): number[][] => recs.filter((r) => r[0] === 3).map((r) => [r[1], r[2]]);

test('touch controls drive the game', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openAndPlay(page);
  await expect(page.locator('#touch')).toBeHidden(); // the mouse started the game
  await record(page);

  const p = await gamePoint(page, 400, 300);
  await page.touchscreen.tap(p.x, p.y);
  await expect(page.locator('#touch')).toBeVisible();
  await page.waitForTimeout(100);
  expect(buttons(await take(page))).toEqual([[1, 1], [1, 0]]);

  await page.locator('#touch button', { hasText: 'RMB' }).tap();
  await expect(page.locator('#touch button', { hasText: 'RMB' })).toHaveAttribute('aria-pressed', 'true');
  await page.touchscreen.tap(p.x, p.y);
  await page.waitForTimeout(100);
  expect(buttons(await take(page))).toEqual([[3, 1], [3, 0]]);
  await page.locator('#touch button', { hasText: 'RMB' }).tap();

  // a second finger while the first is down: only the first one clicks
  const cdp = await page.context().newCDPSession(page);
  const pt = (id: number, x: number, y: number) => ({ x, y, id });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(1, p.x, p.y)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(1, p.x, p.y), pt(2, p.x + 80, p.y + 40)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [pt(1, p.x, p.y)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
  expect(buttons(await take(page))).toEqual([[1, 1], [1, 0]]);

  // Esc, a key from the fold-out, Shift held carries its flag into the next key and a physical key; the canvas keeps
  // the focus throughout (a blur would release every key)
  const shiftBtn = page.locator('#touch button', { hasText: '⇧' });
  await page.locator('#touch button', { hasText: 'Esc' }).tap();
  await page.locator('#touch button', { hasText: '⋯' }).tap();
  await page.locator('#touch button', { hasText: 'F2' }).tap();
  await shiftBtn.tap();
  await page.locator('#touch button', { hasText: 'F2' }).tap();
  await page.keyboard.press('KeyI');
  await shiftBtn.tap();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('view');
  const keys = (await take(page)).filter((r) => r[0] === 1).map((r) => [r[1], r[2], r[4]]);
  expect(keys).toEqual([[41, 1, 0], [41, 0, 0], [59, 1, 0], [59, 0, 0], [225, 1, 1], [59, 1, 1], [59, 0, 1], [12, 1, 1], [12, 0, 1], [225, 0, 0]]);
  await page.keyboard.press('KeyI'); // close the inventory again
  await shiftBtn.tap();
  await expect(shiftBtn).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: path.join(shots, 'touch-controls.png') });

  // soft keyboard: the canvas blur releases Shift (button follows); typed text arrives as text records, Backspace as a key
  await page.locator('#touch button', { hasText: 'Abc' }).tap();
  await expect(page.locator('#touch .touch-text')).toBeFocused();
  await expect(shiftBtn).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.type('Ab');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  const typed = (await take(page)).filter((r) => r[0] !== 2).map((r) => [r[0], r[1], r[2]]);
  expect(typed).toContainEqual([5, 65, 0]);
  expect(typed).toContainEqual([5, 98, 0]);
  expect(typed).toContainEqual([1, 42, 1]);
  await expect(page.locator('#touch .touch-text')).toHaveValue('\u200b'); // only the placeholder: the game has the text

  // a mouse click hides the column again
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('#touch')).toBeHidden();
  expect(errors).toEqual([]);
});
