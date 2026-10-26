// SPDX-License-Identifier: GPL-3.0-or-later
// Serves the static assets (app, wasm, the source archive). Optional HTTP Basic auth gate: when the SITE_PASSWORD
// secret is set, every request needs it (e.g. a private staging deploy); without it the site is public.
// POST /api/visit counts a page load (web/src/analytics/visit.ts) into Workers Analytics Engine.

import { VISIT_PATH, parseReport, parseUserAgent } from '../web/src/analytics/visit';

interface AnalyticsDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

interface Env {
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
    const { browser, browserMajor, os } = parseUserAgent(request.headers.get('User-Agent') ?? '');
    const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? 'XX';
    // the country is index1; blob order is the dataset's column order (blob1..blob8), keep it stable
    env.VISITS.writeDataPoint({
      indexes: [country],
      blobs: [browser, browserMajor, os, report.webgpu, report.vendor, report.architecture, report.features.join(','), report.jspi ? 'jspi' : 'no-jspi'],
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // gated deploys aren't counted and keep the endpoint behind the password like everything else
    if (!env.SITE_PASSWORD && new URL(request.url).pathname === VISIT_PATH) return countVisit(request, env);
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
