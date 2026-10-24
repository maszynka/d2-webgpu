// SPDX-License-Identifier: GPL-3.0-or-later
// WebGPU renderer, PLAN decision 5 + M6 G-buffer lighting (docs/lighting.md):
// paletted sprites -> G-buffer (index+palette row rg8uint, aux r8uint, height r16uint + blend layer) -> lighting pass -> scene rgba8unorm
// (native res) -> nearest blit.

import spriteWgsl from './shaders/sprite.wgsl?raw';
import blitWgsl from './shaders/blit.wgsl?raw';
import lightLib from './shaders/light.wgsl?raw';
import lightingWgsl from './shaders/lighting.wgsl?raw';
import { LIGHT_PARAMS_BYTES, MAX_LIGHTS, packLightParams, type LightingState } from './lighting';
import { surfaceWgslConstants } from './surface';
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
const INDEX_FORMAT: GPUTextureFormat = 'rg8uint'; // palette index, palette row
const AUX_FORMAT: GPUTextureFormat = 'r8uint';
const HEIGHT_FORMAT: GPUTextureFormat = 'r16uint'; // MRT bytes/sample: 2 + 1 + 2 + 4 = 9 (limit 32)
const BLEND_FORMAT: GPUTextureFormat = 'rgba8unorm';
const SHADER_PREFIX = surfaceWgslConstants(MAX_LIGHTS) + lightLib;
const DEFAULT_LIGHTING: LightingState = { mode: 'off', ambient: 1, lights: [] };

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
  private readonly gIndex: GPUTexture;
  private readonly gAux: GPUTexture;
  private readonly gHeight: GPUTexture;
  private readonly gBlend: GPUTexture;
  private readonly gViews: GPUTextureView[];
  private readonly lightBuf: GPUBuffer;
  private readonly lightingBind: GPUBindGroup;
  private readonly lightingPipeline: GPURenderPipeline;
  private lighting: LightingState = DEFAULT_LIGHTING;
  private colormapRows = 1;
  lastLights = 0;
  private readonly uni = new Float32Array(8);
  private readonly lightScratch = new ArrayBuffer(LIGHT_PARAMS_BYTES);
  /** G-buffer MRT attachments, built once (the G-buffer has a fixed scene size, so there is no resize to react to) */
  private readonly gAttachments: GPURenderPassColorAttachment[];
  private readonly viewUniform: GPUBuffer;
  private readonly spriteBind: GPUBindGroup;
  private readonly blitBind: GPUBindGroup;
  private readonly blitBgl: GPUBindGroupLayout;
  private readonly blitSampler: GPUSampler;
  private frameTex: GPUTexture | null = null;
  private frameBind: GPUBindGroup | null = null;
  private frameW = 0;
  private frameH = 0;
  /** where the last presented RGBA frame sits on the canvas (canvas device pixels) */
  lastRect = { x: 0, y: 0, w: 1, h: 1 };
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
    const gTex = (label: string, format: GPUTextureFormat): GPUTexture =>
      device.createTexture({
        label,
        size: [this.sceneW, this.sceneH],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.gIndex = gTex('g-index', INDEX_FORMAT);
    this.gAux = gTex('g-aux', AUX_FORMAT);
    this.gHeight = gTex('g-height', HEIGHT_FORMAT);
    this.gBlend = gTex('g-blend', BLEND_FORMAT);
    this.gViews = [this.gIndex, this.gAux, this.gHeight, this.gBlend].map((t) => t.createView());
    this.gAttachments = this.gViews.map((view) => ({
      view,
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: 'clear' as const,
      storeOp: 'store' as const,
    }));
    this.lightBuf = device.createBuffer({
      label: 'light-params',
      size: LIGHT_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.viewUniform = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const spriteModule = device.createShaderModule({ label: 'sprite', code: SHADER_PREFIX + spriteWgsl });
    const spriteBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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
        { binding: 4, resource: { buffer: this.lightBuf } },
      ],
    });
    // Blended records accumulate premultiplied "over" colour in the blend layer (integer targets cannot blend):
    // out = src.rgb * a (premultiplied) + dst * (1 - a); additive: src + dst with alpha 0.
    const over: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const blends: Record<BlendMode, GPUBlendState | undefined> = {
      opaque: undefined,
      alpha50: over,
      additive: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      },
      darken: over,
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
                  { shaderLocation: 4, offset: 40, format: 'sint32x2' },
                ],
              },
            ],
          },
          fragment: {
            module: spriteModule,
            entryPoint: 'fs',
            constants: { blend_mode: BLEND_ID[mode] },
            // integer targets: no blend state allowed, so blended records mask them out entirely
            targets: [
              { format: INDEX_FORMAT, writeMask: mode === 'opaque' ? GPUColorWrite.ALL : 0 },
              { format: AUX_FORMAT, writeMask: mode === 'opaque' ? GPUColorWrite.ALL : 0 },
              { format: HEIGHT_FORMAT, writeMask: mode === 'opaque' ? GPUColorWrite.ALL : 0 },
              blend ? { format: BLEND_FORMAT, blend } : { format: BLEND_FORMAT },
            ],
          },
          primitive: { topology: 'triangle-list' },
        }),
      );
    }

    const lightingModule = device.createShaderModule({ label: 'lighting', code: SHADER_PREFIX + lightingWgsl });
    const uintTex = { sampleType: 'uint' } as const;
    const lightingBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: uintTex },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: uintTex },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: uintTex },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: uintTex },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.lightingPipeline = device.createRenderPipeline({
      label: 'lighting',
      layout: device.createPipelineLayout({ bindGroupLayouts: [lightingBgl] }),
      vertex: { module: lightingModule, entryPoint: 'vs' },
      fragment: { module: lightingModule, entryPoint: 'fs', targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.lightingBind = device.createBindGroup({
      layout: lightingBgl,
      entries: [
        { binding: 0, resource: { buffer: this.viewUniform } },
        { binding: 1, resource: { buffer: this.lightBuf } },
        { binding: 2, resource: this.gViews[0]! },
        { binding: 3, resource: this.gViews[1]! },
        { binding: 4, resource: this.gViews[2]! },
        { binding: 5, resource: this.gViews[3]! },
        { binding: 6, resource: this.colormaps.createView() },
        { binding: 7, resource: this.palettes.createView() },
      ],
    });

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
    this.blitBgl = blitBgl;
    this.blitSampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    this.blitBind = device.createBindGroup({
      layout: blitBgl,
      entries: [
        { binding: 0, resource: this.sceneView },
        { binding: 1, resource: this.blitSampler },
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
    this.colormapRows = Math.max(1, rows);
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

  /** Lighting for the next frames (mode, ambient, point lights). Lights beyond MAX_LIGHTS are ignored. */
  setLighting(l: LightingState): void {
    this.lighting = l;
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
    device.queue.writeBuffer(this.lightBuf, 0, packLightParams(this.lighting, this.colormapRows, this.lightScratch));
    this.lastLights = Math.min(MAX_LIGHTS, this.lighting.lights.length);

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
      colorAttachments: this.gAttachments,
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

    const lightPass = enc.beginRenderPass({
      colorAttachments: [{ view: this.sceneView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    lightPass.setPipeline(this.lightingPipeline);
    lightPass.setBindGroup(0, this.lightingBind);
    lightPass.draw(3);
    lightPass.end();

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

  /**
   * Show a finished RGBA frame (the full game's CPU framebuffer, any width, e.g. widescreen) through the same
   * nearest blit as the scene: upload to an rgba8unorm texture, integer-scale letterbox onto the canvas.
   */
  presentRgba(width: number, height: number, rgba: Uint8Array): void {
    if (rgba.length < width * height * 4) throw new Error('presentRgba: pixel buffer too small');
    const device = this.device;
    if (!this.frameTex || this.frameW !== width || this.frameH !== height) {
      this.frameTex?.destroy();
      this.frameTex = device.createTexture({
        label: 'full-frame',
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.frameBind = device.createBindGroup({
        layout: this.blitBgl,
        entries: [
          { binding: 0, resource: this.frameTex.createView() },
          { binding: 1, resource: this.blitSampler },
        ],
      });
      this.frameW = width;
      this.frameH = height;
    }
    device.queue.writeTexture(
      { texture: this.frameTex },
      rgba as Uint8Array<ArrayBuffer>,
      { bytesPerRow: width * 4, rowsPerImage: height },
      [width, height],
    );
    this.resizeToDisplay();
    const r = fitRect(width, height, this.canvas.width, this.canvas.height);
    this.lastRect = r;
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0.05, g: 0.05, b: 0.06, a: 1 }, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setViewport(r.x, r.y, r.w, r.h, 0, 1);
    pass.setScissorRect(r.x, r.y, r.w, r.h);
    pass.setPipeline(this.blitPipeline);
    pass.setBindGroup(0, this.frameBind);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
}
