// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { chooseEngine, describeProbe, MEMORY_NEEDED_MIB, probeEh, probeJspi, probeMemory, type ProbeReport } from './probe';

const good: ProbeReport = { jspi: 'ok', eh: 'ok', memoryMiB: MEMORY_NEEDED_MIB, fileReaderSync: true, indexedDB: true };

describe('probes', () => {
  const like = (o: object): never => Object.assign(Object.create(WebAssembly) as object, o) as never;
  it.skipIf(typeof (WebAssembly as { Suspending?: unknown }).Suspending !== 'function')('JSPI runs end to end where the runtime has it', async () => {
    expect(await probeJspi()).toBe('ok');
  });
  it('JSPI missing, or present but not constructors (iPadOS 26)', async () => {
    expect(await probeJspi({ Instance: WebAssembly.Instance } as never)).toBe('missing');
    expect(await probeJspi(like({ Suspending: {}, promising: () => undefined }))).toBe('missing (Suspending, promising present but not functions)');
  });
  it('JSPI that throws is broken, with the message', async () => {
    const Suspending = function () {
      throw new TypeError('nope');
    };
    expect(await probeJspi(like({ Suspending, promising: () => undefined }))).toBe('broken (TypeError: nope)');
  });
  it('wasm EH validates', () => {
    expect(probeEh()).toBe('ok');
    expect(probeEh({ validate: () => false } as never)).toBe('missing');
  });
  it('memory grows to the target, or reports where it stopped', () => {
    expect(probeMemory(WebAssembly, 320)).toBe(320);
    let grows = 0;
    class Capped {
      buffer = { byteLength: 256 << 20 };
      grow(): void {
        if (++grows > 2) throw new RangeError('out of memory');
      }
    }
    expect(probeMemory({ Memory: Capped } as never)).toBe(256 + 128);
    expect(probeMemory({ Memory: class { constructor() { throw new RangeError('x'); } } } as never)).toBe(0);
  });
});

describe('chooseEngine', () => {
  it('JSPI when it and wasm EH work', () => {
    expect(chooseEngine(good)).toMatchObject({ engine: 'jspi', blocker: null });
  });
  it('falls back to Asyncify without JSPI or wasm EH, saying why', () => {
    const a = chooseEngine({ ...good, jspi: 'missing' });
    expect(a).toMatchObject({ engine: 'asyncify', blocker: null });
    expect(a.detail).toContain('JSPI missing');
    expect(chooseEngine({ ...good, eh: 'missing' }).detail).toContain('wasm exceptions missing');
  });
  it('?engine= forces a build, but not JSPI where it does not work', () => {
    expect(chooseEngine(good, 'asyncify')).toMatchObject({ engine: 'asyncify' });
    expect(chooseEngine({ ...good, jspi: 'missing' }, 'jspi')).toMatchObject({ engine: null });
  });
  it('blocks on too little memory, no FileReaderSync or a dead worker', () => {
    expect(chooseEngine({ ...good, memoryMiB: 512 }).blocker).toContain('512 MiB');
    expect(chooseEngine({ ...good, fileReaderSync: false }).blocker).toContain('FileReaderSync');
    const dead = chooseEngine({ ...good, jspi: 'not run', eh: 'not run', memoryMiB: 0, fileReaderSync: false, worker: 'probe threw: x' });
    expect(dead.engine).toBeNull();
    expect(dead.blocker).toContain('probe threw: x');
    expect(dead.blocker).not.toContain('FileReaderSync');
  });
  it('memory between the Act 1 minimum and the target only warns', () => {
    const c = chooseEngine({ ...good, memoryMiB: 640 });
    expect(c).toMatchObject({ engine: 'jspi', blocker: null });
    expect(c.detail).toContain('stopped at 640 MiB');
  });
  it('a probe that timed out falls back to Asyncify instead of blocking', () => {
    const slow: ProbeReport = { jspi: 'not run', eh: 'not run', memoryMiB: 0, fileReaderSync: false, indexedDB: false, worker: 'gave no answer in 20 s', timedOut: true };
    expect(chooseEngine(slow)).toMatchObject({ engine: 'asyncify', blocker: null });
    expect(chooseEngine(slow, 'jspi').engine).toBeNull();
    expect(describeProbe(slow, 'asyncify')).toContain('engine asyncify (probe timed out)');
  });
  it('no IndexedDB only warns', () => {
    expect(chooseEngine({ ...good, indexedDB: false })).toMatchObject({ engine: 'jspi', blocker: null });
    expect(chooseEngine({ ...good, indexedDB: false }).detail).toContain('not be saved');
  });
  it('log line', () => {
    expect(describeProbe(null, null)).toBe('probe: not finished');
    expect(describeProbe({ ...good, jspi: 'missing' }, 'asyncify')).toBe(
      `probe: engine asyncify | JSPI missing | wasm EH ok | memory ${MEMORY_NEEDED_MIB} MiB | FileReaderSync yes | IndexedDB yes`,
    );
  });
});
