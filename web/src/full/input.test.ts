// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { modFlags, scancodeOf, sdlButton, shouldPreventDefault, textOf, toFramePixels, wheelRecordValue } from './input';

describe('input mapping', () => {
  it('maps DOM codes to SDL scancodes', () => {
    expect(scancodeOf('KeyA')).toBe(4);
    expect(scancodeOf('KeyZ')).toBe(29);
    expect(scancodeOf('Digit1')).toBe(30);
    expect(scancodeOf('Digit0')).toBe(39);
    expect(scancodeOf('Enter')).toBe(40);
    expect(scancodeOf('Escape')).toBe(41);
    expect(scancodeOf('F1')).toBe(58);
    expect(scancodeOf('F12')).toBe(69);
    expect(scancodeOf('ArrowUp')).toBe(82);
    expect(scancodeOf('Numpad5')).toBe(93);
    expect(scancodeOf('ShiftLeft')).toBe(225);
    expect(scancodeOf('NoSuchKey')).toBe(0);
  });
  it('packs modifier flags', () => {
    expect(modFlags({ shiftKey: true, ctrlKey: false, altKey: true, metaKey: false })).toBe(5);
  });
  it('maps pointer positions through the letterbox to game pixels', () => {
    // 800x600 frame shown 2x (1600x1200) centred in a 2000x1200 backing store at dpr 2 (CSS 1000x600)
    const rect = { x: 200, y: 0, w: 1600, h: 1200 };
    expect(toFramePixels(100 + 0, 0, 0, 0, 1000, 600, 2000, 1200, rect, 800, 600)).toEqual({ x: 0, y: 0 });
    expect(toFramePixels(500, 300, 0, 0, 1000, 600, 2000, 1200, rect, 800, 600)).toEqual({ x: 400, y: 300 });
    expect(toFramePixels(5, 5, 0, 0, 1000, 600, 2000, 1200, rect, 800, 600)).toEqual({ x: 0, y: 5 }); // in the bar: clamped
  });
  it('buttons, wheel, text', () => {
    expect(sdlButton(0)).toBe(1);
    expect(sdlButton(2)).toBe(3);
    expect(wheelRecordValue(-100, 0)).toBe(1000);
    expect(wheelRecordValue(100, 0)).toBe(-1000);
    expect(textOf({ key: 'a', ctrlKey: false, metaKey: false, altKey: false })).toBe(97);
    expect(textOf({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
    expect(textOf({ key: 'a', ctrlKey: true, metaKey: false, altKey: false })).toBeNull();
  });
  it('keeps browser shortcuts but stops F-keys, Tab, Space, Esc', () => {
    expect(shouldPreventDefault({ code: 'F1', ctrlKey: false, metaKey: false })).toBe(true);
    expect(shouldPreventDefault({ code: 'Tab', ctrlKey: false, metaKey: false })).toBe(true);
    expect(shouldPreventDefault({ code: 'KeyR', ctrlKey: false, metaKey: true })).toBe(false);
    expect(shouldPreventDefault({ code: 'KeyA', ctrlKey: false, metaKey: false })).toBe(false);
  });
});
