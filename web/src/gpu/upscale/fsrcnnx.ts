// SPDX-License-Identifier: GPL-3.0-or-later
// FSRCNNX 8-0-4-1 (igv) 2x luma upscaler as an UpscaleStage. The network and its weights are igv's (LGPL-3.0-or-later,
// LICENSES/FSRCNNX-LGPL-3.0.txt); the WGSL port is web/src/gpu/shaders/fsrcnnx.wgsl.
//
// Colour handling: the mpv hook runs on LUMA only. Our frame is RGB, so the stage computes BT.709 luma (gamma-space, full
// range) from the rgba8 frame, runs the network on it, upscales chroma (Cb/Cr) bilinearly 2x and recombines. For a linear
// YCbCr transform that is rgb_bilinear + (Y_net - Y_bilinear), done in the last pass. Alpha is output as 1.
//
// Pass graph (7 compute dispatches at native resolution, the last at 2x; every feature map is an rgba16float 2-layer array,
// layer 0 = channels 0-3, layer 1 = 4-7):
//   features   src rgba8 -> FEAT      luma, 5x5 conv, 1 -> 8 (hook passes "feature map 1/2")
//   map1       FEAT -> A              3x3, 8 -> 8, PReLU     ("mapping 1_1/1_2")
//   map2       A -> B                                         ("mapping 2_x")
//   map3       B -> A                                         ("mapping 3_x")
//   map4       A -> B                                         ("mapping 4_x")
//   residual   B + FEAT(skip) -> A    1x1, 8 -> 8, PReLU     ("sub-band residuals 1/2")
//   aggregate  A (+ src chroma) -> out  3x3 sub-pixel conv 8 -> 4, pixel shuffle to 2x, one channel per output pixel,
//                                     recombine with bilinear chroma  ("sub-pixel convolution 1" + "aggregation")
// Owned textures: FEAT, A, B (rgba16float, srcW x srcH x 2 layers) and the rgba8unorm output (2srcW x 2srcH): 4 textures.
import { FSRCNNX_PASSES, type FsrcnnxConvPass } from './fsrcnnx-layout';
import { parseFsrcnnxWeights } from './fsrcnnx-weights';
import type { PassTimer, StageOutput, UpscaleStage } from './stage';
import wgsl from '../shaders/fsrcnnx.wgsl?raw';

/** Default weights URL (copied from web/public by Vite; respects a sub-path deploy). */
export const FSRCNNX_WEIGHTS_URL = `${import.meta.env.BASE_URL}fsrcnnx-8-0-4-1.bin`;

/** A stage factory may be async (the weights are fetched). The renderer must await it before the first encode(). */
export type UpscaleStageFactory = (device: GPUDevice) => UpscaleStage | Promise<UpscaleStage>;
/** Registry accepted by register(): an object with register(mode, factory), or the register function itself. */
export type UpscaleRegistry = { register(mode: string, factory: UpscaleStageFactory): void } | ((mode: string, factory: UpscaleStageFactory) => void);

const weightCache = new Map<string, Promise<Float32Array>>();
function loadWeights(url: string): Promise<Float32Array> {
  let p = weightCache.get(url);
  if (!p) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`fsrcnnx weights: HTTP ${r.status} for ${url}`);
      return parseFsrcnnxWeights(await r.arrayBuffer());
    });
    p.catch(() => weightCache.delete(url)); // retry on the next call after a failure
    weightCache.set(url, p);
  }
  return p;
}

function convPass(name: string): FsrcnnxConvPass {
  const p = FSRCNNX_PASSES.find((x) => x.name === name);
  if (!p || p.kind === 'aggregate') throw new Error(`fsrcnnx layout: no conv pass ${name}`);
  return p;
}
/** Pipeline constants (vec4 indices) for output half A / B. */
function constants(a: FsrcnnxConvPass, b?: FsrcnnxConvPass): Record<string, number> {
  const c: Record<string, number> = { A_BIAS: a.bias / 4, A_PRELU: (a.prelu ?? 0) / 4, A_TERMS: (a.terms[0]?.offset ?? 0) / 4 };
  if (b) Object.assign(c, { B_BIAS: b.bias / 4, B_PRELU: (b.prelu ?? 0) / 4, B_TERMS: (b.terms[0]?.offset ?? 0) / 4 });
  return c;
}

interface Pipes {
  features: GPUComputePipeline;
  map: GPUComputePipeline[];
  residual: GPUComputePipeline;
  aggregate: GPUComputePipeline;
}

