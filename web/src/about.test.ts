// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { aboutInfo, versionLabel } from './about';

describe('versionLabel', () => {
  it('commit, date and the engine once the game runs', () => {
    const info = aboutInfo({ VITE_COMMIT: 'd99246e', VITE_BUILD_DATE: '2026-10-30' } as ImportMetaEnv);
    expect(versionLabel(info)).toBe('d99246e · 2026-10-30');
    expect(versionLabel(info, 'asyncify')).toBe('d99246e · 2026-10-30 · asyncify');
  });
  it('a full sha (the Pages workflow) is cut to 7; no date, no date part', () => {
    const info = aboutInfo({ VITE_COMMIT: 'd99246e0c1f2a3b4c5d6e7f8091a2b3c4d5e6f70' } as ImportMetaEnv);
    expect(versionLabel(info)).toBe('d99246e');
    expect(versionLabel(info, 'asyncify')).toBe('d99246e · asyncify');
  });
  it('a local build says so', () => {
    expect(versionLabel(aboutInfo({} as ImportMetaEnv))).toBe('dev build');
    expect(versionLabel(aboutInfo({} as ImportMetaEnv), 'jspi')).toBe('dev build · jspi');
  });
});
