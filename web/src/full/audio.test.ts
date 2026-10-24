// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AudioBridge, type AudioMessage } from './audio-bridge';
import { AudioEngine, pcmToBuffer, type ContextLike } from './audio';

class Param {
  value = 1;
  targets: number[] = [];
  setTargetAtTime(t: number): void {
    this.targets.push(t);
  }
}
class MockSource {
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  started: { when: number; offset: number } | null = null;
  stopped = false;
  connected: unknown[] = [];
  connect(d: unknown): unknown {
    this.connected.push(d);
    return d;
  }
  disconnect(): void {
    this.connected = [];
  }
  start(when = 0, offset = 0): void {
    this.started = { when, offset };
  }
  stop(): void {
    this.stopped = true;
  }
}
class MockNode {
  gain = new Param();
  pan = new Param();
  connect(d: unknown): unknown {
    return d;
  }
  disconnect(): void {}
}
function mockContext() {
  const sources: MockSource[] = [];
  const nodes: MockNode[] = [];
  const ctx = {
    currentTime: 1,
    destination: { dest: true },
    state: 'suspended',
    resumed: 0,
    resume() {
      this.resumed++;
      this.state = 'running';
      return Promise.resolve();
    },
    createBuffer(channels: number, length: number, rate: number) {
      const planes = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / rate, sampleRate: rate, getChannelData: (c: number) => planes[c]! };
    },
    createBufferSource() {
      const s = new MockSource();
      sources.push(s);
      return s;
    },
    createGain() {
      const n = new MockNode();
      nodes.push(n);
      return n;
    },
    createStereoPanner() {
      const n = new MockNode();
      nodes.push(n);
      return n;
    },
  };
  return { ctx: ctx as unknown as ContextLike & { resumed: number }, sources, nodes };
}
const pcm16 = (...v: number[]) => new Int16Array(v).buffer;

describe('AudioBridge (worker side)', () => {
  function bridge() {
    const posted: { m: AudioMessage; transfer: Transferable[] }[] = [];
    const b = new AudioBridge((m, transfer) => posted.push({ m, transfer }));
    return { b, posted };
  }

  it('posts nothing when idle and one batch per flush', () => {
    const { b, posted } = bridge();
    b.flush();
    expect(posted).toHaveLength(0);
    b.play(1, 5, 6, 1, 0, false, 0);
    b.stop(1);
    b.flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.m.ops.map((o) => o.o)).toEqual(['play', 'stop']);
  });

  it('coalesces gain/pan updates per voice and keeps order around play/stop', () => {
    const { b, posted } = bridge();
    b.play(1, 1, 1, 1, 0, true, 0);
    b.set(1, 0.9, 0.1);
    b.set(1, 0.5, -0.5);
    b.set(2, 0.3, 0);
    b.stop(1);
    b.set(1, 0.2, 0); // after the stop: a new op
    b.flush();
    expect(posted[0]!.m.ops).toEqual([
      { o: 'play', v: 1, k: '1:1', g: 1, p: 0, loop: true, off: 0 },
      { o: 'set', v: 1, g: 0.5, p: -0.5 },
      { o: 'set', v: 2, g: 0.3, p: 0 },
      { o: 'stop', v: 1 },
      { o: 'set', v: 1, g: 0.2, p: 0 },
    ]);
  });

  it('transfers PCM buffers instead of copying them and coalesces master gain', () => {
    const { b, posted } = bridge();
    const data = new Uint8Array([1, 2, 3, 4]);
    b.buf(7, 8, 1, 22050, 16, data);
    b.master(0.5);
    b.master(0.25);
    b.flush();
    const op = posted[0]!.m.ops[0]!;
    expect(op).toMatchObject({ o: 'buf', k: '7:8', ch: 1, rate: 22050, bits: 16 });
    expect(posted[0]!.transfer).toHaveLength(1);
    expect(posted[0]!.m.ops[1]).toEqual({ o: 'master', g: 0.25 });
    expect(b.total).toBe(2);
  });
});

describe('pcmToBuffer', () => {
  it('converts 16-bit and 8-bit PCM to float planes', () => {
    const { ctx } = mockContext();
    const b16 = pcmToBuffer(ctx, pcm16(16384, -32768, 0, 32767), 2, 8000, 16);
    expect([...b16.getChannelData(0)]).toEqual([0.5, 0]);
    expect(b16.getChannelData(1)[0]).toBe(-1);
    const b8 = pcmToBuffer(ctx, new Uint8Array([128, 255, 0]).buffer, 1, 8000, 8);
    expect([...b8.getChannelData(0)]).toEqual([0, 127 / 128, -1]);
  });
});

