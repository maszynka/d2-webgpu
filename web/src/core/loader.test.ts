// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from './loader';

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  sent: unknown[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: unknown): void {
    this.sent.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('CoreClient worker failure', () => {
  it('onerror terminates the worker: pending calls reject and later calls reject instead of hanging', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const started = CoreClient.start('http://localhost/');
    const w = FakeWorker.last!;
    // the init call is pending; the worker crashes
    w.onerror!({ message: 'boom' });
    const { client, status } = await started;
    expect(client).toBeNull();
    expect(status).toEqual({ mode: 'demo', reason: 'boom' });
    expect(w.terminated).toBe(true);
  });

  it('after a crash on a live client, new calls reject immediately', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const started = CoreClient.start('http://localhost/');
    const w = FakeWorker.last!;
    const id = (w.sent[0] as { id: number }).id;
    w.onmessage!({ data: { id, ok: true, result: { available: true } } } as MessageEvent);
    await new Promise((r) => setTimeout(r, 0));
    const v = (w.sent[1] as { id: number }).id;
    w.onmessage!({ data: { id: v, ok: true, result: { version: '1' } } } as MessageEvent);
    const { client } = await started;
    expect(client).not.toBeNull();
    const inflight = client!.mpqHas('x');
    w.onerror!({ message: 'crash' });
    await expect(inflight).rejects.toThrow('crash');
    expect(w.terminated).toBe(true);
    await expect(client!.mpqHas('y')).rejects.toThrow('terminated');
  });
});
