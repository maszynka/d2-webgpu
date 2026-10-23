// SPDX-License-Identifier: GPL-3.0-or-later
// Web Worker hosting d2core.wasm (Emscripten). Missing module => init reports unavailable (demo mode).

import { ABI_MAGIC } from './abi';
import type { Method, MethodArgs, MethodResult, Request, Response } from './protocol';

interface EmModule {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free?(p: number): void;
  [fn: string]: unknown;
}

type ModuleFactory = (opts?: Record<string, unknown>) => Promise<EmModule>;

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Request>) => void) | null;
};

let mod: EmModule | null = null;

// Exported C function names (adapt to docs/abi.md once the wasm side is final).
const DECODE_FN: Record<
  'decodePalette' | 'decodeColormap' | 'decodeDc6' | 'decodeDt1' | 'decodeDs1',
  string
> = {
  decodePalette: '_d2core_palette_decode',
  decodeColormap: '_d2core_colormap_decode',
  decodeDc6: '_d2core_dc6_decode',
  decodeDt1: '_d2core_dt1_decode',
  decodeDs1: '_d2core_ds1_decode',
};

async function init(baseUrl: string): Promise<MethodResult['init']> {
  const url = new URL('d2core.js', baseUrl).href;
  try {
    const probe = await fetch(url, { method: 'GET' });
    const type = probe.headers.get('content-type') ?? '';
    if (!probe.ok || type.includes('text/html')) return { available: false, reason: `d2core.js not found (${probe.status})` };
    await probe.arrayBuffer();
    const imported = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    const factory = (imported.default ?? imported.createD2Core ?? imported.Module) as ModuleFactory | undefined;
    if (typeof factory !== 'function') return { available: false, reason: 'd2core.js has no module factory export' };
    mod = await factory({ locateFile: (p: string) => new URL(p, baseUrl).href });
    return { available: true };
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function requireMod(): EmModule {
  if (!mod) throw new Error('d2core wasm not loaded');
  return mod;
}

function fn(m: EmModule, name: string): (...a: number[]) => number {
  const f = m[name];
  if (typeof f !== 'function') throw new Error(`wasm export ${name} missing`);
  return f as (...a: number[]) => number;
}

/** Copy input into wasm memory, call decode fn, copy ABI result out into a fresh ArrayBuffer, free. */
function callDecode(name: string, input: ArrayBuffer): ArrayBuffer {
  const m = requireMod();
  const inPtr = m._malloc(input.byteLength);
  m.HEAPU8.set(new Uint8Array(input), inPtr);
  try {
    const outPtr = fn(m, name)(inPtr, input.byteLength);
    if (!outPtr) throw new Error(`${name} failed`);
    const dv = new DataView(m.HEAPU8.buffer, outPtr, 16);
    if (dv.getUint32(0, true) !== ABI_MAGIC) throw new Error(`${name}: bad ABI magic`);
    const total = dv.getUint32(8, true);
    const copy = m.HEAPU8.slice(outPtr, outPtr + total).buffer;
    const free = m['_d2core_free'];
    if (typeof free === 'function') (free as (p: number) => void)(outPtr);
    return copy;
  } finally {
    m._free?.(inPtr);
  }
}

async function handle(req: Request): Promise<{ result: MethodResult[Method]; transfer: Transferable[] }> {
  switch (req.method) {
    case 'init':
      return { result: await init((req.args as MethodArgs['init']).baseUrl), transfer: [] };
    case 'version': {
      const m = requireMod();
      const f = fn(m, '_d2core_version');
      const p = f();
      // Accept either a numeric version or a pointer to a C string.
      const heap = m.HEAPU8;
      if (p > 0 && p < heap.length) {
        let e = p;
        while (e < heap.length && heap[e] !== 0 && e - p < 256) e++;
        const s = new TextDecoder().decode(heap.subarray(p, e));
        if (/^[\x20-\x7e]+$/.test(s)) return { result: { version: s }, transfer: [] };
      }
      return { result: { version: String(p) }, transfer: [] };
    }
    default: {
      const buf = callDecode(DECODE_FN[req.method], (req.args as { data: ArrayBuffer }).data);
      return { result: buf, transfer: [buf] };
    }
  }
}

ctx.onmessage = (e) => {
  const req = e.data;
  handle(req).then(
    ({ result, transfer }) => {
      const res: Response = { id: req.id, ok: true, result };
      ctx.postMessage(res, transfer);
    },
    (err: unknown) => {
      const res: Response = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
      ctx.postMessage(res);
    },
  );
};
