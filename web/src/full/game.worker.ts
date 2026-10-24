// SPDX-License-Identifier: GPL-3.0-or-later
// Web Worker hosting d2full.wasm: the whole d2decomped game on SDL3's dummy video driver.
//  - MPQs: WORKERFS (lazy File.slice reads, StormLib reads synchronously here) at /d2
//  - user dir (saves, d2d.cfg, keys): IDBFS at /idb, loaded before main(), flushed periodically and on request
//  - frames: d2web_present -> FramePool (two ping-pong ArrayBuffers) -> postMessage
//  - input: JS queue drained by the game once per frame (wasm/full/d2web.cpp)

import { AudioBridge } from './audio-bridge';
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
  getExceptionMessage?(e: unknown): [string, string] | string;
}
type Factory = (opts: Record<string, unknown>) => Promise<D2Module>;

interface D2WebState {
  events: InputRecord[];
  want: number;
  gated: boolean;
  frames: number;
  present: null;
  pool: FramePool;
  audio: AudioBridge;
  ctl: { queue: { id: number; line: string }[]; reply(id: number, text: string): void };
  /** called by d2web_saved(): a character file was just written */
  onSaved(): void;
}

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const post = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

let state: D2WebState | null = null;
let mod: D2Module | null = null;
let syncing = false;
let syncAgain = false;
/** set when restoring IndexedDB failed: writing the (empty) dir back would erase the saves, so never sync out */
let readOnly = false;
let exited = false;
let syncs = 0;

/** FS.syncfs(false); calls never overlap: one requested while another runs is repeated right after it. */
function flushUserDir(): Promise<void> {
  const m = mod;
  if (!m || readOnly) return Promise.resolve();
  if (syncing) {
    syncAgain = true;
    return Promise.resolve();
  }
  syncing = true;
  return new Promise((resolve) => {
    m.FS.syncfs(false, (err) => {
      syncing = false;
      if (err) post({ t: 'log', line: `IDBFS save failed: ${err.message}` });
      else post({ t: 'synced', saves: ++syncs });
      resolve();
      if (syncAgain) {
        syncAgain = false;
        void flushUserDir();
      }
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
  const audio = new AudioBridge((m, t) => post(m, t));
  state = {
    events: [],
    want: 2,
    gated: true,
    frames: 0,
    present: null,
    pool,
    audio,
    ctl: { queue: [], reply: (id, text) => post({ t: 'ctlReply', id, text }) },
    onSaved: () => void flushUserDir(),
  };
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
    onAbort: (what: unknown) => post({ t: 'error', message: `game aborted: ${String(what)}` }),
    onExit: (code: number) => {
      exited = true;
      // quit-time saves reach IndexedDB before the page hears about the exit
      void flushUserDir()
        .then(() => settle())
        .then(() => {
          post({ t: 'exit', code });
          post({ t: 'flushed' });
        });
    },
  });
  mod = m;
  post({ t: 'status', text: `restoring saves... (module ready after ${((performance.now() - t0) / 1000).toFixed(1)} s)` });
  await new Promise<void>((res) =>
    m.FS.syncfs(true, (err) => {
      if (err) {
        readOnly = true; // never overwrite IndexedDB with what is (maybe) an empty dir
        post({ t: 'error', message: `could not restore saved characters (${err.message}); saving is disabled this session` });
      }
      res();
    }),
  );
  setInterval(() => void flushUserDir(), 10_000);
  post({ t: 'status', text: 'loading Diablo II data (the game is blocked while it loads)...' });
  // yield once so the status message is delivered before main() blocks the worker for a while
  await new Promise((r) => setTimeout(r, 20));
  // JSPI: main() suspends inside the frame loop, so callMain returns a promise that settles when it exits
  const isExit = (e: unknown) => e === 'unwind' || (e instanceof Error && e.name === 'ExitStatus') || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ExitStatus');
  try {
    await Promise.resolve(m.callMain(['--data', '/d2', '--no-video', ...extraArgs]));
  } catch (e) {
    if (!isExit(e)) post({ t: 'error', message: describe(m, e) });
  }
}

/** A C++ exception that escaped main() (WebAssembly.Exception) with its what(); anything else as text. */
function describe(m: D2Module, e: unknown): string {
  try {
    if (m.getExceptionMessage && typeof WebAssembly !== 'undefined' && (e as object) instanceof (WebAssembly as unknown as { Exception: new () => object }).Exception) {
      const r = m.getExceptionMessage(e);
      return `uncaught C++ exception: ${Array.isArray(r) ? r.join(': ') : r}`;
    }
  } catch {
    /* fall through */
  }
  return e instanceof Error ? e.message : String(e);
}

/** Resolves once no IndexedDB write is running or queued. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200 && (syncing || syncAgain); i++) await new Promise((r) => setTimeout(r, 25));
}

/** Page asked to stop: quit the game (it saves), write IndexedDB, say so. Falls back after a few seconds. */
function stop(): void {
  if (!state) {
    post({ t: 'flushed' });
    return;
  }
  state.pool.want = 2; // a paused (hidden) game must run to see the quit
  state.events.push([7, 0, 0, 0, 0, 0]);
  setTimeout(() => {
    if (exited) return;
    void flushUserDir()
      .then(() => settle())
      .then(() => post({ t: 'flushed' }));
  }, 4000);
}

self.addEventListener('error', (e) => post({ t: 'error', message: e.message || 'worker error' }));
self.addEventListener('unhandledrejection', (e) => post({ t: 'error', message: `unhandled: ${String((e as PromiseRejectionEvent).reason)}` }));

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
      state?.pool.recycle(msg.buf, msg.want);
      break;
    case 'flush':
      void flushUserDir();
      break;
    case 'stop':
      stop();
      break;
    case 'ctl':
      state?.ctl.queue.push({ id: msg.id, line: msg.line });
      break;
  }
};
