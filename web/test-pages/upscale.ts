// SPDX-License-Identifier: GPL-3.0-or-later
// Standalone page for the e2e test of the smooth upscale stages: runs one stage on a synthetic input and reads the output back.
// It imports only the stage modules (not the game / renderer) and is served by the vite dev server the spec starts.
import { createDedither } from '../src/gpu/upscale/dedither';
import { createScaleFx } from '../src/gpu/upscale/scalefx';
import { createSmoothScaleFx, createSmoothSuperXbr } from '../src/gpu/upscale/smooth';
import { createSuperXbr } from '../src/gpu/upscale/superxbr';
import type { PassTimer, UpscaleStage } from '../src/gpu/upscale/stage';
import { busy, IMAGES, type TestImage } from './images';

type Factory = (d: GPUDevice) => UpscaleStage;
const STAGES: Record<string, Factory> = {
  dedither: (d) => createDedither(d),
  'dedither-cbd': (d) => createDedither(d, { lines: false }),
  'dedither-lines': (d) => createDedither(d, { cbd: false }),
  scalefx: (d) => createScaleFx(d),
  superxbr: (d) => createSuperXbr(d),
  'smooth-scalefx': (d) => createSmoothScaleFx(d, { dedither: true }),
  'smooth-sxbr': (d) => createSmoothSuperXbr(d, { dedither: true }),
  'smooth-scalefx-nodither': (d) => createSmoothScaleFx(d, { dedither: false }),
  'smooth-sxbr-nodither': (d) => createSmoothSuperXbr(d, { dedither: false }),
};

export interface RunResult {
  width: number;
  height: number;
  ratio: number;
  passes: number;
  live: number;
  /** base64 RGBA8 of the stage output */
  rgba: string;
  errors: string[];
}
export interface TimeResult {
  /** ms per pass label, averaged over the iterations (null: no timestamp-query) */
  passMs: Record<string, number> | null;
  totalMs: number | null;
  /** wall-clock ms per frame of submit + onSubmittedWorkDone, averaged */
  wallMs: number;
  errors: string[];
}

let gpu: { adapter: GPUAdapter; device: GPUDevice; timestamps: boolean } | null = null;
const uncaptured: string[] = [];

async function getGpu(): Promise<NonNullable<typeof gpu>> {
  if (gpu) return gpu;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no adapter');
  const timestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? (['timestamp-query'] as GPUFeatureName[]) : [] });
  device.addEventListener('uncapturederror', (e) => uncaptured.push((e as GPUUncapturedErrorEvent).error.message));
  gpu = { adapter, device, timestamps };
  return gpu;
}

