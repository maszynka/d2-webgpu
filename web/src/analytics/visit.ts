// SPDX-License-Identifier: GPL-3.0-or-later
// Cookieless visit counter: one beacon per page load with what the browser supports (WebGPU adapter class, JSPI).
// The Worker adds the country and the browser family/major version from the User-Agent and stores only those
// fields (Workers Analytics Engine). No cookies, no storage, no IP, no raw User-Agent, no per-visitor id.

export const VISIT_PATH = '/api/visit';

export type WebGpuStatus = 'none' | 'failed' | 'hardware' | 'software';

/** Features worth counting; anything else the adapter reports is dropped. */
export const TRACKED_FEATURES = ['timestamp-query', 'shader-f16', 'subgroups', 'float32-filterable'] as const;

export interface VisitReport {
  webgpu: WebGpuStatus;
  vendor: string;
  architecture: string;
  features: string[];
  jspi: boolean;
}

export interface VisitRow extends VisitReport {
  country: string;
  browser: string;
  browserMajor: string;
  os: string;
}

const STATUSES: readonly WebGpuStatus[] = ['none', 'failed', 'hardware', 'software'];

/** Short lowercase token: adapter vendor/architecture strings are like "apple", "metal-3", "intel", "gen-12lp". */
function token(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32) : '';
}

/** Validates a beacon body; null when it is not a visit report. */
export function parseReport(body: unknown): VisitReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const webgpu = STATUSES.find((s) => s === b['webgpu']);
  if (!webgpu) return null;
  const features = Array.isArray(b['features'])
    ? TRACKED_FEATURES.filter((f) => (b['features'] as unknown[]).includes(f))
    : [];
  return { webgpu, vendor: token(b['vendor']), architecture: token(b['architecture']), features, jspi: b['jspi'] === true };
}

/** Browser family + major version and OS family from a User-Agent; the string itself is not kept. */
export function parseUserAgent(ua: string): { browser: string; browserMajor: string; os: string } {
  const browsers: [string, RegExp][] = [
    ['edge', /Edg(?:e|A|iOS)?\/(\d+)/],
    ['opera', /(?:OPR|Opera)\/(\d+)/],
    ['samsung', /SamsungBrowser\/(\d+)/],
    ['firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['chrome', /(?:Chrome|CriOS)\/(\d+)/],
    ['safari', /Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//],
  ];
  let browser = 'other';
  let browserMajor = '';
  for (const [name, re] of browsers) {
    const m = re.exec(ua);
    if (m) {
      browser = name;
      browserMajor = (m[1] ?? '').slice(0, 4);
      break;
    }
  }
  const os = /Windows/.test(ua) ? 'windows'
    : /iPhone|iPad|iPod/.test(ua) ? 'ios'
    : /Android/.test(ua) ? 'android'
    : /CrOS/.test(ua) ? 'chromeos'
    : /Mac OS X|Macintosh/.test(ua) ? 'macos'
    : /Linux/.test(ua) ? 'linux'
    : 'other';
  return { browser, browserMajor, os };
}

/** Sends the report unless the visitor opted out (Global Privacy Control / Do Not Track) or this is a local build. */
export function sendVisit(report: VisitReport): void {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    const dnt = nav.doNotTrack ?? (window as Window & { doNotTrack?: string }).doNotTrack;
    if (nav.globalPrivacyControl === true || dnt === '1' || dnt === 'yes') return;
    if (location.protocol === 'file:' || /^(|localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
    nav.sendBeacon(VISIT_PATH, new Blob([JSON.stringify(report)], { type: 'application/json' }));
  } catch {
    // counting is best effort
  }
}

export function jspiSupported(): boolean {
  return typeof WebAssembly === 'object' && 'Suspending' in WebAssembly;
}
