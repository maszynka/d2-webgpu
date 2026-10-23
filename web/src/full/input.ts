// SPDX-License-Identifier: GPL-3.0-or-later
// DOM input -> the int32 event records wasm/full/d2web.cpp drains (kind, a, b, c, d, e).

export const EV = { key: 1, motion: 2, button: 3, wheel: 4, text: 5, blur: 6, quit: 7 } as const;
export type InputRecord = [number, number, number, number, number, number];

const CODES: Record<string, number> = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
  PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85,
  NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, Numpad0: 98, NumpadDecimal: 99,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
};
for (let i = 0; i < 26; i++) CODES[`Key${String.fromCharCode(65 + i)}`] = 4 + i;
for (let i = 1; i <= 9; i++) CODES[`Digit${i}`] = 29 + i;
CODES['Digit0'] = 39;
for (let i = 1; i <= 12; i++) CODES[`F${i}`] = 57 + i;
for (let i = 1; i <= 9; i++) CODES[`Numpad${i}`] = 88 + i;

/** SDL scancode (USB HID usage) for a KeyboardEvent.code, 0 when unknown. */
export function scancodeOf(code: string): number {
  return CODES[code] ?? 0;
}

/** Bit flags d2web.cpp turns into SDL_Keymod: 1 shift, 2 ctrl, 4 alt, 8 meta. */
export function modFlags(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): number {
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}

/** Keys the browser would otherwise act on while the game has focus (help, tab focus, alt menu, scrolling). */
export function shouldPreventDefault(e: { code: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  if (e.metaKey) return false; // Cmd chords (reload, devtools, quit) stay with the browser
  if (e.ctrlKey) return /^(Digit\d|Tab)$/.test(e.code) ? false : /^(Key[A-Z]|Space)$/.test(e.code) && e.code !== 'KeyR' && e.code !== 'KeyW' && e.code !== 'KeyT' && e.code !== 'KeyL';
  return /^(F\d+|Tab|Space|Escape|Alt(Left|Right)|Arrow(Up|Down|Left|Right)|Backspace|Slash|Quote|PageUp|PageDown|Home|End)$/.test(e.code);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pointer position (client CSS px) -> game pixels of a frame fbW x fbH shown letterboxed at `rect` (canvas device
 * pixels) in a canvas of CSS size cssW x cssH with backing size devW x devH. Clamped to the frame.
 */
export function toFramePixels(
  clientX: number,
  clientY: number,
  canvasLeft: number,
  canvasTop: number,
  cssW: number,
  cssH: number,
  devW: number,
  devH: number,
  rect: Rect,
  fbW: number,
  fbH: number,
): { x: number; y: number } {
  const dx = ((clientX - canvasLeft) / cssW) * devW;
  const dy = ((clientY - canvasTop) / cssH) * devH;
  const x = Math.floor(((dx - rect.x) / rect.w) * fbW);
  const y = Math.floor(((dy - rect.y) / rect.h) * fbH);
  return { x: Math.max(0, Math.min(fbW - 1, x)), y: Math.max(0, Math.min(fbH - 1, y)) };
}

/** Mouse button of a DOM event: DOM 0..4 (left, middle, right, back, forward) equals SDL 1..5 minus one. */
export function sdlButton(domButton: number): number {
  return domButton + 1;
}

/** Wheel delta (DOM, any deltaMode) -> SDL wheel ticks * 1000 (positive = away from the user, like SDL). */
export function wheelRecordValue(deltaY: number, deltaMode: number): number {
  const ticks = deltaMode === 0 ? deltaY / 100 : deltaMode === 1 ? deltaY / 3 : deltaY;
  return Math.round(-ticks * 1000);
}

/** Printable text a keydown produces for the game's text fields (no ctrl/meta chords). */
export function textOf(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): number | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const cp = [...e.key];
  if (cp.length !== 1) return null;
  return cp[0]!.codePointAt(0) ?? null;
}
