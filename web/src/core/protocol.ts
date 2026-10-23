// SPDX-License-Identifier: GPL-3.0-or-later
// Typed message protocol between the main thread and the d2core worker.
// Binary results are ABI blocks (docs/abi.md): a fresh ArrayBuffer copy, transferred.

export interface MethodArgs {
  init: { baseUrl: string };
  version: Record<string, never>;
  /** Mount File objects at /d2 (WORKERFS) and mpq_open the named ones in the given order. */
  mountMpqs: { files: File[]; order: string[] };
  mpqHas: { name: string };
  /** D2RW result block (decodeRaw). */
  mpqRead: { name: string };
  decodePalette: { data: ArrayBuffer };
  decodeColormap: { data: ArrayBuffer };
  decodeDc6: { data: ArrayBuffer };
  decodeDt1: { data: ArrayBuffer };
  decodeDs1: { data: ArrayBuffer };
  /** mpq_read + decode in one hop, by MPQ path. */
  loadPalette: { name: string };
  loadDc6: { name: string };
  loadDt1: { name: string };
  loadDs1: { name: string };
}

export type Method = keyof MethodArgs;

export interface MethodResult {
  init: { available: boolean; reason?: string };
  version: { version: string };
  mountMpqs: { opened: number; names: string[] };
  mpqHas: boolean;
  mpqRead: ArrayBuffer;
  decodePalette: ArrayBuffer;
  decodeColormap: ArrayBuffer;
  decodeDc6: ArrayBuffer;
  decodeDt1: ArrayBuffer;
  decodeDs1: ArrayBuffer;
  loadPalette: ArrayBuffer;
  loadDc6: ArrayBuffer;
  loadDt1: ArrayBuffer;
  loadDs1: ArrayBuffer;
}

export type Request<M extends Method = Method> = {
  [K in M]: { id: number; method: K; args: MethodArgs[K] };
}[M];

export type Response =
  | { id: number; ok: true; result: MethodResult[Method] }
  | { id: number; ok: false; error: string };
