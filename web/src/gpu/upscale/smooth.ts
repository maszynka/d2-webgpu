// SPDX-License-Identifier: GPL-3.0-or-later
// "Smooth" presentation chains: [dedither ->] ScaleFX 3x | Super-xBR 2x, each composed into one UpscaleStage (passes = sum,
// ratio = product). The renderer resamples the output to the target (EASU / area downsample).
import { Dedither, type DeditherOptions } from './dedither';
import { ScaleFx } from './scalefx';
import type { PassTimer, StageOutput, UpscaleStage } from './stage';
import { SuperXbr } from './superxbr';

/** Runs stages back to back: each stage's output view is the next one's source. */
export class ChainStage implements UpscaleStage {
  readonly ratio: number;
  readonly passes: number;
  constructor(private readonly stages: readonly UpscaleStage[]) {
    if (stages.length === 0) throw new Error('empty chain');
    this.ratio = stages.reduce((r, s) => r * s.ratio, 1);
    this.passes = stages.reduce((n, s) => n + s.passes, 0);
  }
  encode(enc: GPUCommandEncoder, src: GPUTextureView, srcW: number, srcH: number, timer?: PassTimer): StageOutput {
    let cur: StageOutput = { view: src, width: srcW, height: srcH };
    for (const s of this.stages) cur = s.encode(enc, cur.view, cur.width, cur.height, timer);
    return cur;
  }
  /** The final stage's output texture (tests / captures), when that stage exposes it. */
  outputTexture(): GPUTexture | null {
    const last = this.stages[this.stages.length - 1] as { outputTexture?: () => GPUTexture | null } | undefined;
    return last?.outputTexture?.() ?? null;
  }
  liveTextures(): number {
    return this.stages.reduce((n, s) => n + s.liveTextures(), 0);
  }
  destroy(): void {
    for (const s of this.stages) s.destroy();
  }
}

export interface SmoothOptions {
  /** run the dedither stage first (default true) */
  dedither?: boolean;
  /** dedither details (default: libretro checkerboard-dedither + our stripe/checker detector) */
  ditherOptions?: DeditherOptions;
}

/** dedither -> ScaleFX 3x (ratio 3, 5 passes + 3-4 dedither passes). */
export function createSmoothScaleFx(device: GPUDevice, opts: SmoothOptions = {}): UpscaleStage {
  const dd = opts.dedither ?? true;
  return new ChainStage([...(dd ? [new Dedither(device, opts.ditherOptions)] : []), new ScaleFx(device)]);
}

/** dedither -> Super-xBR 2x (ratio 2, 3 passes + 3-4 dedither passes). */
export function createSmoothSuperXbr(device: GPUDevice, opts: SmoothOptions = {}): UpscaleStage {
  const dd = opts.dedither ?? true;
  return new ChainStage([...(dd ? [new Dedither(device, opts.ditherOptions)] : []), new SuperXbr(device)]);
}

export type StageRegistry = (mode: string, factory: (device: GPUDevice) => UpscaleStage) => void;

/** Registers the two smooth modes (dedither on); the integrator can call the factories directly for the dedither-off variants. */
export function register(registry: StageRegistry): void {
  registry('smooth-scalefx', (device) => createSmoothScaleFx(device, { dedither: true }));
  registry('smooth-sxbr', (device) => createSmoothSuperXbr(device, { dedither: true }));
}
