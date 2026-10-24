// SPDX-License-Identifier: GPL-3.0-or-later
// Brings a stage's output (any size) to the frame's rect on the canvas: EASU + RCAS when the target is larger, an
// explicit area (box) downsample when it is smaller, a plain copy when it is equal. One instance per compare side.
import { PARAMS_FLOATS, easuConstants, packParams } from './fsr';
import type { Rect } from './fit';
import type { StageOutput } from './upscale/stage';

export type ResampleKind = 'copy' | 'easu-rcas' | 'down';

/** Which resample brings a stage output of inW x inH to a rect: larger -> EASU+RCAS, smaller -> area downsample. */
export function resampleKind(inW: number, inH: number, r: { w: number; h: number }): ResampleKind {
  if (r.w === inW && r.h === inH) return 'copy';
  if (r.w > inW || r.h > inH) return 'easu-rcas';
  return 'down';
}

export interface ResampleDeps {
  device: GPUDevice;
  createTex(desc: GPUTextureDescriptor): GPUTexture;
  destroyTex(t: GPUTexture): void;
  easuBgl: GPUBindGroupLayout;
  blitBgl: GPUBindGroupLayout;
  easuPipeline: GPURenderPipeline;
  rcasPipeline: GPURenderPipeline;
  blitPipeline: GPURenderPipeline;
  downPipeline: GPURenderPipeline;
  nearest: GPUSampler;
}

/** The final pass the caller records inside its own render pass (viewport / scissor are the caller's). */
export interface ResampleFinal {
  kind: ResampleKind;
  pipeline: GPURenderPipeline;
  bind: GPUBindGroup;
}

export class StageResample {
  private key = '';
  private view: GPUTextureView | null = null;
  private easuTex: GPUTexture | null = null;
  private easuBind: GPUBindGroup | null = null;
  private final: ResampleFinal | null = null;
  private readonly params = new Float32Array(PARAMS_FLOATS);
  private readonly buf: GPUBuffer;

  constructor(private readonly d: ResampleDeps) {
    this.buf = d.device.createBuffer({ label: 'stage-resample-params', size: PARAMS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Textures this resampler owns right now (the renderer counts them for its leak stats; they go through createTex). */
  get live(): number {
    return this.easuTex ? 1 : 0;
  }

  /**
   * Encode what must run before the final pass (the EASU pass for an upscale) and return the final pass. `stamp` gives
   * timestampWrites for the pre pass (the caller times the final pass itself).
   */
  prepare(enc: GPUCommandEncoder, out: StageOutput, r: Rect, sharp: number, stamp?: () => GPURenderPassTimestampWrites | undefined): ResampleFinal {
    const kind = resampleKind(out.width, out.height, r);
    const key = `${kind}:${out.width}x${out.height}>${r.w}x${r.h}`;
    const d = this.d;
    if (key !== this.key || out.view !== this.view || !this.final) {
      if (this.easuTex) d.destroyTex(this.easuTex);
      this.easuTex = null;
      this.easuBind = null;
      this.key = key;
      this.view = out.view;
      const mkEasuBind = (view: GPUTextureView): GPUBindGroup =>
        d.device.createBindGroup({ layout: d.easuBgl, entries: [{ binding: 0, resource: { buffer: this.buf } }, { binding: 1, resource: view }] });
      if (kind === 'copy') {
        this.final = {
          kind,
          pipeline: d.blitPipeline,
          bind: d.device.createBindGroup({ layout: d.blitBgl, entries: [{ binding: 0, resource: out.view }, { binding: 1, resource: d.nearest }] }),
        };
      } else if (kind === 'down') {
        this.final = { kind, pipeline: d.downPipeline, bind: mkDownBind(d, this.buf, out.view) };
      } else {
        this.easuTex = d.createTex({ label: 'stage-easu', size: [r.w, r.h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        this.easuBind = mkEasuBind(out.view);
        this.final = { kind, pipeline: d.rcasPipeline, bind: mkEasuBind(this.easuTex.createView()) };
      }
    }
    if (kind === 'down') {
      this.params.set([r.x, r.y, r.w, r.h, out.width, out.height, 0, 0]);
      d.device.queue.writeBuffer(this.buf, 0, this.params as Float32Array<ArrayBuffer>);
    } else if (kind === 'easu-rcas') {
      packParams(this.params, easuConstants(out.width, out.height, out.width, out.height, r.w, r.h), sharp, r);
      d.device.queue.writeBuffer(this.buf, 0, this.params as Float32Array<ArrayBuffer>);
      const ts = stamp?.();
      const easu = enc.beginRenderPass({
        colorAttachments: [{ view: this.easuTex!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        ...(ts ? { timestampWrites: ts } : {}),
      });
      easu.setPipeline(d.easuPipeline);
      easu.setBindGroup(0, this.easuBind!);
      easu.draw(3);
      easu.end();
    }
    return this.final!;
  }

  destroy(): void {
    if (this.easuTex) this.d.destroyTex(this.easuTex);
    this.easuTex = null;
    this.buf.destroy();
  }
}

function mkDownBind(d: ResampleDeps, buf: GPUBuffer, view: GPUTextureView): GPUBindGroup {
  // same layout shape as EASU's (uniform + float texture)
  return d.device.createBindGroup({ layout: d.easuBgl, entries: [{ binding: 0, resource: { buffer: buf } }, { binding: 1, resource: view }] });
}
