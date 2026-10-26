// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FsrAutoCheck, initialAutoMode } from './autoquality';
import type { PresentInfo } from './renderer';

const info = (ms: number, over: Partial<PresentInfo> = {}): PresentInfo =>
  ({
    mode: 'fsr1',
    pass: 'easu-rcas',
    compare: null,
    gpuMs: ms + 4,
    gpuParts: [
      { side: 0, label: 'EASU+RCAS', ms },
      { side: 2, label: 'UI', ms: 4 },
    ],
    ...over,
  }) as PresentInfo;

describe('auto upscaler', () => {
  it('a software adapter starts on bilinear', () => {
    expect(initialAutoMode(true)).toBe('bilinear');
    expect(initialAutoMode(false)).toBe('fsr1');
  });

  it('keeps FSR1 under the budget, ignoring the UI pass', () => {
    const c = new FsrAutoCheck(8, 5);
    for (let i = 0; i < 4; i++) expect(c.feed(info(6.9))).toBeNull();
    expect(c.feed(info(7))).toEqual({ kind: 'keep', ms: 6.9 });
    expect(c.feed(info(50))).toBeNull(); // decided once
  });

  it('downgrades on a slow median, not on one spike', () => {
    const slow = new FsrAutoCheck(8, 5);
    let v = null;
    for (const ms of [12, 14, 3, 13, 15]) v = slow.feed(info(ms)) ?? v;
    expect(v).toEqual({ kind: 'downgrade', ms: 13 });
    const spike = new FsrAutoCheck(8, 5);
    v = null;
    for (const ms of [5, 40, 5, 6, 5]) v = spike.feed(info(ms)) ?? v;
    expect(v?.kind).toBe('keep');
  });

  it('ignores frames that are not single-mode FSR1 with timings, and stops when cancelled', () => {
    const c = new FsrAutoCheck(8, 1);
    expect(c.feed(null)).toBeNull();
    expect(c.feed(info(20, { mode: 'bilinear', pass: 'bilinear' }))).toBeNull();
    expect(c.feed(info(20, { compare: {} as PresentInfo['compare'] }))).toBeNull();
    expect(c.feed(info(20, { gpuParts: [] }))).toBeNull();
    c.cancel();
    expect(c.feed(info(20))).toBeNull();
    expect(c.decided).toBe(true);
  });
});
