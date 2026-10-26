// SPDX-License-Identifier: GPL-3.0-or-later
// Fullscreen for a container element (Fullscreen API), with keyboard lock where the browser has it, so Esc reaches the
// game instead of leaving fullscreen at once (browsers still reserve a long press of Esc).

interface KeyboardLike {
  lock?(codes?: string[]): Promise<void>;
  unlock?(): void;
}

export interface FullscreenHost {
  fullscreenElement: Element | null;
  exitFullscreen(): Promise<void>;
  addEventListener(type: 'fullscreenchange', fn: () => void): void;
}

export class FullscreenController {
  constructor(
    private readonly el: HTMLElement,
    private readonly doc: FullscreenHost = document,
    private readonly keyboard: KeyboardLike | undefined = (navigator as unknown as { keyboard?: KeyboardLike }).keyboard,
    private readonly onChange: (active: boolean) => void = () => undefined,
  ) {
    this.doc.addEventListener('fullscreenchange', () => {
      const on = this.active;
      if (!on) this.keyboard?.unlock?.();
      this.onChange(on);
    });
  }

  get active(): boolean {
    return this.doc.fullscreenElement === this.el;
  }

  /** Enter or leave fullscreen (call from a user gesture). Resolves false when the browser refused. */
  async toggle(): Promise<boolean> {
    try {
      if (this.active) {
        await this.doc.exitFullscreen();
        return true;
      }
      await this.el.requestFullscreen({ navigationUI: 'hide' });
      try {
        await this.keyboard?.lock?.(['Escape']);
      } catch {
        /* keyboard lock unsupported or refused: Esc leaves fullscreen as usual */
      }
      return true;
    } catch {
      return false;
    }
  }
}
