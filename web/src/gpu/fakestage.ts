// SPDX-License-Identifier: GPL-3.0-or-later
// A trivial 2x nearest UpscaleStage for end-to-end tests of the stage path (registry -> encode -> resample): the page's
// test hook window.__d2.registerFakeStage() registers it for a stage mode. Not used in normal operation.
import { registerStage } from './upscale/registry';
import type { PassTimer, StageOutput, UpscaleStage } from './upscale/stage';

const SHADER = `
@group(0) @binding(0) var src: texture_2d<f32>;
struct VsOut { @builtin(position) pos: vec4f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut; o.pos = vec4f(p[vi], 0.0, 1.0); return o;
}
@fragment fn fs(@builtin(position) f: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(src, vec2i(floor(f.xy * 0.5)), 0).rgb, 1.0);
}`;

export class FakeStage implements UpscaleStage {
  readonly ratio: number;
  readonly passes = 1;
  private tex: GPUTexture | null = null;
  private view: GPUTextureView | null = null;
  private readonly pipeline: GPURenderPipeline;
  private readonly bgl: GPUBindGroupLayout;
  private bind: GPUBindGroup | null = null;
  private bindFor: GPUTextureView | null = null;
  private lives = 0;

  constructor(private readonly device: GPUDevice, ratio = 2) {
    this.ratio = ratio;
    const module = device.createShaderModule({ code: SHADER.replace('0.5', String(1 / ratio)) });
    this.bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bgl] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
  }

  encode(enc: GPUCommandEncoder, src: GPUTextureView, srcW: number, srcH: number, timer?: PassTimer): StageOutput {
    const w = srcW * this.ratio;
    const h = srcH * this.ratio;
    if (!this.tex || this.tex.width !== w || this.tex.height !== h) {
      this.tex?.destroy();
      this.tex = this.device.createTexture({ label: 'fake-stage', size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.view = this.tex.createView();
      this.lives = 1;
    }
    if (!this.bind || this.bindFor !== src) {
      this.bind = this.device.createBindGroup({ layout: this.bgl, entries: [{ binding: 0, resource: src }] });
      this.bindFor = src;
    }
    const ts = timer?.('nearest 2x');
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.view!, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      ...(ts ? { timestampWrites: ts as GPURenderPassTimestampWrites } : {}),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);
    pass.end();
    return { view: this.view!, width: w, height: h };
  }

  liveTextures(): number {
    return this.lives;
  }

  destroy(): void {
    this.tex?.destroy();
    this.tex = null;
    this.lives = 0;
  }
}

/** Register the fake stage for a (concrete) stage mode; ratio 2 by default. */
export function registerFakeStage(mode = 'smooth-sxbr', ratio = 2): void {
  registerStage(mode, (device) => new FakeStage(device, ratio));
}
