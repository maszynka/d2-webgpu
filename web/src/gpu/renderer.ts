// SPDX-License-Identifier: GPL-3.0-or-later
// WebGPU renderer, PLAN decision 5: paletted sprites -> offscreen rgba8unorm (native res) -> nearest blit.

import spriteWgsl from './shaders/sprite.wgsl?raw';
import blitWgsl from './shaders/blit.wgsl?raw';
import { ShelfPacker, type AtlasRect } from './atlas';
import { BLEND_ID, INSTANCE_BYTES, type BlendMode, DrawList } from './drawlist';
import { requestGpu, type GpuContext } from './device';
import type { Camera } from '../world/camera';

/** Atlas edge: the device's 2D texture limit, capped (r8uint: 8192^2 = 64 MiB). */
export const ATLAS_SIZE_CAP = 8192;
export function atlasSizeFor(maxTextureDimension2D: number): number {
  return Math.max(256, Math.min(maxTextureDimension2D, ATLAS_SIZE_CAP));
}
export const COLORMAP_ROWS_MAX = 64;
export const PALETTE_ROWS_MAX = 16;

export interface RendererOptions {
  /** native scene resolution */
  width?: number;
  height?: number;
}

const SCENE_FORMAT: GPUTextureFormat = 'rgba8unorm';

/** Compute the destination rect for fitting src into dst: integer scale when >= 1, else fractional fit. */
export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number): { x: number; y: number; w: number; h: number } {
  const f = Math.min(dstW / srcW, dstH / srcH);
  const s = f >= 1 ? Math.floor(f) : f;
  const w = Math.max(1, Math.floor(srcW * s));
  const h = Math.max(1, Math.floor(srcH * s));
  return { x: Math.floor((dstW - w) / 2), y: Math.floor((dstH - h) / 2), w, h };
}

export class Renderer {
  readonly sceneW: number;
  readonly sceneH: number;
  private readonly gpu: GpuContext;
  private readonly device: GPUDevice;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: GPUCanvasContext;
  private readonly canvasFormat: GPUTextureFormat;
  readonly atlasSize: number;
  private packer: ShelfPacker;
  private readonly atlas: GPUTexture;
  private readonly colormaps: GPUTexture;
  private readonly palettes: GPUTexture;
  private readonly scene: GPUTexture;
  private readonly sceneView: GPUTextureView;
  private readonly uni = new Float32Array(8);
  private readonly viewUniform: GPUBuffer;
  private readonly spriteBind: GPUBindGroup;
  private readonly blitBind: GPUBindGroup;
  private readonly spritePipelines = new Map<BlendMode, GPURenderPipeline>();
  private readonly blitPipeline: GPURenderPipeline;
  private instanceBuf: GPUBuffer | null = null;
  private instanceCap = 0;
  lastDrawCalls = 0;
  lastInstances = 0;

