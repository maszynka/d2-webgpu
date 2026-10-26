// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FrameMailbox, FramePool, type FrameMessage } from './framepool';
import { TRAILER_BYTES, TRAILER_HEADER, UI_MAGIC, UI_MAX_RECTS, decodeTrailer, encodeTrailer } from './uitrailer';

describe('UI trailer codec', () => {
  it('round-trips a screen id and rects', () => {
    const info = { screen: 1 as const, rects: [{ x: 0, y: 540, w: 800, h: 60 }, { x: 300, y: 12, w: 65535, h: 1 }] };
    const bytes = encodeTrailer(info);
    expect(bytes.byteLength).toBe(TRAILER_HEADER + 16);
    expect(decodeTrailer(bytes.buffer as ArrayBuffer, 0)).toEqual(info);
  });

  it('decodes at an offset behind pixels, and a menu has no rects', () => {
    const buf = new Uint8Array(40 + TRAILER_BYTES);
    buf.set(encodeTrailer({ screen: 0, rects: [] }), 40);
    expect(decodeTrailer(buf.buffer, 40)).toEqual({ screen: 0, rects: [] });
  });

  it('is little endian with the "2DI1" magic (what d2web.cpp writes)', () => {
    const b = encodeTrailer({ screen: 2, rects: [{ x: 0x0102, y: 3, w: 4, h: 5 }] });
    expect([...b.subarray(0, 8)]).toEqual([0x32, 0x44, 0x49, 0x31, 2, 0, 1, 0]);
    expect([...b.subarray(8, 10)]).toEqual([0x02, 0x01]);
    expect(UI_MAGIC).toBe(0x31494432);
  });

  it('returns null for no magic, a bad screen id, or a truncated buffer', () => {
    expect(decodeTrailer(new ArrayBuffer(100), 0)).toBeNull();
    const bad = encodeTrailer({ screen: 1, rects: [] });
    bad[4] = 9;
    expect(decodeTrailer(bad.buffer as ArrayBuffer, 0)).toBeNull();
    const t = encodeTrailer({ screen: 1, rects: [{ x: 1, y: 1, w: 1, h: 1 }, { x: 2, y: 2, w: 2, h: 2 }] });
    expect(decodeTrailer(t.slice(0, t.length - 4).buffer as ArrayBuffer, 0)).toBeNull();
    expect(decodeTrailer(new ArrayBuffer(4), 0)).toBeNull();
    expect(decodeTrailer(new ArrayBuffer(100), 200)).toBeNull();
  });

  it('caps the count at 64', () => {
    const rects = Array.from({ length: 80 }, (_, i) => ({ x: i, y: 0, w: 1, h: 1 }));
    expect(decodeTrailer(encodeTrailer({ screen: 1, rects }).buffer as ArrayBuffer, 0)!.rects).toHaveLength(UI_MAX_RECTS);
  });
});

describe('the trailer travels in the pooled frame buffer', () => {
  it('FramePool copies pixels and the trailer into one buffer; the mailbox hands both to present', () => {
    const posted: FrameMessage[] = [];
    const pool = new FramePool((m) => posted.push(m));
    const heap = new Uint8Array(4096);
    heap.set([1, 2, 3, 4, 5, 6, 7, 8], 16); // 2x1 pixels
    const tr = encodeTrailer({ screen: 1, rects: [{ x: 1, y: 0, w: 1, h: 1 }] });
    heap.set(tr, 1024);
    expect(pool.submit(heap, 16, 2, 1, 1024, tr.length)).toBe(true);
    const f = posted[0]!;
    expect(f.buf.byteLength).toBe(8 + TRAILER_BYTES);
    const recycled: (ArrayBuffer | null)[] = [];
    const box = new FrameMailbox((b) => recycled.push(b));
    box.receive(f);
    let seen: { px: number[]; ui: unknown } | null = null;
    box.flush((w, h, rgba, ui) => (seen = { px: [...rgba], ui }));
    expect(seen).toEqual({ px: [1, 2, 3, 4, 5, 6, 7, 8], ui: { screen: 1, rects: [{ x: 1, y: 0, w: 1, h: 1 }] } });
  });

  it('a frame without a trailer (demo / smoke) decodes to null; a stale trailer is overwritten on reuse', () => {
    const posted: FrameMessage[] = [];
    const pool = new FramePool((m) => posted.push(m));
    const heap = new Uint8Array(4096);
    const box = new FrameMailbox(() => undefined);
    pool.submit(heap, 0, 1, 1);
    box.receive(posted[0]!);
    let ui: unknown = 'unset';
    box.flush((_w, _h, _p, u) => (ui = u));
    expect(ui).toBeNull();

    const a = encodeTrailer({ screen: 1, rects: [{ x: 9, y: 9, w: 9, h: 9 }] });
    const b = encodeTrailer({ screen: 0, rects: [] });
    heap.set(a, 100);
    heap.set(b, 200);
    pool.submit(heap, 0, 1, 1, 100, a.length);
    const first = posted[1]!;
    pool.recycle(first.buf);
    pool.submit(heap, 0, 1, 1, 200, b.length); // same ArrayBuffer again
    box.receive(posted[2]!);
    box.flush((_w, _h, _p, u) => (ui = u));
    expect(ui).toEqual({ screen: 0, rects: [] });
  });
});
