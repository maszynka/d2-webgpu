// SPDX-License-Identifier: GPL-3.0-or-later
// Small helpers shared by the multi-pass upscale stages: full-screen-triangle render pipelines (auto layout), pass recording
// with optional timestamp writes, and a base class that owns the stage's working textures (recreated when the source
// size or view changes, destroyed with the stage).
import type { PassTimer, StageOutput, UpscaleStage } from './stage';

/** Usage of every stage texture: rendered into, sampled (textureLoad) by the next pass, and readable for tests/captures. */
export const STAGE_TEXTURE_USAGE = 0x1 /* COPY_SRC */ | 0x4 /* TEXTURE_BINDING */ | 0x10; /* RENDER_ATTACHMENT */

/** A pipeline drawing one full-screen triangle with `entry` as fragment entry (vertex entry is always `vs`). */
export function createPassPipeline(device: GPUDevice, module: GPUShaderModule, entry: string, format: GPUTextureFormat, label: string): GPURenderPipeline {
  return device.createRenderPipeline({
    label,
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: entry, targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
}

/** One full-screen pass into `target` (a texture view of exactly the output size, so the fragment position is the pixel). */
export function recordPass(enc: GPUCommandEncoder, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup, target: GPUTextureView, label: string, timer: PassTimer | undefined): void {
  const tw = timer?.(label) as GPURenderPassTimestampWrites | undefined;
  const pass = enc.beginRenderPass({
    label,
    colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    ...(tw ? { timestampWrites: tw } : {}),
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}

/** Bind group over texture views at bindings 0.. in order. */
export function textureBindGroup(device: GPUDevice, pipeline: GPURenderPipeline, views: readonly GPUTextureView[], label: string): GPUBindGroup {
  return device.createBindGroup({ label, layout: pipeline.getBindGroupLayout(0), entries: views.map((resource, binding) => ({ binding, resource })) });
}

export abstract class PassStage implements UpscaleStage {
  abstract readonly ratio: number;
  abstract readonly passes: number;
  private owned: GPUTexture[] = [];
  private key = '';
  private lastSrc: GPUTextureView | null = null;
  private out: StageOutput | null = null;

  protected constructor(protected readonly device: GPUDevice) {}

  /** Create the working textures + the output for a source size; returns the output texture's view. Called when the size changes. */
  protected abstract allocate(srcW: number, srcH: number): GPUTextureView;
  /** (Re)create the bind groups (called after allocate or when the source view changes). */
  protected abstract bind(src: GPUTextureView): void;
  /** Record the passes (bind groups are current). */
  protected abstract record(enc: GPUCommandEncoder, srcW: number, srcH: number, timer: PassTimer | undefined): void;

  protected tex(w: number, h: number, format: GPUTextureFormat, label: string): GPUTexture {
    const t = this.device.createTexture({ label, size: [w, h], format, usage: STAGE_TEXTURE_USAGE });
    this.owned.push(t);
    return t;
  }

  encode(enc: GPUCommandEncoder, src: GPUTextureView, srcW: number, srcH: number, timer?: PassTimer): StageOutput {
    if (!(srcW >= 1 && srcH >= 1) || !Number.isInteger(srcW) || !Number.isInteger(srcH)) throw new Error(`invalid source size ${srcW}x${srcH}`);
    const key = `${srcW}x${srcH}`;
    let rebind = src !== this.lastSrc;
    if (key !== this.key || !this.out) {
      this.release();
      const view = this.allocate(srcW, srcH);
      this.out = { view, width: srcW * this.ratio, height: srcH * this.ratio };
      this.key = key;
      rebind = true;
    }
    if (rebind) {
      this.bind(src);
      this.lastSrc = src;
    }
    this.record(enc, srcW, srcH, timer);
    return this.out;
  }

  liveTextures(): number {
    return this.owned.length;
  }

  /** The texture holding the stage output (tests / captures); null before the first encode. */
  outputTexture(): GPUTexture | null {
    return this.owned.length > 0 && this.out ? (this.owned[this.owned.length - 1] ?? null) : null;
  }

  private release(): void {
    for (const t of this.owned) t.destroy();
    this.owned = [];
    this.out = null;
    this.key = '';
    this.lastSrc = null;
  }

  destroy(): void {
    this.release();
  }
}
