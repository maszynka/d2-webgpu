// SPDX-License-Identifier: GPL-3.0-or-later
// Visit counter, opt-in: nothing is sent until the visitor chose (consent.ts UI). With "tech" consent one beacon per
// page load carries what the browser supports (WebGPU adapter class, JSPI) and the Worker adds the browser family/major
// version and OS family from the User-Agent; with "country" consent the Worker adds the country. Stored in Workers
// Analytics Engine. No cookies, no IP, no raw User-Agent, no per-visitor id; the choice itself stays in localStorage.

export const VISIT_PATH = '/api/visit';

export type WebGpuStatus = 'none' | 'failed' | 'hardware' | 'software';

/** What the visitor allowed; neither means nothing is sent. */
export interface Consent {
  tech: boolean;
  country: boolean;
}

/** Features worth counting; anything else the adapter reports is dropped. */
export const TRACKED_FEATURES = ['timestamp-query', 'shader-f16', 'subgroups', 'float32-filterable'] as const;

export interface VisitReport {
  consent: Consent;
  /** 'unknown' when tech data is not allowed */
  webgpu: WebGpuStatus | 'unknown';
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

/** Validates a beacon body; null when it is not a visit report or allows nothing. Tech fields are dropped without tech consent. */
export function parseReport(body: unknown): VisitReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const c = b['consent'] as Record<string, unknown> | null | undefined;
  const consent: Consent = { tech: c?.['tech'] === true, country: c?.['country'] === true };
  if (!consent.tech && !consent.country) return null;
  if (!consent.tech) return { consent, webgpu: 'unknown', vendor: '', architecture: '', features: [], jspi: false };
  const webgpu = STATUSES.find((s) => s === b['webgpu']);
  if (!webgpu) return null;
  const features = Array.isArray(b['features'])
    ? TRACKED_FEATURES.filter((f) => (b['features'] as unknown[]).includes(f))
    : [];
  return { consent, webgpu, vendor: token(b['vendor']), architecture: token(b['architecture']), features, jspi: b['jspi'] === true };
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

/** Global Privacy Control / Do Not Track, or a local build: never sent, whatever was chosen. */
function optedOutOrLocal(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  const dnt = nav.doNotTrack ?? (window as Window & { doNotTrack?: string }).doNotTrack;
  if (nav.globalPrivacyControl === true || dnt === '1' || dnt === 'yes') return true;
  return location.protocol === 'file:' || /^(|localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
}

const CONSENT_KEY = 'd2.analytics.consent.v1';

/** The stored choice; null when the visitor has not chosen yet (or storage is unavailable). */
export function readConsent(): Consent | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<Consent>;
    return { tech: c.tech === true, country: c.country === true };
  } catch {
    return null;
  }
}

export type TechInfo = Pick<VisitReport, 'webgpu' | 'vendor' | 'architecture' | 'features' | 'jspi'>;

let tech: TechInfo | null = null;
let consent: Consent | null = null;
let consentRead = false;
let sent = false;

function currentConsent(): Consent | null {
  if (!consentRead) {
    consent = readConsent();
    consentRead = true;
  }
  return consent;
}

/** At most one beacon per page load, once both the browser checks and a choice that allows something are in. */
function flush(): void {
  const c = currentConsent();
  if (sent || !tech || !c || (!c.tech && !c.country)) return;
  sent = true;
  try {
    if (optedOutOrLocal()) return;
    const report: VisitReport = c.tech
      ? { consent: c, ...tech }
      : { consent: c, webgpu: 'unknown', vendor: '', architecture: '', features: [], jspi: false };
    navigator.sendBeacon(VISIT_PATH, new Blob([JSON.stringify(report)], { type: 'application/json' }));
  } catch {
    // counting is best effort
  }
}

/** The browser checks are done (main.ts); sent now if the visitor already allowed it. */
export function recordTech(info: TechInfo): void {
  tech = { ...info, features: info.features.filter((f) => (TRACKED_FEATURES as readonly string[]).includes(f)) };
  flush();
}

/** The visitor's choice (consent UI); remembered in this browser and, if it allows something, sent this page load. */
export function setConsent(c: Consent): void {
  consent = { tech: c.tech, country: c.country };
  consentRead = true;
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(consent));
  } catch {
    // private mode: the choice lasts for this page only
  }
  flush();
}

/** null until chosen */
export function getConsent(): Consent | null {
  return currentConsent();
}

export function jspiSupported(): boolean {
  return typeof WebAssembly === 'object' && 'Suspending' in WebAssembly;
}
