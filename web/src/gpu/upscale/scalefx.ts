// SPDX-License-Identifier: GPL-3.0-or-later
// ScaleFX 3x (Sp00kyFox, MIT, LICENSES/ScaleFX-MIT.txt), standard variant, as an UpscaleStage of ratio 3.
//
// Variant choice: the libretro `scalefx.slangp` (standard pass 4) over `scalefx-hybrid` / `scalefx+rAA`. Same pass count (5),
// but the standard output contains only colours present in the input (a nearest-style subpixel copy), so it composes with the
// following EASU/area resample without introducing new colours or ringing; hybrid adds an anti-aliasing blend we do not need
// on top of the later resample and the dedither stage.
//
// Pass graph (native textures A, B = rgba16float, C = rgba8unorm; OUT = rgba8unorm at 3x, the only 3x texture):
//   p0  src      -> A   metrics (colour distances)                       original: float framebuffer  -> rgba16float
//   p1  A        -> B   corner strengths                                 original: float framebuffer  -> rgba16float
//   p2  B, A     -> C   junction resolution, packed k/15                 original: rgba8              -> rgba8unorm
//   p3  C        -> B   edge levels 1..6, subpixel selectors (c+9m)/80   original: rgba8              -> rgba16float (B is free after p2)
//   p4  B, src   -> OUT 3x subpixel copy from the native frame (refpass)
// Three native-size working textures rather than two: p2 consumes the metrics (A) and the strengths (B) together, so both stay
// alive until it has run (at most ~5 MB each at 1066x600). Only OUT exists at 3x. rgba16float is enough for the metrics and
// strengths (values in 0..1 used for ordering comparisons) and it decodes the (c + 9m)/80 selector exactly (margin 0.04 of 0.5).
import { createPassPipeline, PassStage, recordPass, textureBindGroup } from './pass';
import type { PassTimer } from './stage';
import pass0 from './scalefx-pass0.wgsl?raw';
import pass1 from './scalefx-pass1.wgsl?raw';
import pass2 from './scalefx-pass2.wgsl?raw';
import pass3 from './scalefx-pass3.wgsl?raw';
import pass4 from './scalefx-pass4.wgsl?raw';

export class ScaleFx extends PassStage {
  readonly ratio = 3;
  readonly passes = 5;
  private readonly p: GPURenderPipeline[];
  private groups: GPUBindGroup[] = [];
  private views: { A: GPUTextureView; B: GPUTextureView; C: GPUTextureView; OUT: GPUTextureView } | null = null;

  constructor(device: GPUDevice) {
    super(device);
    const mod = (code: string, label: string): GPUShaderModule => device.createShaderModule({ label, code });
    this.p = [
      createPassPipeline(device, mod(pass0, 'scalefx-pass0'), 'fs', 'rgba16float', 'scalefx.p0'),
      createPassPipeline(device, mod(pass1, 'scalefx-pass1'), 'fs', 'rgba16float', 'scalefx.p1'),
      createPassPipeline(device, mod(pass2, 'scalefx-pass2'), 'fs', 'rgba8unorm', 'scalefx.p2'),
      createPassPipeline(device, mod(pass3, 'scalefx-pass3'), 'fs', 'rgba16float', 'scalefx.p3'),
      createPassPipeline(device, mod(pass4, 'scalefx-pass4'), 'fs', 'rgba8unorm', 'scalefx.p4'),
    ];
  }

  protected allocate(w: number, h: number): GPUTextureView {
    const A = this.tex(w, h, 'rgba16float', 'scalefx A').createView();
    const B = this.tex(w, h, 'rgba16float', 'scalefx B').createView();
    const C = this.tex(w, h, 'rgba8unorm', 'scalefx C').createView();
    const OUT = this.tex(w * 3, h * 3, 'rgba8unorm', 'scalefx out').createView();
    this.views = { A, B, C, OUT };
    return OUT;
  }

  protected bind(src: GPUTextureView): void {
    const v = this.views!;
    const g = (i: number, views: GPUTextureView[]): GPUBindGroup => textureBindGroup(this.device, this.p[i]!, views, `scalefx.p${i}`);
    this.groups = [g(0, [src]), g(1, [v.A]), g(2, [v.B, v.A]), g(3, [v.C]), g(4, [v.B, src])];
  }

  protected record(enc: GPUCommandEncoder, _w: number, _h: number, timer: PassTimer | undefined): void {
    const v = this.views!;
    const targets = [v.A, v.B, v.C, v.B, v.OUT];
    for (let i = 0; i < 5; i++) recordPass(enc, this.p[i]!, this.groups[i]!, targets[i]!, `scalefx.p${i}`, timer);
  }
}

export function createScaleFx(device: GPUDevice): ScaleFx {
  return new ScaleFx(device);
}