  private constructor(gpu: GpuContext, canvas: HTMLCanvasElement, opts: RendererOptions) {
    this.gpu = gpu;
    const device = gpu.device;
    this.device = device;
    this.atlasSize = atlasSizeFor(device.limits.maxTextureDimension2D);
    this.packer = new ShelfPacker(this.atlasSize, this.atlasSize);
    this.canvas = canvas;
    this.sceneW = opts.width ?? 800;
    this.sceneH = opts.height ?? 600;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Could not create a WebGPU canvas context');
    this.ctx = ctx;
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.canvasFormat, alphaMode: 'opaque' });

    this.atlas = device.createTexture({
      label: 'index-atlas',
      size: [this.atlasSize, this.atlasSize],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.colormaps = device.createTexture({
      label: 'colormaps',
      size: [256, COLORMAP_ROWS_MAX],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.palettes = device.createTexture({
      label: 'palettes',
      size: [256, PALETTE_ROWS_MAX],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.scene = device.createTexture({
      label: 'scene',
      size: [this.sceneW, this.sceneH],
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sceneView = this.scene.createView();
    this.viewUniform = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const spriteModule = device.createShaderModule({ label: 'sprite', code: spriteWgsl });
    const spriteBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const spriteLayout = device.createPipelineLayout({ bindGroupLayouts: [spriteBgl] });
    this.spriteBind = device.createBindGroup({
      layout: spriteBgl,
      entries: [
        { binding: 0, resource: { buffer: this.viewUniform } },
        { binding: 1, resource: this.atlas.createView() },
        { binding: 2, resource: this.colormaps.createView() },
        { binding: 3, resource: this.palettes.createView() },
      ],
    });
    const blends: Record<BlendMode, GPUBlendState | undefined> = {
      opaque: undefined,
      alpha50: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
      additive: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      },
      darken: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    };
    for (const mode of Object.keys(BLEND_ID) as BlendMode[]) {
      const blend = blends[mode];
      this.spritePipelines.set(
        mode,
        device.createRenderPipeline({
          label: `sprite-${mode}`,
          layout: spriteLayout,
          vertex: {
            module: spriteModule,
            entryPoint: 'vs',
            buffers: [
              {
                arrayStride: INSTANCE_BYTES,
                stepMode: 'instance',
                attributes: [
                  { shaderLocation: 0, offset: 0, format: 'uint32x4' },
                  { shaderLocation: 1, offset: 16, format: 'sint32x2' },
                  { shaderLocation: 2, offset: 24, format: 'uint32x2' },
                  { shaderLocation: 3, offset: 32, format: 'uint32x2' },
                ],
              },
            ],
          },
          fragment: {
            module: spriteModule,
            entryPoint: 'fs',
            constants: { blend_mode: BLEND_ID[mode] },
            targets: [blend ? { format: SCENE_FORMAT, blend } : { format: SCENE_FORMAT }],
          },
          primitive: { topology: 'triangle-list' },
        }),
      );
    }

    const blitModule = device.createShaderModule({ label: 'blit', code: blitWgsl });
    const blitBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.blitPipeline = device.createRenderPipeline({
      label: 'blit',
      layout: device.createPipelineLayout({ bindGroupLayouts: [blitBgl] }),
      vertex: { module: blitModule, entryPoint: 'vs' },
      fragment: { module: blitModule, entryPoint: 'fs', targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    this.blitBind = device.createBindGroup({
      layout: blitBgl,
      entries: [
        { binding: 0, resource: this.sceneView },
        { binding: 1, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) },
      ],
    });
    device.addEventListener?.('uncapturederror', (e) => {
      console.error('WebGPU uncaptured error:', (e as GPUUncapturedErrorEvent).error.message);
    });
  }

  static async create(canvas: HTMLCanvasElement, opts: RendererOptions = {}): Promise<Renderer> {
    return new Renderer(await requestGpu(), canvas, opts);
  }

  get adapterInfo(): GpuContext['info'] {
    return this.gpu.info;
  }

  /** Forget every atlas placement (call when switching scenes; old texels are simply overwritten). */
  resetAtlas(): void {
    this.packer = new ShelfPacker(this.atlasSize, this.atlasSize);
  }

  /** Upload an 8-bit index image into the atlas. Index 0 = transparent. */
  uploadSprite(w: number, h: number, indices: Uint8Array): AtlasRect {
    if (indices.length < w * h) throw new Error('uploadSprite: pixel buffer too small');
    const rect = this.packer.pack(w, h);
    if (!rect) throw new Error(`Atlas full: cannot place ${w}x${h}`);
    if (w > 0 && h > 0) {
      this.device.queue.writeTexture(
        { texture: this.atlas, origin: [rect.x, rect.y] },
        indices as Uint8Array<ArrayBuffer>,
        { bytesPerRow: w, rowsPerImage: h },
        [w, h],
      );
    }
    return rect;
  }

  /** 256-row colormaps: `rows` rows of 256 bytes. */
  setColormaps(data: Uint8Array, rows: number): void {
    if (rows > COLORMAP_ROWS_MAX) throw new Error('too many colormap rows');
    this.device.queue.writeTexture(
      { texture: this.colormaps },
      data as Uint8Array<ArrayBuffer>,
      { bytesPerRow: 256, rowsPerImage: rows },
      [256, rows],
    );
  }

  /** `rows` palettes as RGBA bytes, 256 entries each. */
  setPalettes(rgba: Uint8Array, rows: number): void {
    if (rows > PALETTE_ROWS_MAX) throw new Error('too many palette rows');
    this.device.queue.writeTexture(
      { texture: this.palettes },
      rgba as Uint8Array<ArrayBuffer>,
      { bytesPerRow: 256 * 4, rowsPerImage: rows },
      [256, rows],
    );
  }

  /** Match canvas backing store to its CSS size. */
  resizeToDisplay(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(list: DrawList, camera: Camera): void {
    const device = this.device;
    const { batches, data } = list.build();
    this.lastDrawCalls = batches.length;
    this.lastInstances = data.byteLength / INSTANCE_BYTES;

    const o = camera.origin(this.sceneW, this.sceneH);
    const uni = this.uni;
    uni.set([this.sceneW, this.sceneH, o.x, o.y, camera.zoom, 0, 0, 0]);
    device.queue.writeBuffer(this.viewUniform, 0, uni);

    if (data.byteLength > 0) {
      if (!this.instanceBuf || this.instanceCap < data.byteLength) {
        this.instanceBuf?.destroy();
        this.instanceCap = Math.max(data.byteLength, this.instanceCap * 2, 64 * INSTANCE_BYTES);
        this.instanceBuf = device.createBuffer({
          label: 'instances',
          size: this.instanceCap,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }
      device.queue.writeBuffer(this.instanceBuf, 0, data);
    }

    const enc = device.createCommandEncoder();
    const scenePass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.sceneView,
          clearValue: { r: 0.02, g: 0.02, b: 0.03, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    if (this.instanceBuf) {
      scenePass.setBindGroup(0, this.spriteBind);
      scenePass.setVertexBuffer(0, this.instanceBuf);
      for (const b of batches) {
        const p = this.spritePipelines.get(b.blend);
        if (!p) continue;
        scenePass.setPipeline(p);
        scenePass.draw(6, b.count, 0, b.first);
      }
    }
    scenePass.end();

    this.resizeToDisplay();
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const blitPass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          clearValue: { r: 0.05, g: 0.05, b: 0.06, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    const r = fitRect(this.sceneW, this.sceneH, cw, ch);
    blitPass.setViewport(r.x, r.y, r.w, r.h, 0, 1);
    blitPass.setScissorRect(r.x, r.y, r.w, r.h);
    blitPass.setPipeline(this.blitPipeline);
    blitPass.setBindGroup(0, this.blitBind);
    blitPass.draw(3);
    blitPass.end();
    device.queue.submit([enc.finish()]);
  }
}
