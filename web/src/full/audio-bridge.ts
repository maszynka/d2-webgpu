// SPDX-License-Identifier: GPL-3.0-or-later
// Worker side of the game's audio: wasm/full/d2web_audio.cpp (virtual OpenAL) calls these through
// globalThis.__d2web.audio. Commands are collected and posted to the main thread once per game
// frame (flush), where AudioEngine plays them. "set" commands (gain/pan) coalesce per voice.

/** One audio command. Buffers are keyed `a:b` (content hash + size, or -1:<AL buffer id> for one-shot music). */
export type AudioOp =
  | { o: 'buf'; k: string; ch: number; rate: number; bits: number; data: ArrayBuffer }
  | { o: 'free'; k: string }
  | { o: 'play'; v: number; k: string; g: number; p: number; loop: boolean; off: number }
  | { o: 'set'; v: number; g: number; p: number }
  | { o: 'stop'; v: number }
  | { o: 'master'; g: number };

export type AudioMessage = { t: 'audio'; ops: AudioOp[] };

export class AudioBridge {
  private ops: AudioOp[] = [];
  private transfers: ArrayBuffer[] = [];
  private pendingSet = new Map<number, Extract<AudioOp, { o: 'set' }>>();
  private pendingMaster: Extract<AudioOp, { o: 'master' }> | null = null;
  /** commands queued since the start (for tests / diagnostics) */
  total = 0;

  constructor(private readonly post: (m: AudioMessage, transfer: Transferable[]) => void) {}

  private push(op: AudioOp): void {
    this.ops.push(op);
    this.total++;
  }

  buf(a: number, b: number, ch: number, rate: number, bits: number, data: Uint8Array): void {
    const buffer = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? (data.buffer as ArrayBuffer) : (data.slice().buffer as ArrayBuffer);
    this.push({ o: 'buf', k: `${a}:${b}`, ch, rate, bits, data: buffer });
    this.transfers.push(buffer);
  }
  free(a: number, b: number): void {
    this.push({ o: 'free', k: `${a}:${b}` });
  }
  play(v: number, a: number, b: number, g: number, p: number, loop: boolean, off: number): void {
    this.pendingSet.delete(v);
    this.push({ o: 'play', v, k: `${a}:${b}`, g, p, loop, off });
  }
  set(v: number, g: number, p: number): void {
    const pending = this.pendingSet.get(v);
    if (pending) {
      pending.g = g;
      pending.p = p;
      return;
    }
    const op: Extract<AudioOp, { o: 'set' }> = { o: 'set', v, g, p };
    this.pendingSet.set(v, op);
    this.push(op);
  }
  stop(v: number): void {
    this.pendingSet.delete(v);
    this.push({ o: 'stop', v });
  }
  master(g: number): void {
    if (this.pendingMaster) {
      this.pendingMaster.g = g;
      return;
    }
    this.pendingMaster = { o: 'master', g };
    this.push(this.pendingMaster);
  }

  /** Post everything queued (one message per frame, nothing when idle). */
  flush(): void {
    if (this.ops.length === 0) return;
    const ops = this.ops;
    const transfers = this.transfers;
    this.ops = [];
    this.transfers = [];
    this.pendingSet.clear();
    this.pendingMaster = null;
    this.post({ t: 'audio', ops }, transfers);
  }
}
