// SPDX-License-Identifier: GPL-3.0-or-later
// The upscaling strip (#upscale: world upscaler, sharpness, Compare and its A/B controls) sits in the bar while the bar
// has room for it and moves into the Display popover's first row when it would overflow (narrow windows, or compare on
// at a middling width). The elements move, they are never cloned, so ids, listeners and state stay (docs/design/ui.md 2.10).

export interface StripLayout {
  /** true while the strip lives in the popover */
  readonly collapsed: boolean;
  /** re-measure (the bar resized, the strip's contents changed, a popover closed) */
  relayout(): void;
}

export function bindUpscaleStrip(
  bar: HTMLElement,
  strip: HTMLElement,
  /** the strip's row in the Display popover */
  slot: HTMLElement,
  /** the bar control the strip sits in front of */
  anchor: HTMLElement,
  /** true while a popover is open: the layout is left alone until it closes */
  busy: () => boolean,
): StripLayout {
  const inline = (): boolean => strip.parentElement === bar;
  const place = (collapsed: boolean): void => {
    if (collapsed) {
      if (!inline()) return;
      slot.append(strip);
    } else if (!inline() || strip.nextElementSibling !== anchor) bar.insertBefore(strip, anchor);
    bar.classList.toggle('upscale-collapsed', collapsed);
  };
  const relayout = (): void => {
    if (busy()) return;
    // a move would drop the focus (and close an open <select> popup): wait for it to leave
    if (strip.contains(document.activeElement)) return;
    place(false); // measure with the strip in the bar: the bar's items never shrink, the status line does (min-width 0)
    const over = bar.scrollWidth > bar.clientWidth;
    place(over);
  };
  new ResizeObserver(relayout).observe(bar);
  strip.addEventListener('focusout', (e) => {
    if (!strip.contains(e.relatedTarget as Node | null)) relayout();
  });
  relayout();
  return {
    get collapsed() {
      return !inline();
    },
    relayout,
  };
}
