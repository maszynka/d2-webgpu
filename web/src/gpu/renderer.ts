// SPDX-License-Identifier: GPL-3.0-or-later
// WebGPU renderer, PLAN decision 5 + M6 G-buffer lighting (docs/lighting.md):
// paletted sprites -> G-buffer (index+palette row rg8uint, aux r8uint, height r16uint + blend layer) -> lighting pass -> scene rgba8unorm
// (native res) -> nearest blit.

import spriteWgsl from './shaders/sprite.wgsl?raw';
import blitWgsl from './shaders/blit.wgsl?raw';
import easuWgsl from './shaders/easu.wgsl?raw';
import rcasWgsl from './shaders/rcas.wgsl?raw';
import lightLib from './shaders/light.wgsl?raw';
import lightingWgsl from './shaders/lighting.wgsl?raw';
import { LIGHT_PARAMS_BYTES, MAX_LIGHTS, packLightParams, type LightingState } from './lighting';
import { surfaceWgslConstants } from './surface';
import { ShelfPacker, type AtlasRect } from './atlas';
import { BLEND_ID, INSTANCE_BYTES, type BlendMode, DrawList } from './drawlist';
import { requestGpu, type GpuContext } from './device';
import { fitRect, type Rect } from './fit';
import { DEFAULT_PRESENT_MODE, DEFAULT_SHARPNESS, PARAMS_FLOATS, clampSharpness, easuConstants, packParams, planPresent, type PresentMode, type PresentPass } from './fsr';
import { GpuTimer } from './timer';
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

export { fitRect };

/** Source texture bind groups for the presentation passes. */
interface SrcBinds {
  nearest: GPUBindGroup;
  linear: GPUBindGroup;
  easu: GPUBindGroup;
}