describe('AudioEngine (main thread voice registry)', () => {
  function engine() {
    const m = mockContext();
    const e = new AudioEngine(m.ctx);
    e.handle([{ o: 'buf', k: 'a', ch: 1, rate: 100, bits: 16, data: pcm16(...new Array(100).fill(1000)) }]);
    return { ...m, e };
  }

  it('plays a cached buffer with gain, pan and an offset in sample frames', () => {
    const { e, sources } = engine();
    e.handle([{ o: 'play', v: 1, k: 'a', g: 0.7, p: -0.3, loop: false, off: 25 }]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.started).toEqual({ when: 0, offset: 0.25 });
    expect(e.activeVoices).toBe(1);
    expect(e.stats.plays).toBe(1);
  });

  it('wraps the offset of looping voices and drops a finished one-shot offset', () => {
    const { e, sources } = engine();
    e.handle([{ o: 'play', v: 1, k: 'a', g: 1, p: 0, loop: true, off: 250 }]);
    expect(sources[0]!.loop).toBe(true);
    expect(sources[0]!.started!.offset).toBeCloseTo(0.5);
    e.handle([{ o: 'play', v: 2, k: 'a', g: 1, p: 0, loop: false, off: 500 }]);
    expect(sources).toHaveLength(1); // past the end: nothing started
  });

  it('smooths gain/pan changes with setTargetAtTime and ignores unknown voices', () => {
    const { e, nodes } = engine();
    e.handle([{ o: 'play', v: 1, k: 'a', g: 1, p: 0, loop: false, off: 0 }, { o: 'set', v: 1, g: 0.4, p: 0.8 }, { o: 'set', v: 99, g: 0, p: 0 }]);
    const gain = nodes.find((n) => n.gain.targets.includes(0.4));
    const pan = nodes.find((n) => n.pan.targets.includes(0.8));
    expect(gain).toBeDefined();
    expect(pan).toBeDefined();
  });

  it('restarting a voice id stops the old node; stop removes it; onended clears the registry', () => {
    const { e, sources } = engine();
    e.handle([{ o: 'play', v: 1, k: 'a', g: 1, p: 0, loop: false, off: 0 }]);
    e.handle([{ o: 'play', v: 1, k: 'a', g: 1, p: 0, loop: false, off: 0 }]);
    expect(sources[0]!.stopped).toBe(true);
    expect(e.activeVoices).toBe(1);
    sources[1]!.onended?.();
    expect(e.activeVoices).toBe(0);
    e.handle([{ o: 'play', v: 2, k: 'a', g: 1, p: 0, loop: true, off: 0 }, { o: 'stop', v: 2 }]);
    expect(sources[2]!.stopped).toBe(true);
    expect(e.activeVoices).toBe(0);
  });

  it('counts a play for a buffer that is not there and frees one-shot buffers', () => {
    const { e, sources } = engine();
    e.handle([{ o: 'play', v: 1, k: 'nope', g: 1, p: 0, loop: false, off: 0 }]);
    expect(e.stats.missing).toBe(1);
    e.handle([{ o: 'buf', k: '-1:3', ch: 1, rate: 100, bits: 8, data: new Uint8Array(10).buffer }, { o: 'free', k: '-1:3' }, { o: 'play', v: 2, k: '-1:3', g: 1, p: 0, loop: false, off: 0 }]);
    expect(e.stats.missing).toBe(2);
    expect(sources).toHaveLength(0);
  });

  it('master volume is listener gain times the UI volume; resume only when suspended', async () => {
    const { e, ctx, nodes } = engine();
    e.handle([{ o: 'master', g: 0.5 }]);
    e.setVolume(0.5);
    const master = nodes[0]!;
    expect(master.gain.targets.at(-1)).toBeCloseTo(0.25);
    await e.resume();
    await e.resume();
    expect(ctx.resumed).toBe(1);
  });

  it('bridge -> engine round trip', () => {
    const m = mockContext();
    const e = new AudioEngine(m.ctx);
    const b = new AudioBridge((msg) => e.handle(msg.ops));
    b.buf(1, 2, 1, 100, 16, new Uint8Array(pcm16(1, 2, 3, 4)));
    b.play(5, 1, 2, 1, 0, false, 0);
    b.flush();
    expect(e.activeVoices).toBe(1);
    expect(e.stats.messages).toBe(1);
  });
});
