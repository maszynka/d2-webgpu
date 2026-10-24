// SPDX-License-Identifier: GPL-3.0-or-later
// The A/B compare divider: a draggable / keyboard-adjustable handle over the stage plus the "A: ..." / "B: ..." chips.
// Only the handle takes pointer events; everything else over the canvas ignores them, so game clicks pass through.
import { SPLIT_MAX, SPLIT_MIN, clampSplit } from '../gpu/compare';
import { presentLabel } from '../gpu/fsr';
import type { PresentControls } from './present';

export const CHIP_MIN_SIDE_PX = 90; // a side narrower than this (CSS px) hides its chip

/** Divider fraction for a pointer at clientX over a canvas box. */
export function splitFromPointer(clientX: number, left: number, width: number): number {
  return width > 0 ? clampSplit((clientX - left) / width) : 0.5;
}
/** Keyboard step: arrows 1 %, shift 10 %, Home/End the limits; null when the key is not ours. */
export function splitFromKey(split: number, key: string, shift: boolean): number | null {
  const step = shift ? 0.1 : 0.01;
  if (key === 'ArrowLeft' || key === 'ArrowDown') return clampSplit(split - step);
  if (key === 'ArrowRight' || key === 'ArrowUp') return clampSplit(split + step);
  if (key === 'Home') return SPLIT_MIN;
  if (key === 'End') return SPLIT_MAX;
  return null;
}

export function bindDivider(ctl: PresentControls, canvas: HTMLCanvasElement, afterDrag: () => void): { update(): void } {
  const handle = document.getElementById('cmp-divider') as HTMLElement | null;
  const chipA = document.getElementById('cmp-chip-a') as HTMLElement | null;
  const chipB = document.getElementById('cmp-chip-b') as HTMLElement | null;
  const stage = document.getElementById('stage');
  if (!handle || !stage) return { update: () => undefined };

  const update = (): void => {
    const on = ctl.compare.on;
    handle.hidden = !on;
    if (chipA) chipA.hidden = !on;
    if (chipB) chipB.hidden = !on;
    stage.classList.toggle('cmp', on);
    if (!on) return;
    const s = ctl.compare.split;
    handle.style.left = `${s * 100}%`;
    handle.setAttribute('aria-valuenow', String(Math.round(s * 100)));
    const w = canvas.clientWidth;
    if (chipA) {
      chipA.textContent = `A: ${presentLabel(ctl.compare.a)}`;
      chipA.hidden = s * w < CHIP_MIN_SIDE_PX;
    }
    if (chipB) {
      chipB.textContent = `B: ${presentLabel(ctl.compare.b)}`;
      chipB.hidden = (1 - s) * w < CHIP_MIN_SIDE_PX;
    }
  };
  ctl.onChange(update);
  new ResizeObserver(update).observe(canvas);

  let dragging = false;
  const move = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    ctl.setSplit(splitFromPointer(e.clientX, r.left, r.width), false);
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.focus({ preventScroll: true });
    e.preventDefault();
    e.stopPropagation();
    move(e);
  });
  handle.addEventListener('pointermove', (e) => {
    if (dragging) move(e);
  });
  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    ctl.setSplit(ctl.compare.split, true); // persist
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    afterDrag();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  // the game must not see the handle's clicks, wheel or keys
  for (const t of ['click', 'pointerup', 'mousedown', 'mouseup', 'contextmenu'] as const) handle.addEventListener(t, (e) => e.stopPropagation());
  handle.addEventListener('keydown', (e) => {
    const next = splitFromKey(ctl.compare.split, e.key, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    ctl.setSplit(next);
  });
  update();
  return { update };
}
