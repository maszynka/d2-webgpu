// SPDX-License-Identifier: GPL-3.0-or-later
// Start-up probe for the full game: what the game's worker can actually do in this browser, run in a module worker like
// the game's (probe.worker.ts). Feature flags alone were not enough: iPadOS 26 has WebAssembly.Suspending as a property
// but not a constructor, so "is it there" passed and the game failed later. Every check here runs the feature.

/** Which d2full build to load: JSPI (smaller, faster) or the Asyncify fallback (web/public/asyncify/). */
export type Engine = 'jspi' | 'asyncify';

export interface ProbeReport {
  /** JSPI ran a suspending import end to end ('ok'), is missing, or threw (the message) */
  jspi: string;
  /** wasm exception handling (legacy try / catch_all, what emcc -fwasm-exceptions emits): 'ok' or why not */
  eh: string;
  /** largest wasm memory the probe could grow to, MiB (the game needs ~550 MiB in the first acts) */
  memoryMiB: number;
  /** what the game's file systems need inside a worker */
  fileReaderSync: boolean;
  indexedDB: boolean;
  /** set when the probe worker itself did not start or answer */
  worker?: string;
  /** the worker started but gave no report in time (a slow device or a hung check): not proof the game cannot run */
  timedOut?: boolean;
}

/** What the probe grows to: the game's Act 1 peak (docs/benchmarks.md: 531 MiB in Blood Moor) plus headroom. */
export const MEMORY_NEEDED_MIB = 768;
/** Below this the game cannot reach Act 1 at all: a blocker. Between this and MEMORY_NEEDED_MIB: a warning. */
export const MEMORY_MIN_MIB = 576;
const MEMORY_PROBE_MIB = MEMORY_NEEDED_MIB;
/** a JSPI call that never settles (a half-done implementation) is as good as none */
const JSPI_LIMIT_MS = 2000;
const PAGE = 65536;

// () -> i32 that calls its import m.f: the smallest module JSPI can suspend in
const JSPI_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, // type: () -> i32
  0x02, 0x07, 0x01, 0x01, 0x6d, 0x01, 0x66, 0x00, 0x00, // import "m" "f" func 0
  0x03, 0x02, 0x01, 0x00, // func 1: type 0
  0x07, 0x05, 0x01, 0x01, 0x67, 0x00, 0x01, // export "g" = func 1
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b, // body: call 0
]);

// () -> () with try ... catch_all ... end (legacy wasm EH)
const EH_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x06, 0x40, 0x19, 0x0b, 0x0b,
]);

const hungMark = Symbol('hung');
const msg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

type Wasm = typeof WebAssembly & {
  Suspending?: new (f: (...a: unknown[]) => unknown) => unknown;
  promising?: (f: unknown) => (...a: unknown[]) => Promise<unknown>;
};

/** Run a suspending import through a promising export and check the value comes back. */
export async function probeJspi(wasm: Wasm = WebAssembly as Wasm): Promise<string> {
  if (typeof wasm.Suspending !== 'function' || typeof wasm.promising !== 'function') {
    const has = ['Suspending', 'promising'].filter((k) => k in wasm);
    return has.length ? `missing (${has.join(', ')} present but not functions)` : 'missing';
  }
  try {
    const f = new wasm.Suspending(async () => 42);
    const inst = new wasm.Instance(new wasm.Module(JSPI_MODULE), { m: { f: f as WebAssembly.ImportValue } });
    const g = wasm.promising((inst.exports as { g: unknown }).g);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<typeof hungMark>((r) => (timer = setTimeout(() => r(hungMark), JSPI_LIMIT_MS)));
    const v = await Promise.race([g(), hung]).finally(() => clearTimeout(timer));
    if (v === hungMark) return `broken (no result in ${JSPI_LIMIT_MS / 1000} s)`;
    return v === 42 ? 'ok' : `broken (returned ${String(v)})`;
  } catch (e) {
    return `broken (${msg(e)})`;
  }
}

export function probeEh(wasm: typeof WebAssembly = WebAssembly): string {
  try {
    return wasm.validate(EH_MODULE) ? 'ok' : 'missing';
  } catch (e) {
    return `broken (${msg(e)})`;
  }
}

/**
 * Grow a memory with the game's limits (256 MiB initial, 2 GiB maximum) towards MEMORY_PROBE_MIB, in 64 MiB steps;
 * returns how far it got. The pages are never touched: this checks that the browser grants the address space, not that
 * the device can keep that much resident. The memory goes with the worker.
 */
export function probeMemory(wasm: typeof WebAssembly = WebAssembly, targetMiB = MEMORY_PROBE_MIB): number {
  const mib = (pages: number): number => (pages * PAGE) / (1 << 20);
  let mem: WebAssembly.Memory;
  try {
    mem = new wasm.Memory({ initial: (256 << 20) / PAGE, maximum: (2048 * 1024 * 1024) / PAGE });
  } catch {
    return 0;
  }
  const step = (64 << 20) / PAGE;
  let pages = mem.buffer.byteLength / PAGE;
  while (mib(pages) < targetMiB) {
    try {
      mem.grow(step);
      pages += step;
    } catch {
      break;
    }
  }
  return mib(pages);
}

