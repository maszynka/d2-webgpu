// SPDX-License-Identifier: GPL-3.0-or-later
// The welcome cards shown over the test scene until a game folder is open: the browser checks (WebGPU adapter, engine
// core) on the left, the folder picker on the right. The picker's controls (#pick, #folder-label, #regrant) are the
// bar's own: they move into the card while it is shown and back in front of Play when it goes (docs/design/ui.md 2.10).

export type CheckId = 'gpu' | 'core';
export type CheckState = 'pending' | 'ok' | 'fail';

export interface Welcome {
  readonly shown: boolean;
  /** show / hide the cards; `moved` is called after the folder controls changed place (the bar re-measures) */
  setVisible(on: boolean): void;
  setCheck(id: CheckId, state: CheckState, detail: string): void;
}

export function bindWelcome(bar: HTMLElement, onMoved: () => void = () => undefined): Welcome {
  const root = document.getElementById('welcome') as HTMLElement | null;
  const slot = document.getElementById('open-slot') as HTMLElement | null;
  const anchor = document.getElementById('play-btn') as HTMLElement | null;
  const controls = ['pick', 'folder-label', 'regrant'].map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
  const place = (inCard: boolean): void => {
    if (!slot || !anchor) return;
    const first = controls[0];
    if (!first || (first.parentElement === slot) === inCard) return;
    for (const c of controls) (inCard ? slot : bar).insertBefore(c, inCard ? null : anchor);
    onMoved();
  };
  return {
    get shown() {
      return !!root && !root.hidden;
    },
    setVisible(on) {
      if (!root) return;
      root.hidden = !on;
      place(on);
    },
    setCheck(id, state, detail) {
      const li = document.getElementById(`chk-${id}`);
      if (!li) return;
      li.dataset.state = state;
      const why = li.querySelector('.why');
      if (why) why.textContent = detail;
      const box = li.querySelector('.box');
      if (box) box.textContent = state === 'ok' ? '✓' : state === 'fail' ? '✗' : '…';
    },
  };
}
