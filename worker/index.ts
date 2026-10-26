// SPDX-License-Identifier: GPL-3.0-or-later
// Serves the static assets (app, wasm, the source archive). Optional HTTP Basic auth gate: when the SITE_PASSWORD
// secret is set, every request needs it (e.g. a private staging deploy); without it the site is public.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SITE_PASSWORD?: string;
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
