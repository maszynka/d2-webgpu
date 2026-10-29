// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { jspiSupported, parseReport, parseUserAgent } from './visit';

describe('parseReport', () => {
  const all = { tech: true, country: true };
  it('keeps the known fields and drops the rest', () => {
    expect(parseReport({
      consent: all, webgpu: 'hardware', vendor: 'Apple', architecture: 'metal-3', jspi: true,
      features: ['timestamp-query', 'texture-compression-bc', 'shader-f16'], extra: 'x',
    })).toEqual({ consent: all, webgpu: 'hardware', vendor: 'apple', architecture: 'metal-3', features: ['timestamp-query', 'shader-f16'], jspi: true });
  });

  it('rejects bodies without a known WebGPU status', () => {
    expect(parseReport(null)).toBeNull();
    expect(parseReport('hardware')).toBeNull();
    expect(parseReport({ consent: all, webgpu: 'yes' })).toBeNull();
  });

  it('allows nothing without consent, and only the country without tech consent', () => {
    expect(parseReport({ webgpu: 'hardware', jspi: true })).toBeNull();
    expect(parseReport({ consent: { tech: false, country: false }, webgpu: 'hardware' })).toBeNull();
    expect(parseReport({ consent: { tech: false, country: true }, webgpu: 'hardware', vendor: 'apple', jspi: true, features: ['shader-f16'] }))
      .toEqual({ consent: { tech: false, country: true }, webgpu: 'unknown', vendor: '', architecture: '', features: [], jspi: false });
    expect(parseReport({ consent: { tech: true, country: false }, webgpu: 'none' })?.consent).toEqual({ tech: true, country: false });
  });

  it('strips odd characters and caps the length of adapter strings', () => {
    const r = parseReport({ consent: all, webgpu: 'software', vendor: '<script>/var/x ' + 'a'.repeat(80), architecture: 5 });
    expect(r?.vendor).toMatch(/^[a-z0-9._-]{1,32}$/);
    expect(r?.architecture).toBe('');
    expect(r?.features).toEqual([]);
    expect(r?.jspi).toBe(false);
  });
});

describe('parseUserAgent', () => {
  const cases: [string, string, string, string][] = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'chrome', '141', 'macos'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'edge', '141', 'windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', 'firefox', '144', 'linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15', 'safari', '26', 'macos'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1', 'safari', '26', 'ios'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'chrome', '141', 'android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1', 'chrome', '141', 'ios'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15', 'firefox', '144', 'ios'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0', 'edge', '141', 'android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0', 'opera', '124', 'windows'],
    ['curl/8.7.1', 'other', '', 'other'],
  ];
  it.each(cases)('%s', (ua, browser, browserMajor, os) => {
    expect(parseUserAgent(ua)).toEqual({ browser, browserMajor, os });
  });
});

describe('jspiSupported', () => {
  it('needs both Suspending and promising as functions (iOS 26 WebKit has neither)', () => {
    expect(jspiSupported({ Suspending: function () {}, promising: () => 0 })).toBe(true);
    expect(jspiSupported({})).toBe(false);
    expect(jspiSupported({ Suspending: undefined, promising: () => 0 })).toBe(false);
    expect(jspiSupported({ Suspending: function () {} })).toBe(false);
    expect(jspiSupported(undefined)).toBe(false);
  });
});
