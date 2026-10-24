// SPDX-License-Identifier: GPL-3.0-or-later
// DOM glue for the presentation controls (#present, #sharp, and the A/B compare #cmp-btn, #cmp-a, #cmp-b): mode,
// RCAS sharpness and compare state, remembered in localStorage (a per-viewer convenience, every access guarded).
// ?present=fsr1|bilinear|nearest|nearest-stretch|native, ?sharp=N, ?compare=1|0, ?cmpA=, ?cmpB=, ?split=0.5 win for that load only.
import { DEFAULT_SPLIT, clampSplit } from '../gpu/compare';
import { DEFAULT_PRESENT_MODE, DEFAULT_SHARPNESS, PRESENT_MODES, clampSharpness, parsePresentMode, type PresentMode } from '../gpu/fsr';

export interface CompareControlState {
  on: boolean;
  a: PresentMode;
  b: PresentMode;
  split: number;
  sharpA: number;
  sharpB: number;
}

/** A/B presets: [label, A, B] */
export const COMPARE_PRESETS: readonly { id: string; label: string; a: PresentMode; b: PresentMode }[] = [
  { id: 'fsr-bilinear', label: 'FSR1 vs Bilinear', a: 'fsr1', b: 'bilinear' },
  { id: 'easu-bilinear', label: 'EASU only vs Bilinear', a: 'easu', b: 'bilinear' },
];

interface Target {
  setPresent(mode: PresentMode, sharpness?: number): void;
  setCompare?(c: CompareControlState): void;
}

