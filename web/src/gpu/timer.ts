// SPDX-License-Identifier: GPL-3.0-or-later
// GPU pass timing with timestamp queries (optional device feature 'timestamp-query'). Adapted from the Timer in
// fsr4-web-bench/src/pipeline.ts. Up to `spans` render passes per frame (begin/end each); results arrive asynchronously.

/** What the timed spans of one frame were: per side, a label ("EASU+RCAS") and the span indices that make it up. */
export interface GpuTag {
  /** same key = same layout (averages carry over) */
  key: string;
  sides: { side: number; label: string; spans: number[] }[];
}

export class GpuTimer {
  private readonly qs: GPUQuerySet;
  private readonly resolve: GPUBuffer;
  private readonly readback: GPUBuffer[] = [];
  private busy = false;
  private used = 0;
  /** newest completed result: the tag of that frame and the smoothed ms per span (null until the first result) */
  result: { tag: GpuTag; ms: number[] } | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly spans = 6,
  ) {
    this.qs = device.createQuerySet({ type: 'timestamp', count: spans * 2 });
    this.resolve = device.createBuffer({ size: spans * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  }

  /** Start a frame: false while the previous result is still being read back (nothing is timed this frame). */
  begin(): boolean {
    this.used = 0;
    return !this.busy;
  }

  /** timestampWrites for the next timed pass of this frame (call only when begin() returned true). */
  writes(): GPURenderPassTimestampWrites {
    // past capacity the last span is reused, so finish() never resolves more queries than exist
    const i = this.used < this.spans ? this.used++ : this.spans - 1;
    return { querySet: this.qs, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }

  /** After the timed passes were encoded: resolve and read back. Call before queue.submit with the same encoder. */
  finish(enc: GPUCommandEncoder, tag: GpuTag): void {
    const n = this.used;
    if (n === 0 || this.busy) return;
    const rb = this.readback.pop() ?? this.device.createBuffer({ size: this.spans * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.resolveQuerySet(this.qs, 0, n * 2, this.resolve, 0);
    enc.copyBufferToBuffer(this.resolve, 0, rb, 0, n * 16);
    this.busy = true;
    // runs after the caller's synchronous submit()
    queueMicrotask(() => {
      rb.mapAsync(GPUMapMode.READ, 0, n * 16).then(
        () => {
          const t = new BigInt64Array(rb.getMappedRange(0, n * 16).slice(0));
          rb.unmap();
          this.readback.push(rb);
          const now: number[] = [];
          for (let i = 0; i < n; i++) now.push(Number(t[i * 2 + 1]! - t[i * 2]!) / 1e6);
          if (now.every((v) => v >= 0 && v < 1000)) {
            const prev = this.result;
            const same = prev !== null && prev.tag.key === tag.key && prev.ms.length === n;
            this.result = { tag, ms: now.map((v, i) => (same ? prev.ms[i]! * 0.9 + v * 0.1 : v)) };
          }
          this.busy = false;
        },
        () => {
          this.busy = false;
        },
      );
    });
  }
}
