// SPDX-License-Identifier: GPL-3.0-or-later
// The top bar's placement: in flow above the surface until the game runs (or fullscreen), then an overlay that hides
// itself and comes back on the hot edge / F10 / when pinned or held (docs/design/ui.md section 2).

export type BarState = 'inflow' | 'overlay-visible' | 'overlay-hidden';

export const HIDE_DELAY_MS = 1500;
export const HOT_EDGE_PX = 3;
export const HOT_EDGE_MS = 250;

export class Bar {
  private overlay = false;
  private hidden = false;
  private hovering = false;
  private held = false;
  pinned = false;
  /** Called when the bar hides while focus is inside it (inert would drop focus to body): give it back to the game. */
  onHidden: () => void = () => undefined;
  /** The pointer left the bar with focus still in it (a select/slider just used): hand focus back to the game. */
  onPointerLeft: () => void = () => undefined;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private edgeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly bar: HTMLElement,
    private readonly body: HTMLElement,
    /** true while a popover is open: the bar stays */
    private readonly popoverOpen: () => boolean,
    private readonly onChange: () => void = () => undefined,
  ) {
    bar.addEventListener('pointerenter', () => {
      this.hovering = true;
      this.clearHide();
    });
    bar.addEventListener('pointerleave', () => {
      this.hovering = false;
      if (this.overlay && this.focusInside()) this.onPointerLeft();
      this.armHide();
    });
    bar.addEventListener('focusin', () => this.reveal());
    // keyboard focus inside keeps the bar up; leaving it re-arms the auto-hide
    bar.addEventListener('focusout', (e) => {
      if (!this.bar.contains(e.relatedTarget as Node | null)) this.armHide();
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.overlay || !this.hidden) return;
      if (e.clientY > HOT_EDGE_PX) {
        if (this.edgeTimer) clearTimeout(this.edgeTimer);
        this.edgeTimer = null;
      } else if (!this.edgeTimer) {
        this.edgeTimer = setTimeout(() => {
          this.edgeTimer = null;
          this.reveal();
        }, HOT_EDGE_MS);
      }
    });
    window.addEventListener('pointerdown', (e) => {
      if (this.overlay && this.hidden && e.clientY <= HOT_EDGE_PX) this.reveal();
    });
  }

  get state(): BarState {
    return !this.overlay ? 'inflow' : this.hidden ? 'overlay-hidden' : 'overlay-visible';
  }

  /** Overlay mode (the game runs, or fullscreen): the surface takes the whole page, the bar floats over it. */
  setOverlay(on: boolean): void {
    if (this.overlay === on) return;
    this.overlay = on;
    this.body.classList.toggle('bar-over', on);
    this.hidden = false;
    this.apply();
    if (on) this.armHide();
    else this.clearHide();
  }

  /** Keep the bar up (loading, a failed game) until release(). */
  hold(on: boolean): void {
    this.held = on;
    if (on) this.reveal();
    else this.armHide();
  }

  setPinned(on: boolean): void {
    this.pinned = on;
    if (on) this.reveal();
    else this.armHide();
  }

  reveal(): void {
    this.clearHide();
    if (this.hidden) {
      this.hidden = false;
      this.apply();
    }
    this.armHide();
  }

  hideNow(): void {
    if (!this.overlay) return;
    this.hidden = true;
    this.apply();
  }

  toggle(): void {
    if (this.state === 'overlay-hidden') this.reveal();
    else this.hideNow();
  }

  /** Re-evaluate the auto-hide (a popover closed, the pointer left, ...). */
  armHide(): void {
    this.clearHide();
    if (!this.overlay || this.hidden || this.pinned || this.held || this.hovering || this.popoverOpen() || this.focusInside()) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (this.overlay && !this.pinned && !this.held && !this.hovering && !this.popoverOpen() && !this.focusInside()) this.hideNow();
    }, HIDE_DELAY_MS);
  }

  private focusInside(): boolean {
    return this.bar.contains(document.activeElement);
  }

  private clearHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private apply(): void {
    this.bar.classList.toggle('hidden', this.overlay && this.hidden);
    const off = this.overlay && this.hidden;
    const hadFocus = off && this.bar.contains(document.activeElement);
    this.bar.toggleAttribute('inert', off);
    if (hadFocus) this.onHidden();
    if (off) this.bar.setAttribute('aria-hidden', 'true');
    else this.bar.removeAttribute('aria-hidden');
    this.onChange();
  }
}
