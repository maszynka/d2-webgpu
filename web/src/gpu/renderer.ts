// SPDX-License-Identifier: GPL-3.0-or-later
// WebGPU renderer with G-buffer lighting:
// paletted sprites -> G-buffer (index+palette row rg8uint, aux r8uint, height r16uint + blend layer) -> lighting pass -> scene rgba8unorm
// (native res) -> nearest blit.

import spriteWgsl from './shaders/sprite.wgsl?raw';
import blitWgsl from './shaders/blit.wgsl?raw';
import easuWgsl from './shaders/easu.wgsl?raw';
import rcasWgsl from './shaders/rcas.wgsl?raw';
import lightLib from './shaders/light.wgsl?raw';
import lightingWgsl from './shaders/lighting.wgsl?raw';
import loupeWgsl from './shaders/loupe.wgsl?raw';
import uiWgsl from './shaders/ui.wgsl?raw';
import downsampleWgsl from './shaders/downsample.wgsl?raw';
import { planCompare } from './compare';
import { DEFAULT_DENSITY, densitySize, effectiveDpr, type Density } from './density';
import { StageResample, type ResampleDeps } from './resample';
import { clearStageFailed, createStage, markStageFailed, setStageLoading } from './upscale/registry';
import type { UpscaleStage } from './upscale/stage';
import { DEFAULT_UI_SCALER, maskKey, planMask, rasterizeMask, sharpPrescale, type MaskKind, type UiScaler } from './uimask';
import type { UiInfo } from '../full/uitrailer';
import { loupeLayout } from './loupe';
import { LIGHT_PARAMS_BYTES, MAX_LIGHTS, packLightParams, type LightingState } from './lighting';
import { surfaceWgslConstants } from './surface';
import { ShelfPacker, type AtlasRect } from './atlas';
import { BLEND_ID, INSTANCE_BYTES, type BlendMode, DrawList } from './drawlist';
import { requestGpu, type GpuContext } from './device';
import { fitRect, type Rect } from './fit';
import { DEFAULT_PRESENT_MODE, DEFAULT_SHARPNESS, PARAMS_FLOATS, clampSharpness, easuConstants, packParams, pixelPrescale, planPresent, type PresentMode, type PresentPass } from './fsr';
import { GpuTimer, type GpuTag } from './timer';
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

const STAGE_RETRY_MS = 30_000; // a failed async stage (weights fetch) becomes selectable again after this
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
  view: GPUTextureView;
  nearest: GPUBindGroup;
  linear: GPUBindGroup;
  /** loupe bind group (composite + this source), valid for `loupeFor` */
  loupe?: GPUBindGroup;
  loupeFor?: GPUTexture;
}

export interface CompareState {
  on: boolean;
  a: PresentMode;
  b: PresentMode;
  /** divider position, fraction of the canvas width */
  split: number;
  /** RCAS sharpness (stops) per side while that side is FSR1 */
  sharpA: number;
  sharpB: number;
}
export interface LoupeState {
  on: boolean;
  /** the pointer is over the canvas (the square is drawn) */
  visible: boolean;
  /** pointer position on the canvas, device px */
  x: number;
  y: number;
  zoom: number;
  /** square edge, device px */
  size: number;
  /** show native-frame pixels instead of the composed output */
  source: boolean;
}

