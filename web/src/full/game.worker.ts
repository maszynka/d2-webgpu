// SPDX-License-Identifier: GPL-3.0-or-later
// Web Worker hosting d2full.wasm: the whole d2decomped game on SDL3's dummy video driver.
//  - MPQs: WORKERFS (lazy File.slice reads, StormLib reads synchronously here) at /d2
//  - user dir (saves, d2d.cfg, keys): IDBFS at /idb, loaded before main(), flushed periodically and on request
//  - frames: d2web_present -> FramePool (two ping-pong ArrayBuffers) -> postMessage
//  - input: JS queue drained by the game once per frame (wasm/full/d2web.cpp)

import { FramePool } from './framepool';
import type { InputRecord } from './input';
import type { FromWorker, ToWorker } from './protocol';

interface EmFs {
  mkdir(p: string): void;
  mount(type: unknown, opts: unknown, mountpoint: string): void;
  syncfs(populate: boolean, cb: (err: Error | null) => void): void;
}
interface D2Module {
  FS: EmFs;
  ENV: Record<string, string>;
  WORKERFS: unknown;
  IDBFS: unknown;
  HEAPU8: Uint8Array;
  callMain(args: string[]): void;
}
type Factory = (opts: Record<string, unknown>) => Promise<D2Module>;

interface D2WebState {
  events: InputRecord[];
  want: number;
  gated: boolean;
  frames: number;
  present: null;
  pool: FramePool;
}

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const post = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

let state: D2WebState | null = null;
let mod: D2Module | null = null;
let syncing = false;

function flushUserDir(): Promise<void> {
  const m = mod;
  if (!m || syncing) return Promise.resolve(); // never overlap syncfs calls
  syncing = true;
  return new Promise((resolve) => {
    m.FS.syncfs(false, (err) => {
      syncing = false;
      if (err) post({ t: 'log', line: `IDBFS save failed: ${err.message}` });
      resolve();
    });
  });
}

async function start(files: File[], baseUrl: string, extraArgs: string[]): Promise<void> {
  const t0 = performance.now();
  post({ t: 'status', text: 'loading game code...' });
  const pool = new FramePool((m, t) => {
    if (state && state.frames === 1) post({ t: 'status', text: 'running' });
    post(m, t);
  });
  state = { events: [], want: 2, gated: true, frames: 0, present: null, pool };
  (globalThis as unknown as { __d2web: D2WebState }).__d2web = state;

  const url = new URL('d2full.js', baseUrl).href;
  const factory = ((await import(/* @vite-ignore */ url)) as { default: Factory }).default;
  const m = await factory({
    noInitialRun: true,
    locateFile: (p: string) => new URL(p, baseUrl).href,
    print: (line: string) => post({ t: 'log', line }),
    printErr: (line: string) => post({ t: 'log', line }),
    preRun: [
      (mm: D2Module) => {
        mm.ENV['HOME'] = '/home/web_user';
        mm.ENV['XDG_CONFIG_HOME'] = '/idb'; // userdir: /idb/d2d/{save,d2d.cfg,...}
        mm.FS.mkdir('/idb');
        mm.FS.mount(mm.IDBFS, {}, '/idb');
        mm.FS.mkdir('/d2');
        // lower-cased names: the game looks files up by lower-case MPQ names
        mm.FS.mount(mm.WORKERFS, { blobs: files.map((f) => ({ name: f.name.toLowerCase(), data: f })) }, '/d2');
      },
    ],
    onExit: (code: number) => post({ t: 'exit', code }),
  });
  mod = m;
  post({ t: 'status', text: `restoring saves... (module ready after ${((performance.now() - t0) / 1000).toFixed(1)} s)` });
  await new Promise<void>((res) => m.FS.syncfs(true, (err) => { if (err) post({ t: 'log', line: `IDBFS load failed: ${err.message}` }); res(); }));
  setInterval(() => void flushUserDir(), 10_000);
  post({ t: 'status', text: 'loading Diablo II data (the game is blocked while it loads)...' });
  // yield once so the status message is delivered before main() blocks the worker for a while
  await new Promise((r) => setTimeout(r, 20));
  try {
    m.callMain(['--data', '/d2', '--no-video', ...extraArgs]);
  } catch (e) {
    if (e !== 'unwind' && !(e instanceof Error && e.name === 'ExitStatus')) throw e; // 'unwind': main loop installed
  }
}

ctx.onmessage = (e) => {
  const msg = e.data;
  switch (msg.t) {
    case 'start':
      start(msg.files, msg.baseUrl, msg.args ?? []).catch((err: unknown) => post({ t: 'error', message: err instanceof Error ? `${err.message}` : String(err) }));
      break;
    case 'input':
      if (state) for (const r of msg.recs) state.events.push(r);
      break;
    case 'recycle':
      state?.pool.recycle(msg.buf);
      break;
    case 'flush':
      void flushUserDir();
      break;
  }
};