const K_MODE = 'd2.present';
const K_SHARP = 'd2.sharpness';
const K_CMP = 'd2.cmp';
const K_CMP_A = 'd2.cmpA';
const K_CMP_B = 'd2.cmpB';
const K_SPLIT = 'd2.cmpSplit';
const K_SHARP_A = 'd2.cmpSharpA';
const K_SHARP_B = 'd2.cmpSharpB';
export const DEFAULT_CMP_A: PresentMode = 'nearest-stretch';
export const DEFAULT_CMP_B: PresentMode = 'fsr1';

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeStored(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

export interface PresentControls {
  mode: PresentMode;
  sharpness: number;
  compare: CompareControlState;
  /** the divider moved (drag / keys): apply + persist */
  setSplit(split: number, persist?: boolean): void;
  onChange(fn: () => void): void;
}

export function bindPresentControls(target: Target, params: URLSearchParams = new URLSearchParams(location.search)): PresentControls {
  const sel = document.getElementById('present') as HTMLSelectElement | null;
  const sharp = document.getElementById('sharp') as HTMLInputElement | null;
  const cmpBtn = document.getElementById('cmp-btn') as HTMLButtonElement | null;
  const selA = document.getElementById('cmp-a') as HTMLSelectElement | null;
  const selB = document.getElementById('cmp-b') as HTMLSelectElement | null;
  const shA = document.getElementById('cmp-sharp-a') as HTMLInputElement | null;
  const shB = document.getElementById('cmp-sharp-b') as HTMLInputElement | null;
  const preset = document.getElementById('cmp-preset') as HTMLSelectElement | null;
  if (preset && preset.options.length === 0) {
    preset.add(new Option('Presets\u2026', ''));
    for (const q of COMPARE_PRESETS) preset.add(new Option(q.label, q.id));
  }
  for (const s of [sel, selA, selB]) {
    if (s && s.options.length === 0) for (const m of PRESENT_MODES) s.add(new Option(m.label, m.id));
  }
  const listeners: (() => void)[] = [];
  const urlMode = params.get('present');
  const urlSharp = params.get('sharp');
  const stored = readStored(K_SHARP);
  const urlCmp = params.get('compare');
  const urlSplit = params.get('split');
  const storedSplit = readStored(K_SPLIT);
  const num = (url: string | null, st: string | null, d: number): number =>
    url !== null && Number.isFinite(Number(url)) ? clampSharpness(Number(url)) : st !== null && Number.isFinite(Number(st)) ? clampSharpness(Number(st)) : d;
  const c: PresentControls = {
    mode: parsePresentMode(urlMode ?? readStored(K_MODE) ?? DEFAULT_PRESENT_MODE),
    sharpness: urlSharp !== null && Number.isFinite(Number(urlSharp)) ? clampSharpness(Number(urlSharp)) : stored !== null && Number.isFinite(Number(stored)) ? clampSharpness(Number(stored)) : DEFAULT_SHARPNESS,
    compare: {
      on: urlCmp !== null ? urlCmp === '1' : readStored(K_CMP) === '1',
      a: parsePresentMode(params.get('cmpA') ?? readStored(K_CMP_A) ?? DEFAULT_CMP_A),
      b: parsePresentMode(params.get('cmpB') ?? readStored(K_CMP_B) ?? DEFAULT_CMP_B),
      sharpA: 0,
      sharpB: 0,
      split: clampSplit(urlSplit !== null && Number.isFinite(Number(urlSplit)) ? Number(urlSplit) : storedSplit !== null && Number.isFinite(Number(storedSplit)) ? Number(storedSplit) : DEFAULT_SPLIT),
    },
    setSplit(split, persist = true) {
      c.compare.split = clampSplit(split);
      if (persist) writeStored(K_SPLIT, String(c.compare.split));
      apply();
    },
    onChange(fn) {
      listeners.push(fn);
    },
  };
  c.compare.sharpA = num(params.get('sharpA'), readStored(K_SHARP_A), c.sharpness);
  c.compare.sharpB = num(params.get('sharpB'), readStored(K_SHARP_B), c.sharpness);
  const fsrSide = (m: PresentMode): boolean => m === 'fsr1';
  function apply(): void {
    target.setPresent(c.mode, c.sharpness);
    target.setCompare?.({ ...c.compare });
    if (sel) {
      sel.value = c.mode;
      sel.hidden = c.compare.on;
    }
    if (selA) {
      selA.value = c.compare.a;
      selA.hidden = !c.compare.on;
    }
    if (selB) {
      selB.value = c.compare.b;
      selB.hidden = !c.compare.on;
    }
    cmpBtn?.setAttribute('aria-pressed', String(c.compare.on));
    if (sharp) {
      sharp.value = String(c.sharpness);
      sharp.hidden = c.compare.on || c.mode !== 'fsr1';
    }
    if (shA) {
      shA.value = String(c.compare.sharpA);
      shA.hidden = !(c.compare.on && fsrSide(c.compare.a));
    }
    if (shB) {
      shB.value = String(c.compare.sharpB);
      shB.hidden = !(c.compare.on && fsrSide(c.compare.b));
    }
    if (preset) {
      preset.hidden = !c.compare.on;
      preset.value = '';
    }
    for (const fn of listeners) fn();
  }
  sel?.addEventListener('change', () => {
    c.mode = parsePresentMode(sel.value);
    writeStored(K_MODE, c.mode);
    apply();
  });
  selA?.addEventListener('change', () => {
    c.compare.a = parsePresentMode(selA.value);
    writeStored(K_CMP_A, c.compare.a);
    apply();
  });
  selB?.addEventListener('change', () => {
    c.compare.b = parsePresentMode(selB.value);
    writeStored(K_CMP_B, c.compare.b);
    apply();
  });
  shA?.addEventListener('input', () => {
    c.compare.sharpA = clampSharpness(Number(shA.value));
    writeStored(K_SHARP_A, String(c.compare.sharpA));
    apply();
  });
  shB?.addEventListener('input', () => {
    c.compare.sharpB = clampSharpness(Number(shB.value));
    writeStored(K_SHARP_B, String(c.compare.sharpB));
    apply();
  });
  preset?.addEventListener('change', () => {
    const q = COMPARE_PRESETS.find((x) => x.id === preset.value);
    if (!q) return;
    c.compare.a = q.a;
    c.compare.b = q.b;
    writeStored(K_CMP_A, q.a);
    writeStored(K_CMP_B, q.b);
    apply();
  });
  cmpBtn?.addEventListener('click', () => {
    c.compare.on = !c.compare.on;
    writeStored(K_CMP, c.compare.on ? '1' : '0');
    apply();
  });
  sharp?.addEventListener('input', () => {
    c.sharpness = clampSharpness(Number(sharp.value));
    writeStored(K_SHARP, String(c.sharpness));
    apply();
  });
  apply();
  return c;
}
