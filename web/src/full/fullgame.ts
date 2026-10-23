// SPDX-License-Identifier: GPL-3.0-or-later
// Main-thread side of the full game: owns the game worker, shows its frames through our WebGPU blit
// (Renderer.presentRgba) and forwards DOM mouse/keyboard/wheel events as game input.

import type { Renderer } from '../gpu/renderer';
import { FrameMailbox, type FrameMessage } from './framepool';
import { EV, modFlags, scancodeOf, sdlButton, shouldPreventDefault, textOf, toFramePixels, wheelRecordValue, type InputRecord } from './input';
import type { FromWorker, ToWorker } from './protocol';

export interface FullGameHooks {
  onStatus(text: string, error?: boolean): void;
  onLog?(line: string): void;
  onExit?(code: number): void;
}

export interface FullGameStats {
  frames: number;
  shown: number;
  dropped: number;
  heapMiB: number;
  width: number;
  height: number;
  status: string;
  exited: number | null;
  logs: string[];
}

export class FullGame {
  readonly stats: FullGameStats = { frames: 0, shown: 0, dropped: 0, heapMiB: 0, width: 800, height: 600, status: 'starting', exited: null, logs: [] };
  private worker: Worker | null;
  private readonly mailbox: FrameMailbox;
  private pendingInput: InputRecord[] = [];
  private motion: { x: number; y: number } | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly renderer: Renderer,
    private readonly canvas: HTMLCanvasElement,
    files: File[],
    private readonly hooks: FullGameHooks,
    baseUrl: string = new URL(import.meta.env.BASE_URL, document.baseURI).href,
    args: string[] = [],
  ) {
    this.worker = new Worker(new URL('./game.worker.ts', import.meta.url), { type: 'module' });
    this.mailbox = new FrameMailbox((buf) => this.send({ t: 'recycle', buf }, buf ? [buf] : []));
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.fail(e.message || 'game worker crashed');
    this.send({ t: 'start', files, baseUrl, args });
    this.attachInput();
  }

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  private onMessage(m: FromWorker): void {
    switch (m.t) {
      case 'frame':
        this.onFrame(m);
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
  }

  private onFrame(m: FrameMessage): void {
    this.stats.frames++;
    this.stats.width = m.w;
    this.stats.height = m.h;
    this.stats.heapMiB = Math.round(m.heap / 1048576);
    this.mailbox.receive(m);
  }

  /** Call once per animation frame while the game is the active mode. */
  tick(): void {
    this.flushInput();
    if (this.mailbox.flush((w, h, rgba) => this.renderer.presentRgba(w, h, rgba))) this.stats.shown++;
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

    on('pointermove', (e) => {
      this.motion = this.pos(e);
    });
    on('pointerdown', (e) => {
      c.focus();
      c.setPointerCapture(e.pointerId);
      const p = this.pos(e);
      this.motion = null;
      this.queue([EV.motion, p.x, p.y, 0, 0, 0]);
      this.queue([EV.button, sdlButton(e.button), 1, p.x, p.y, 0]);
      e.preventDefault();
    });
    on('pointerup', (e) => {
      const p = this.pos(e);
      this.motion = null;
      this.queue([EV.motion, p.x, p.y, 0, 0, 0]);
      this.queue([EV.button, sdlButton(e.button), 0, p.x, p.y, 0]);
      e.preventDefault();
    });
    on('wheel', (e) => {
      const p = this.pos(e);
      this.queue([EV.wheel, wheelRecordValue(e.deltaY, e.deltaMode), p.x, p.y, 0, 0]);
      e.preventDefault();
    }, { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    on('keydown', (e) => {
      const sc = scancodeOf(e.code);
      if (sc) this.queue([EV.key, sc, 1, e.repeat ? 1 : 0, modFlags(e), 0]);
      const cp = textOf(e);
      if (cp !== null) this.queue([EV.text, cp, 0, 0, 0, 0]);
      if (shouldPreventDefault(e)) e.preventDefault();
    });
    on('keyup', (e) => {
      const sc = scancodeOf(e.code);
      if (sc) this.queue([EV.key, sc, 0, 0, modFlags(e), 0]);
      if (shouldPreventDefault(e)) e.preventDefault();
    });
    // losing focus must not leave keys or buttons stuck down
    on('blur', () => this.queue([EV.blur, 0, 0, 0, 0, 0]));
    const onHide = () => {
      this.queue([EV.blur, 0, 0, 0, 0, 0]);
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

  /** Ask the game to flush its saves, then stop. */
  stop(): void {
    this.send({ t: 'flush' });
    for (const f of this.cleanup.splice(0)) f();
    const w = this.worker;
    this.worker = null;
    // let the IndexedDB write finish before the worker goes away
    if (w) setTimeout(() => w.terminate(), 1500);
  }
}
