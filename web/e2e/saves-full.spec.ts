// SPDX-License-Identifier: GPL-3.0-or-later
// Save backup round trip through the real game (D2_MPQ_DIR only): create a character, download the backup while the
// game runs, import it into a fresh browser profile, and find the character in the game's character select list.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { click, mpqDir, openAndPlay, waitState } from './fullhelpers';

test.skip(!mpqDir, 'set D2_MPQ_DIR to run against real game files');
test.setTimeout(10 * 60_000);

async function newCharacter(page: Page, name: string): Promise<void> {
  await click(page, 400, 306); // SINGLE PLAYER
  await page.waitForTimeout(800);
  await click(page, 117, 498); // CREATE NEW CHARACTER
  await page.waitForTimeout(1200);
  await page.keyboard.type(name, { delay: 80 });
  await page.waitForTimeout(400);
  await click(page, 689, 554); // OK
  await waitState(page, (s) => s['screen'] === 'ingame', 120_000, 'in game');
}

test('a backup made while playing restores the character in a fresh profile', async ({ browser }) => {
  const first = await browser.newContext({ acceptDownloads: true });
  const page = await first.newPage();
  await openAndPlay(page);
  await page.waitForTimeout(1500);
  await newCharacter(page, 'Backupka');
  await expect.poll(() => page.evaluate(() => window.__d2?.full?.synced ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
  // the bar is hidden over the game: click the button directly (it asks the worker to write IndexedDB first)
  const [download] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => document.getElementById('saves-export')!.click())]);
  const zip = readFileSync((await download.path())!);
  expect(zip.includes(Buffer.from('d2d/save/Backupka.d2s'))).toBe(true);
  await first.close();

  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await p2.goto('/');
  await p2.waitForFunction(() => (window.__d2?.frames ?? 0) > 3, undefined, { timeout: 30_000 });
  await expect(p2.locator('#game-status')).toContainText(/game folder/);
  await p2.setInputFiles('#saves-file', [{ name: 'backup.zip', mimeType: 'application/zip', buffer: zip }]);
  await expect(p2.locator('#game-status')).toContainText('Imported Backupka');
  await openAndPlay(p2);
  await p2.waitForTimeout(1500);
  await click(p2, 400, 306); // SINGLE PLAYER
  const sel = await waitState(p2, (s) => s['screen'] === 'charselect', 20_000, 'character select');
  console.log(`fresh profile after import: ${sel['saves']} saves, name=${sel['name']}`);
  expect(Number(sel['saves'])).toBe(1);
  expect(sel['name']).toBe('Backupka');
  await fresh.close();
});
