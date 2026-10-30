// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { aboutInfo, versionLabel } from './about';

describe('versionLabel', () => {
  it('commit, date and the engine once the game runs', () => {
    const info = aboutInfo({ VITE_COMMIT: 'd99246e', VITE_BUILD_DATE: '2026-10-30' } as ImportMetaEnv);
    expect(versionLabel(info)).toBe('d99246e · 2026-10-30');
    expect(versionLabel(info, 'asyncify')).toBe('d99246e · 2026-10-30 · asyncify');
  });
  it('a local build says so', () => {
    expect(versionLabel(aboutInfo({} as ImportMetaEnv), 'jspi')).toBe('dev build · jspi');
  });
});
