// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { MAX_VIEW_WIDTH, MIN_VIEW_WIDTH, viewWidthFor } from './viewsize';

describe('viewWidthFor (native game width from the display aspect, height fixed at 600)', () => {
  it('follows the aspect at 600 rows, even', () => {
    expect(viewWidthFor(1920, 1080)).toBe(1066); // 16:9 -> 1066.7 -> even
    expect(viewWidthFor(1950, 1000)).toBe(1170);
    expect(viewWidthFor(2560, 1080)).toBe(MAX_VIEW_WIDTH); // 21:9 hits the cap
    expect(viewWidthFor(1600, 900) % 2).toBe(0);
  });
  it('clamps to 800..1400', () => {
    expect(viewWidthFor(800, 600)).toBe(MIN_VIEW_WIDTH);
    expect(viewWidthFor(500, 900)).toBe(MIN_VIEW_WIDTH); // portrait
    expect(viewWidthFor(3440, 1000)).toBe(MAX_VIEW_WIDTH);
    expect(viewWidthFor(5120, 1440)).toBe(MAX_VIEW_WIDTH);
  });
  it('is independent of the unit (css px or device px)', () => {
    expect(viewWidthFor(1950, 1000)).toBe(viewWidthFor(3900, 2000));
  });
  it('falls back to 800 for a degenerate display', () => {
    expect(viewWidthFor(0, 0)).toBe(MIN_VIEW_WIDTH);
    expect(viewWidthFor(1000, 0)).toBe(MIN_VIEW_WIDTH);
    expect(viewWidthFor(NaN, 600)).toBe(MIN_VIEW_WIDTH);
  });
});
