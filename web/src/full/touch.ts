// SPDX-License-Identifier: GPL-3.0-or-later
// Touch controls for the full game (tablets, phones). A tap is a left click already (pointer events); this adds what a
// finger cannot do: a sticky right button (holding left means walking, so a long press cannot double as right click),
// held Shift / Alt, the keys a keyboard would give (Esc, panels, skills, belt) and a soft keyboard for text fields.
import { EV, scancodeOf, type InputRecord } from './input';

export interface TouchKey {
  label: string;
  /** KeyboardEvent.code it stands for */
  code: string;
  title: string;
}

/** Always on screen, in this order: the keys a run needs most. */
export const TOUCH_MAIN: readonly TouchKey[] = [{ label: 'Esc', code: 'Escape', title: 'Menu / close panels (Esc)' }];

/** Behind the ⋯ button. */
export const TOUCH_MORE: readonly TouchKey[] = [
  { label: 'I', code: 'KeyI', title: 'Inventory (I)' },
  { label: 'C', code: 'KeyC', title: 'Character (C)' },
  { label: 'T', code: 'KeyT', title: 'Skill tree (T)' },
  { label: 'Q', code: 'KeyQ', title: 'Quests (Q)' },
  { label: 'Map', code: 'Tab', title: 'Automap (Tab)' },
  { label: 'Run', code: 'KeyR', title: 'Walk / run (R)' },
  { label: '⏎', code: 'Enter', title: 'Chat / confirm (Enter)' },
  { label: 'F1', code: 'F1', title: 'Skill hotkey F1' },
  { label: 'F2', code: 'F2', title: 'Skill hotkey F2' },
  { label: 'F3', code: 'F3', title: 'Skill hotkey F3' },
  { label: 'F4', code: 'F4', title: 'Skill hotkey F4' },
  { label: '1', code: 'Digit1', title: 'Belt slot 1' },
  { label: '2', code: 'Digit2', title: 'Belt slot 2' },
  { label: '3', code: 'Digit3', title: 'Belt slot 3' },
  { label: '4', code: 'Digit4', title: 'Belt slot 4' },
];

/** Modifier field of a key record (d2web.cpp: 1 shift, 4 alt). */
function mods(held: { shift: boolean; alt: boolean }): number {
  return (held.shift ? 1 : 0) | (held.alt ? 4 : 0);
}

/** Press and release of one key, with the held modifiers. */
export function keyTap(code: string, held = { shift: false, alt: false }): InputRecord[] {
  const sc = scancodeOf(code);
  if (!sc) return [];
  const m = mods(held);
  return [
    [EV.key, sc, 1, 0, m, 0],
    [EV.key, sc, 0, 0, m, 0],
  ];
}

/**
 * A modifier key going down or up; `held` is the state after the change. Every key record sets the game's modifier
 * state (d2web.cpp g_mods), so the flags must carry what is still held.
 */
export function keyHold(code: string, down: boolean, held: { shift: boolean; alt: boolean }): InputRecord[] {
  const sc = scancodeOf(code);
  return sc ? [[EV.key, sc, down ? 1 : 0, 0, mods(held), 0]] : [];
}

/** Text typed on the soft keyboard, one record per code point. */
export function textRecords(data: string): InputRecord[] {
  return [...data].map((ch) => [EV.text, ch.codePointAt(0)!, 0, 0, 0, 0] as InputRecord);
}

/**
 * Soft-keyboard input -> records. iOS and Android differ: some keys arrive as keydown (Enter, Backspace on iOS), some
 * only as beforeinput (Backspace on Android has key "Unidentified"). `key` is the keydown key, or null for a
 * beforeinput event with its inputType and data. Returns null when the event is not ours (let the browser have it).
 */
export function softKeyRecords(ev: { key: string | null; inputType?: string; data?: string | null }): InputRecord[] | null {
  if (ev.key !== null) {
    if (ev.key === 'Enter') return keyTap('Enter');
    if (ev.key === 'Backspace') return keyTap('Backspace');
    if (ev.key === 'Escape') return keyTap('Escape');
    return null; // printable keys come through beforeinput
  }
  switch (ev.inputType) {
    // composition (IME) input cannot be cancelled and repeats the whole word on every change: not handled in v1
    case 'insertText':
    case 'insertReplacementText':
      return ev.data ? textRecords(ev.data) : [];
    case 'deleteContentBackward':
      return keyTap('Backspace');
    case 'insertLineBreak':
    case 'insertParagraph':
      return keyTap('Enter');
    default:
      return [];
  }
}