function upload(device: GPUDevice, img: TestImage): GPUTexture {
  const t = device.createTexture({ size: [img.w, img.h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: t }, img.data as Uint8Array<ArrayBuffer>, { bytesPerRow: img.w * 4 }, [img.w, img.h]);
  return t;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readTexture(device: GPUDevice, enc: GPUCommandEncoder, tex: GPUTexture): Promise<() => Promise<Uint8Array>> {
  const bpr = Math.ceil((tex.width * 4) / 256) * 256;
  const buf = device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  return async () => {
    await buf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(tex.width * tex.height * 4);
    for (let y = 0; y < tex.height; y++) out.set(mapped.subarray(y * bpr, y * bpr + tex.width * 4), y * tex.width * 4);
    buf.unmap();
    buf.destroy();
    return out;
  };
}

function resolveImage(image: string | { w: number; h: number }): TestImage {
  if (typeof image === 'string') {
    const f = IMAGES[image];
    if (!f) throw new Error(`unknown image ${image}`);
    return f();
  }
  return busy(image.w, image.h);
}

async function run(stage: string, image: string | { w: number; h: number }): Promise<RunResult> {
  const { device } = await getGpu();
  const factory = STAGES[stage];
  if (!factory) throw new Error(`unknown stage ${stage}`);
  const img = resolveImage(image);
  const before = uncaptured.length;
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  const src = upload(device, img);
  const st = factory(device);
  const enc = device.createCommandEncoder();
  const out = st.encode(enc, src.createView(), img.w, img.h);
  // the output texture is the last one the stage allocated; read it back through a fresh copy of the same encode
  const tex = (st as unknown as { outputTexture?: () => GPUTexture | null }).outputTexture?.();
  if (!tex) throw new Error('stage exposes no output texture');
  const finish = await readTexture(device, enc, tex);
  device.queue.submit([enc.finish()]);
  const pixels = await finish();
  const live = st.liveTextures();
  const errors: string[] = [];
  const oom = await device.popErrorScope();
  const val = await device.popErrorScope();
  if (oom) errors.push(`oom: ${oom.message}`);
  if (val) errors.push(`validation: ${val.message}`);
  errors.push(...uncaptured.slice(before));
  const res: RunResult = { width: out.width, height: out.height, ratio: st.ratio, passes: st.passes, live, rgba: toBase64(pixels), errors };
  st.destroy();
  src.destroy();
  return res;
}

async function time(stage: string, w: number, h: number, iterations: number): Promise<TimeResult> {
  const { device, timestamps } = await getGpu();
  const factory = STAGES[stage];
  if (!factory) throw new Error(`unknown stage ${stage}`);
  const img = busy(w, h);
  const before = uncaptured.length;
  device.pushErrorScope('validation');
  const src = upload(device, img);
  const st = factory(device);
  const view = src.createView();
  const labels: string[] = [];
  const capacity = 32;
  const qs = timestamps ? device.createQuerySet({ type: 'timestamp', count: capacity * 2 }) : null;
  const resolveBuf = qs ? device.createBuffer({ size: capacity * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const readBuf = qs ? device.createBuffer({ size: capacity * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null;
  const sums: Record<string, number> = {};
  let timed = 0;
  // warm-up (pipeline compilation, texture allocation)
  {
    const enc = device.createCommandEncoder();
    st.encode(enc, view, w, h);
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
  }
  const t0 = performance.now();
  for (let it = 0; it < iterations; it++) {
    labels.length = 0;
    const enc = device.createCommandEncoder();
    const timer: PassTimer | undefined = qs
      ? (label) => {
          const i = labels.length;
          labels.push(label);
          return { querySet: qs, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
        }
      : undefined;
    st.encode(enc, view, w, h, timer);
    if (qs && resolveBuf && readBuf) {
      enc.resolveQuerySet(qs, 0, labels.length * 2, resolveBuf, 0);
      enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, labels.length * 16);
    }
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    if (readBuf) {
      await readBuf.mapAsync(GPUMapMode.READ, 0, labels.length * 16);
      const t = new BigInt64Array(readBuf.getMappedRange(0, labels.length * 16).slice(0));
      readBuf.unmap();
      labels.forEach((l, i) => {
        sums[l] = (sums[l] ?? 0) + Number(t[i * 2 + 1]! - t[i * 2]!) / 1e6;
      });
      timed++;
    }
  }
  const wallMs = (performance.now() - t0) / iterations;
  const errors: string[] = [];
  const val = await device.popErrorScope();
  if (val) errors.push(`validation: ${val.message}`);
  errors.push(...uncaptured.slice(before));
  let passMs: Record<string, number> | null = null;
  let totalMs: number | null = null;
  if (timed > 0) {
    passMs = {};
    totalMs = 0;
    for (const [k, v] of Object.entries(sums)) {
      passMs[k] = v / timed;
      totalMs += v / timed;
    }
  }
  st.destroy();
  src.destroy();
  return { passMs, totalMs, wallMs, errors };
}

/** Texture-lifecycle probe: resize the source a few times, report liveTextures() after each, then after destroy(). */
async function lifecycle(stage: string, sizes: [number, number][]): Promise<{ live: number[]; afterDestroy: number; errors: string[] }> {
  const { device } = await getGpu();
  const factory = STAGES[stage];
  if (!factory) throw new Error(`unknown stage ${stage}`);
  const before = uncaptured.length;
  device.pushErrorScope('validation');
  const st = factory(device);
  const live: number[] = [];
  for (const [w, h] of sizes) {
    const src = upload(device, busy(w, h));
    const enc = device.createCommandEncoder();
    st.encode(enc, src.createView(), w, h);
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    live.push(st.liveTextures());
    src.destroy();
  }
  st.destroy();
  const errors: string[] = [];
  const val = await device.popErrorScope();
  if (val) errors.push(`validation: ${val.message}`);
  errors.push(...uncaptured.slice(before));
  return { live, afterDestroy: st.liveTextures(), errors };
}

async function info(): Promise<{ adapter: string; timestamps: boolean }> {
  const g = await getGpu();
  const ai = g.adapter.info;
  return { adapter: `${ai.vendor} ${ai.architecture} ${ai.description}`, timestamps: g.timestamps };
}

const api = { info, run, time, lifecycle };
declare global {
  interface Window {
    upscaleTest: typeof api;
  }
}
window.upscaleTest = api;
