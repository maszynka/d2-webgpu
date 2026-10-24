// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { densitySize, effectiveDpr, parseDensity } from './density';

describe('render density', () => {
  const dev = { w: 3200, h: 1800 };
  const css = { w: 1600, h: 900 };
  it('auto uses the device-pixel box, 1x the CSS box (a quarter of the pixels at DPR 2)', () => {
    expect(densitySize('auto', dev, css, 1600, 900, 2, 16384)).toEqual({ w: 3200, h: 1800 });
    expect(densitySize('1', dev, css, 1600, 900, 2, 16384)).toEqual({ w: 1600, h: 900 });
  });
  it('falls back to client size (times dpr in auto) before the observer reports', () => {
    expect(densitySize('auto', null, null, 1600, 900, 2, 16384)).toEqual({ w: 3200, h: 1800 });
    expect(densitySize('1', null, null, 1600, 900, 2, 16384)).toEqual({ w: 1600, h: 900 });
    expect(densitySize('1', null, { w: 0, h: 0 }, 1600, 900, 2, 16384)).toEqual({ w: 1600, h: 900 });
  });
  it('does not trust a device-pixel box that is far from client * dpr (emulated DPR reports CSS pixels)', () => {
    expect(densitySize('auto', { w: 1600, h: 900 }, css, 1600, 900, 2, 16384)).toEqual({ w: 3200, h: 1800 });
    // fractional zoom: the exact box differs from client * dpr by a pixel: kept
    expect(densitySize('auto', { w: 1999, h: 1125 }, null, 1600, 900, 1.25, 16384)).toEqual({ w: 1999, h: 1125 });
  });
  it('rounds fractional CSS boxes, never below 1, never above the texture limit', () => {
    expect(densitySize('1', null, { w: 1599.6, h: 899.4 }, 0, 0, 2, 16384)).toEqual({ w: 1600, h: 899 });
    expect(densitySize('1', null, null, 0, 0, 1, 16384)).toEqual({ w: 1, h: 1 });
    expect(densitySize('auto', { w: 99999, h: 5 }, null, 99999, 5, 1, 8192)).toEqual({ w: 8192, h: 5 });
  });
  it('parses and reports the effective dpr', () => {
    expect(parseDensity('1')).toBe('1');
    expect(parseDensity('auto')).toBe('auto');
    expect(parseDensity('x')).toBe('auto');
    expect(effectiveDpr(1600, 1600)).toBe(1);
    expect(effectiveDpr(3200, 1600)).toBe(2);
    expect(effectiveDpr(100, 0)).toBe(1);
  });
});
