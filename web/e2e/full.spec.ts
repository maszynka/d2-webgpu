// SPDX-License-Identifier: GPL-3.0-or-later
// The whole game on the user's own Diablo II files (never in CI, never in the repo): only runs with
// D2_MPQ_DIR=<folder with d2data.mpq ...>.
//  1. title screen -> character screens (menus, text input)
//  2. F2 scenario: new character -> Rogue Encampment -> click / hold / Shift on the ground -> Blood Moor ->
//     attack a monster -> Save and Exit -> reload the page -> the character is in the select list (IDBFS)
// Game state is read through upstream's devctl verbs (FullGame.devctl: `state`, `debug level`, `monsters`),
// not through pixels. Screenshots go to D2_SHOT_DIR (default web/test-results/).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cam, click, ctl, gameState, moveTo, mpqDir, openAndPlay, perf, perfReset, shot, shots, shownFrames, stats, waitState } from './fullhelpers';

test.skip(!mpqDir, 'set D2_MPQ_DIR to run against real game files');
test.setTimeout(10 * 60_000);

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'debug' && m.text().startsWith('[d2]')) process.stdout.write(`${m.text()}\n`);
  });
  return errors;
}

/** title -> SINGLE PLAYER -> CREATE NEW CHARACTER -> name -> OK; resolves once in game */
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

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

