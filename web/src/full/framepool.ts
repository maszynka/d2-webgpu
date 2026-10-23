// SPDX-License-Identifier: GPL-3.0-or-later
// Frame hand-off between the game worker and the main thread (docs/full-game-status.md).
// Two standalone ArrayBuffers ping-pong: the worker copies a frame out of the wasm heap into the free
// one and transfers it; the main thread uploads it and transfers it back. The heap's own buffer is never
// transferred. A mailbox counter ("frame wanted") gates the worker: it only runs a frame while the page
// has asked for one, so a hidden tab (no requestAnimationFrame, no recycled buffers) pauses the game.

export interface FrameMessage {
  t: 'frame';
  w: number;
  h: number;
  buf: ArrayBuffer;
  /** wasm heap size in bytes when the frame was produced (diagnostics) */
  heap: number;
}

export type Post = (msg: FrameMessage, transfer: Transferable[]) => void;

export class FramePool {
  private free: ArrayBuffer[] = [];
  private allocated = 0;
  /** frames the page still wants; the worker runs a frame only while this is > 0 */
  want: number;

  constructor(
    private readonly post: Post,
    private readonly max = 2,
    initialWant = 2,
  ) {
    this.want = initialWant;
  }

  /** Whether the worker should run (and present) a frame now. */
  get wanted(): boolean {
    return this.want > 0;
  }

  /** Copy w*h RGBA pixels at `ptr` of `heap` into a pooled buffer and post it. False when both are in flight. */
  submit(heap: Uint8Array, ptr: number, w: number, h: number): boolean {
    if (this.want > 0) this.want--;
    const n = w * h * 4;
    let buf = this.free.pop();
    if (buf && buf.byteLength !== n) {
      this.allocated--; // resolution changed (widescreen): drop the stale buffer
      buf = undefined;
    }
    if (!buf) {
      if (this.allocated >= this.max) return false;
      this.allocated++;
      buf = new ArrayBuffer(n);
    }
    new Uint8Array(buf).set(heap.subarray(ptr, ptr + n));
    this.post({ t: 'frame', w, h, buf, heap: heap.length }, [buf]);
    return true;
  }

  /** The main thread is done with `buf` and wants the next frame. */
  recycle(buf: ArrayBuffer | null): void {
    if (buf) this.free.push(buf);
    this.want = Math.min(this.want + 1, this.max);
  }
}

/** Main-thread side: keeps only the newest frame, uploads it on the next animation frame, then recycles. */
export class FrameMailbox {
  private latest: FrameMessage | null = null;
  dropped = 0;

  constructor(private readonly recycle: (buf: ArrayBuffer | null) => void) {}

  /** A frame arrived: an older one still waiting is superseded (its buffer goes straight back). */
  receive(msg: FrameMessage): void {
    if (this.latest) {
      this.dropped++;
      this.recycle(this.latest.buf);
    }
    this.latest = msg;
  }

  /** Called once per animation frame; `present` uploads the pixels. Returns whether something was shown. */
  flush(present: (w: number, h: number, rgba: Uint8Array) => void): boolean {
    const f = this.latest;
    if (!f) return false;
    this.latest = null;
    present(f.w, f.h, new Uint8Array(f.buf));
    this.recycle(f.buf);
    return true;
  }
}
