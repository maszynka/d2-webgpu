// SPDX-License-Identifier: GPL-3.0-or-later
// HUD: a small top-left overlay with the presented FPS, source / output resolution, the active mode(s) and GPU time.
// Separate from the F9 debug overlay; off by default, on with compare (unless the user switched it off).
import { presentLabel } from '../gpu/fsr';
import type { PresentInfo } from '../gpu/renderer';

export interface HudSample {
  /** smoothed frames shown per second */
  fps: number;
  /** full game: frames received from the worker per second (null outside the game) */
  gameFps: number | null;
  info: PresentInfo | null;
  dpr: number;
}

/** "fsr1 · easu-rcas · 3.0×" (with a pixel-art prescale: "fsr1-pixel · easu-rcas · 3.17× (3× nearest + 1.06× EASU)") */
export function presentSummary(p: PresentInfo): string {
  const scale = p.rect.w / p.srcW;
  const one = (mode: string, pass: string, k: number): string =>
    `${mode} \u00b7 ${pass} \u00b7 ${scale.toFixed(2)}\u00d7${k > 1 ? ` (${k}\u00d7 nearest + ${(scale / k).toFixed(2)}\u00d7 EASU)` : ''}`;
  if (p.compare) return `A ${one(p.compare.a, p.compare.passA, p.compare.prescaleA)}  |  B ${one(p.compare.b, p.compare.passB, p.compare.prescaleB)}`;
  return one(p.mode, p.pass, p.prescale);
}

export function formatHud(s: HudSample): string {
  const p = s.info;
  const lines: string[] = [];
  lines.push(`${s.fps.toFixed(1)} fps${s.gameFps !== null ? `  (game ${s.gameFps.toFixed(1)}/s)` : ''}`);
  if (!p) return `${lines[0]}\nno frame yet`;
  const scale = p.rect.w / p.srcW;
  lines.push(`source ${p.srcW}x${p.srcH}`);
  lines.push(`output ${p.canvasW}x${p.canvasH} px  frame ${p.rect.w}x${p.rect.h}  x${scale.toFixed(2)}  dpr ${s.dpr}`);
  if (p.compare) lines.push(`A ${presentLabel(p.compare.a)} (${p.compare.passA}${p.compare.prescaleA > 1 ? `, ${p.compare.prescaleA}x pre` : ''}) | B ${presentLabel(p.compare.b)} (${p.compare.passB}${p.compare.prescaleB > 1 ? `, ${p.compare.prescaleB}x pre` : ''})  split ${p.compare.splitPx}px`);
  else lines.push(`mode ${presentLabel(p.mode)} (${p.pass}${p.prescale > 1 ? `, ${p.prescale}x nearest prescale` : ''})`);
  lines.push(p.gpuMs !== null ? `gpu ${p.gpuMs.toFixed(2)} ms (EASU+RCAS)` : 'gpu - ms');
  return lines.join('\n');
}

/** Frames-per-second from a monotone counter, sampled at most every `windowMs`, exponentially smoothed. */
export class RateMeter {
  private t0 = 0;
  private n0 = 0;
  private rate = 0;
  private primed = false;
  sample(now: number, count: number, windowMs = 500): number {
    if (!this.primed) {
      this.primed = true;
      this.t0 = now;
      this.n0 = count;
      return this.rate;
    }
    const dt = now - this.t0;
    if (dt >= windowMs) {
      const inst = Math.max(0, ((count - this.n0) * 1000) / dt);
      this.rate = this.rate === 0 ? inst : this.rate * 0.5 + inst * 0.5;
      this.t0 = now;
      this.n0 = count;
    }
    return this.rate;
  }
}

export interface HudControls {
  readonly on: boolean;
  toggle(): void;
  /** call per animation frame with the live counters */
  update(now: number, presented: number, gameRecv: number | null, info: PresentInfo | null): void;
  /** compare turned on / off: shows the HUD by default unless the user chose */
  compareChanged(on: boolean): void;
}

export function bindHud(params: URLSearchParams, read: (k: string) => string | null, write: (k: string, v: string) => void, compareOn: boolean): HudControls {
  const el = document.getElementById('hud') as HTMLElement | null;
  const btn = document.getElementById('hud-btn') as HTMLButtonElement | null;
  const urlHud = params.get('hud');
  let pref: boolean | null = urlHud !== null ? urlHud === '1' : read('d2.hud') === null ? null : read('d2.hud') === '1';
  let cmp = compareOn;
  const fpsMeter = new RateMeter();
  const gameMeter = new RateMeter();
  let at = 0;
  let tipAt = 0;
  const on = (): boolean => pref ?? cmp;
  const apply = (): void => {
    if (el) el.hidden = !on();
    btn?.setAttribute('aria-pressed', String(on()));
  };
  const ctl: HudControls = {
    get on() {
      return on();
    },
    toggle() {
      pref = !on();
      if (urlHud === null) write('d2.hud', pref ? '1' : '0');
      apply();
    },
    update(now, presented, gameRecv, info) {
      const fps = fpsMeter.sample(now, presented);
      const g = gameRecv === null ? null : gameMeter.sample(now, gameRecv);
      if (now - tipAt > 500) {
        tipAt = now;
        if (info) {
          const tip = presentSummary(info);
          for (const id of ['present', 'cmp-a', 'cmp-b']) document.getElementById(id)?.setAttribute('title', tip);
        }
      }
      if (!on() || !el || now - at < 250) return;
      at = now;
      el.textContent = formatHud({ fps, gameFps: g, info, dpr: window.devicePixelRatio || 1 });
    },
    compareChanged(c) {
      cmp = c;
      apply();
    },
  };
  btn?.addEventListener('click', () => ctl.toggle());
  apply();
  return ctl;
}