interface FsrChain {
  k: number;
  preTex: GPUTexture | null;
  preView: GPUTextureView | null;
  easuTex: GPUTexture;
  easuBind: GPUBindGroup;
  rcasA: GPUBindGroup;
  rcasB: GPUBindGroup;
  show: GPUBindGroup;
  bufA: GPUBuffer;
  bufB: GPUBuffer;
  srcView: GPUTextureView;
  preW: number;
  preH: number;
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
  /** GPU time of the timed FSR passes, ms, summed over the parts (null: no timestamp-query feature, no result yet, or no EASU) */
  gpuMs: number | null;
  /** what was timed, per side (side 0 = single mode or A, 1 = B): label such as "prescale+EASU+RCAS" and ms */
  gpuParts: { side: number; label: string; ms: number }[];
  /** A/B compare: both sides' modes and passes, the divider in canvas px (null: single mode) */
  compare: { a: PresentMode; b: PresentMode; passA: PresentPass; passB: PresentPass; splitPx: number; prescaleA: number; prescaleB: number } | null;
  /** live FSR chains after this frame (only the ones in use are kept) */
  chains: number;
  /** nearest prescale factor before EASU ("FSR1 (pixel-art)"); 1 = none */
  prescale: number;
  /** world stage that ran (concrete registered mode) for side A / single mode, null when none */
  stage: string | null;
  /** UI scaler state: setting, what the frame's mask covered, rect count, whether the UI pass ran */
  ui: { scaler: UiScaler; screen: number | null; kind: MaskKind; rects: number; applied: boolean };
  /** render density setting and the backing pixels per CSS pixel actually used (device dpr in auto) */
  density: Density;
  dprEffective: number;
  /** the loupe square on the canvas (device px) while it is drawn */
  loupe: { box: Rect; center: { x: number; y: number }; zoom: number; source: boolean } | null;
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
  private readonly paramsData = new Float32Array(PARAMS_FLOATS);
  /** FSR chains keyed by the nearest prescale factor (1 = none): EASU input, EASU output, RCAS bind groups, params */
  private readonly chains = new Map<number, FsrChain>();
  private blitRgbaPipeline!: GPURenderPipeline;
  /** exact device-pixel size of the canvas from the ResizeObserver (null until it reports, or unsupported) */
  private devPx: { w: number; h: number } | null = null;
  private readonly timer: GpuTimer | null;
  /** content-box size in CSS px from the ResizeObserver (render density 1x) */
  private cssBox: { w: number; h: number } | null = null;
  density: Density = DEFAULT_DENSITY;
  uiScaler: UiScaler = DEFAULT_UI_SCALER;
  /** the game's UI info of the current frame (screen id + rects); sticky until the next frame / setUi */
  private ui: UiInfo | null = null;
  private maskTex: GPUTexture | null = null;
  private maskKeyNow = '';
  private maskScratch = new Uint8Array(0);
  private readonly uiBgl: GPUBindGroupLayout;
  private readonly uiPipeline: GPURenderPipeline;
  private readonly downPipeline: GPURenderPipeline;
  private readonly uiBuf: GPUBuffer;
  private readonly uiData = new Float32Array(12);
  private uiBind: GPUBindGroup | null = null;
  private uiBindFor: { src: GPUTextureView; mask: GPUTexture } | null = null;
  /** live stages by concrete mode, resamplers by compare side; both dropped when a frame does not use them */
  private readonly stages = new Map<string, UpscaleStage>();
  private readonly resamplers = new Map<number, StageResample>();
  private texCreated = 0;
  private texDestroyed = 0;
  presentMode: PresentMode = DEFAULT_PRESENT_MODE;
  sharpness = DEFAULT_SHARPNESS;
  lastPresent: PresentInfo | null = null;
  compare: CompareState = { on: false, a: 'nearest-stretch', b: 'fsr1', split: 0.5, sharpA: DEFAULT_SHARPNESS, sharpB: DEFAULT_SHARPNESS };
  loupe: LoupeState = { on: false, visible: false, x: 0, y: 0, zoom: 8, size: 256, source: false };
  /** frames handed to render() / presentRgba() (not repaints): the HUD's presented-frame counter */
  presentCount = 0;
  /** set when a presentation setting changed: callers that only present on new frames should repaint() */
  presentDirty = false;
  private lastSrc: { binds: SrcBinds; w: number; h: number } | null = null;
  private composite: GPUTexture | null = null;
  private compositeBind: GPUBindGroup | null = null;
  private loupePipeline!: GPURenderPipeline;
  private loupeBgl!: GPUBindGroupLayout;
  private loupeBuf!: GPUBuffer;
  private readonly loupeData = new Float32Array(16);
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

