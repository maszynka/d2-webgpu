// SPDX-License-Identifier: GPL-3.0-or-later
// Serves the static assets (app, wasm, the source archive). Optional HTTP Basic auth gate: when the SITE_PASSWORD
// secret is set, every request needs it (e.g. a private staging deploy); without it the site is public.
// POST /api/visit counts a page load (web/src/analytics/visit.ts) into Workers Analytics Engine; /admin shows the counts
// (worker/admin.ts, its own password).

import { VISIT_PATH, parseReport, parseUserAgent } from '../web/src/analytics/visit';
import { ADMIN_HTML, adminEnabled, adminStats, type AdminEnv } from './admin';

interface AnalyticsDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

interface Env extends AdminEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SITE_PASSWORD?: string;
  VISITS?: AnalyticsDataset;
}

const MAX_VISIT_BODY = 1024;

async function countVisit(request: Request, env: Env): Promise<Response> {
  const done = new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  // not counted: opted-out visitors, oversized bodies
  if (!env.VISITS) return done;
  if (request.headers.get('Sec-GPC') === '1' || request.headers.get('DNT') === '1') return done;
  if (!(Number(request.headers.get('Content-Length') ?? NaN) <= MAX_VISIT_BODY)) return done; // missing or malformed: skip
  try {
    const text = await request.text();
    if (text.length > MAX_VISIT_BODY) return done;
    const report = parseReport(JSON.parse(text));
    if (!report) return done;
    // without tech consent no browser / OS either; without country consent '--'
    const ua = report.consent.tech ? parseUserAgent(request.headers.get('User-Agent') ?? '') : { browser: '', browserMajor: '', os: '' };
    const country = report.consent.country ? ((request as Request & { cf?: { country?: string } }).cf?.country ?? 'XX') : '--';
    // the country is index1; blob order is the dataset's column order (blob1..blob8), keep it stable
    env.VISITS.writeDataPoint({
      indexes: [country],
      blobs: [ua.browser, ua.browserMajor, ua.os, report.webgpu, report.vendor, report.architecture, report.features.join(','), report.consent.tech ? (report.jspi ? 'jspi' : 'no-jspi') : ''],
      doubles: [1],
    });
  } catch {
    // aborted upload, bad JSON: not counted
  }
  return done;
}

const encoder = new TextEncoder();

async function sameSecret(a: string, b: string): Promise<boolean> {
  // compare digests so the time taken doesn't depend on where the strings differ
  const [da, db] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  const x = new Uint8Array(da!);
  const y = new Uint8Array(db!);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function passwordFrom(header: string | null): string | null {
  if (!header?.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(':');
    return colon < 0 ? null : decoded.slice(colon + 1); // any user name
  } catch {
    return null;
  }
}

const ADMIN_HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  const given = passwordFrom(request.headers.get('Authorization'));
  if (given === null || !(await sameSecret(given, env.ADMIN_PASSWORD!))) {
    return new Response('Password required', {
      status: 401,
      headers: { ...ADMIN_HEADERS, 'WWW-Authenticate': 'Basic realm="d2-webgpu admin", charset="UTF-8"' },
    });
  }
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    return new Response(ADMIN_HTML, { headers: { ...ADMIN_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' } });
  }
  if (url.pathname === '/admin/api/stats') {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...ADMIN_HEADERS, Allow: 'GET' } });
    return adminStats(env, url);
  }
  return new Response('Not found', { status: 404, headers: ADMIN_HEADERS });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // only when configured; otherwise /admin is an ordinary path (behind the site password on gated deploys)
    if (adminEnabled(env) && (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))) return admin(request, env, url);
    // gated deploys aren't counted and keep the endpoint behind the password like everything else
    if (!env.SITE_PASSWORD && url.pathname === VISIT_PATH) return countVisit(request, env);
    if (!env.SITE_PASSWORD) {
      // public; kept out of search results until the project is announced
      const response = await env.ASSETS.fetch(request);
      const out = new Response(response.body, response);
      out.headers.set('X-Robots-Tag', 'noindex, nofollow');
      return out;
    }
    const given = passwordFrom(request.headers.get('Authorization'));
    if (given === null || !(await sameSecret(given, env.SITE_PASSWORD))) {
      return new Response('Password required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="d2-webgpu", charset="UTF-8"', 'Cache-Control': 'no-store' },
      });
    }
    const response = await env.ASSETS.fetch(request);
    const out = new Response(response.body, response);
    out.headers.set('Cache-Control', 'private, no-store');
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return out;
  },
};
