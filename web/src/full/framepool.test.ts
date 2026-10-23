// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FrameMailbox, FramePool, type FrameMessage } from './framepool';

function setup() {
  const posted: FrameMessage[] = [];
  const pool = new FramePool((m) => posted.push(m));
  const heap = new Uint8Array(64);
  return { posted, pool, heap };
}

describe('FramePool', () => {
  it('copies pixels out of the heap into its own buffer', () => {
    const { posted, pool, heap } = setup();
    heap.set([1, 2, 3, 4, 5, 6, 7, 8], 16);
    expect(pool.submit(heap, 16, 2, 1)).toBe(true);
    const f = posted[0]!;
    expect(f.buf).not.toBe(heap.buffer);
    expect([...new Uint8Array(f.buf)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    heap[16] = 99; // later heap writes do not reach the posted copy
    expect(new Uint8Array(f.buf)[0]).toBe(1);
  });

  it('allows two frames in flight, then drops until one comes back', () => {
    const { posted, pool, heap } = setup();
    expect(pool.submit(heap, 0, 2, 2)).toBe(true);
    expect(pool.submit(heap, 0, 2, 2)).toBe(true);
    expect(pool.submit(heap, 0, 2, 2)).toBe(false);
    pool.recycle(posted[0]!.buf);
    expect(pool.submit(heap, 0, 2, 2)).toBe(true);
    expect(posted).toHaveLength(3);
    expect(posted[2]!.buf).toBe(posted[0]!.buf); // the same buffer ping-pongs
  });

  it('gates the worker on the mailbox: no request, no frame', () => {
    const { posted, pool, heap } = setup();
    expect(pool.wanted).toBe(true);
    pool.submit(heap, 0, 1, 1);
    pool.submit(heap, 0, 1, 1);
    expect(pool.wanted).toBe(false); // page has not consumed anything: a hidden tab pauses the game
    pool.recycle(posted[0]!.buf);
    expect(pool.wanted).toBe(true);
    pool.recycle(posted[1]!.buf);
    pool.recycle(null);
    expect(pool.want).toBe(2); // capped
  });

  it('reallocates when the frame size changes (widescreen)', () => {
    const { posted, pool, heap } = setup();
    pool.submit(heap, 0, 2, 2);
    pool.recycle(posted[0]!.buf);
    expect(pool.submit(heap, 0, 4, 2)).toBe(true);
    expect(posted[1]!.buf.byteLength).toBe(32);
  });
});

describe('FrameMailbox', () => {
  it('shows only the newest frame and hands superseded buffers back', () => {
    const back: (ArrayBuffer | null)[] = [];
    const box = new FrameMailbox((b) => back.push(b));
    const a = new ArrayBuffer(4);
    const b = new ArrayBuffer(4);
    box.receive({ t: 'frame', w: 1, h: 1, buf: a, heap: 0 });
    box.receive({ t: 'frame', w: 1, h: 1, buf: b, heap: 0 });
    expect(back).toEqual([a]);
    const shown: number[] = [];
    expect(box.flush((w) => shown.push(w))).toBe(true);
    expect(back).toEqual([a, b]);
    expect(box.flush((w) => shown.push(w))).toBe(false);
    expect(shown).toEqual([1]);
    expect(box.dropped).toBe(1);
  });
});