/** What the last presentation did (debug panel, tests). */
export interface PresentInfo {
  mode: PresentMode;
  pass: PresentPass;
  srcW: number;
  srcH: number;
  canvasW: number;
  canvasH: number;
  rect: Rect;
  /** GPU time of the EASU + RCAS passes, ms (null: no timestamp-query feature, or no EASU this frame) */
  gpuMs: number | null;
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
  private sceneBinds!: SrcBinds;
  private readonly linearSampler: GPUSampler;
  private readonly easuBgl: GPUBindGroupLayout;
  private readonly easuPipeline: GPURenderPipeline;
  private readonly rcasPipeline: GPURenderPipeline;
  private readonly paramsBuf: GPUBuffer;
  private readonly paramsData = new Float32Array(PARAMS_FLOATS);
  private easuTex: GPUTexture | null = null;
  private rcasBind: GPUBindGroup | null = null;
  private readonly timer: GpuTimer | null;
  presentMode: PresentMode = DEFAULT_PRESENT_MODE;
  sharpness = DEFAULT_SHARPNESS;
  lastPresent: PresentInfo | null = null;
  private readonly blitBgl: GPUBindGroupLayout;
  private readonly blitSampler: GPUSampler;
  private frameTex: GPUTexture | null = null;
  private frameBinds: SrcBinds | null = null;
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
    this.linearSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.easuBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const easuLayout = device.createPipelineLayout({ bindGroupLayouts: [this.easuBgl] });
    const easuModule = device.createShaderModule({ label: 'easu', code: easuWgsl });
    const rcasModule = device.createShaderModule({ label: 'rcas', code: rcasWgsl });
    this.easuPipeline = device.createRenderPipeline({
      label: 'easu',
      layout: easuLayout,
      vertex: { module: easuModule, entryPoint: 'vs' },
      fragment: { module: easuModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.rcasPipeline = device.createRenderPipeline({
      label: 'rcas',
      layout: easuLayout,
      vertex: { module: rcasModule, entryPoint: 'vs' },
      fragment: { module: rcasModule, entryPoint: 'fs', targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    this.paramsBuf = device.createBuffer({ label: 'present-params', size: PARAMS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.timer = device.features.has('timestamp-query') ? new GpuTimer(device, 2) : null;
    this.sceneBinds = this.makeBinds(this.sceneView);
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

  /** Presentation: FSR1 (EASU + RCAS), nearest (integer scale) or bilinear; RCAS sharpness in stops (0 sharpest .. 2). */
  setPresent(mode: PresentMode, sharpness: number = this.sharpness): void {
    this.presentMode = mode;
    this.sharpness = clampSharpness(sharpness);
  }

  /** Match the canvas backing store to its CSS size at the device pixel ratio. */
  resizeToDisplay(): void {
    const dpr = window.devicePixelRatio || 1;
    const max = this.device.limits.maxTextureDimension2D;
    const w = Math.min(max, Math.max(1, Math.round(this.canvas.clientWidth * dpr)));
    const h = Math.min(max, Math.max(1, Math.round(this.canvas.clientHeight * dpr)));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private makeBinds(view: GPUTextureView): SrcBinds {
    const bg = (sampler: GPUSampler) =>
      this.device.createBindGroup({ layout: this.blitBgl, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sampler }] });
    return {
      nearest: bg(this.blitSampler),
      linear: bg(this.linearSampler),
      easu: this.device.createBindGroup({ layout: this.easuBgl, entries: [{ binding: 0, resource: { buffer: this.paramsBuf } }, { binding: 1, resource: view }] }),
    };
  }

  /** Encode the passes that show a srcW x srcH texture on the canvas in the current presentation mode. */
  private encodePresent(enc: GPUCommandEncoder, binds: SrcBinds, srcW: number, srcH: number): void {
    this.resizeToDisplay();
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const plan = planPresent(this.presentMode, srcW, srcH, cw, ch);
    const r = plan.rect;
    this.lastRect = r;
    const target = this.ctx.getCurrentTexture().createView();
    const clear = { r: 0.02, g: 0.02, b: 0.025, a: 1 };
    let gpuMs: number | null = null;
    if (plan.pass === 'easu-rcas') {
      if (!this.easuTex || this.easuTex.width !== r.w || this.easuTex.height !== r.h) {
        this.easuTex?.destroy();
        this.easuTex = this.device.createTexture({
          label: 'easu-out',
          size: [r.w, r.h],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.rcasBind = this.device.createBindGroup({
          layout: this.easuBgl,
          entries: [{ binding: 0, resource: { buffer: this.paramsBuf } }, { binding: 1, resource: this.easuTex.createView() }],
        });
      }
      this.device.queue.writeBuffer(this.paramsBuf, 0, packParams(this.paramsData, easuConstants(srcW, srcH, srcW, srcH, r.w, r.h), this.sharpness, r) as Float32Array<ArrayBuffer>);
      const timed = this.timer?.begin() ?? false;
      const easu = enc.beginRenderPass({
        colorAttachments: [{ view: this.easuTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        ...(timed ? { timestampWrites: this.timer!.writes() } : {}),
      });
      easu.setPipeline(this.easuPipeline);
      easu.setBindGroup(0, binds.easu);
      easu.draw(3);
      easu.end();
      const rcas = enc.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: clear }],
        ...(timed ? { timestampWrites: this.timer!.writes() } : {}),
      });
      rcas.setViewport(r.x, r.y, r.w, r.h, 0, 1);
      rcas.setScissorRect(r.x, r.y, r.w, r.h);
      rcas.setPipeline(this.rcasPipeline);
      rcas.setBindGroup(0, this.rcasBind!);
      rcas.draw(3);
      rcas.end();
      if (timed) this.timer!.finish(enc);
      gpuMs = this.timer ? this.timer.avgMs : null;
    } else {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: clear }] });
      pass.setViewport(r.x, r.y, r.w, r.h, 0, 1);
      pass.setScissorRect(r.x, r.y, r.w, r.h);
      pass.setPipeline(this.blitPipeline);
      pass.setBindGroup(0, plan.pass === 'nearest' ? binds.nearest : binds.linear);
      pass.draw(3);
      pass.end();
    }
    this.lastPresent = { mode: this.presentMode, pass: plan.pass, srcW, srcH, canvasW: cw, canvasH: ch, rect: r, gpuMs };
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

    this.encodePresent(enc, this.sceneBinds, this.sceneW, this.sceneH);
    device.queue.submit([enc.finish()]);
  }

  /**
   * Show a finished RGBA frame (the full game's CPU framebuffer, any width, e.g. widescreen) through the same
   * presentation path as the scene (FSR1 / nearest / bilinear): upload to an rgba8unorm texture.
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
      this.frameBinds = this.makeBinds(this.frameTex.createView());
      this.frameW = width;
      this.frameH = height;
    }
    device.queue.writeTexture(
      { texture: this.frameTex },
      rgba as Uint8Array<ArrayBuffer>,
      { bytesPerRow: width * 4, rowsPerImage: height },
      [width, height],
    );
    const enc = device.createCommandEncoder();
    this.encodePresent(enc, this.frameBinds!, width, height);
    device.queue.submit([enc.finish()]);
  }
}