class FsrcnnxStage implements UpscaleStage {
  readonly ratio = 2;
  readonly passes = 7;
  private w = 0;
  private h = 0;
  private feat: GPUTexture | null = null;
  private a: GPUTexture | null = null;
  private b: GPUTexture | null = null;
  private out: GPUTexture | null = null;
  private views: { feat: GPUTextureView; a: GPUTextureView; b: GPUTextureView; out: GPUTextureView } | null = null;
  private groups: GPUBindGroup[] | null = null;
  private groupsSrc: GPUTextureView | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly weights: GPUBuffer,
    private readonly pipes: Pipes,
  ) {}

  liveTextures(): number {
    return [this.feat, this.a, this.b, this.out].filter(Boolean).length;
  }

  private release(): void {
    this.feat?.destroy();
    this.a?.destroy();
    this.b?.destroy();
    this.out?.destroy();
    this.feat = this.a = this.b = this.out = null;
    this.views = null;
    this.groups = null;
  }

  private ensure(w: number, h: number): void {
    if (this.views && w === this.w && h === this.h) return;
    this.release();
    const mk = (width: number, height: number, layers: number, format: GPUTextureFormat, extra: number): GPUTexture =>
      this.device.createTexture({ size: [width, height, layers], format, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | extra });
    this.feat = mk(w, h, 2, 'rgba16float', 0);
    this.a = mk(w, h, 2, 'rgba16float', 0);
    this.b = mk(w, h, 2, 'rgba16float', 0);
    this.out = mk(w * 2, h * 2, 1, 'rgba8unorm', GPUTextureUsage.COPY_SRC);
    const arr = (t: GPUTexture): GPUTextureView => t.createView({ dimension: '2d-array' });
    this.views = { feat: arr(this.feat), a: arr(this.a), b: arr(this.b), out: this.out.createView() };
    this.w = w;
    this.h = h;
    this.groupsSrc = null;
  }

  private bindGroups(src: GPUTextureView): GPUBindGroup[] {
    if (this.groups && this.groupsSrc === src) return this.groups;
    const v = this.views!;
    const buf = { binding: 0, resource: { buffer: this.weights } };
    const g = (p: GPUComputePipeline, e: GPUBindGroupEntry[]): GPUBindGroup => this.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [buf, ...e] });
    const bg = (binding: number, view: GPUTextureView): GPUBindGroupEntry => ({ binding, resource: view });
    const [m1, m2, m3, m4] = this.pipes.map as [GPUComputePipeline, GPUComputePipeline, GPUComputePipeline, GPUComputePipeline];
    this.groups = [
      g(this.pipes.features, [bg(1, src), bg(4, v.feat)]),
      g(m1, [bg(2, v.feat), bg(4, v.a)]),
      g(m2, [bg(2, v.a), bg(4, v.b)]),
      g(m3, [bg(2, v.b), bg(4, v.a)]),
      g(m4, [bg(2, v.a), bg(4, v.b)]),
      g(this.pipes.residual, [bg(2, v.b), bg(3, v.feat), bg(4, v.a)]),
      g(this.pipes.aggregate, [bg(1, src), bg(2, v.a), bg(5, v.out)]),
    ];
    this.groupsSrc = src;
    return this.groups;
  }

  encode(enc: GPUCommandEncoder, src: GPUTextureView, srcW: number, srcH: number, timer?: PassTimer): StageOutput {
    this.ensure(srcW, srcH);
    const groups = this.bindGroups(src);
    const p = this.pipes;
    const steps: [string, GPUComputePipeline, number, number][] = [
      ['fsrcnnx features', p.features, srcW, srcH],
      ['fsrcnnx map1', p.map[0]!, srcW, srcH],
      ['fsrcnnx map2', p.map[1]!, srcW, srcH],
      ['fsrcnnx map3', p.map[2]!, srcW, srcH],
      ['fsrcnnx map4', p.map[3]!, srcW, srcH],
      ['fsrcnnx residual', p.residual, srcW, srcH],
      ['fsrcnnx aggregate', p.aggregate, srcW * 2, srcH * 2],
    ];
    steps.forEach(([label, pipe, w, h], i) => {
      const tw = timer?.(label) as GPUComputePassTimestampWrites | undefined;
      const pass = enc.beginComputePass({ label, ...(tw ? { timestampWrites: tw } : {}) });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, groups[i]!);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      pass.end();
    });
    return { view: this.views!.out, width: srcW * 2, height: srcH * 2 };
  }

  destroy(): void {
    this.release();
    this.weights.destroy();
  }
}

/** Builds the stage from already-parsed weights (tests, or a caller that fetched them itself). */
export async function createFsrcnnxFromWeights(device: GPUDevice, weights: Float32Array): Promise<UpscaleStage> {
  const buffer = device.createBuffer({ label: 'fsrcnnx weights', size: weights.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, weights as Float32Array<ArrayBuffer>);
  const module = device.createShaderModule({ label: 'fsrcnnx', code: wgsl });
  const pipe = (entryPoint: string, c: Record<string, number>): Promise<GPUComputePipeline> =>
    device.createComputePipelineAsync({ label: `fsrcnnx ${entryPoint}`, layout: 'auto', compute: { module, entryPoint, constants: c } });
  const half = (n: string): FsrcnnxConvPass => convPass(n);
  const [features, m1, m2, m3, m4, residual, aggregate] = await Promise.all([
    pipe('features', constants(half('feature_map_1'), half('feature_map_2'))),
    pipe('mapping', constants(half('mapping_1_1'), half('mapping_1_2'))),
    pipe('mapping', constants(half('mapping_2_1'), half('mapping_2_2'))),
    pipe('mapping', constants(half('mapping_3_1'), half('mapping_3_2'))),
    pipe('mapping', constants(half('mapping_4_1'), half('mapping_4_2'))),
    pipe('residual', constants(half('sub_band_residuals_1'), half('sub_band_residuals_2'))),
    pipe('aggregate', constants(half('sub_pixel_convolution_1'))),
  ]);
  return new FsrcnnxStage(device, buffer, { features, map: [m1, m2, m3, m4], residual, aggregate });
}

/** Fetches the weights (cached per URL) and builds the stage. */
export async function createFsrcnnx(device: GPUDevice, weightsUrl: string = FSRCNNX_WEIGHTS_URL): Promise<UpscaleStage> {
  return createFsrcnnxFromWeights(device, await loadWeights(weightsUrl));
}

/**
 * Registers mode 'fsrcnnx' with the renderer's stage registry. The factory is async (it fetches the weights): the
 * integrator must await it (e.g. kick it off when the mode is first selected and keep the previous mode until it resolves).
 */
export function register(registry: UpscaleRegistry, weightsUrl: string = FSRCNNX_WEIGHTS_URL): void {
  const factory: UpscaleStageFactory = (device) => createFsrcnnx(device, weightsUrl);
  if (typeof registry === 'function') registry('fsrcnnx', factory);
  else registry.register('fsrcnnx', factory);
}
