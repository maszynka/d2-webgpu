// SPDX-License-Identifier: GPL-3.0-or-later
// DOM glue for the lighting controls (index.html #light-tools).

import { LIGHT_MODES, type LightMode } from '../gpu/lighting';

export interface LightControls {
  mode: LightMode;
  ambient: number;
  /** programmatic change (scene switch); updates the widgets */
  set(mode: LightMode, ambient?: number): void;
}

export function bindLightControls(mode: LightMode, ambient: number): LightControls {
  const sel = document.getElementById('light-mode') as HTMLSelectElement | null;
  const amb = document.getElementById('ambient') as HTMLInputElement | null;
  const out = document.getElementById('ambient-val');
  const c: LightControls = {
    mode,
    ambient,
    set(m, a) {
      c.mode = m;
      if (a !== undefined) c.ambient = a;
      if (sel) sel.value = c.mode;
      if (amb) amb.value = String(c.ambient);
      if (out) out.textContent = c.ambient.toFixed(2);
    },
  };
  sel?.addEventListener('change', () => {
    const v = sel.value as LightMode;
    if (LIGHT_MODES.includes(v)) c.mode = v;
  });
  amb?.addEventListener('input', () => {
    c.ambient = Number(amb.value);
    if (out) out.textContent = c.ambient.toFixed(2);
  });
  c.set(mode, ambient);
  return c;
}
