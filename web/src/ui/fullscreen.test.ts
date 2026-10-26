// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { FullscreenController, type FullscreenHost } from './fullscreen';

function setup(opts: { reject?: boolean; noKeyboard?: boolean } = {}) {
  const el: { requestFullscreen: ReturnType<typeof vi.fn> } & Record<string, unknown> = { requestFullscreen: vi.fn(async () => { if (opts.reject) throw new Error('denied'); host.fullscreenElement = el as unknown as Element; }) };
  let listener: (() => void) | undefined;
  const host: FullscreenHost = {
    fullscreenElement: null,
    exitFullscreen: vi.fn(async () => { host.fullscreenElement = null; }),
    addEventListener: (_t, fn) => { listener = fn; },
  };
  const keyboard = opts.noKeyboard ? undefined : { lock: vi.fn(async () => undefined), unlock: vi.fn() };
  const changes: boolean[] = [];
  const c = new FullscreenController(el as unknown as HTMLElement, host, keyboard, (on) => changes.push(on));
  return { el, host, keyboard, c, changes, fire: () => listener?.() };
}

describe('FullscreenController', () => {
  it('requests fullscreen on the element and locks Escape', async () => {
    const t = setup();
    expect(await t.c.toggle()).toBe(true);
    expect(t.el.requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(t.keyboard!.lock).toHaveBeenCalledWith(['Escape']);
    expect(t.c.active).toBe(true);
  });
  it('exits when active, unlocking the keyboard on the change event', async () => {
    const t = setup();
    await t.c.toggle();
    await t.c.toggle();
    expect(t.host.exitFullscreen).toHaveBeenCalled();
    t.fire();
    expect(t.keyboard!.unlock).toHaveBeenCalled();
    expect(t.changes).toEqual([false]);
  });
  it('works without keyboard lock and reports a refusal', async () => {
    expect(await setup({ noKeyboard: true }).c.toggle()).toBe(true);
    expect(await setup({ reject: true }).c.toggle()).toBe(false);
  });
});