    this.atlas = this.tex({
      label: 'index-atlas',
      size: [this.atlasSize, this.atlasSize],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.colormaps = this.tex({
      label: 'colormaps',
      size: [256, COLORMAP_ROWS_MAX],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.palettes = this.tex({
      label: 'palettes',
      size: [256, PALETTE_ROWS_MAX],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.scene = this.tex({
      label: 'scene',
      size: [this.sceneW, this.sceneH],
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sceneView = this.scene.createView();
    const gTex = (label: string, format: GPUTextureFormat): GPUTexture =>
      this.tex({
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
    this.blitRgbaPipeline = device.createRenderPipeline({
      label: 'blit-rgba',
      layout: device.createPipelineLayout({ bindGroupLayouts: [blitBgl] }),
      vertex: { module: blitModule, entryPoint: 'vs' },
      fragment: { module: blitModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.loupeBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const loupeModule = device.createShaderModule({ label: 'loupe', code: loupeWgsl });
    this.loupePipeline = device.createRenderPipeline({
      label: 'loupe',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.loupeBgl] }),
      vertex: { module: loupeModule, entryPoint: 'vs' },
      fragment: { module: loupeModule, entryPoint: 'fs', targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    this.loupeBuf = device.createBuffer({ label: 'loupe-params', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uiBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const uiModule = device.createShaderModule({ label: 'ui', code: uiWgsl });
    this.uiPipeline = device.createRenderPipeline({
      label: 'ui',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.uiBgl] }),
      vertex: { module: uiModule, entryPoint: 'vs' },
      fragment: { module: uiModule, entryPoint: 'fs', targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    this.uiBuf = device.createBuffer({ label: 'ui-params', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const downModule = device.createShaderModule({ label: 'downsample', code: downsampleWgsl });
    this.downPipeline = device.createRenderPipeline({
      label: 'downsample',
      layout: easuLayout,
      vertex: { module: downModule, entryPoint: 'vs' },
      fragment: { module: downModule, entryPoint: 'fs', targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    try {
      new ResizeObserver((entries) => {
        for (const e of entries) {
          const b = e.contentBoxSize?.[0];
          if (b) this.cssBox = { w: b.inlineSize, h: b.blockSize };
        }
        this.presentDirty = true;
      }).observe(canvas, { box: 'content-box' });
    } catch {
      /* content-box unsupported: clientWidth / clientHeight below */
    }
    try {
      new ResizeObserver((entries) => {
        for (const e of entries) {
          const b = e.devicePixelContentBoxSize?.[0];
          if (b) this.devPx = { w: b.inlineSize, h: b.blockSize };
        }
        this.presentDirty = true; // a paused source is repainted at the new size
      }).observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      /* no device-pixel-content-box: client size * dpr below */
    }
    this.timer = device.features.has('timestamp-query') ? new GpuTimer(device, 32) : null;
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
    this.presentDirty = true;
  }

  /** A/B compare: mode A left of the divider, mode B right, same rect for both. */
  setCompare(c: CompareState): void {
    this.compare = { ...c };
    this.presentDirty = true;
  }

  /** Loupe state (cheap; the composite path is only used while the loupe is on and the pointer is over the canvas). */
  setLoupe(l: Partial<LoupeState>): void {
    this.loupe = { ...this.loupe, ...l };
    this.presentDirty = true;
  }

  /** UI scaler for menus / HUD / panels (sharp bilinear, same as the world, nearest). */
  setUiScaler(m: UiScaler): void {
    this.uiScaler = m;
    this.presentDirty = true;
  }

  /** Render density: 'auto' = device pixels, '1' = CSS pixels (the browser scales the canvas). */
  setDensity(d: Density): void {
    this.density = d;
    this.presentDirty = true;
  }

  /** The game's UI info (screen id + rects) for the frame being presented; null = none (the world scaler everywhere). */
  setUi(info: UiInfo | null): void {
    this.ui = info;
    this.presentDirty = true;
  }

  /** The UI info of the frame last presented (screen id, rects) - the HUD / tests read it. */
  get currentUi(): UiInfo | null {
    return this.ui;
  }

  /** Backing pixels per CSS pixel actually in use. */
  get effectiveDpr(): number {
    return effectiveDpr(this.canvas.width, this.canvas.clientWidth);
  }

  /** Textures created / destroyed through the renderer and alive in its stages (leak tests). */
  textureStats(): { created: number; destroyed: number; live: number; stages: number; resample: number } {
    let stages = 0;
    for (const st of this.stages.values()) stages += st.liveTextures();
    let resample = 0;
    for (const rs of this.resamplers.values()) resample += rs.live;
    return { created: this.texCreated, destroyed: this.texDestroyed, live: this.texCreated - this.texDestroyed, stages, resample };
  }

  private tex(desc: GPUTextureDescriptor): GPUTexture {
    this.texCreated++;
    return this.device.createTexture(desc);
  }

  private killTex(t: GPUTexture): void {
    this.texDestroyed++;
    t.destroy();
  }

  /** Present the last source again (a setting or the loupe moved and no new frame arrived). */
  repaint(): void {
    if (!this.lastSrc) return;
    const enc = this.device.createCommandEncoder();
    this.encodePresent(enc, this.lastSrc.binds, this.lastSrc.w, this.lastSrc.h);
    this.device.queue.submit([enc.finish()]);
  }

  /** Match the canvas backing store to its size in device pixels (the observer's exact box, else client size * dpr). */
  resizeToDisplay(): void {
    const { w, h } = densitySize(this.density, this.devPx, this.cssBox, this.canvas.clientWidth, this.canvas.clientHeight, window.devicePixelRatio || 1, this.device.limits.maxTextureDimension2D);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private makeBinds(view: GPUTextureView): SrcBinds {
    const bg = (sampler: GPUSampler) =>
      this.device.createBindGroup({ layout: this.blitBgl, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sampler }] });
    return {
      view,
      nearest: bg(this.blitSampler),
      linear: bg(this.linearSampler),
    };
  }

  /** The (re)built EASU chain for nearest prescale k at this rect / source: textures and bind groups follow size changes. */
  private fsrChain(k: number, binds: SrcBinds, srcW: number, srcH: number, r: Rect): FsrChain {
    let ch = this.chains.get(k);
    const preW = srcW * k;
    const preH = srcH * k;
    if (ch && ch.easuTex.width === r.w && ch.easuTex.height === r.h && ch.srcView === binds.view && ch.preW === preW && ch.preH === preH) return ch;
    const d = this.device;
    const rt = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    if (ch) {
      this.killTex(ch.easuTex);
      if (ch.preTex) this.killTex(ch.preTex);
    }
    const bufA = ch?.bufA ?? d.createBuffer({ label: `present-params-a${k}`, size: PARAMS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bufB = ch?.bufB ?? d.createBuffer({ label: `present-params-b${k}`, size: PARAMS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const preTex = k > 1 ? this.tex({ label: `prescale-${k}x`, size: [preW, preH], format: 'rgba8unorm', usage: rt }) : null;
    const preView = preTex ? preTex.createView() : null;
    const easuTex = this.tex({ label: 'easu-out', size: [r.w, r.h], format: 'rgba8unorm', usage: rt });
    const ev = easuTex.createView();
    const bg = (buf: GPUBuffer, view: GPUTextureView): GPUBindGroup =>
      d.createBindGroup({ layout: this.easuBgl, entries: [{ binding: 0, resource: { buffer: buf } }, { binding: 1, resource: view }] });
    ch = {
      k,
      preTex,
      preView,
      easuTex,
      easuBind: bg(bufA, preView ?? binds.view),
      rcasA: bg(bufA, ev),
      rcasB: bg(bufB, ev),
      show: d.createBindGroup({ layout: this.blitBgl, entries: [{ binding: 0, resource: ev }, { binding: 1, resource: this.blitSampler }] }),
      bufA,
      bufB,
      srcView: binds.view,
      preW,
      preH,
    };
    this.chains.set(k, ch);
    return ch;
  }

  private destroyChain(ch: FsrChain): void {
    this.killTex(ch.easuTex);
    if (ch.preTex) this.killTex(ch.preTex);
    ch.bufA.destroy();
    ch.bufB.destroy();
  }

  /** Number of live FSR chains (tests). */
  get chainCount(): number {
    return this.chains.size;
  }

  /** Release the presentation resources owned by the renderer's FSR / composite stages. */
  dispose(): void {
    this.disposed = true;
    for (const ch of this.chains.values()) this.destroyChain(ch);
    this.chains.clear();
    if (this.composite) this.killTex(this.composite);
    this.composite = null;
    if (this.frameTex) this.killTex(this.frameTex);
    this.frameTex = null;
    for (const st of this.stages.values()) st.destroy();
    this.stages.clear();
    for (const st of this.deadStages.splice(0)) st.destroy();
    for (const rs of this.resamplers.values()) rs.destroy();
    this.resamplers.clear();
    if (this.maskTex) this.killTex(this.maskTex);
    this.maskTex = null;
  }

  private ensureComposite(w: number, h: number): GPUTexture {
    if (!this.composite || this.composite.width !== w || this.composite.height !== h) {
      if (this.composite) this.killTex(this.composite);
      this.composite = this.tex({
        label: 'composite',
        size: [w, h],
        format: this.canvasFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.compositeBind = this.device.createBindGroup({
        layout: this.blitBgl,
        entries: [{ binding: 0, resource: this.composite.createView() }, { binding: 1, resource: this.blitSampler }],
      });
    }
    return this.composite;
  }

  /** De-dither before the smooth stages (read by their factories); toggling rebuilds the live smooth stages */
  dedither = true;
  setDedither(on: boolean): void {
    if (on === this.dedither) return;
    this.dedither = on;
    for (const [mode, st] of this.stages) {
      if (!mode.startsWith('smooth')) continue;
      st.destroy();
      this.stages.delete(mode);
    }
    this.presentDirty = true;
  }
  private readonly pendingStages = new Set<string>();
  /** Stages whose encode threw: destroyed at the next present, after the frame that recorded their passes was submitted. */
  private readonly deadStages: UpscaleStage[] = [];
  private disposed = false;

  /** The live stage for a concrete mode, or false while an async factory is still building it (presentDirty on resolve). */
  private ensureStage(mode: string): boolean {
    if (this.stages.has(mode)) return true;
    if (this.pendingStages.has(mode)) return false;
    let made: UpscaleStage | Promise<UpscaleStage>;
    try {
      made = createStage(mode, this.device);
    } catch (e) {
      console.error(`upscale stage ${mode} failed:`, e);
      markStageFailed(mode);
      return false;
    }
    if (!(made instanceof Promise)) {
      this.stages.set(mode, made);
      return true;
    }
    this.pendingStages.add(mode);
    setStageLoading(mode, true);
    made.then(
      (st) => {
        this.pendingStages.delete(mode);
        if (this.disposed || this.stages.has(mode)) st.destroy();
        else this.stages.set(mode, st);
        this.presentDirty = true;
        setStageLoading(mode, false);
      },
      (e: unknown) => {
        console.error(`upscale stage ${mode} failed:`, e);
        this.pendingStages.delete(mode);
        this.presentDirty = true;
        markStageFailed(mode);
        setStageLoading(mode, false);
        setTimeout(() => clearStageFailed(mode), STAGE_RETRY_MS); // e.g. a failed weights fetch: offer it again later
      },
    );
    return false;
  }

  /** The resample deps stage outputs need (pipelines are the renderer's own). */
  private resampleDeps(): ResampleDeps {
    return {
      device: this.device,
      createTex: (d) => this.tex(d),
      destroyTex: (t) => this.killTex(t),
      easuBgl: this.easuBgl,
      blitBgl: this.blitBgl,
      easuPipeline: this.easuPipeline,
      rcasPipeline: this.rcasPipeline,
      blitPipeline: this.blitPipeline,
      downPipeline: this.downPipeline,
      nearest: this.blitSampler,
    };
  }

  /** The native-resolution UI mask texture for this frame's plan (re-uploaded only when it changed); null when not needed. */
  private ensureMask(kind: MaskKind, rects: readonly { x: number; y: number; w: number; h: number }[], w: number, h: number): GPUTexture {
    if (!this.maskTex || this.maskTex.width !== w || this.maskTex.height !== h) {
      if (this.maskTex) this.killTex(this.maskTex);
      this.maskTex = this.tex({ label: 'ui-mask', size: [w, h], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.maskKeyNow = '';
      this.uiBind = null;
    }
    const key = maskKey({ kind, rects: rects as never[] }, w, h);
    if (key !== this.maskKeyNow) {
      if (this.maskScratch.length < w * h) this.maskScratch = new Uint8Array(w * h);
      rasterizeMask(this.maskScratch, w, h, kind === 'rects' ? rects : []);
      this.device.queue.writeTexture({ texture: this.maskTex }, this.maskScratch as Uint8Array<ArrayBuffer>, { bytesPerRow: w, rowsPerImage: h }, [w, h]);
      this.maskKeyNow = key;
    }
    return this.maskTex;
  }

  /** Encode the passes that show a srcW x srcH texture on the canvas in the current presentation mode. */
  private encodePresent(enc: GPUCommandEncoder, binds: SrcBinds, srcW: number, srcH: number): void {
    for (const st of this.deadStages.splice(0)) st.destroy();
    this.resizeToDisplay();
    this.presentDirty = false;
    this.lastSrc = { binds, w: srcW, h: srcH };
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const cmp = this.compare.on ? planCompare(this.compare.a, this.compare.b, this.compare.split, srcW, srcH, cw, ch) : null;
    const plan = cmp ? null : planPresent(this.presentMode, srcW, srcH, cw, ch);
    const r = cmp ? cmp.rect : plan!.rect;
    this.lastRect = r;
    const maxTex = this.device.limits.maxTextureDimension2D;
    const kOf = (m: PresentMode, pass: PresentPass): number => (m === 'fsr1-pixel' && pass === 'easu-rcas' ? pixelPrescale(r, srcW, srcH, maxTex) : 1);
    type Seg = { pass: PresentPass; scissor: Rect | null; side: number; sharp: number; k: number; stage?: string | undefined };
    const segs: Seg[] = cmp
      ? [
          { ...cmp.a, side: 0, sharp: this.compare.sharpA, k: kOf(cmp.a.mode, cmp.a.pass) },
          { ...cmp.b, side: 1, sharp: this.compare.sharpB, k: kOf(cmp.b.mode, cmp.b.pass) },
        ]
      : [{ pass: plan!.pass, scissor: r, side: 0, sharp: this.sharpness, k: kOf(this.presentMode, plan!.pass), stage: plan!.stage }];
    // a stage that is not built yet (async factory in flight) presents with FSR1 until it resolves
    for (const g of segs) {
      if (g.pass !== 'stage' || !g.stage || this.ensureStage(g.stage)) continue;
      g.pass = r.w > srcW || r.h > srcH ? 'easu-rcas' : 'bilinear';
      g.stage = undefined;
    }
    const loupeOn =
      this.loupe.on && this.loupe.visible && Number.isFinite(this.loupe.x) && Number.isFinite(this.loupe.y) && Number.isFinite(this.loupe.size) && this.loupe.size > 0 && cw > 0 && ch > 0;
    const canvasView = this.ctx.getCurrentTexture().createView();
    const target = loupeOn ? this.ensureComposite(cw, ch).createView() : canvasView;
    const clear = { r: 0.02, g: 0.02, b: 0.025, a: 1 };
    const ks = [...new Set(segs.filter((g) => g.pass === 'easu-rcas' || g.pass === 'easu').map((g) => g.k))];
    const stageModes = [...new Set(segs.filter((g) => g.pass === 'stage' && g.stage).map((g) => g.stage!))];
    // the UI pass: the game's UI pixels over the world result, with the UI scaler
    const mplan = planMask(this.ui);
    const uiOn = this.uiScaler !== 'world' && mplan.kind !== 'none';
    const timed = (ks.length > 0 || stageModes.length > 0 || uiOn) && (this.timer?.begin() ?? false);
    let spanN = 0;
    const stamp = (): { timestampWrites?: GPURenderPassTimestampWrites } => (timed ? (spanN++, { timestampWrites: this.timer!.writes() }) : {});
    const tagSides: GpuTag['sides'] = [];
    const chainSpans = new Map<number, number[]>();
    for (const k of ks) {
      const ch = this.fsrChain(k, binds, srcW, srcH, r);
      const inW = srcW * k;
      const inH = srcH * k;
      const con = easuConstants(inW, inH, inW, inH, r.w, r.h);
      const sharpOf = (side: number): number => segs.find((g) => g.side === side && g.k === k)?.sharp ?? this.sharpness;
      this.device.queue.writeBuffer(ch.bufA, 0, packParams(this.paramsData, con, sharpOf(0), r) as Float32Array<ArrayBuffer>);
      this.device.queue.writeBuffer(ch.bufB, 0, packParams(this.paramsData, con, sharpOf(1), r) as Float32Array<ArrayBuffer>);
      const spans: number[] = [];
      if (ch.preView) {
        if (timed) spans.push(spanN);
        const pre = enc.beginRenderPass({
          colorAttachments: [{ view: ch.preView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
          ...stamp(),
        });
        pre.setPipeline(this.blitRgbaPipeline);
        pre.setBindGroup(0, binds.nearest);
        pre.draw(3);
        pre.end();
      }
      if (timed) spans.push(spanN);
      const easu = enc.beginRenderPass({
        colorAttachments: [{ view: ch.easuTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        ...stamp(),
      });
      easu.setPipeline(this.easuPipeline);
      easu.setBindGroup(0, ch.easuBind);
      easu.draw(3);
      easu.end();
      chainSpans.set(k, spans);
    }
    // chains of prescale factors this frame does not use are dropped (window resize / mode / compare changes would leak them)
    for (const [k, ch] of this.chains) {
      if (ks.includes(k)) continue;
      this.destroyChain(ch);
      this.chains.delete(k);
    }
    // world stages: encode once per concrete mode, then bring each side's use of it to the rect
    const stageOut = new Map<string, import('./upscale/stage').StageOutput>();
    for (const mode of stageModes) {
      const side = segs.find((g) => g.stage === mode)!.side;
      try {
        const st = this.stages.get(mode);
        if (!st) throw new Error(`stage ${mode} not built`); // ensureStage built it above
        const out = st.encode(enc, binds.view, srcW, srcH, (label) => {
          if (!timed) return undefined;
          tagSides.push({ side, label: `${mode}: ${label}`, spans: [spanN] });
          return stamp().timestampWrites;
        });
        stageOut.set(mode, out);
      } catch (e) {
        console.error(`upscale stage ${mode} failed:`, e);
        markStageFailed(mode);
        const dead = this.stages.get(mode);
        if (dead) this.deadStages.push(dead); // passes already recorded into enc may reference its textures
        this.stages.delete(mode);
        this.presentDirty = true; // next present falls back to FSR1
      }
    }
    for (const [mode, st] of this.stages) {
      if (stageModes.includes(mode)) continue;
      st.destroy();
      this.stages.delete(mode);
    }
    const finals = new Map<number, import('./resample').ResampleFinal>();
    for (const g of segs) {
      const out = g.pass === 'stage' && g.stage ? stageOut.get(g.stage) : undefined;
      if (!out) continue;
      let rs = this.resamplers.get(g.side);
      if (!rs) {
        rs = new StageResample(this.resampleDeps());
        this.resamplers.set(g.side, rs);
      }
      finals.set(
        g.side,
        rs.prepare(enc, out, r, g.sharp, () => {
          if (!timed) return undefined;
          tagSides.push({ side: g.side, label: `${g.stage}: EASU`, spans: [spanN] });
          return stamp().timestampWrites;
        }),
      );
    }
    for (const [side, rs] of this.resamplers) {
      if (finals.has(side)) continue;
      rs.destroy();
      this.resamplers.delete(side);
    }
    segs.forEach((g, i) => {
      const gpuPass = g.pass === 'easu-rcas' || g.pass === 'easu';
      const fin = finals.get(g.side);
      const stagePass = g.pass === 'stage' && fin !== undefined;
      let rcasSpan = -1;
      if (timed && gpuPass && g.pass === 'easu-rcas') rcasSpan = spanN;
      const stageSpan = timed && stagePass && fin.kind !== 'copy' ? spanN : -1;
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: i === 0 ? 'clear' : 'load', storeOp: 'store', clearValue: clear }],
        ...(rcasSpan >= 0 || stageSpan >= 0 ? stamp() : {}),
      });
      if (timed && gpuPass) {
        const label = `${g.k > 1 ? 'prescale+' : ''}EASU${g.pass === 'easu-rcas' ? '+RCAS' : ''}`;
        tagSides.push({ side: g.side, label, spans: [...(chainSpans.get(g.k) ?? []), ...(rcasSpan >= 0 ? [rcasSpan] : [])] });
      }
      if (stageSpan >= 0) tagSides.push({ side: g.side, label: `${g.stage}: ${fin!.kind === 'down' ? 'downsample' : 'RCAS'}`, spans: [stageSpan] });
      const sc = g.scissor;
      if (sc) {
        pass.setViewport(r.x, r.y, r.w, r.h, 0, 1);
        pass.setScissorRect(sc.x, sc.y, sc.w, sc.h);
        if (stagePass) {
          pass.setPipeline(fin.pipeline);
          pass.setBindGroup(0, fin.bind);
        } else if (g.pass === 'easu-rcas') {
          pass.setPipeline(this.rcasPipeline);
          const ch = this.chains.get(g.k)!;
          pass.setBindGroup(0, g.side === 0 ? ch.rcasA : ch.rcasB);
        } else if (g.pass === 'easu') {
          pass.setPipeline(this.blitPipeline); // the EASU texture is rect-sized: a 1:1 copy
          pass.setBindGroup(0, this.chains.get(g.k)!.show);
        } else {
          pass.setPipeline(this.blitPipeline);
          pass.setBindGroup(0, g.pass === 'nearest' ? binds.nearest : binds.linear);
        }
        pass.draw(3);
      }
      pass.end();
    });
    let uiApplied = false;
    if (uiOn && r.w > 0 && r.h > 0) {
      const mask = this.ensureMask(mplan.kind, mplan.rects, srcW, srcH);
      if (!this.uiBind || this.uiBindFor?.src !== binds.view || this.uiBindFor.mask !== mask) {
        this.uiBind = this.device.createBindGroup({
          layout: this.uiBgl,
          entries: [{ binding: 0, resource: { buffer: this.uiBuf } }, { binding: 1, resource: binds.view }, { binding: 2, resource: mask.createView() }],
        });
        this.uiBindFor = { src: binds.view, mask };
      }
      const scale = Math.min(r.w / srcW, r.h / srcH);
      this.uiData.set([r.x, r.y, r.w, r.h, srcW, srcH, sharpPrescale(scale), this.uiScaler === 'nearest' ? 1 : 0, mplan.kind === 'all' ? 1 : 0, 0, 0, 0]);
      this.device.queue.writeBuffer(this.uiBuf, 0, this.uiData as Float32Array<ArrayBuffer>);
      if (timed) tagSides.push({ side: 2, label: 'UI', spans: [spanN] });
      const up = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }], ...stamp() });
      up.setViewport(r.x, r.y, r.w, r.h, 0, 1);
      up.setScissorRect(r.x, r.y, r.w, r.h);
      up.setPipeline(this.uiPipeline);
      up.setBindGroup(0, this.uiBind);
      up.draw(3);
      up.end();
      uiApplied = true;
    }
    if (timed) this.timer!.finish(enc, { key: tagSides.map((t) => `${t.side}:${t.label}`).join('|'), sides: tagSides });
    // the newest completed measurement, labelled by what it timed (it may lag a frame or two behind a mode change)
    const gpuParts: PresentInfo['gpuParts'] = [];
    const res = this.timer?.result ?? null;
    if (res) for (const s of res.tag.sides) gpuParts.push({ side: s.side, label: s.label, ms: s.spans.reduce((a, i) => a + (res.ms[i] ?? 0), 0) });
    const gpuMs: number | null = gpuParts.length > 0 ? gpuParts.reduce((a, p) => a + p.ms, 0) : null;
    let loupeInfo: PresentInfo['loupe'] = null;
    if (loupeOn) {
      const L = this.loupe;
      const lay = loupeLayout(L.x, L.y, L.size, cw, ch);
      if (binds.loupeFor !== this.composite) {
        binds.loupe = this.device.createBindGroup({
          layout: this.loupeBgl,
          entries: [
            { binding: 0, resource: { buffer: this.loupeBuf } },
            { binding: 1, resource: this.composite!.createView() },
            { binding: 2, resource: binds.view },
          ],
        });
        binds.loupeFor = this.composite!;
      }
      const d = this.loupeData;
      d.set([lay.box.x, lay.box.y, lay.box.w, L.zoom, lay.center.x, lay.center.y, cw, ch, r.x, r.y, r.w, r.h, srcW, srcH, L.source ? 1 : 0, 0]);
      this.device.queue.writeBuffer(this.loupeBuf, 0, d as Float32Array<ArrayBuffer>);
      const fin = enc.beginRenderPass({ colorAttachments: [{ view: canvasView, loadOp: 'clear', storeOp: 'store', clearValue: clear }] });
      fin.setViewport(0, 0, cw, ch, 0, 1);
      fin.setPipeline(this.blitPipeline);
      fin.setBindGroup(0, this.compositeBind!);
      fin.draw(3);
      fin.setPipeline(this.loupePipeline);
      fin.setBindGroup(0, binds.loupe!);
      fin.setScissorRect(lay.box.x, lay.box.y, lay.box.w, lay.box.h);
      fin.draw(3);
      fin.end();
      loupeInfo = { box: lay.box, center: lay.center, zoom: L.zoom, source: L.source };
    }
    this.lastPresent = {
      mode: this.presentMode,
      pass: segs[0]!.pass,
      srcW,
      srcH,
      canvasW: cw,
      canvasH: ch,
      rect: r,
      gpuMs,
      gpuParts,
      chains: this.chains.size,
      compare: cmp ? { a: cmp.a.mode, b: cmp.b.mode, passA: cmp.a.pass, passB: cmp.b.pass, splitPx: cmp.splitPx, prescaleA: segs[0]!.k, prescaleB: segs[1]!.k } : null,
      prescale: segs[0]!.k,
      stage: segs[0]!.stage ?? null,
      ui: { scaler: this.uiScaler, screen: this.ui ? this.ui.screen : null, kind: mplan.kind, rects: mplan.rects.length, applied: uiApplied },
      density: this.density,
      dprEffective: this.effectiveDpr,
      loupe: loupeInfo,
    };
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

    this.presentCount++;
    this.encodePresent(enc, this.sceneBinds, this.sceneW, this.sceneH);
    device.queue.submit([enc.finish()]);
  }

  /**
   * Show a finished RGBA frame (the full game's CPU framebuffer, any width, e.g. widescreen) through the same
   * presentation path as the scene (FSR1 / nearest / bilinear): upload to an rgba8unorm texture.
   */
  presentRgba(width: number, height: number, rgba: Uint8Array, ui?: UiInfo | null): void {
    if (ui !== undefined) this.ui = ui;
    if (rgba.length < width * height * 4) throw new Error('presentRgba: pixel buffer too small');
    const device = this.device;
    if (!this.frameTex || this.frameW !== width || this.frameH !== height) {
      if (this.frameTex) this.killTex(this.frameTex);
      this.frameTex = this.tex({
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
    this.presentCount++;
    const enc = device.createCommandEncoder();
    this.encodePresent(enc, this.frameBinds!, width, height);
    device.queue.submit([enc.finish()]);
  }
}