/** Where the game's input goes; null while no game runs. */
export interface TouchSink {
  inject(r: InputRecord): void;
  /** the SDL button a touch press sends (1 left, 3 right) */
  touchButton: number;
}

export interface TouchControls {
  /** forget held toggles (the game stopped or lost focus) */
  reset(): void;
}

/**
 * Build the controls inside `root` (an empty element over the game). `sink()` is the running game or null. The column
 * is shown by CSS only while a game runs and the last pointer was a finger (body.playing.touch).
 */
export function bindTouchControls(root: HTMLElement, sink: () => TouchSink | null): TouchControls {
  const held = { shift: false, alt: false, right: false };
  const send = (recs: InputRecord[]): void => {
    const s = sink();
    if (s) for (const r of recs) s.inject(r);
  };
  const button = (label: string, title: string, cls = ''): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    if (cls) b.className = cls;
    // keep focus (and the soft keyboard, when it is up) where it is
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    return b;
  };
  const col = document.createElement('div');
  col.className = 'touch-col';
  const grid = document.createElement('div');
  grid.className = 'touch-more';
  grid.hidden = true;

  const keyButton = (k: TouchKey): HTMLButtonElement => {
    const b = button(k.label, k.title);
    b.addEventListener('click', () => send(keyTap(k.code, held)));
    return b;
  };
  const toggle = (label: string, title: string, on: (v: boolean) => void): { el: HTMLButtonElement; set(v: boolean): void } => {
    const b = button(label, title, 'toggle');
    b.setAttribute('aria-pressed', 'false');
    const set = (v: boolean): void => {
      if (b.getAttribute('aria-pressed') === String(v)) return;
      b.setAttribute('aria-pressed', String(v));
      on(v);
    };
    b.addEventListener('click', () => set(b.getAttribute('aria-pressed') !== 'true'));
    return { el: b, set };
  };

  const right = toggle('RMB', 'Right button: taps use the right mouse button while on', (v) => {
    held.right = v;
    const s = sink();
    if (s) s.touchButton = v ? 3 : 1;
  });
  const shift = toggle('⇧', 'Shift held: attack in place, while on', (v) => {
    held.shift = v;
    send(keyHold('ShiftLeft', v, held));
  });
  const alt = toggle('Alt', 'Alt held: show items on the ground, while on', (v) => {
    held.alt = v;
    send(keyHold('AltLeft', v, held));
  });

  // the soft keyboard: a focused text field is the only way to bring it up; what is typed goes to the game
  const field = document.createElement('input');
  field.className = 'touch-text';
  field.type = 'text';
  field.autocomplete = 'off';
  field.setAttribute('autocapitalize', 'off');
  field.setAttribute('autocorrect', 'off');
  field.spellcheck = false;
  field.setAttribute('aria-label', 'Text for the game');
  field.addEventListener('keydown', (e) => {
    const recs = softKeyRecords({ key: e.key });
    if (!recs) return;
    e.preventDefault();
    send(recs);
  });
  field.addEventListener('beforeinput', (e) => {
    e.preventDefault(); // the field stays empty; the game keeps the text
    send(softKeyRecords({ key: null, inputType: e.inputType, data: e.data }) ?? []);
  });
  // the game canvas loses focus to the field, and the game releases every key on blur: the toggles follow
  field.addEventListener('focus', () => {
    shift.set(false);
    alt.set(false);
  });
  const kbd = button('Abc', 'Keyboard: type into the game (names, chat)');
  // focus moves inside the click (a user gesture), which iOS needs to open the keyboard
  kbd.addEventListener('click', () => {
    if (document.activeElement === field) field.blur();
    else field.focus({ preventScroll: true });
  });

  const more = button('⋯', 'More keys', 'toggle');
  more.setAttribute('aria-pressed', 'false');
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', () => {
    grid.hidden = !grid.hidden;
    more.setAttribute('aria-pressed', String(!grid.hidden));
    more.setAttribute('aria-expanded', String(!grid.hidden));
  });

  for (const k of TOUCH_MAIN) col.append(keyButton(k));
  col.append(right.el, shift.el, alt.el, kbd, more);
  for (const k of TOUCH_MORE) grid.append(keyButton(k));
  root.append(grid, col, field);

  return {
    reset() {
      // the game already dropped held keys (blur / restart): only the buttons and the press mode follow
      for (const t of [right, shift, alt]) t.el.setAttribute('aria-pressed', 'false');
      held.right = held.shift = held.alt = false;
      const s = sink();
      if (s) s.touchButton = 1;
      field.blur();
      grid.hidden = true;
      more.setAttribute('aria-pressed', 'false');
      more.setAttribute('aria-expanded', 'false');
    },
  };
}
