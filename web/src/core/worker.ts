// SPDX-License-Identifier: GPL-3.0-or-later
// Web Worker hosting d2core.wasm (Emscripten). Missing module => init reports unavailable (demo mode).
// MPQs are mounted through WORKERFS (lazy File.slice reads, nothing copied into wasm memory).

import { D2Core, type EmModule, type ModuleFactory } from './binding';
import { decodeRaw } from './abi';
import type { Method, MethodArgs, MethodResult, Request, Response } from './protocol';

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Request>) => void) | null;
};

let core: D2Core | null = null;
let mounted = false;
const MOUNT = '/d2';

async function init(baseUrl: string): Promise<MethodResult['init']> {
  const url = new URL('d2core.js', baseUrl).href;
  try {
    // No separate probe download: import directly (a missing file, or an SPA fallback serving HTML, fails the import).
    let imported: Record<string, unknown>;
    try {
      imported = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    } catch (e) {
      return { available: false, reason: `d2core.js could not be loaded from ${url}: ${e instanceof Error ? e.message : String(e)}` };
    }
    const factory = (imported.default ?? imported.createD2Core) as ModuleFactory | undefined;
    if (typeof factory !== 'function') return { available: false, reason: 'd2core.js has no module factory export' };
    const mod: EmModule = await factory({ locateFile: (p: string) => new URL(p, baseUrl).href });
    core = new D2Core(mod);
    return { available: true };
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function requireCore(): D2Core {
  if (!core) throw new Error('d2core wasm not loaded');
  return core;
}

function mountMpqs(files: File[], order: string[]): MethodResult['mountMpqs'] {
  const c = requireCore();
  const fs = c.m.FS;
  c.mpqClose();
  if (mounted) {
    fs.unmount(MOUNT);
    mounted = false;
  }
  if (!fs.analyzePath(MOUNT).exists) fs.mkdir(MOUNT);
  fs.mount(c.m.WORKERFS, { files }, MOUNT);
  mounted = true;
  const present = new Set(files.map((f) => f.name));
  const names = order.filter((n) => present.has(n));
  const opened = names.length > 0 ? c.mpqOpen(names.map((n) => `${MOUNT}/${n}`)) : 0;
  return { opened, names };
}

/** mpq_read -> raw bytes, then a decoder of the same module. */
function loadAndDecode(name: string, decode: (c: D2Core, raw: Uint8Array) => ArrayBuffer): ArrayBuffer {
  const c = requireCore();
  const raw = decodeRaw(c.mpqReadResult(name));
  return decode(c, raw);
}

async function handle(req: Request): Promise<{ result: MethodResult[Method]; transfer: Transferable[] }> {
  const bin = (buf: ArrayBuffer) => ({ result: buf, transfer: [buf] as Transferable[] });
  const data = (a: unknown): Uint8Array => new Uint8Array((a as { data: ArrayBuffer }).data);
  switch (req.method) {
    case 'init':
      return { result: await init((req.args as MethodArgs['init']).baseUrl), transfer: [] };
    case 'version':
      return { result: { version: requireCore().version() }, transfer: [] };
    case 'mountMpqs': {
      const a = req.args as MethodArgs['mountMpqs'];
      return { result: mountMpqs(a.files, a.order), transfer: [] };
    }
    case 'mpqHas':
      return { result: requireCore().mpqHas((req.args as MethodArgs['mpqHas']).name), transfer: [] };
    case 'mpqRead':
      return bin(requireCore().mpqReadResult((req.args as MethodArgs['mpqRead']).name));
    case 'decodePalette':
      return bin(requireCore().paletteDecode(data(req.args)));
    case 'decodeColormap':
      return bin(requireCore().colormapDecode(data(req.args)));
    case 'decodeDc6':
      return bin(requireCore().dc6Decode(data(req.args)));
    case 'decodeDt1':
      return bin(requireCore().dt1Decode(data(req.args)));
    case 'decodeDs1':
      return bin(requireCore().ds1Decode(data(req.args)));
    case 'loadPalette':
      return bin(loadAndDecode((req.args as MethodArgs['loadPalette']).name, (c, raw) => c.paletteDecode(raw)));
    case 'loadDc6':
      return bin(loadAndDecode((req.args as MethodArgs['loadDc6']).name, (c, raw) => c.dc6Decode(raw)));
    case 'loadDt1':
      return bin(loadAndDecode((req.args as MethodArgs['loadDt1']).name, (c, raw) => c.dt1Decode(raw)));
    case 'loadDs1':
      return bin(loadAndDecode((req.args as MethodArgs['loadDs1']).name, (c, raw) => c.ds1Decode(raw)));
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
