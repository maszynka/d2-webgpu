// SPDX-License-Identifier: GPL-3.0-or-later
// Save backup and import (Tools -> Saves) against the real IndexedDB layout of Emscripten's IDBFS. No game data needed.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

function d2s(name: string, version = 96): Buffer {
  const b = Buffer.alloc(128);
  b.writeUInt32LE(0xaa55aa55, 0);
  b.writeUInt32LE(version, 4);
  b.writeUInt32LE(b.length, 8); // file size, as 1.09+ headers carry it
  b.write(name, 0x14, 'latin1');
  return b;
}

/** Keys and entry modes in the "/idb" database (what the game's IDBFS will load). */
const idb = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Record<string, { mode: number; size: number | null }>>((resolve, reject) => {
        const req = indexedDB.open('/idb', 21);
        req.onerror = () => reject(req.error);
        // a fresh profile has no database yet: create the store the way IDBFS does
        req.onupgradeneeded = () => req.result.createObjectStore('FILE_DATA').createIndex('timestamp', 'timestamp', { unique: false });
        req.onsuccess = () => {
          const out: Record<string, { mode: number; size: number | null }> = {};
          const cur = req.result.transaction('FILE_DATA').objectStore('FILE_DATA').openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) {
              req.result.close();
              resolve(out);
              return;
            }
            const v = c.value as { mode: number; contents?: Uint8Array };
            out[String(c.key)] = { mode: v.mode, size: v.contents ? v.contents.length : null };
            c.continue();
          };
        };
      }),
  );

/** The page has booted (renderer drawing, core status shown), so its startup messages no longer replace ours. */
async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window.__d2?.frames ?? 0) > 3, undefined, { timeout: 30_000 });
  await expect(page.locator('#game-status')).toContainText(/game folder|Game files cannot be read/);
}

async function openTools(page: Page): Promise<void> {
  if (!(await page.locator('#game-tools').isVisible())) await page.click('#tools-btn');
  await expect(page.locator('#saves-import')).toBeVisible();
}

test('import loose .d2s files, then download a backup that restores them', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page);
  await openTools(page);
  await page.setInputFiles('#saves-file', [
    { name: 'copy of hero.d2s', mimeType: 'application/octet-stream', buffer: d2s('Barbara') },
    { name: 'Barbara.key', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3]) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') },
  ]);
  await expect(page.locator('#game-status')).toContainText('Imported Barbara');
  await expect(page.locator('#game-status')).toContainText('notes.txt (not a save file)');
  const db = await idb(page);
  expect(db['/idb/d2d/save/Barbara.d2s']).toEqual({ mode: 0o100666, size: 128 });
  expect(db['/idb/d2d/save/Barbara.key']).toEqual({ mode: 0o100666, size: 3 });
  expect(db['/idb/d2d']?.size).toBeNull();
  expect(db['/idb/d2d/save']?.size).toBeNull();

  await openTools(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#saves-export')]);
  expect(download.suggestedFilename()).toMatch(/^d2-webgpu-saves-\d{4}-\d\d-\d\d\.zip$/);
  const zip = readFileSync((await download.path())!);
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  expect(zip.includes(Buffer.from('d2d/save/Barbara.d2s'))).toBe(true);
  await expect(page.locator('#game-status')).toContainText('1 character (Barbara)');

  // restoring the backup over the existing character asks first
  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    void d.accept();
  });
  await openTools(page);
  await page.setInputFiles('#saves-file', [{ name: 'backup.zip', mimeType: 'application/zip', buffer: zip }]);
  await expect(page.locator('#game-status')).toContainText('Imported Barbara');
  expect(asked).toContain('d2d/save/Barbara.d2s');
  expect(errors).toEqual([]);
});

test('an unsupported or foreign file is refused without touching storage', async ({ page }) => {
  await ready(page);
  await openTools(page);
  await page.setInputFiles('#saves-file', [{ name: 'Old.d2s', mimeType: 'application/octet-stream', buffer: d2s('Old', 71) }]);
  await expect(page.locator('#game-status')).toContainText('Nothing to import');
  await expect(page.locator('#game-status')).toContainText('version 71');
  expect(Object.keys(await idb(page)).filter((k) => k.endsWith('.d2s'))).toEqual([]);
});
