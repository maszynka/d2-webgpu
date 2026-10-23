// SPDX-License-Identifier: GPL-3.0-or-later
// Main-thread client for the d2core worker. Degrades to "demo mode" when d2core.js is absent.

import type { Method, MethodArgs, MethodResult, Request, Response } from './protocol';

export type CoreStatus =
  | { mode: 'wasm'; version: string }
  | { mode: 'demo'; reason: string };

interface Pending {
  resolve: (v: MethodResult[Method]) => void;
  reject: (e: Error) => void;
}

export class CoreClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  /** Spawn the worker and try to load the wasm module. Never throws. */
  static async start(baseUrl: string = document.baseURI): Promise<{ client: CoreClient | null; status: CoreStatus }> {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      return { client: null, status: { mode: 'demo', reason: `worker failed: ${String(e)}` } };
    }
    const client = new CoreClient();
    client.worker = worker;
    worker.onmessage = (e: MessageEvent<Response>) => client.onMessage(e.data);
    worker.onerror = (e) => client.failAll(new Error(e.message || 'worker error'));
    try {
      const init = await client.call('init', { baseUrl });
      if (!init.available) {
        client.terminate();
        return { client: null, status: { mode: 'demo', reason: init.reason ?? 'wasm unavailable' } };
      }
      let version = 'unknown';
      try {
        version = (await client.call('version', {})).version;
      } catch {
        /* version export optional */
      }
      return { client, status: { mode: 'wasm', version } };
    } catch (e) {
      client.terminate();
      return { client: null, status: { mode: 'demo', reason: e instanceof Error ? e.message : String(e) } };
    }
  }

  call<M extends Method>(method: M, args: MethodArgs[M], transfer: Transferable[] = []): Promise<MethodResult[M]> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('core worker terminated'));
    const id = this.nextId++;
    return new Promise<MethodResult[M]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject });
      worker.postMessage({ id, method, args } as Request, transfer);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new Error('core worker terminated'));
  }

  private onMessage(res: Response): void {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
