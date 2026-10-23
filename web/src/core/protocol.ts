// SPDX-License-Identifier: GPL-3.0-or-later
// Typed message protocol between the main thread and the d2core worker.

export type Method =
  | 'init'
  | 'version'
  | 'decodePalette'
  | 'decodeColormap'
  | 'decodeDc6'
  | 'decodeDt1'
  | 'decodeDs1';

export interface MethodArgs {
  init: { baseUrl: string };
  version: Record<string, never>;
  decodePalette: { data: ArrayBuffer };
  decodeColormap: { data: ArrayBuffer };
  decodeDc6: { data: ArrayBuffer };
  decodeDt1: { data: ArrayBuffer };
  decodeDs1: { data: ArrayBuffer };
}

/** Result payloads: binary results are ABI buffers (fresh ArrayBuffer copy, transferred). */
export interface MethodResult {
  init: { available: boolean; reason?: string };
  version: { version: string };
  decodePalette: ArrayBuffer;
  decodeColormap: ArrayBuffer;
  decodeDc6: ArrayBuffer;
  decodeDt1: ArrayBuffer;
  decodeDs1: ArrayBuffer;
}

export type Request<M extends Method = Method> = {
  [K in M]: { id: number; method: K; args: MethodArgs[K] };
}[M];

export type Response =
  | { id: number; ok: true; result: MethodResult[Method] }
  | { id: number; ok: false; error: string };
