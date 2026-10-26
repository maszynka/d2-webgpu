// SPDX-License-Identifier: GPL-3.0-or-later
// FSR1 by default when the GPU can carry it: a software adapter starts on bilinear; otherwise the first timed
// EASU+RCAS frames decide (median over a window against a budget). Only while the viewer hasn't picked a mode.

import type { PresentInfo } from './renderer';

/** EASU+RCAS GPU time (ms, median) above which FSR1 is too heavy for this GPU */
export const FSR_BUDGET_MS = 8;
/** timed frames the decision waits for */
export const FSR_SAMPLES = 30;

export type AutoVerdict = { kind: 'keep'; ms: number } | { kind: 'downgrade'; ms: number };

/** The upscaler to start with when the viewer hasn't chosen one. */
export function initialAutoMode(isFallbackAdapter: boolean): 'fsr1' | 'bilinear' {
  return isFallbackAdapter ? 'bilinear' : 'fsr1';
}

/** Collects FSR1 timings from present infos and decides once. */
export class FsrAutoCheck {
  private readonly ms: number[] = [];
  private done = false;

  constructor(
    private readonly budgetMs = FSR_BUDGET_MS,
    private readonly samples = FSR_SAMPLES,
  ) {}

  get decided(): boolean {
    return this.done;
  }

  /** Feed one frame's present info; returns the verdict once (then null forever). */
  feed(p: PresentInfo | null): AutoVerdict | null {
    if (this.done || !p || p.compare || p.mode !== 'fsr1' || p.pass !== 'easu-rcas') return null;
    // the FSR passes alone (the UI pass costs the same in every mode)
    const part = p.gpuParts.filter((g) => /EASU|RCAS/.test(g.label)).reduce((a, g) => a + g.ms, 0);
    if (!(part > 0)) return null;
    this.ms.push(part);
    if (this.ms.length < this.samples) return null;
    this.done = true;
    const sorted = [...this.ms].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1]!;
    return median > this.budgetMs ? { kind: 'downgrade', ms: median } : { kind: 'keep', ms: median };
  }

  /** Stop deciding (the viewer picked a mode). */
  cancel(): void {
    this.done = true;
  }
}
