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
  viewW: number;
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
// bumped when finalFlush abandons a stuck write, so that write's late callback is ignored
let syncGen = 0;
/** set when restoring IndexedDB failed: writing the (empty) dir back would erase the saves, so never sync out */
let readOnly = false;
let exited = false;
let syncs = 0;
/** the periodic IndexedDB write; cleared when the game exits or is stopped */
let syncTimer: ReturnType<typeof setInterval> | null = null;
/** the final write is done: nothing may touch the (possibly torn down) user dir again */
let closed = false;

function stopSyncTimer(): void {
  if (syncTimer !== null) clearInterval(syncTimer);
  syncTimer = null;
}

/** callers waiting for a write that starts after their request (a running write may predate the data they need) */
let nextWaiters: (() => void)[] = [];
/** callers waiting for the write in flight */
let runWaiters: (() => void)[] = [];

/**
 * FS.syncfs(false); calls never overlap: one requested while another runs is repeated right after it. Resolves when a
 * write that started after this call has finished (at once when writing is impossible: no module, read-only, closed).
 */
function flushUserDir(): Promise<void> {
  const m = mod;
  if (!m || readOnly || closed) return Promise.resolve();
  const done = new Promise<void>((resolve) => nextWaiters.push(resolve));
  if (syncing) syncAgain = true;
  else runSync(m);
  return done;
}

function runSync(m: D2Module): void {
  syncing = true;
  const gen = syncGen;
  runWaiters = nextWaiters;
  nextWaiters = [];
  m.FS.syncfs(false, (err) => {
    if (gen !== syncGen) return;
    syncing = false;
    if (err) post({ t: 'log', line: `IDBFS save failed: ${err.message}` });
    else post({ t: 'synced', saves: ++syncs });
    const waiters = runWaiters;
    runWaiters = [];
    waiters.forEach((r) => r());
    if (syncAgain) {
      syncAgain = false;
      if (!readOnly && !closed) runSync(m);
    }
    if (!syncing) nextWaiters.splice(0).forEach((r) => r());
  });
}

async function start(files: File[], baseUrl: string, extraArgs: string[], viewWidth: number): Promise<void> {
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
    viewW: viewWidth,
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
      stopSyncTimer();
      // quit-time saves reach IndexedDB before the page hears about the exit
      void finalFlush()
        .then(() => settle())
        .then(() => {
          closed = true;
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
  syncTimer = setInterval(() => void flushUserDir(), 10_000);
  post({ t: 'status', text: 'loading Diablo II data (the game is blocked while it loads)...' });
  // yield once so the status message is delivered before main() blocks the worker for a while
  await new Promise((r) => setTimeout(r, 20));
  // JSPI build: main() suspends inside the frame loop, so callMain returns a promise that settles when it exits.
  // Asyncify build: callMain returns (or throws "unwind") at the first sleep; the loop goes on from timers, onExit ends it.
  const isExit = (e: unknown) => e === 'unwind' || (e instanceof Error && e.name === 'ExitStatus') || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ExitStatus');
  try {
    await Promise.resolve(m.callMain(['--data', '/d2', '--no-video', '--widescreen', ...extraArgs]));
  } catch (e) {
    if (!isExit(e)) post({ t: 'error', message: describe(m, e) });
  }
}

/**
 * A C++ exception that escaped main() with its what(): a WebAssembly.Exception (JSPI build, wasm EH) or Emscripten's
 * CppException with an excPtr (Asyncify build, JS EH). Anything else as text.
 */
function describe(m: D2Module, e: unknown): string {
  try {
    const wasmExc = typeof WebAssembly !== 'undefined' && (e as object) instanceof (WebAssembly as unknown as { Exception: new () => object }).Exception;
    const jsExc = typeof e === 'object' && e !== null && typeof (e as { excPtr?: unknown }).excPtr === 'number';
    if (m.getExceptionMessage && (wasmExc || jsExc)) {
      const r = m.getExceptionMessage(e);
      return `uncaught C++ exception: ${Array.isArray(r) ? r.join(': ') : r}`;
    }
  } catch {
    /* fall through */
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The last write, after the game has exited. A write that was already running when the runtime exited (the quit-time
 * character save starts one) never completes: IDBFS' callbacks die with the runtime. Wait a moment for it, then give up on
 * it and write again from scratch, so the saved character always reaches IndexedDB.
 */
async function finalFlush(): Promise<void> {
  for (let i = 0; i < 60 && (syncing || syncAgain); i++) await new Promise((r) => setTimeout(r, 25));
  if (syncing) {
    syncGen++;
    syncing = false;
    syncAgain = false;
    nextWaiters.unshift(...runWaiters.splice(0)); // the abandoned write's callers wait for the fresh one
  }
  await flushUserDir();
}

/** Resolves once no IndexedDB write is running or queued. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200 && (syncing || syncAgain); i++) await new Promise((r) => setTimeout(r, 25));
}

/** Page asked to stop: quit the game (it saves), write IndexedDB, say so. Falls back after a few seconds. */
function stop(): void {
  if (!state || exited) {
    // never started, or the game already quit and wrote its saves: nothing to wait for
    stopSyncTimer();
    void settle().then(() => post({ t: 'flushed' })); // returns at once unless the exit-time write is still running
    return;
  }
  state.pool.want = 2; // a paused (hidden) game must run to see the quit
  state.events.push([7, 0, 0, 0, 0, 0]);
  setTimeout(() => {
    if (exited) return;
    stopSyncTimer();
    void flushUserDir()
      .then(() => settle())
      .then(() => {
        closed = true;
        post({ t: 'flushed' });
      });
  }, 4000);
}

// the Asyncify build's frame loop runs from timers once callMain returned, so its uncaught C++ exceptions land here
self.addEventListener('error', (e) => post({ t: 'error', message: mod && e.error !== undefined && e.error !== null ? describe(mod, e.error) : e.message || 'worker error' }));
self.addEventListener('unhandledrejection', (e) => {
  const reason: unknown = (e as PromiseRejectionEvent).reason;
  post({ t: 'error', message: `unhandled: ${mod ? describe(mod, reason) : String(reason)}` });
});

ctx.onmessage = (e) => {
  const msg = e.data;
  switch (msg.t) {
    case 'start':
      start(msg.files, msg.baseUrl, msg.args ?? [], msg.viewWidth ?? 800).catch((err: unknown) => post({ t: 'error', message: err instanceof Error ? `${err.message}` : String(err) }));
      break;
    case 'view':
      if (state) state.viewW = msg.width;
      break;
    case 'input':
      if (state) for (const r of msg.recs) state.events.push(r);
      break;
    case 'recycle':
      state?.pool.recycle(msg.buf, msg.want);
      break;
    case 'flush': {
      const id = msg.id;
      void flushUserDir().then(() => {
        if (id !== undefined) post({ t: 'flushDone', id });
      });
      break;
    }
    case 'stop':
      stop();
      break;
    case 'ctl':
      state?.ctl.queue.push({ id: msg.id, line: msg.line });
      break;
  }
};
