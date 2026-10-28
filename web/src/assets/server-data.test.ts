// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncServerData, toDownload, type DataEntry } from './server-data';

describe('toDownload', () => {
  const remote: DataEntry[] = [
    { name: 'd2data.mpq', size: 10, etag: 'a' },
    { name: 'd2exp.mpq', size: 20, etag: 'b' },
    { name: 'd2char.mpq', size: 30, etag: 'c' },
  ];
  it('skips copies with the same size and server version', () => {
    const local = new Map([['d2data.mpq', 10], ['d2exp.mpq', 20], ['d2char.mpq', 29]]);
    expect(toDownload(remote, local, { 'd2data.mpq': 'a', 'd2exp.mpq': 'old', 'd2char.mpq': 'c' }).map((e) => e.name)).toEqual(['d2exp.mpq', 'd2char.mpq']);
    expect(toDownload(remote, new Map(), {})).toHaveLength(3);
  });
});

// a minimal in-memory OPFS: one directory of files
class FakeFile {
  constructor(public data = '') {}
  async getFile(): Promise<File> {
    return new File([this.data], 'f');
  }
  async createWritable(): Promise<{ write(c: string | Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> {
    let next = '';
    return {
      write: async (c) => void (next += typeof c === 'string' ? c : new TextDecoder().decode(c)),
      close: async () => void (this.data = next),
      abort: async () => undefined,
    };
  }
  readonly kind = 'file';
}
class FakeDir {
  readonly files = new Map<string, FakeFile>();
  readonly kind = 'directory';
  async getDirectoryHandle(): Promise<FakeDir> {
    return this;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    let f = this.files.get(name);
    if (!f && opts?.create) this.files.set(name, (f = new FakeFile()));
    if (!f) throw new DOMException('missing', 'NotFoundError');
    return f;
  }
  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
  }
  async *entries(): AsyncIterable<[string, FakeFile]> {
    yield* this.files.entries();
  }
}

function server(files: Record<string, { body: string; etag: string }>): { fetch: typeof fetch; got: string[] } {
  const got: string[] = [];
  const f = (async (url: string) => {
    const name = decodeURIComponent(url.slice('/data/'.length));
    got.push(name);
    if (name === 'manifest.json') return Response.json({ files: Object.entries(files).map(([n, v]) => ({ name: n, size: v.body.length, etag: v.etag })) });
    const v = files[name];
    return v ? new Response(v.body) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: f, got };
}

describe('syncServerData', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('downloads what changed, keeps the rest and drops what the server removed', async () => {
    const dir = new FakeDir();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => dir, persist: async () => true, estimate: async () => ({ quota: 1e9, usage: 0 }) } });
    const s1 = server({ 'd2data.mpq': { body: 'data', etag: '1' }, 'd2sfx.mpq': { body: 'o', etag: '1' } });
    await syncServerData('/data/', () => undefined, s1.fetch);
    expect(s1.got).toEqual(['manifest.json', 'd2data.mpq', 'd2sfx.mpq']);
    expect(dir.files.get('d2data.mpq')?.data).toBe('data');

    const s2 = server({ 'd2data.mpq': { body: 'data', etag: '1' }, 'd2exp.mpq': { body: 'exp', etag: '1' } });
    const seen: number[] = [];
    await syncServerData('/data/', (p) => seen.push(p.done), s2.fetch);
    expect(s2.got).toEqual(['manifest.json', 'd2exp.mpq']);
    expect([...dir.files.keys()].sort()).toEqual(['d2data.mpq', 'd2exp.mpq', 'etags.json']);
    expect(seen.at(-1)).toBe(3);

    const s3 = server({ 'd2data.mpq': { body: 'DATA', etag: '2' }, 'd2exp.mpq': { body: 'exp', etag: '1' } });
    await syncServerData('/data/', () => undefined, s3.fetch);
    expect(s3.got).toEqual(['manifest.json', 'd2data.mpq']);
    expect(dir.files.get('d2data.mpq')?.data).toBe('DATA');
  });

  it('keeps the old copy when a download breaks off, and plays the saved copy when the server is unreachable', async () => {
    const dir = new FakeDir();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => dir } });
    await syncServerData('/data/', () => undefined, server({ 'd2data.mpq': { body: 'data', etag: '1' } }).fetch);
    const broken = (async (url: string) => {
      if (url.endsWith('manifest.json')) return Response.json({ files: [{ name: 'd2data.mpq', size: 4, etag: '2' }] });
      const body = new ReadableStream({ pull: (c) => c.error(new Error('connection reset')) });
      return new Response(body);
    }) as unknown as typeof fetch;
    await expect(syncServerData('/data/', () => undefined, broken)).rejects.toThrow(/connection reset/);
    expect(dir.files.get('d2data.mpq')?.data).toBe('data');
    expect(JSON.parse(dir.files.get('etags.json')!.data)).toEqual({ 'd2data.mpq': '1' });

    const seen: boolean[] = [];
    const down = (async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    expect(await syncServerData('/data/', (p) => seen.push(p.offline === true), down)).toBe(dir);
    expect(seen).toEqual([true]);
    const empty = new FakeDir();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => empty } });
    await expect(syncServerData('/data/', () => undefined, down)).rejects.toThrow(/Failed to fetch/);
  });

  it('stops before downloading when the browser has too little room', async () => {
    const dir = new FakeDir();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => dir, estimate: async () => ({ quota: 2, usage: 0 }) } });
    const s = server({ 'd2data.mpq': { body: 'data', etag: '1' } });
    await expect(syncServerData('/data/', () => undefined, s.fetch)).rejects.toThrow(/Not enough browser storage/);
    expect(s.got).toEqual(['manifest.json']);
  });
});
