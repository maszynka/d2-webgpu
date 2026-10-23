// SPDX-License-Identifier: GPL-3.0-or-later
// Typed wrapper over the d2core Emscripten module (wasm/api/d2core.h, docs/abi.md).
// Runs in the worker and in node (tests). Results come back as self-contained
// ArrayBuffers (copied out of wasm memory, then freed) for the readers in abi.ts.

export interface EmModule {
  HEAPU8: Uint8Array;
  UTF8ToString(ptr: number): string;
  stringToUTF8(s: string, ptr: number, max: number): void;
  lengthBytesUTF8(s: string): number;
  FS: {
    mkdir(path: string): void;
    mount(type: unknown, opts: Record<string, unknown>, mountpoint: string): void;
    unmount(mountpoint: string): void;
    analyzePath(path: string): { exists: boolean };
    writeFile(path: string, data: Uint8Array): void;
  };
  WORKERFS: unknown;
  NODEFS?: unknown;
  _d2core_version(): number;
  _d2core_abi_version(): number;
  _d2core_last_error(): number;
  _d2core_alloc(bytes: number): number;
  _d2core_free(ptr: number): void;
  _d2core_result_size(ptr: number): number;
  _mpq_open(paths: number): number;
  _mpq_close(): void;
  _mpq_has(name: number): number;
  _mpq_read(name: number): number;
  _palette_decode(buf: number, len: number): number;
  _colormap_decode(buf: number, len: number): number;
  _colormap_slice(buf: number, len: number, offset: number, rows: number): number;
  _dc6_decode(buf: number, len: number): number;
  _dt1_decode(buf: number, len: number): number;
  _ds1_decode(buf: number, len: number): number;
}

export type ModuleFactory = (opts?: Record<string, unknown>) => Promise<EmModule>;

export const EXPECTED_ABI_VERSION = 1;

export class CoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreError';
  }
}

type Decoder = '_palette_decode' | '_colormap_decode' | '_dc6_decode' | '_dt1_decode' | '_ds1_decode';

export class D2Core {
  constructor(readonly m: EmModule) {
    const v = m._d2core_abi_version();
    if (v !== EXPECTED_ABI_VERSION) throw new CoreError(`d2core ABI version ${v}, expected ${EXPECTED_ABI_VERSION}`);
  }

  version(): string {
    return this.m.UTF8ToString(this.m._d2core_version());
  }

  /** Message of the last failed call ("" after a success). */
  lastError(): string {
    return this.m.UTF8ToString(this.m._d2core_last_error());
  }

  private fail(what: string): never {
    throw new CoreError(`${what}: ${this.lastError() || 'failed'}`);
  }

  private withBytes<T>(bytes: Uint8Array, fn: (ptr: number, len: number) => T): T {
    // d2core_alloc(0) may return NULL; give inputs at least one byte
    const ptr = this.m._d2core_alloc(Math.max(1, bytes.length));
    if (!ptr) throw new CoreError('d2core_alloc failed');
    try {
      this.m.HEAPU8.set(bytes, ptr); // re-read HEAPU8 after the alloc: memory may have grown
      return fn(ptr, bytes.length);
    } finally {
      this.m._d2core_free(ptr);
    }
  }

  private withCString<T>(s: string, fn: (ptr: number) => T): T {
    const len = this.m.lengthBytesUTF8(s) + 1;
    const ptr = this.m._d2core_alloc(len);
    if (!ptr) throw new CoreError('d2core_alloc failed');
    try {
      this.m.stringToUTF8(s, ptr, len);
      return fn(ptr);
    } finally {
      this.m._d2core_free(ptr);
    }
  }

  /** Copy a result out of wasm memory into a fresh ArrayBuffer and free it. */
  private takeResult(ptr: number): ArrayBuffer {
    const total = this.m._d2core_result_size(ptr);
    const copy = this.m.HEAPU8.slice(ptr, ptr + total).buffer; // after the call; HEAPU8 re-read
    this.m._d2core_free(ptr);
    return copy;
  }

  /** `paths` in override order: later ones win (patch_d2.mpq last). Returns the number opened. */
  mpqOpen(paths: string[]): number {
    const n = this.withCString(paths.join('\n'), (p) => this.m._mpq_open(p));
    if (n < 0) this.fail('mpq_open');
    return n;
  }

  mpqClose(): void {
    this.m._mpq_close();
  }

  mpqHas(name: string): boolean {
    return this.withCString(name, (p) => this.m._mpq_has(p)) === 1;
  }

  /** D2RW result block of a file (decode with decodeRaw). */
  mpqReadResult(name: string): ArrayBuffer {
    const ptr = this.withCString(name, (p) => this.m._mpq_read(p));
    if (!ptr) this.fail(`mpq_read(${name})`);
    return this.takeResult(ptr);
  }

  private decode(fn: Decoder, what: string, data: Uint8Array): ArrayBuffer {
    const ptr = this.withBytes(data, (p, n) => this.m[fn](p, n));
    if (!ptr) this.fail(what);
    return this.takeResult(ptr);
  }

  paletteDecode(data: Uint8Array): ArrayBuffer {
    return this.decode('_palette_decode', 'palette_decode', data);
  }
  colormapDecode(data: Uint8Array): ArrayBuffer {
    return this.decode('_colormap_decode', 'colormap_decode', data);
  }
  colormapSlice(data: Uint8Array, offset: number, rows: number): ArrayBuffer {
    const ptr = this.withBytes(data, (p, n) => this.m._colormap_slice(p, n, offset, rows));
    if (!ptr) this.fail('colormap_slice');
    return this.takeResult(ptr);
  }
  dc6Decode(data: Uint8Array): ArrayBuffer {
    return this.decode('_dc6_decode', 'dc6_decode', data);
  }
  dt1Decode(data: Uint8Array): ArrayBuffer {
    return this.decode('_dt1_decode', 'dt1_decode', data);
  }
  ds1Decode(data: Uint8Array): ArrayBuffer {
    return this.decode('_ds1_decode', 'ds1_decode', data);
  }
}
