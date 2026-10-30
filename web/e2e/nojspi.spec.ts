// SPDX-License-Identifier: GPL-3.0-or-later
// A browser without WebAssembly JSPI (iOS / iPadOS 26 WebKit): the start-up probe, run in a worker like the game's,
// picks the Asyncify build, and with real game files (D2_MPQ_DIR) the game runs on it. ?nojspi=1 hides JSPI from the
// probe worker (an init script cannot reach workers); the Asyncify build itself never uses JSPI.
import { expect, test } from '@playwright/test';
import { ctl, mpqDir, openAndPlay } from './fullhelpers';

test('welcome card: with JSPI the probe picks the JSPI build', async ({ page }) => {
  const lines: string[] = [];
  page.on('console', (m) => lines.push(m.text()));
  await page.goto('/');
  await expect(page.locator('#chk-jspi')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#chk-jspi .why')).toContainText('JSPI build');
  await expect.poll(() => lines.find((l) => l.startsWith('probe: '))).toMatch(/^probe: engine jspi \| JSPI ok \| wasm EH ok \| memory 768 MiB/);
});

test('welcome card: without JSPI the probe picks the Asyncify build and says why', async ({ page }) => {
  await page.goto('/?nojspi=1');
  await expect(page.locator('#chk-jspi')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#chk-jspi .why')).toContainText('fallback build (Asyncify): JSPI missing');
});

test('real game files: without JSPI the game runs on the Asyncify build', async ({ page }) => {
  test.skip(!mpqDir, 'set D2_MPQ_DIR to run against real game files');
  test.setTimeout(300_000);
  const errors: string[] = [];
  const wasm: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().endsWith('d2full.wasm')) wasm.push(new URL(r.url()).pathname);
  });
  await openAndPlay(page, undefined, '?nojspi=1');
  expect(wasm).toEqual(['/asyncify/d2full.wasm']);
  // the game answers its control channel: the Asyncify frame loop runs and reads input
  expect(await ctl(page, 'state')).toMatch(/\w+=/);
  expect(errors).toEqual([]);
});
