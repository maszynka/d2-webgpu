// SPDX-License-Identifier: GPL-3.0-or-later
// Patch 0015: a summoning skill's passive stats go to its pets, not the player. Before it, one point in Skeleton
// Mastery (with Raise Skeleton) gave a Necromancer +2048 max life, so monsters' hits never showed on the life globe.
// Real data (D2_MPQ_DIR), never in CI.
import { expect, test } from '@playwright/test';
import { click, ctl, gameState, mpqDir, openAndPlay, waitState } from './fullhelpers';

test.skip(!mpqDir, 'D2_MPQ_DIR');
test.setTimeout(300_000);

test('Necromancer: Skeleton Mastery and the summons leave the player life, speed and resists alone', async ({ page }) => {
  await openAndPlay(page);
  await page.waitForTimeout(1500);
  await click(page, 400, 306); // SINGLE PLAYER
  await page.waitForTimeout(800);
  await click(page, 117, 498); // CREATE NEW CHARACTER
  await page.waitForTimeout(1500);
  await click(page, 300, 330, 1500); // the Necromancer, left of the fire
  await page.keyboard.type('Bones', { delay: 80 });
  await page.waitForTimeout(400);
  await click(page, 689, 554); // OK
  await waitState(page, (s) => s['screen'] === 'ingame', 120_000, 'in game');

  const before = await gameState(page);
  const attack0 = await ctl(page, 'debug attack');
  // Raise Skeleton, Skeleton Mastery, Clay Golem, Golem Mastery, Revive
  for (const [id, n] of [[70, 1], [69, 5], [75, 1], [79, 3], [95, 1]] as const) expect(await ctl(page, `debug points ${id} ${n}`)).toMatch(/^ok/);
  await page.waitForTimeout(800);
  const after = await gameState(page);
  const passives = (await ctl(page, 'debug passives')).trim();
  console.log(`life ${before['life']} -> ${after['life']}; passives: ${passives}`);
  expect(after['life']).toBe(before['life']);
  expect(passives).toBe('ok'); // a Necromancer's only passive stats were the summons' (maxhp, velocitypercent, item_normaldamage)
  expect(await ctl(page, 'debug attack')).toBe(attack0);
});
