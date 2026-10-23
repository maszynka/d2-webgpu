// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { switchScene } from './scene-switch';

describe('switchScene', () => {
  it('resets the atlas, then returns the built scene', () => {
    const log: string[] = [];
    const r = switchScene(() => log.push('reset'), () => (log.push('build'), 42), () => log.push('fallback'));
    expect(r).toBe(42);
    expect(log).toEqual(['reset', 'build']);
  });
  it('falls back to the fallback scene and rethrows when building fails after the reset', () => {
    const log: string[] = [];
    expect(() =>
      switchScene(() => log.push('reset'), () => { throw new Error('atlas full'); }, () => log.push('fallback')),
    ).toThrow('atlas full');
    expect(log).toEqual(['reset', 'fallback']);
  });
});
