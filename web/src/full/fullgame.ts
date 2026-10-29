// SPDX-License-Identifier: GPL-3.0-or-later
// Main-thread side of the full game: owns the game worker, shows its frames through our WebGPU blit
// (Renderer.presentRgba) and forwards DOM mouse/keyboard/wheel events as game input.

import type { Renderer } from '../gpu/renderer';
import { AudioEngine, type ContextLike } from './audio';
import { FrameMailbox, type FrameMessage } from './framepool';
import { EV, modFlags, scancodeOf, sdlButton, shouldPreventDefault, textOf, toFramePixels, wheelRecordValue, type InputRecord } from './input';
import type { FromWorker, ToWorker } from './protocol';
import { VIEW_DEBOUNCE_MS, VIEW_STEP, viewWidthFor } from './viewsize';

export interface FullGameHooks {
  onStatus(text: string, error?: boolean): void;
  onLog?(line: string): void;
  onExit?(code: number): void;
  /** the worker crashed or reported an error: the game is stopped for good (the page offers Restart) */
  onFail?(message: string): void;
}

export interface FullGameStats {
  frames: number;
  shown: number;
  dropped: number;
  heapMiB: number;
  width: number;
  height: number;
  /** in-game view width asked of the game from the display's aspect (the frame width follows on in-game screens; menus stay 800) */
  viewWidth: number;
  status: string;
  exited: number | null;
  logs: string[];
  /** audio batches received from the game / commands in them / voices playing now / state of the AudioContext */
  audioMessages: number;
  audioOps: number;
  audioVoices: number;
  audioState: string;
  /** IndexedDB writes completed by the worker */
  synced: number;
}

export interface PerfSample {
  /** frames the game produced in the window */
  frames: number;
  seconds: number;
  fps: number;
  /** gaps between received frames, ms */
  p95Gap: number;
  maxGap: number;
  /** gaps over 100 ms (level builds, hitches) */
  hitches: number;
  heapMiB: number;
}

export class FullGame {
  readonly stats: FullGameStats = { frames: 0, shown: 0, dropped: 0, heapMiB: 0, width: 800, height: 600, viewWidth: 800, status: 'starting', exited: null, logs: [], audioMessages: 0, audioOps: 0, audioVoices: 0, audioState: 'none', synced: 0 };
  private worker: Worker | null;
  private readonly mailbox: FrameMailbox;
  private pendingInput: InputRecord[] = [];
  private motion: { x: number; y: number } | null = null;
  /** SDL button a finger or pen press sends: 1 left, 3 right (the touch controls' RMB toggle) */
  touchButton = 1;
  /** modifier flags held by the touch toggles, added to every physical key record */
  touchMods = 0;
  /** told when the game released every key (the touch toggles follow) */
  onBlur: (() => void) | null = null;
  private readonly cleanup: (() => void)[] = [];
  private audio: AudioEngine | null = null;
  private ctlSeq = 0;
  private readonly ctlWaiting = new Map<number, (text: string) => void>();
  private frameTimes: number[] = [];
  private readonly flushedResolvers: (() => void)[] = [];
  private readonly flushWaiting = new Map<number, () => void>();
  private flushId = 0;

  constructor(
    private readonly renderer: Renderer,
    private readonly canvas: HTMLCanvasElement,
    files: File[],
    private readonly hooks: FullGameHooks,
    baseUrl: string = new URL(import.meta.env.BASE_URL, document.baseURI).href,
    args: string[] = [],
  ) {
    this.worker = new Worker(new URL('./game.worker.ts', import.meta.url), { type: 'module' });
    this.mailbox = new FrameMailbox((buf, want) => this.send({ t: 'recycle', buf, want }, buf ? [buf] : []));
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.fail(e.message || 'game worker crashed');
    this.setupAudio();
    this.stats.viewWidth = this.displayViewWidth();
    this.send({ t: 'start', files, baseUrl, args, viewWidth: this.stats.viewWidth });
    this.attachInput();
    this.watchSize();
  }

