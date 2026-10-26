// SPDX-License-Identifier: GPL-3.0-or-later
// The analytics opt-in (#consent): two checkboxes (browser support data, country) and Confirm / allow nothing. Shown
// until the visitor chose, wherever they are: under the welcome cards while those show, otherwise as a small strip at
// the bottom of the stage (closed cards, a reconnected folder, autoplay, URL params). Reopened from Tools -> Privacy.
// The choice itself lives in analytics/visit.ts (localStorage); this file only draws and reads the controls.

import { getConsent, setConsent, type Consent } from '../analytics/visit';

export interface ConsentUi {
  readonly shown: boolean;
  /** show the controls again, preset to the stored choice (Tools -> Privacy) */
  open(): void;
}

/** One line for the Tools row: what the stored choice allows. */
export function describeConsent(c: Consent | null): string {
  if (!c) return 'not chosen yet';
  const parts = [c.tech && 'WebGPU support', c.country && 'country'].filter((p): p is string => !!p);
  return parts.length ? `allowed: ${parts.join(', ')}` : 'nothing is collected';
}

export function bindConsent(): ConsentUi {
  const root = document.getElementById('consent') as HTMLFormElement | null;
  const welcome = document.getElementById('welcome');
  const stage = document.getElementById('stage');
  const tech = document.getElementById('consent-tech') as HTMLInputElement | null;
  const country = document.getElementById('consent-country') as HTMLInputElement | null;
  const none = document.getElementById('consent-none');
  const edit = document.getElementById('consent-edit');
  const state = document.getElementById('consent-state');
  if (!root || !tech || !country) return { shown: false, open: () => undefined };

  const summarise = (): void => {
    if (state) state.textContent = describeConsent(getConsent());
  };

  // in the welcome grid while the cards show (a third, full-width row), else a strip over the stage
  const place = (): void => {
    const inCards = !!welcome && !welcome.hidden;
    const parent = inCards ? welcome : stage;
    if (parent && root.parentElement !== parent) parent.appendChild(root);
  };
  if (welcome) new MutationObserver(place).observe(welcome, { attributes: true, attributeFilter: ['hidden'] });

  /** A choice was made during play: the keyboard goes back to the game (the hidden form already dropped focus). */
  const release = (): void => {
    if (document.body.classList.contains('playing')) document.getElementById('view')?.focus({ preventScroll: true });
    else if (root.contains(document.activeElement) || document.activeElement === document.body) {
      // outside play: keep keyboard users near where they were (the Tools entry when its popover is open)
      const target = edit && edit.offsetWidth > 0 ? edit : document.getElementById('view');
      target?.focus({ preventScroll: true });
    }
  };

  const choose = (c: Consent): void => {
    setConsent(c);
    root.hidden = true;
    summarise();
    release();
  };
  root.addEventListener('submit', (e) => {
    e.preventDefault();
    choose({ tech: tech.checked, country: country.checked });
  });
  none?.addEventListener('click', () => choose({ tech: false, country: false }));

  const open = (preset: Consent | null, focus: boolean): void => {
    tech.checked = preset?.tech === true;
    country.checked = preset?.country === true;
    place();
    root.hidden = false;
    if (focus) tech.focus({ preventScroll: true });
  };
  edit?.addEventListener('click', () => open(getConsent(), true));

  summarise();
  if (getConsent() === null) open(null, false);
  else place();

  return {
    get shown() {
      return !root.hidden;
    },
    open: () => open(getConsent(), true),
  };
}
