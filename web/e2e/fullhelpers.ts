// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers for the real-data full-game specs (D2_MPQ_DIR, never in CI).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

export const mpqDir = process.env['D2_MPQ_DIR'];
export const shots = process.env['D2_SHOT_DIR'] ?? path.resolve('test-results');

/** distinct colours / non-black pixels of a screenshot */
export function stats(buf: Buffer): { colours: number; lit: number } {
  const png = PNG.sync.read(buf);
  const seen = new Set<number>();
  let lit = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const c = ((png.data[i] ?? 0) << 16) | ((png.data[i + 1] ?? 0) << 8) | (png.data[i + 2] ?? 0);
    seen.add(c);
    if (c > 0x202020) lit++;
  }
  return { colours: seen.size, lit };
}

/**
 * game pixel -> page coordinates, from where the renderer actually put the frame (any presentation mode, any width).
 * x counts from the centre 800x600 of a wide frame, like upstream's mouse coordinates (menus: the whole 800 frame).
 */
export async function gamePoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas#view').boundingBox())!;
  const p = await page.evaluate(() => {
    const c = document.querySelector('canvas#view') as HTMLCanvasElement;
    const pr = window.__d2!.present!;
    return { r: pr.rect, srcW: pr.srcW, srcH: pr.srcH, cw: c.width, ch: c.height };
  });
  const gx = x + (p.srcW - 800) / 2;
  const dx = p.r.x + ((gx + 0.5) / p.srcW) * p.r.w;
  const dy = p.r.y + ((y + 0.5) / p.srcH) * p.r.h;
  return { x: box.x + (dx / p.cw) * box.width, y: box.y + (dy / p.ch) * box.height };
}

export async function moveTo(page: Page, x: number, y: number): Promise<void> {
  const p = await gamePoint(page, x, y);
  await page.mouse.move(p.x, p.y);
}

export async function click(page: Page, x: number, y: number, settle = 400): Promise<void> {
  await moveTo(page, x, y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(settle);
}

export async function shownFrames(page: Page): Promise<number> {
  return page.evaluate(() => window.__d2?.full?.shown ?? 0);
}

/** Run an upstream devctl verb in the game (see components/devctl, apps/d2d/devctl_verbs.hpp). */
export async function ctl(page: Page, line: string): Promise<string> {
  return page.evaluate((l) => window.__d2!.fullGame!.devctl(l), line);
}

/** `state` reply as a key -> value map */
export async function gameState(page: Page): Promise<Record<string, string>> {
  const text = await ctl(page, 'state');
  const out: Record<string, string> = {};
  for (const part of text.split(/\s+/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export function cam(state: Record<string, string>): { x: number; y: number } {
  const [x, y] = (state['cam'] ?? '0,0').split(',').map(Number);
  return { x: x ?? 0, y: y ?? 0 };
}

export async function waitState(page: Page, pred: (s: Record<string, string>) => boolean, timeoutMs: number, what: string): Promise<Record<string, string>> {
  const t0 = Date.now();
  let last: Record<string, string> = {};
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await gameState(page);
      if (pred(last)) return last;
    } catch {
      /* the game is busy (level build): try again */
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`timed out waiting for ${what}; last state: ${JSON.stringify(last)}`);
}

export interface PerfSample {
  frames: number;
  seconds: number;
  fps: number;
  p95Gap: number;
  maxGap: number;
  hitches: number;
  heapMiB: number;
}
export async function perf(page: Page): Promise<PerfSample> {
  return page.evaluate(() => window.__d2!.fullGame!.perf());
}
export async function perfReset(page: Page): Promise<void> {
  await page.evaluate(() => window.__d2!.fullGame!.perfReset());
}

/** Open the page, hand it the MPQs (hard-linked scratch folder, nothing copied) and press Play. Resolves with seconds to the first frames. */
export async function openAndPlay(page: Page, only?: RegExp): Promise<number> {
  await page.goto('/');
  expect(await page.evaluate(() => 'gpu' in navigator && !!navigator.gpu), 'WebGPU').toBe(true);
  await page.waitForFunction(() => window.__d2?.core?.mode === 'wasm', undefined, { timeout: 30_000 });
  const names = fs.readdirSync(mpqDir!).filter((n) => /\.mpq$/i.test(n) && (!only || only.test(n)));
  expect(names.length).toBeGreaterThan(only ? 2 : 3);
  const link = fs.mkdtempSync(path.join(os.tmpdir(), 'd2links-'));
  for (const n of names) fs.linkSync(path.join(mpqDir!, n), path.join(link, n));
  await page.setInputFiles('#folder', link);
  // the status shows "opened ..." only briefly when autoplay starts the game at once
  await page.waitForFunction(() => /opened/.test(document.getElementById('game-status')?.textContent ?? '') || window.__d2?.mode === 'full', undefined, { timeout: 60_000 });
  const t0 = Date.now();
  // picking the files starts the game by itself (autoplay); press Play only when it has not
  await page.waitForFunction(() => window.__d2?.mode === 'full', undefined, { timeout: 3000 }).catch(async () => {
    await page.click('#play-btn');
  });
  await page.waitForFunction(() => (window.__d2?.full?.shown ?? 0) > 5, undefined, { timeout: 240_000 }).catch(async (e) => {
    console.log('stuck:', JSON.stringify(await page.evaluate(() => ({ ...window.__d2?.full, logs: window.__d2?.full?.logs.slice(-5) }))));
    throw e;
  });
  return (Date.now() - t0) / 1000;
}

export function shot(page: Page, name: string): Promise<Buffer> {
  fs.mkdirSync(shots, { recursive: true });
  return page.locator('canvas#view').screenshot({ path: path.join(shots, name) });
}
