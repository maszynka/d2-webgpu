// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { identityColormap, kindOfPath, selectMpqs } from './mpq';
import {
  collectMpqFiles,
  pickGameDirectory,
  reGrant,
  readPermission,
  restoreHandle,
  supportsDirectoryPicker,
  type FsDirHandle,
  type FsFileHandle,
  type HandleStore,
} from './picker';

const nf = (name: string, rel?: string) => (rel ? { name, webkitRelativePath: rel } : { name });

describe('selectMpqs', () => {
  it('orders known archives case-insensitively with patch_d2 last, ignoring others', () => {
    const sel = selectMpqs([nf('PATCH_D2.MPQ'), nf('d2sfx.mpq'), nf('D2Data.mpq'), nf('d2exp.MPQ'), nf('readme.txt'), nf('d2char.mpq'), nf('other.mpq')]);
    expect(sel.order).toEqual(['D2Data.mpq', 'd2exp.MPQ', 'd2char.mpq', 'd2sfx.mpq', 'PATCH_D2.MPQ']);
    expect(sel.files).toHaveLength(5);
    expect(sel.missing).toContain('d2music.mpq');
    expect(sel.missing).not.toContain('d2data.mpq');
  });
  it('keeps the shallowest copy of a duplicate (webkitdirectory listings)', () => {
    const deep = nf('d2data.mpq', 'Diablo II/backup/d2data.mpq');
    const top = nf('D2DATA.MPQ', 'Diablo II/D2DATA.MPQ');
    expect(selectMpqs([deep, top]).files).toEqual([top]);
  });
  it('returns nothing when no archive is present', () => {
    const sel = selectMpqs([nf('a.txt')]);
    expect(sel.files).toEqual([]);
    expect(sel.order).toEqual([]);
  });
});

describe('helpers', () => {
  it('identityColormap rows', () => {
    const c = identityColormap(2);
    expect(c.length).toBe(512);
    expect([c[0], c[255], c[256], c[511]]).toEqual([0, 255, 0, 255]);
  });
  it('kindOfPath', () => {
    expect(kindOfPath('data\\x\\TitleScreen.DC6')).toBe('dc6');
    expect(kindOfPath(' a.ds1 ')).toBe('ds1');
    expect(kindOfPath('a.dt1')).toBe('dt1');
    expect(kindOfPath('pal.dat')).toBe('pal');
    expect(kindOfPath('a.txt')).toBe('unknown');
  });
});

function file(name: string): FsFileHandle {
  return { kind: 'file', name, getFile: () => Promise.resolve(new File([name], name)) };
}
function dir(name: string, entries: (FsFileHandle | FsDirHandle)[], perm?: { query?: PermissionState; request?: PermissionState }): FsDirHandle {
  const h: FsDirHandle = {
    kind: 'directory',
    name,
    async *values() {
      for (const e of entries) yield e;
    },
  };
  if (perm) {
    h.queryPermission = () => Promise.resolve(perm.query ?? 'granted');
    h.requestPermission = () => Promise.resolve(perm.request ?? perm.query ?? 'granted');
  }
  return h;
}

describe('directory handle', () => {
  it('collects known MPQs from the folder and one subfolder level only', async () => {
    const h = dir('Diablo II', [file('d2data.mpq'), file('Game.exe'), dir('Data', [file('D2EXP.MPQ'), dir('deep', [file('d2char.mpq')])])]);
    const files = await collectMpqFiles(h);
    expect(files.map((f) => f.name).sort()).toEqual(['D2EXP.MPQ', 'd2data.mpq']);
  });
  it('permission states: granted, prompt -> requested only on demand, denied, no API', async () => {
    const prompt = dir('x', [], { query: 'prompt', request: 'granted' });
    expect(await readPermission(prompt, false)).toBe('prompt');
    expect(await readPermission(prompt, true)).toBe('granted');
    expect(await reGrant(prompt)).toBe(true);
    const denied = dir('x', [], { query: 'denied' });
    expect(await readPermission(denied, true)).toBe('denied');
    expect(await reGrant(denied)).toBe(false);
    expect(await readPermission(dir('x', []), false)).toBe('granted');
  });
  it('restoreHandle reports none / granted / needs-permission / denied', async () => {
    const mem = (h: FsDirHandle | null): HandleStore => ({ get: () => Promise.resolve(h), set: () => Promise.resolve(), clear: () => Promise.resolve() });
    expect(await restoreHandle(mem(null))).toEqual({ state: 'none' });
    expect((await restoreHandle(mem(dir('a', [], { query: 'granted' })))).state).toBe('granted');
    expect((await restoreHandle(mem(dir('a', [], { query: 'prompt' })))).state).toBe('needs-permission');
    expect((await restoreHandle(mem(dir('a', [], { query: 'denied' })))).state).toBe('denied');
    const broken = dir('a', []);
    broken.queryPermission = () => Promise.reject(new Error('stale'));
    expect((await restoreHandle(mem(broken))).state).toBe('none');
  });
  it('feature detection', async () => {
    expect(supportsDirectoryPicker({})).toBe(false);
    const h = dir('p', []);
    const win = { showDirectoryPicker: () => Promise.resolve(h) };
    expect(supportsDirectoryPicker(win)).toBe(true);
    expect(await pickGameDirectory(win)).toBe(h);
    await expect(pickGameDirectory({})).rejects.toThrow(/not available/);
  });
});
