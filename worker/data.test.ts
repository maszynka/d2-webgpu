// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { listData, serveData, type R2BucketLike, type R2ObjectLike } from './data';
import worker from './index';

function bucket(keys: Record<string, string>, pageSize = 2): R2BucketLike {
  const objs: R2ObjectLike[] = Object.entries(keys).map(([key, body]) => ({ key, size: body.length, httpEtag: `"${key}-1"` }));
  return {
    async list(opts) {
      const at = Number(opts?.cursor ?? 0);
      const page = objs.slice(at, at + pageSize);
      const truncated = at + pageSize < objs.length;
      return truncated ? { objects: page, truncated, cursor: String(at + pageSize) } : { objects: page, truncated };
    },
    async get(key) {
      const o = objs.find((x) => x.key === key);
      return o ? { ...o, body: new Response(keys[key]).body! } : null;
    },
    async head(key) {
      return objs.find((x) => x.key === key) ?? null;
    },
  };
}

const files = { 'd2exp.mpq': 'exp', 'd2data.mpq': 'data!', 'notes.txt': 'x', 'Patch_D2.mpq': 'p' };
const get = (path: string, init?: RequestInit): Request => new Request(`https://x.test${path}`, init);

describe('listData', () => {
  it('lists only the archives, across pages, by name', async () => {
    expect(await listData(bucket(files))).toEqual([
      { name: 'd2data.mpq', size: 5, etag: '"d2data.mpq-1"' },
      { name: 'd2exp.mpq', size: 3, etag: '"d2exp.mpq-1"' },
      { name: 'Patch_D2.mpq', size: 1, etag: '"Patch_D2.mpq-1"' },
    ]);
  });
});

describe('serveData', () => {
  it('serves the manifest and an archive, uncached', async () => {
    const m = await serveData(get('/data/manifest.json'), bucket(files), '/data/manifest.json');
    expect(((await m.json()) as { files: unknown[] }).files).toHaveLength(3);
    const r = await serveData(get('/data/d2data.mpq'), bucket(files), '/data/d2data.mpq');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('data!');
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect(r.headers.get('ETag')).toBe('"d2data.mpq-1"');
  });

  it('refuses other keys and methods', async () => {
    expect((await serveData(get('/data/notes.txt'), bucket(files), '/data/notes.txt')).status).toBe(404);
    expect((await serveData(get('/data/missing.mpq'), bucket(files), '/data/missing.mpq')).status).toBe(404);
    expect((await serveData(get('/data/a/b.mpq'), bucket(files), '/data/a/b.mpq')).status).toBe(404);
    expect((await serveData(get('/data/d2data.mpq', { method: 'PUT', body: 'x' }), bucket(files), '/data/d2data.mpq')).status).toBe(405);
  });
});

describe('private deploy gate', () => {
  const assets = { fetch: async () => new Response('app', { headers: { 'Content-Type': 'text/plain' } }) };
  const auth = (pw: string): RequestInit => ({ headers: { Authorization: `Basic ${btoa(`me:${pw}`)}` } });

  it('fails closed without the site password', async () => {
    const r = await worker.fetch(get('/data/d2data.mpq'), { ASSETS: assets, DATA: bucket(files) });
    expect(r.status).toBe(503);
    expect((await worker.fetch(get('/'), { ASSETS: assets, DATA: bucket(files) })).status).toBe(503);
  });

  it('serves the data only with the password', async () => {
    const env = { ASSETS: assets, DATA: bucket(files), SITE_PASSWORD: 'secret' };
    expect((await worker.fetch(get('/data/d2data.mpq'), env)).status).toBe(401);
    expect((await worker.fetch(get('/data/d2data.mpq', auth('wrong')), env)).status).toBe(401);
    const r = await worker.fetch(get('/data/d2data.mpq', auth('secret')), env);
    expect(await r.text()).toBe('data!');
  });

  it('leaves /data/ to the app on the public deploy', async () => {
    const r = await worker.fetch(get('/data/d2data.mpq'), { ASSETS: assets });
    expect(await r.text()).toBe('app');
  });
});
