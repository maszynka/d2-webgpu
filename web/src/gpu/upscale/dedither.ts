// SPDX-License-Identifier: GPL-3.0-or-later
// Dedither stage (ratio 1, native resolution): libretro "Checkerboard Dedither" (Hyllian, MIT, LICENSES/checkerboard-dedither-MIT.txt)
// plus an optional detector of our own for two-colour stripes / checkerboards (dedither.wgsl, fsLines).
//
// Pass graph (cbd + lines, 4 passes; textures A, B = rgba16float native, OUT = rgba8unorm native):
//   fs1   src      -> A      blend candidate + luma diff (linear light, alpha = diff)
//   fs2   src, A   -> B      pattern classification + directional blend
//   fs3   src, B   -> A      mitigate isolated corrections, back to display gamma (A is reused, B is free)
//   lines A        -> OUT    our stripe/checker detector
// cbd only: fs3 writes OUT directly (3 passes). lines only: one pass src -> OUT.
// Formats: the original keeps linear-light colour in rgba8 framebuffers; that quantises dark colours (the linear->gamma curve
// has slope 16/255 per step near black), so the two intermediates here are rgba16float. Output is rgba8unorm like the input.
import ditherWgsl from './dedither.wgsl?raw';
import { createPassPipeline, PassStage, recordPass, textureBindGroup } from './pass';
import type { PassTimer } from './stage';

export interface DeditherOptions {
  /** libretro checkerboard-dedither (default true) */
  cbd?: boolean;
  /** our own stripe/checker detector (default true) */
  lines?: boolean;
}

interface Pass {
  label: string;
  pipeline: GPURenderPipeline;
  /** which resources feed the bind group: 'src' (the stage input), 'A', 'B' */
  inputs: readonly ('src' | 'A' | 'B')[];
  /** which texture it renders into */
  target: 'A' | 'B' | 'OUT';
  group: GPUBindGroup | null;
}

export class Dedither extends PassStage {
  readonly ratio = 1;
  readonly passes: number;
  private readonly list: Pass[] = [];
  private vA: GPUTextureView | null = null;
  private vB: GPUTextureView | null = null;
  private vO: GPUTextureView | null = null;

  constructor(device: GPUDevice, opts: DeditherOptions = {}) {
    super(device);
    const cbd = opts.cbd ?? true;
    const lines = opts.lines ?? true;
    if (!cbd && !lines) throw new Error('dedither: enable cbd and/or lines');
    const module = device.createShaderModule({ label: 'dedither', code: ditherWgsl });
    const mk = (entry: string, format: GPUTextureFormat, label: string): GPURenderPipeline => createPassPipeline(device, module, entry, format, label);
    if (cbd) {
      this.list.push({ label: 'dedither.cbd1', pipeline: mk('fs1', 'rgba16float', 'dedither.fs1'), inputs: ['src'], target: 'A', group: null });
      this.list.push({ label: 'dedither.cbd2', pipeline: mk('fs2', 'rgba16float', 'dedither.fs2'), inputs: ['src', 'A'], target: 'B', group: null });
      if (lines) {
        this.list.push({ label: 'dedither.cbd3', pipeline: mk('fs3', 'rgba16float', 'dedither.fs3'), inputs: ['src', 'B'], target: 'A', group: null });
        this.list.push({ label: 'dedither.lines', pipeline: mk('fsLines', 'rgba8unorm', 'dedither.fsLines'), inputs: ['A'], target: 'OUT', group: null });
      } else {
        this.list.push({ label: 'dedither.cbd3', pipeline: mk('fs3', 'rgba8unorm', 'dedither.fs3'), inputs: ['src', 'B'], target: 'OUT', group: null });
      }
    } else {
      this.list.push({ label: 'dedither.lines', pipeline: mk('fsLines', 'rgba8unorm', 'dedither.fsLines'), inputs: ['src'], target: 'OUT', group: null });
    }
    this.passes = this.list.length;
  }

  protected allocate(w: number, h: number): GPUTextureView {
    const needsA = this.list.some((p) => p.target === 'A');
    const needsB = this.list.some((p) => p.target === 'B');
    this.vA = needsA ? this.tex(w, h, 'rgba16float', 'dedither A').createView() : null;
    this.vB = needsB ? this.tex(w, h, 'rgba16float', 'dedither B').createView() : null;
    this.vO = this.tex(w, h, 'rgba8unorm', 'dedither out').createView();
    return this.vO;
  }

  private view(which: 'src' | 'A' | 'B' | 'OUT', src: GPUTextureView | null): GPUTextureView {
    const v = which === 'src' ? src : which === 'A' ? this.vA : which === 'B' ? this.vB : this.vO;
    if (!v) throw new Error(`dedither: texture ${which} missing`);
    return v;
  }

  protected bind(src: GPUTextureView): void {
    for (const p of this.list) {
      p.group = textureBindGroup(this.device, p.pipeline, p.inputs.map((i) => this.view(i, src)), p.label);
    }
  }

  protected record(enc: GPUCommandEncoder, _w: number, _h: number, timer: PassTimer | undefined): void {
    for (const p of this.list) recordPass(enc, p.pipeline, p.group!, this.view(p.target, null), p.label, timer);
  }
}

export function createDedither(device: GPUDevice, opts: DeditherOptions = {}): Dedither {
  return new Dedither(device, opts);
}
