// SPDX-License-Identifier: GPL-3.0-or-later
// Main-thread Web Audio backend of the full game: a voice registry driven by the worker's batched
// commands (audio-bridge.ts). Voice = AudioBufferSourceNode -> GainNode -> StereoPannerNode -> master.
// The game's C++ side decides what plays and when it ends; this only mirrors it.
import type { AudioOp } from './audio-bridge';

// Minimal structural types so tests can pass a mock AudioContext.
export interface ParamLike {
  value: number;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
}
export interface NodeLike {
  connect(dest: unknown): unknown;
  disconnect(): void;
}
export interface BufferLike {
  readonly duration: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}
export interface SourceLike extends NodeLike {
  buffer: unknown;
  loop: boolean;
  onended: (() => void) | null;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}
export interface ContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly state: string;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, rate: number): BufferLike;
  createBufferSource(): SourceLike;
  createGain(): NodeLike & { gain: ParamLike };
  createStereoPanner(): NodeLike & { pan: ParamLike };
}

interface Voice {
  src: SourceLike;
  gain: NodeLike & { gain: ParamLike };
  pan: NodeLike & { pan: ParamLike };
}

const SMOOTH = 0.02; // seconds: gain / pan changes glide instead of clicking

/** Raw PCM (8-bit unsigned or 16-bit signed little endian, interleaved) -> an AudioBuffer. */
export function pcmToBuffer(ctx: ContextLike, data: ArrayBuffer, channels: number, rate: number, bits: number): BufferLike {
  const bytes = bits === 8 ? 1 : 2;
  const frames = Math.floor(data.byteLength / (bytes * channels));
  const buffer = ctx.createBuffer(channels, Math.max(1, frames), rate);
  const planes = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  if (bits === 8) {
    const src = new Uint8Array(data);
    for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) planes[c]![i] = ((src[i * channels + c] ?? 128) - 128) / 128;
  } else {
    const src = new DataView(data);
    for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) planes[c]![i] = src.getInt16((i * channels + c) * 2, true) / 32768;
  }
  return buffer;
}

export class AudioEngine {
  private readonly buffers = new Map<string, BufferLike>();
  private readonly voices = new Map<number, Voice>();
  private readonly master: NodeLike & { gain: ParamLike };
  private listener = 1;
  private user = 1;
  readonly stats = { messages: 0, ops: 0, plays: 0, buffers: 0, missing: 0, errors: 0 };

  constructor(private readonly ctx: ContextLike) {
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
  }

  /** Browsers start contexts suspended until a user gesture: call from one (and again on later gestures). */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined);
  }

  /** The UI's volume (0..1), on top of the game's own master volume. */
  setVolume(v: number): void {
    this.user = Math.max(0, Math.min(1, v));
    this.applyMaster();
  }

  get activeVoices(): number {
    return this.voices.size;
  }

  private applyMaster(): void {
    this.master.gain.setTargetAtTime(this.listener * this.user, this.ctx.currentTime, SMOOTH);
  }

  handle(ops: readonly AudioOp[]): void {
    this.stats.messages++;
    for (const op of ops) {
      this.stats.ops++;
      try {
        this.apply(op);
      } catch {
        this.stats.errors++; // one bad command (a refused node, a detached context) must not drop the rest of the batch
      }
    }
  }

  private apply(op: AudioOp): void {
    switch (op.o) {
      case 'buf':
        this.buffers.set(op.k, pcmToBuffer(this.ctx, op.data, op.ch, op.rate, op.bits));
        this.stats.buffers++;
        break;
      case 'free':
        this.buffers.delete(op.k);
        break;
      case 'play':
        this.play(op);
        break;
      case 'set': {
        const v = this.voices.get(op.v);
        if (!v) break;
        const t = this.ctx.currentTime;
        v.gain.gain.setTargetAtTime(op.g, t, SMOOTH);
        v.pan.pan.setTargetAtTime(op.p, t, SMOOTH);
        break;
      }
      case 'stop':
        this.stopVoice(op.v);
        break;
      case 'master':
        this.listener = op.g;
        this.applyMaster();
        break;
    }
  }

  private play(op: Extract<AudioOp, { o: 'play' }>): void {
    this.stopVoice(op.v);
    const buffer = this.buffers.get(op.k);
    if (!buffer) {
      this.stats.missing++;
      return;
    }
    const offset = Math.max(0, op.off) / buffer.sampleRate; // a negative offset would make start() throw
    if (!op.loop && offset >= buffer.duration) return;
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    const pan = this.ctx.createStereoPanner();
    src.buffer = buffer;
    src.loop = op.loop;
    gain.gain.value = op.g;
    pan.pan.value = op.p;
    src.connect(gain);
    gain.connect(pan);
    pan.connect(this.master);
    const voice: Voice = { src, gain, pan };
    this.voices.set(op.v, voice);
    src.onended = () => {
      if (this.voices.get(op.v) === voice) this.voices.delete(op.v);
      src.disconnect();
      gain.disconnect();
      pan.disconnect();
    };
    try {
      src.start(0, op.loop ? offset % buffer.duration : offset);
    } catch (e) {
      this.stopVoice(op.v);
      throw e;
    }
    this.stats.plays++;
  }

  private stopVoice(id: number): void {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    v.src.onended = null;
    try {
      v.src.stop();
    } catch {
      /* already stopped */
    }
    v.src.disconnect();
    v.gain.disconnect();
    v.pan.disconnect();
  }

  /** Silence everything and drop the registry (game stopped). */
  dispose(): void {
    for (const id of [...this.voices.keys()]) this.stopVoice(id);
    this.buffers.clear();
  }
}