/** Everything above, as the probe worker runs it. */
export async function runProbe(g: typeof globalThis = globalThis): Promise<ProbeReport> {
  return {
    jspi: await probeJspi(),
    eh: probeEh(),
    memoryMiB: probeMemory(),
    fileReaderSync: typeof (g as { FileReaderSync?: unknown }).FileReaderSync === 'function',
    indexedDB: typeof (g as { indexedDB?: unknown }).indexedDB === 'object' && (g as { indexedDB?: unknown }).indexedDB !== null,
  };
}

export interface EngineChoice {
  engine: Engine | null;
  /** one line for the welcome row */
  detail: string;
  /** the game will not start: why (shown instead of starting it) */
  blocker: string | null;
}

/**
 * The build to load for a probe report; `force` (?engine=) overrides the choice but not the blockers. JSPI needs
 * both JSPI and wasm EH; the Asyncify build needs neither (it uses JS exceptions).
 */
export function chooseEngine(r: ProbeReport, force: Engine | null = null): EngineChoice {
  // no report in time: nothing known, so the build that needs the least, and the game says the rest when it starts
  if (r.timedOut && force !== 'jspi')
    return { engine: 'asyncify', detail: `fallback build (Asyncify): the probe ${r.worker ?? 'did not answer'}, so nothing was tested`, blocker: null };
  const blockers: string[] = [];
  if (r.worker) blockers.push(`the game's module worker did not run (${r.worker})`);
  if (!r.worker && !r.fileReaderSync) blockers.push('no FileReaderSync in workers (the game reads its MPQ files with it)');
  if (!r.worker && r.memoryMiB < MEMORY_MIN_MIB)
    blockers.push(`WebAssembly memory stopped at ${r.memoryMiB} MiB, the game needs about ${MEMORY_NEEDED_MIB} MiB`);
  const jspiOk = r.jspi === 'ok' && r.eh === 'ok';
  const engine: Engine = force ?? (jspiOk ? 'jspi' : 'asyncify');
  if (engine === 'jspi' && !jspiOk) blockers.push(`?engine=jspi, but JSPI ${r.jspi} / wasm exceptions ${r.eh}`);
  const warn =
    (r.indexedDB ? '' : '; no IndexedDB in workers: characters will not be saved') +
    (r.memoryMiB < MEMORY_NEEDED_MIB ? `; WebAssembly memory stopped at ${r.memoryMiB} MiB: later areas may run out` : '');
  if (blockers.length) return { engine: null, detail: blockers.join('; '), blocker: `The full game cannot start in this browser: ${blockers.join('; ')}.` };
  if (engine === 'jspi') return { engine, detail: `JSPI build${force ? ' (forced)' : ''}, ${r.memoryMiB} MiB memory ok${warn}`, blocker: null };
  const why = force ? 'forced by ?engine=asyncify' : r.jspi !== 'ok' ? `JSPI ${r.jspi}` : `wasm exceptions ${r.eh}`;
  return {
    engine,
    detail: `fallback build (Asyncify): ${why}. Larger download (~7.7 MB) and may run slower${warn}`,
    blocker: null,
  };
}

/** One line for the copied log. */
export function describeProbe(r: ProbeReport | null, engine: Engine | null): string {
  if (!r) return 'probe: not finished';
  return `probe: engine ${engine ?? 'none'}${r.timedOut ? ' (probe timed out)' : ''} | JSPI ${r.jspi} | wasm EH ${r.eh} | memory ${r.memoryMiB} MiB | FileReaderSync ${r.fileReaderSync ? 'yes' : 'no'} | IndexedDB ${r.indexedDB ? 'yes' : 'no'}${r.worker ? ` | worker ${r.worker}` : ''}`;
}

/**
 * Start probe.worker.ts and wait for its report; a worker that does not answer in `ms` is reported as such.
 * `hideJspi` probes as if the browser had no JSPI (tests).
 */
export function probeInWorker(hideJspi = false, ms = 20_000): Promise<ProbeReport> {
  const failed = (why: string, timedOut = false): ProbeReport => ({ jspi: 'not run', eh: 'not run', memoryMiB: 0, fileReaderSync: false, indexedDB: false, worker: why, timedOut });
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./probe.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      resolve(failed(msg(e)));
      return;
    }
    const done = (r: ProbeReport): void => {
      clearTimeout(timer);
      w.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => done(failed(`gave no answer in ${ms / 1000} s`, true)), ms);
    w.onmessage = (e: MessageEvent<ProbeReport>) => done(e.data);
    w.onerror = (e) => {
      e.preventDefault();
      done(failed(e.message || 'worker error'));
    };
    w.postMessage({ hideJspi });
  });
}