test('full game: title screen, then character screens', async ({ page }) => {
  const errors = watch(page);
  const loadSeconds = await openAndPlay(page);
  const info = await page.evaluate(() => ({ heap: window.__d2?.full?.heapMiB, w: window.__d2?.full?.width, h: window.__d2?.full?.height }));
  console.log(`first frames after ${loadSeconds.toFixed(1)} s, wasm heap ${info.heap} MiB, frame ${info.w}x${info.h}`);
  await page.waitForTimeout(1500); // the fire animation moves
  const title = await shot(page, 'full-title.png');
  const s = stats(title);
  console.log(`title: ${s.colours} colours, ${s.lit} lit pixels`);
  expect(s.colours).toBeGreaterThan(200);
  expect(s.lit).toBeGreaterThan(20_000);
  const before = await shownFrames(page);
  await page.waitForTimeout(1000);
  expect(await shownFrames(page)).toBeGreaterThan(before + 5);

  // F3: the title screen has sound: the game posted audio commands (menu music / clicks), no need to hear them
  await expect.poll(() => page.evaluate(() => window.__d2?.full?.audioMessages ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
  console.log(`audio: ${JSON.stringify(await page.evaluate(() => ({ m: window.__d2?.full?.audioMessages, ops: window.__d2?.full?.audioOps, state: window.__d2?.full?.audioState, voices: window.__d2?.full?.audioVoices })))}`);

  await click(page, 400, 306);
  await page.waitForTimeout(800);
  await shot(page, 'full-select.png');
  await click(page, 117, 498);
  await page.waitForTimeout(1200);
  const chars = await shot(page, 'full-chars.png');
  const c = stats(chars);
  console.log(`chars: ${c.colours} colours, ${c.lit} lit pixels`);
  expect(c.colours).toBeGreaterThan(100);

  // text input reaches the name field (SDL_EVENT_TEXT_INPUT path)
  await page.keyboard.type('Hero', { delay: 80 });
  await page.waitForTimeout(500);
  const typed = await shot(page, 'full-name.png');
  expect(Buffer.compare(typed, chars)).not.toBe(0);
  expect((await gameState(page))['name']).toBe('Hero');
  expect(errors.filter((e) => !/favicon|404/i.test(e))).toEqual([]);
});

test('full game F2: new character, camp, walking, Blood Moor, fight, save, reload', async ({ page }) => {
  const errors = watch(page);
  const measurements: Record<string, unknown> = {};
  await openAndPlay(page);
  await page.waitForTimeout(1500);

  await newCharacter(page, 'Hero');
  await page.waitForTimeout(3000); // the camp finishes building its neighbours (frame hitches)

  // saving the new character reached IndexedDB at once (patch 0011: d2web_saved -> FS.syncfs), not on a timer
  await expect.poll(() => page.evaluate(() => window.__d2?.full?.synced ?? 0), { timeout: 8000 }).toBeGreaterThan(0);

  const camp = await gameState(page);
  expect(camp['name']).toBe('Hero');
  console.log(`camp: ${camp['life']} life, ${camp['items']} items, level id ${(await ctl(page, 'debug level')).trim()}`);
  await shot(page, 'f2-camp.png');
  // 10 s of standing in the camp: frame rate and memory
  await perfReset(page);
  await page.waitForTimeout(10_000);
  measurements['camp'] = await perf(page);
  console.log(`camp perf: ${JSON.stringify(measurements['camp'])}`);

  // --- click on the ground moves the character ---------------------------------------------------------
  const p0 = cam(await gameState(page));
  await click(page, 560, 360, 1800);
  const p1 = cam(await gameState(page));
  console.log(`click: ${JSON.stringify(p0)} -> ${JSON.stringify(p1)}`);
  expect(dist(p0, p1), 'a click on the ground walks the character').toBeGreaterThan(1);
  await shot(page, 'f2-camp-walked.png');

  // --- a held button keeps walking (follows the pointer) ----------------------------------------------
  await moveTo(page, 230, 380);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.waitForTimeout(600);
  const h1 = await gameState(page);
  await page.waitForTimeout(900);
  const h2 = await gameState(page);
  await page.mouse.up();
  console.log(`held: ${h1['cam']} walking=${h1['walking']} -> ${h2['cam']} walking=${h2['walking']}`);
  expect(h1['walking']).toBe('1');
  expect(dist(cam(h1), cam(h2)), 'still walking while the button is held').toBeGreaterThan(0.8);
  await page.waitForTimeout(4000); // arrive

  // --- Shift + click: attack in place, the character does not walk -----------------------------------
  const s0 = await gameState(page);
  await page.keyboard.down('Shift');
  await click(page, 650, 330, 900);
  const s1 = await gameState(page);
  await page.keyboard.up('Shift');
  console.log(`shift-click: ${s0['cam']} ${s0['pmode']} -> ${s1['cam']} ${s1['pmode']}`);
  expect(dist(cam(s0), cam(s1)), 'Shift-click does not walk').toBeLessThan(0.6);

  // --- leave the camp for Blood Moor -------------------------------------------------------------------
  // The camp is joined to its wilderness neighbours by level edges, and the town layout is random per
  // character; upstream's `debug goto <level>` arrives on a level at a free spot (devctl verb), used here.
  await perfReset(page);
  const goto = await ctl(page, 'debug goto 2');
  expect(goto).toMatch(/^ok /);
  await waitState(page, () => true, 500, 'settle');
  await expect.poll(async () => (await ctl(page, 'debug level')).split(' ')[1], { timeout: 30_000 }).toBe('2');
  await page.waitForTimeout(8000);
  measurements['bloodMoorArrival'] = await perf(page);
  console.log(`Blood Moor arrival + 8 s: ${JSON.stringify(measurements['bloodMoorArrival'])}`);
  await shot(page, 'f2-bloodmoor.png');

  // --- fight: walk up to the nearest monster and attack it with the left button ---------------------------
  const parse = (txt: string) =>
    txt
      .split('\n')
      .filter((l) => l.includes('\t'))
      .map((l) => {
        const f = l.split('\t');
        return { id: f[12]!, x: Number(f[1]), y: Number(f[2]), sx: Number(f[3]), sy: Number(f[4]), hp: f[5]!, mode: f[6]!, name: f[11]! };
      });
  const startMonsters = parse(await ctl(page, 'monsters'));
  expect(startMonsters.length, 'Blood Moor has monsters').toBeGreaterThan(0);
  const exp0 = Number((await gameState(page))['exp']);
  let hit = false;
  let attacked = '';
  for (let i = 0; i < 120 && !hit; i++) {
    const me = cam(await gameState(page));
    const live = parse(await ctl(page, 'monsters')).filter((m) => !/^D[DT]|^DEAD$/.test(m.mode));
    live.sort((a, b) => dist(a, me) - dist(b, me));
    const m = live[0];
    if (!m) break;
    const onScreen = m.sx > 40 && m.sx < 760 && m.sy > 40 && m.sy < 420;
    if (onScreen) {
      attacked = `${m.name} ${m.id} ${m.hp} ${m.mode}`;
      await click(page, m.sx, m.sy - 18, 250);
    } else {
      // walk up to it; when that takes too long (obstacles) the debug verb places the player beside it
      if (i % 12 === 11) await ctl(page, `debug warp ${m.x - 1.5} ${m.y - 1.5}`);
      else await ctl(page, `cmd move ${m.x} ${m.y}`);
      await page.waitForTimeout(600);
    }
    const now = parse(await ctl(page, 'monsters'));
    const st = await gameState(page);
    const target = now.find((n) => n.id === m.id);
    const was = startMonsters.find((o) => o.id === m.id);
    hit = Number(st['exp']) > exp0 || (target !== undefined && was !== undefined && (target.hp.split('/')[0] !== was.hp.split('/')[0] || /^D[DT]/.test(target.mode)));
    if (st['life']?.startsWith('0/')) break; // died
    if (i % 20 === 19) console.log(`fight ${i}: target ${m.name} ${m.id} ${m.hp} ${m.mode} onScreen=${onScreen} life ${st['life']} cam ${st['cam']}`);
  }
  console.log(`fight: target ${attacked}; exp ${exp0} -> ${(await gameState(page))['exp']}; life ${(await gameState(page))['life']}; hit=${hit}`);
  await shot(page, 'f2-fight.png');
  expect(hit, 'the character hurt or killed a monster').toBe(true);
  await page.waitForTimeout(1500);
  measurements['afterFight'] = await perf(page);
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, 'f2-measurements.json'), JSON.stringify(measurements, null, 2));

  // --- Save and Exit (Esc menu) -----------------------------------------------------------------------
  const synced0 = await page.evaluate(() => window.__d2?.full?.synced ?? 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  expect((await gameState(page))['gamemenu']).toMatch(/^[1-9]/);
  await shot(page, 'f2-menu.png');
  await click(page, 400, 260, 300); // SAVE AND EXIT GAME
  await waitState(page, (s) => s['screen'] !== 'ingame', 60_000, 'back at the menus');
  await expect.poll(() => page.evaluate(() => window.__d2?.full?.synced ?? 0), { timeout: 10_000 }).toBeGreaterThan(synced0);
  await shot(page, 'f2-after-save.png');
  console.log(`saved: screen=${(await gameState(page))['screen']}`);
  expect(errors.filter((e) => !/favicon|404/i.test(e))).toEqual([]);

  // --- reload the page: the character is in the list --------------------------------------------------
  await page.reload();
  await openAndPlay(page);
  await page.waitForTimeout(1500);
  await click(page, 400, 306); // SINGLE PLAYER
  const sel = await waitState(page, (s) => s['screen'] === 'charselect', 20_000, 'character select');
  console.log(`after reload: ${sel['saves']} saves, name=${sel['name']}`);
  expect(Number(sel['saves'])).toBeGreaterThanOrEqual(1);
  await shot(page, 'f2-reloaded-select.png');
});
