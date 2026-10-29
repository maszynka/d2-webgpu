// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { EV, scancodeOf } from './input';
import { keyHold, keyTap, softKeyRecords, textRecords, TOUCH_MAIN, TOUCH_MORE } from './touch';

describe('touch key records', () => {
  it('taps a key down and up, with the held modifiers', () => {
    expect(keyTap('KeyI')).toEqual([
      [EV.key, 12, 1, 0, 0, 0],
      [EV.key, 12, 0, 0, 0, 0],
    ]);
    expect(keyTap('Digit1', { shift: true, alt: false })[0]![4]).toBe(1);
    expect(keyTap('NoSuchKey')).toEqual([]);
  });
  it('holds a modifier with the flags of what stays held', () => {
    expect(keyHold('ShiftLeft', true, { shift: true, alt: false })).toEqual([[EV.key, 225, 1, 0, 1, 0]]);
    // releasing Shift while Alt stays held keeps the alt flag (every key record sets the game's modifier state)
    expect(keyHold('ShiftLeft', false, { shift: false, alt: true })).toEqual([[EV.key, 225, 0, 0, 4, 0]]);
  });
  it('every on-screen key maps to a scancode', () => {
    for (const k of [...TOUCH_MAIN, ...TOUCH_MORE]) expect(scancodeOf(k.code), k.code).toBeGreaterThan(0);
  });
});

describe('soft keyboard', () => {
  it('turns typed text into one record per code point', () => {
    expect(textRecords('Aé😀')).toEqual([
      [EV.text, 65, 0, 0, 0, 0],
      [EV.text, 0xe9, 0, 0, 0, 0],
      [EV.text, 0x1f600, 0, 0, 0, 0],
    ]);
  });
  it('takes Enter, Backspace, Esc from keydown and leaves printable keys to beforeinput', () => {
    expect(softKeyRecords({ key: 'Enter' })).toEqual(keyTap('Enter'));
    expect(softKeyRecords({ key: 'Backspace' })).toEqual(keyTap('Backspace'));
    expect(softKeyRecords({ key: 'Escape' })).toEqual(keyTap('Escape'));
    expect(softKeyRecords({ key: 'a' })).toBeNull();
  });
  it('maps beforeinput types (Android sends Backspace only this way)', () => {
    expect(softKeyRecords({ key: null, inputType: 'insertText', data: 'hi' })).toEqual(textRecords('hi'));
    expect(softKeyRecords({ key: null, inputType: 'deleteContentBackward', data: null })).toEqual(keyTap('Backspace'));
    expect(softKeyRecords({ key: null, inputType: 'insertLineBreak', data: null })).toEqual(keyTap('Enter'));
    expect(softKeyRecords({ key: null, inputType: 'insertText', data: null })).toEqual([]);
    expect(softKeyRecords({ key: null, inputType: 'formatBold', data: null })).toEqual([]);
  });
});
