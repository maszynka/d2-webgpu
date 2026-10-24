// SPDX-License-Identifier: GPL-3.0-or-later
// Super-xBR 2x (Hyllian, MIT, LICENSES/Super-xBR-MIT.txt) as an UpscaleStage of ratio 2: the three super-xbr passes of
// `super-xbr.slangp`.
//
// Pass graph (T1 native, T2 2x = rgba8unorm-srgb; OUT 2x = rgba8unorm):
//   p0  src      -> T1   sample at (x + .5, y + .5)                 (original pass 1, scale 1x)
//   p1  src, T1  -> T2   fills the other two sub-pixels of each 2x block (original pass 2, scale 2x)
//   p2  T2       -> OUT  2x re-interpolation of every pixel         (original pass 3, scale 1x of the 2x)
// Dropped from the preset: the luma pass (luma is computed inline, no alpha channel is carried), and the final
// `custom-jinc2-sharper` (viewport-scaled resample) and `deblur-fast` passes: those are the preset's own resampler to the
// screen size, which the renderer replaces with EASU / an area downsample. So the stage output is the pure 2x xBR result.
// Formats: the original sets srgb_framebuffer on its xBR passes. The shaders treat display colours as linear, so the sRGB
// storage is only an 8-bit precision distribution that favours dark values; T1 and T2 use rgba8unorm-srgb to match exactly.
// OUT is plain rgba8unorm (values are written as-is, which equals the original's encode-then-decode round trip).
import { createPassPipeline, PassStage, recordPass, textureBindGroup } from './pass';
import type { PassTimer } from './stage';
import common from './super-xbr-common.wgsl?raw';
import pass0 from './super-xbr-pass0.wgsl?raw';
import pass1 from './super-xbr-pass1.wgsl?raw';
import pass2 from './super-xbr-pass2.wgsl?raw';

export class SuperXbr extends PassStage {
  readonly ratio = 2;
  readonly passes = 3;
  private readonly p: GPURenderPipeline[];
  private groups: GPUBindGroup[] = [];
  private views: { T1: GPUTextureView; T2: GPUTextureView; OUT: GPUTextureView } | null = null;

  constructor(device: GPUDevice) {
    super(device);
    const mod = (code: string, label: string): GPUShaderModule => device.createShaderModule({ label, code: `${common}\n${code}` });
    this.p = [
      createPassPipeline(device, mod(pass0, 'super-xbr-pass0'), 'fs', 'rgba8unorm-srgb', 'superxbr.p0'),
      createPassPipeline(device, mod(pass1, 'super-xbr-pass1'), 'fs', 'rgba8unorm-srgb', 'superxbr.p1'),
      createPassPipeline(device, mod(pass2, 'super-xbr-pass2'), 'fs', 'rgba8unorm', 'superxbr.p2'),
    ];
  }

  protected allocate(w: number, h: number): GPUTextureView {
    const T1 = this.tex(w, h, 'rgba8unorm-srgb', 'superxbr T1').createView();
    const T2 = this.tex(w * 2, h * 2, 'rgba8unorm-srgb', 'superxbr T2').createView();
    const OUT = this.tex(w * 2, h * 2, 'rgba8unorm', 'superxbr out').createView();
    this.views = { T1, T2, OUT };
    return OUT;
  }

  protected bind(src: GPUTextureView): void {
    const v = this.views!;
    const g = (i: number, views: GPUTextureView[]): GPUBindGroup => textureBindGroup(this.device, this.p[i]!, views, `superxbr.p${i}`);
    this.groups = [g(0, [src]), g(1, [src, v.T1]), g(2, [v.T2])];
  }

  protected record(enc: GPUCommandEncoder, _w: number, _h: number, timer: PassTimer | undefined): void {
    const v = this.views!;
    const targets = [v.T1, v.T2, v.OUT];
    for (let i = 0; i < 3; i++) recordPass(enc, this.p[i]!, this.groups[i]!, targets[i]!, `superxbr.p${i}`, timer);
  }
}

export function createSuperXbr(device: GPUDevice): SuperXbr {
  return new SuperXbr(device);
}
