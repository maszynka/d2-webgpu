// SPDX-License-Identifier: GPL-3.0-or-later
// DOM glue for the presentation controls (#present, #sharp): mode and RCAS sharpness, remembered in localStorage (a
// per-viewer convenience, every access guarded). ?present=fsr1|nearest|bilinear and ?sharp=N win for that load only.
import { DEFAULT_PRESENT_MODE, DEFAULT_SHARPNESS, PRESENT_MODES, clampSharpness, parsePresentMode, type PresentMode } from '../gpu/fsr';

interface Target {
  setPresent(mode: PresentMode, sharpness?: number): void;
}

const K_MODE = 'd2.present';
const K_SHARP = 'd2.sharpness';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

export interface PresentControls {
  readonly mode: PresentMode;
  readonly sharpness: number;
}

export function bindPresentControls(target: Target, params: URLSearchParams = new URLSearchParams(location.search)): PresentControls {
  const sel = document.getElementById('present') as HTMLSelectElement | null;
  const sharp = document.getElementById('sharp') as HTMLInputElement | null;
  if (sel && sel.options.length === 0) {
    for (const m of PRESENT_MODES) sel.add(new Option(m.label, m.id));
  }
  const urlMode = params.get('present');
  const urlSharp = params.get('sharp');
  const stored = read(K_SHARP);
  const c = {
    mode: parsePresentMode(urlMode ?? read(K_MODE) ?? DEFAULT_PRESENT_MODE),
    sharpness: urlSharp !== null && Number.isFinite(Number(urlSharp)) ? clampSharpness(Number(urlSharp)) : stored !== null && Number.isFinite(Number(stored)) ? clampSharpness(Number(stored)) : DEFAULT_SHARPNESS,
  };
  const apply = (): void => {
    target.setPresent(c.mode, c.sharpness);
    if (sel) sel.value = c.mode;
    if (sharp) {
      sharp.value = String(c.sharpness);
      sharp.hidden = c.mode !== 'fsr1';
    }
  };
  sel?.addEventListener('change', () => {
    c.mode = parsePresentMode(sel.value);
    write(K_MODE, c.mode);
    apply();
  });
  sharp?.addEventListener('input', () => {
    c.sharpness = clampSharpness(Number(sharp.value));
    write(K_SHARP, String(c.sharpness));
    apply();
  });
  apply();
  return c;
}
