// SPDX-License-Identifier: GPL-3.0-or-later
// The native resolution of the in-game view. Upstream's framebuffer is always 600 rows tall (kScreenHeight, which the
// HUD, panels and fonts are laid out for) and its width is a runtime value, clamped 800..kMaxViewWidth (1400 =
// 21:9 and a bit); menus and cinematics are always 800x600. The page picks the width from its display's aspect and posts it
// (patch 0013: d2web::view_width()).
export const VIEW_HEIGHT = 600;
export const MIN_VIEW_WIDTH = 800;
export const MAX_VIEW_WIDTH = 1400;
/** a changed width is only sent when it moves by at least this much (px) ... */
export const VIEW_STEP = 16;
/** ... and this long after the last resize event (ms); fullscreen changes apply at once */
export const VIEW_DEBOUNCE_MS = 200;

/** Game view width for a display of cssW x cssH (any unit): 600 * aspect, even, within 800..1400. */
export function viewWidthFor(w: number, h: number): number {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return MIN_VIEW_WIDTH;
  const even = Math.round((VIEW_HEIGHT * w) / h / 2) * 2; // even: nearest, not floor
  return Math.max(MIN_VIEW_WIDTH, Math.min(MAX_VIEW_WIDTH, even));
}
