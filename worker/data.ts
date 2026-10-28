// SPDX-License-Identifier: GPL-3.0-or-later
// Private deploy only (wrangler env "private"): the owner's own Diablo II archives from an R2 bucket, behind the site
// password. GET /data/manifest.json lists them, GET /data/<name>.mpq streams one. The app (web/src/assets/server-data.ts)
// copies them into the browser's private storage (OPFS) and opens them from there. The public deploy has no bucket.

import { DATA_META, DATA_PATH, MPQ_KEY, type DataEntry } from '../web/src/assets/server-data';

export interface R2ObjectLike {
  key: string;
  size: number;
  httpEtag: string;
}
export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream;
}
export interface R2BucketLike {
  list(opts?: { cursor?: string }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
}

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };

/** the archives in the bucket (other keys are ignored), by name */
export async function listData(bucket: R2BucketLike): Promise<DataEntry[]> {
  const out: DataEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor ? { cursor } : {});
    for (const o of page.objects) if (MPQ_KEY.test(o.key)) out.push({ name: o.key, size: o.size, etag: o.httpEtag });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** a request under DATA_PATH; the caller has already checked the site password */
export async function serveData(request: Request, bucket: R2BucketLike, pathname: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { ...HEADERS, Allow: 'GET, HEAD' } });
  const name = pathname.slice(DATA_PATH.length);
  if (name === 'manifest.json') return Response.json({ files: await listData(bucket) }, { headers: HEADERS });
  if (!MPQ_KEY.test(name)) return new Response('Not found', { status: 404, headers: HEADERS });
  const head = request.method === 'HEAD';
  const obj = head ? await bucket.head(name) : await bucket.get(name);
  if (!obj) return new Response('Not found', { status: 404, headers: HEADERS });
  const headers = { ...HEADERS, 'Content-Type': 'application/octet-stream', ETag: obj.httpEtag };
  if (head) return new Response(null, { headers: { ...headers, 'Content-Length': String(obj.size) } });
  return new Response((obj as R2ObjectBodyLike).body, { headers });
}

interface HtmlRewriterLike {
  on(selector: string, handlers: { element(e: { append(content: string, opts: { html: boolean }): void }): void }): HtmlRewriterLike;
  transform(response: Response): Response;
}
declare const HTMLRewriter: { new (): HtmlRewriterLike };

/** tells the app (a <meta> in the page head) that its archives come from DATA_PATH */
export function announceData(response: Response): Response {
  if (!(response.headers.get('Content-Type') ?? '').includes('text/html')) return response;
  return new HTMLRewriter()
    .on('head', { element: (e) => e.append(`<meta name="${DATA_META}" content="${DATA_PATH}" />`, { html: true }) })
    .transform(response);
}
