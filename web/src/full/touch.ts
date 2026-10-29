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
export function mods(held: { shift: boolean; alt: boolean }): number {
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

/** What the hidden field holds between keystrokes (see the focus handler). */
export const FIELD_SEED = '\u200b';

/** Where the game's input goes; null while no game runs. */
export interface TouchSink {
  inject(r: InputRecord): void;
  /** the SDL button a touch press sends (1 left, 3 right) */
  touchButton: number;
  /** modifier flags the toggles hold, added to physical key records too (each one sets the game's modifier state) */
  touchMods: number;
  /** called when the game released every key (canvas blur, page hidden) */
  onBlur: (() => void) | null;
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
  /** hand the toggles' state to the game, and learn when the game drops held keys */
  const attach = (): void => {
    const s = sink();
    if (!s) return;
    s.touchButton = held.right ? 3 : 1;
    s.touchMods = mods(held);
    s.onBlur = releaseHeld;
  };
  const button = (label: string, title: string, cls = ''): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    // keep focus (the game canvas, or the field with the soft keyboard up) where it is: a canvas blur releases every key.
    // mousedown, not pointerdown: WebKit may drop the click of a cancelled pointerdown; a tap's mousedown still comes
    let before: Element | null = null;
    b.addEventListener('pointerdown', () => (before = document.activeElement));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (document.activeElement === b && before instanceof HTMLElement && before !== b) before.focus({ preventScroll: true });
      before = null;
    });
    return b;
  };
  const col = document.createElement('div');
  col.className = 'touch-col';
  const grid = document.createElement('div');
  grid.className = 'touch-more';
  grid.hidden = true;

  const keyButton = (k: TouchKey): HTMLButtonElement => {
    const b = button(k.label, k.title);
    b.setAttribute('aria-label', k.title);
    b.addEventListener('click', () => send(keyTap(k.code, held)));
    return b;
  };
  const toggle = (label: string, name: string, title: string, on: (v: boolean) => void): { el: HTMLButtonElement; set(v: boolean): void } => {
    const b = button(label, title, 'toggle');
    b.setAttribute('aria-label', name);
    b.setAttribute('aria-pressed', 'false');
    const set = (v: boolean): void => {
      if (b.getAttribute('aria-pressed') === String(v)) return;
      b.setAttribute('aria-pressed', String(v));
      on(v);
    };
    b.addEventListener('click', () => set(b.getAttribute('aria-pressed') !== 'true'));
    return { el: b, set };
  };

  const right = toggle('RMB', 'Right button', 'Right button: taps use the right mouse button while on', (v) => {
    held.right = v;
    attach();
  });
  const shift = toggle('⇧', 'Shift', 'Shift held: attack in place, while on', (v) => {
    held.shift = v;
    attach();
    send(keyHold('ShiftLeft', v, held));
  });
  const alt = toggle('Alt', 'Alt', 'Alt held: show items on the ground, while on', (v) => {
    held.alt = v;
    attach();
    send(keyHold('AltLeft', v, held));
  });
  /** the game released every key itself: the Shift / Alt buttons follow, without sending anything */
  function releaseHeld(): void {
    held.shift = held.alt = false;
    for (const t of [shift, alt]) t.el.setAttribute('aria-pressed', 'false');
    const s = sink();
    if (s) s.touchMods = 0;
  }

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
  const seed = (): void => {
    field.value = FIELD_SEED;
    field.setSelectionRange(1, 1);
  };
  field.addEventListener('beforeinput', (e) => {
    if (e.cancelable) e.preventDefault(); // the field keeps only its placeholder character; the game keeps the text
    send(softKeyRecords({ key: null, inputType: e.inputType, data: e.data }) ?? []);
  });
  // what a non-cancelable edit (dictation, some autocorrect) put in was sent above: drop it from the field
  field.addEventListener('input', seed);
  // one zero-width character to delete: some Android keyboards send no Backspace at all in an empty field
  field.addEventListener('focus', seed);
  const kbd = button('Abc', 'Keyboard: type into the game (names, chat)');
  kbd.setAttribute('aria-label', 'Abc keyboard');
  // focus moves inside the click (a user gesture), which iOS needs to open the keyboard
  kbd.addEventListener('click', () => {
    if (document.activeElement === field) field.blur();
    else field.focus({ preventScroll: true });
  });

  const more = button('⋯', 'More keys', 'toggle');
  more.setAttribute('aria-label', 'More keys');
  grid.id = 'touch-more';
  more.setAttribute('aria-controls', grid.id);
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', () => {
    grid.hidden = !grid.hidden;
    more.setAttribute('aria-expanded', String(!grid.hidden));
  });

  for (const k of TOUCH_MAIN) col.append(keyButton(k));
  col.append(right.el, shift.el, alt.el, kbd, more);
  for (const k of TOUCH_MORE) grid.append(keyButton(k));
  root.setAttribute('role', 'group');
  root.append(grid, col, field);

  return {
    reset() {
      // a new or stopped game holds nothing: only the buttons and the press mode follow
      for (const t of [right, shift, alt]) t.el.setAttribute('aria-pressed', 'false');
      held.right = held.shift = held.alt = false;
      attach();
      field.blur();
      grid.hidden = true;
      more.setAttribute('aria-expanded', 'false');
    },
  };
}