  private displayViewWidth(): number {
    return viewWidthFor(this.canvas.clientWidth, this.canvas.clientHeight);
  }

  private viewTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Re-derive the game's view width from the canvas's current shape and tell the game when it changed. Resizes are
   * debounced and ignore changes under VIEW_STEP px; `immediate` (fullscreen enter / exit) applies at once.
   */
  updateView(immediate = false): void {
    if (this.viewTimer) clearTimeout(this.viewTimer);
    this.viewTimer = null;
    const apply = (): void => {
      this.viewTimer = null;
      const w = this.displayViewWidth();
      if (w === this.stats.viewWidth) return;
      if (!immediate && Math.abs(w - this.stats.viewWidth) < VIEW_STEP && w !== 800 && w !== 1400) return;
      this.stats.viewWidth = w;
      this.send({ t: 'view', width: w });
    };
    if (immediate) apply();
    else this.viewTimer = setTimeout(apply, VIEW_DEBOUNCE_MS);
  }

  /** Window resize, fullscreen enter/exit, layout changes: all change the canvas box. */
  private watchSize(): void {
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.updateView());
      ro.observe(this.canvas);
      this.cleanup.push(() => ro.disconnect());
    }
    const on = () => this.updateView();
    window.addEventListener('resize', on);
    const fs = () => this.updateView(true);
    document.addEventListener('fullscreenchange', fs);
    this.cleanup.push(() => {
      window.removeEventListener('resize', on);
      document.removeEventListener('fullscreenchange', fs);
      if (this.viewTimer) clearTimeout(this.viewTimer);
    });
  }

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  private onMessage(m: FromWorker): void {
    switch (m.t) {
      case 'frame':
        this.onFrame(m);
        break;
      case 'audio':
        this.stats.audioMessages++;
        this.stats.audioOps += m.ops.length;
        this.audio?.handle(m.ops);
        this.stats.audioVoices = this.audio?.activeVoices ?? 0;
        break;
      case 'ctlReply':
        this.ctlWaiting.get(m.id)?.(m.text);
        this.ctlWaiting.delete(m.id);
        break;
      case 'flushed':
        this.flushedResolvers.splice(0).forEach((r) => r());
        break;
      case 'synced':
        this.stats.synced = m.saves;
        break;
      case 'flushDone':
        this.flushWaiting.get(m.id)?.();
        this.flushWaiting.delete(m.id);
        break;
      case 'status':
        this.stats.status = m.text;
        this.hooks.onStatus(m.text);
        break;
      case 'log':
        this.stats.logs.push(m.line);
        if (this.stats.logs.length > 400) this.stats.logs.splice(0, 100);
        this.hooks.onLog?.(m.line);
        break;
      case 'exit':
        this.stats.exited = m.code;
        this.hooks.onStatus(`game exited (code ${m.code})`, m.code !== 0);
        this.hooks.onExit?.(m.code);
        break;
      case 'error':
        this.fail(m.message);
        break;
    }
  }

  private fail(message: string): void {
    this.stats.status = `error: ${message}`;
    this.hooks.onStatus(`Game failed: ${message}`, true);
    this.hooks.onFail?.(message);
  }

  private onFrame(m: FrameMessage): void {
    this.stats.frames++;
    this.frameTimes.push(performance.now());
    if (this.frameTimes.length > 50_000) this.frameTimes.splice(0, 10_000);
    this.stats.width = m.w;
    this.stats.height = m.h;
    this.stats.heapMiB = Math.round(m.heap / 1048576);
    this.mailbox.receive(m);
  }

  // --- audio ---------------------------------------------------------------

  /** The AudioContext is created here, in the Play click (a user gesture), and resumed on later gestures. */
  private setupAudio(): void {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.audio = new AudioEngine(ctx as unknown as ContextLike);
      this.audio.setVolume(this.volume);
      const update = () => (this.stats.audioState = ctx.state);
      ctx.addEventListener('statechange', update);
      update();
      void this.audio.resume();
      const resume = () => void this.audio?.resume();
      for (const ev of ['pointerdown', 'keydown'] as const) {
        window.addEventListener(ev, resume);
        this.cleanup.push(() => window.removeEventListener(ev, resume));
      }
      this.cleanup.push(() => {
        this.audio?.dispose();
        this.audio = null;
        void ctx.close().catch(() => undefined);
      });
    } catch (e) {
      this.hooks.onLog?.(`no Web Audio: ${String(e)}`);
    }
  }

  private volume = 1;
  /** UI volume 0..1. */
  setVolume(v: number): void {
    this.volume = v;
    this.audio?.setVolume(v);
  }

  // --- devctl & measurements ---------------------------------------------

  /** Run an upstream devctl verb (`state`, `debug level`, `cmd move 10 10`, ...) in the game; resolves with its reply text. */
  devctl(line: string, timeoutMs = 10_000): Promise<string> {
    const id = ++this.ctlSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ctlWaiting.delete(id);
        reject(new Error(`devctl '${line}' timed out`));
      }, timeoutMs);
      this.ctlWaiting.set(id, (text) => {
        clearTimeout(timer);
        resolve(text);
      });
      this.send({ t: 'ctl', id, line });
    });
  }

  /** Start a new measurement window (see perf()). */
  perfReset(): void {
    this.frameTimes = [];
  }

  /** Frame rate and hitches since perfReset(), from the arrival times of the game's frames. */
  perf(): PerfSample {
    const t = this.frameTimes;
    const gaps: number[] = [];
    for (let i = 1; i < t.length; i++) gaps.push(t[i]! - t[i - 1]!);
    const seconds = t.length > 1 ? (t[t.length - 1]! - t[0]!) / 1000 : 0;
    const sorted = [...gaps].sort((a, b) => a - b);
    return {
      frames: t.length,
      seconds,
      fps: seconds > 0 ? (t.length - 1) / seconds : 0,
      p95Gap: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      maxGap: sorted[sorted.length - 1] ?? 0,
      hitches: gaps.filter((g) => g > 100).length,
      heapMiB: this.stats.heapMiB,
    };
  }

  /** Call once per animation frame while the game is the active mode. */
  tick(): void {
    this.flushInput();
    if (this.mailbox.flush((w, h, rgba, ui) => this.renderer.presentRgba(w, h, rgba, ui))) this.stats.shown++;
    this.stats.dropped = this.mailbox.dropped;
  }

  // --- input ---------------------------------------------------------------

  private queue(r: InputRecord): void {
    this.pendingInput.push(r);
  }

  private flushInput(): void {
    if (this.motion) {
      this.pendingInput.push([EV.motion, this.motion.x, this.motion.y, 0, 0, 0]);
      this.motion = null;
    }
    if (this.pendingInput.length > 0) {
      this.send({ t: 'input', recs: this.pendingInput });
      this.pendingInput = [];
    }
  }

  private pos(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return toFramePixels(e.clientX, e.clientY, rect.left, rect.top, rect.width, rect.height, this.canvas.width, this.canvas.height, this.renderer.lastRect, this.stats.width, this.stats.height);
  }

  private attachInput(): void {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      c.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => c.removeEventListener(type, fn as EventListener));
    };
    c.tabIndex = 0;
    c.focus();
    const prevCursor = c.style.cursor;
    c.style.cursor = 'none'; // the game draws its own gauntlet cursor
    this.cleanup.push(() => (c.style.cursor = prevCursor));

    // one mouse: a second finger is ignored (a pinch or a palm must not move the cursor or click)
    const ours = (e: PointerEvent): boolean => e.pointerType !== 'touch' || e.isPrimary;
    /** the SDL button each pointer pressed, so the release matches it (a touch press follows touchButton) */
    const pressed = new Map<number, number>();
    on('pointermove', (e) => {
      if (ours(e)) this.motion = this.pos(e);
    });
    on('pointerdown', (e) => {
      e.preventDefault();
      if (!ours(e)) return;
      c.focus();
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        return; // the pointer is already gone
      }
      const p = this.pos(e);
      // a finger or a pen tip has one button: the touch controls choose it
      const b = e.pointerType === 'mouse' ? sdlButton(e.button) : this.touchButton;
      pressed.set(e.pointerId, b);
      this.motion = null;
      this.queue([EV.motion, p.x, p.y, 0, 0, 0]);
      this.queue([EV.button, b, 1, p.x, p.y, 0]);
    });
    const release = (e: PointerEvent) => {
      e.preventDefault();
      if (!ours(e)) return;
      // a finger is released once (lostpointercapture may come before its pointerup)
      if (e.pointerType !== 'mouse' && !pressed.has(e.pointerId)) return;
      const p = this.pos(e);
      const b = e.pointerType === 'mouse' ? sdlButton(e.button) : (pressed.get(e.pointerId) ?? 1);
      pressed.delete(e.pointerId);
      this.motion = null;
      this.queue([EV.motion, p.x, p.y, 0, 0, 0]);
      this.queue([EV.button, b, 0, p.x, p.y, 0]);
    };
    on('pointerup', release);
    // a cancelled / lost capture must not leave the button held down in the game
    on('pointercancel', release);
    on('lostpointercapture', (e) => {
      if (e.buttons !== 0) release(e);
    });
    on('wheel', (e) => {
      const p = this.pos(e);
      this.queue([EV.wheel, wheelRecordValue(e.deltaY, e.deltaMode), p.x, p.y, 0, 0]);
      e.preventDefault();
    }, { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    on('keydown', (e) => {
      const sc = scancodeOf(e.code);
      if (sc) this.queue([EV.key, sc, 1, e.repeat ? 1 : 0, modFlags(e) | this.touchMods, 0]);
      const cp = textOf(e);
      if (cp !== null) this.queue([EV.text, cp, 0, 0, 0, 0]);
      if (shouldPreventDefault(e)) e.preventDefault();
    });
    on('keyup', (e) => {
      const sc = scancodeOf(e.code);
      if (sc) this.queue([EV.key, sc, 0, 0, modFlags(e) | this.touchMods, 0]);
      if (shouldPreventDefault(e)) e.preventDefault();
    });
    // losing focus must not leave keys or buttons stuck down
    on('blur', () => {
      this.queue([EV.blur, 0, 0, 0, 0, 0]);
      this.onBlur?.();
      this.flushInput();
    });
    const onHide = () => {
      this.queue([EV.blur, 0, 0, 0, 0, 0]);
      this.onBlur?.();
      this.flushInput(); // a hidden page gets no animation frames: send now
      this.send({ t: 'flush' });
    };
    window.addEventListener('pagehide', onHide);
    this.cleanup.push(() => window.removeEventListener('pagehide', onHide));
    const onVis = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    document.addEventListener('visibilitychange', onVis);
    this.cleanup.push(() => document.removeEventListener('visibilitychange', onVis));
  }

  /** Push a raw input record (tests, scripted menus). */
  inject(r: InputRecord): void {
    this.queue(r);
  }

  /** Write the user dir to IndexedDB now; resolves once a write that started after this call has finished (or a timeout). */
  async flushSaves(timeoutMs = 5000): Promise<void> {
    if (!this.worker || this.stats.exited !== null) return;
    const id = ++this.flushId;
    const done = new Promise<void>((resolve) => this.flushWaiting.set(id, resolve));
    this.send({ t: 'flush', id });
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    this.flushWaiting.delete(id);
  }

  /**
   * Quit the game (it saves the character), wait until the worker has written IndexedDB (or a timeout), then drop
   * the worker, so two workers never touch IDBFS at once.
   */
  async stop(timeoutMs = 12_000): Promise<void> {
    for (const f of this.cleanup.splice(0)) f();
    const w = this.worker;
    if (!w) return;
    if (this.stats.exited !== null) {
      // the game already quit and its exit-time write finished (worker: onExit): nothing to wait for
      this.worker = null;
      w.terminate();
      return;
    }
    const done = new Promise<void>((resolve) => this.flushedResolvers.push(resolve));
    this.send({ t: 'stop' });
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    this.worker = null;
    w.terminate();
  }
}
