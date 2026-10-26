// SPDX-License-Identifier: GPL-3.0-or-later
// Test harness for the FSRCNNX stage: runs it on a synthetic image and returns the readback to Playwright.
import { requestGpu } from '../src/gpu/device';
import { createFsrcnnx } from '../src/gpu/upscale/fsrcnnx';

/** Deterministic hard-edged pixel-art-like test image (stripes, discs, checker, gradient, lines), RGBA8. */
export function synth(w: number, h: number): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      let r = 30 + 150 * u;
      let g = 40 + 120 * v;
      let b = 90 + 60 * (1 - u);
      const s = Math.min(w, h);
      // discs
      for (const [cx, cy, rad, col] of [
        [0.3, 0.35, 0.18, [220, 60, 50]],
        [0.7, 0.6, 0.22, [240, 220, 90]],
        [0.55, 0.25, 0.1, [30, 30, 40]],
      ] as const) {
        if (Math.hypot(x - cx * w, y - cy * h) < rad * s) [r, g, b] = col;
      }
      // diagonal stripes in a band
      if (v > 0.8 && ((x + y) >> 2) % 2 === 0) [r, g, b] = [250, 250, 250];
      // checker (dithering-like) patch
      if (u < 0.2 && v > 0.55 && v < 0.75 && ((x ^ y) & 1) === 0) [r, g, b] = [r * 0.6, g * 0.6, b * 0.6];
      // thin lines
      if (Math.abs(y - h * 0.5) < 1 || Math.abs(x - w * 0.85) < 1) [r, g, b] = [15, 15, 15];
      d.set([r, g, b, 255], (y * w + x) * 4);
    }
  return d;
}

async function readback(device: GPUDevice, tex: GPUTexture, w: number, h: number): Promise<Uint8Array> {
  const bpr = Math.ceil((w * 4) / 256) * 256;
  const buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
  buf.unmap();
  buf.destroy();
  return out;
}

function upload(device: GPUDevice, data: Uint8Array, w: number, h: number): GPUTexture {
  const t = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: t }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: w * 4 }, [w, h]);
  return t;
}

async function toPngDataUrl(rgba: Uint8Array, w: number, h: number): Promise<string> {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(s)}`;
}

export interface BenchResult {
  width: number;
  height: number;
  adapter: string;
  fallback: boolean;
  timestamps: boolean;
  /** per pass: label and median GPU ms over the iterations (null when timestamp-query is unavailable) */
  passes: { label: string; ms: number | null }[];
  totalMs: number | null;
  /** wall time per iteration (submit -> onSubmittedWorkDone), ms */
  wallMs: number;
  liveTextures: number;
  png: string;
  errors: string[];
}

const harness = {
  async patch(w: number, h: number): Promise<{ input: number[]; output: number[]; errors: string[]; liveTextures: number }> {
    const { device } = await requestGpu();
    const errors: string[] = [];
    device.pushErrorScope('validation');
    const stage = await createFsrcnnx(device);
    const input = synth(w, h);
    const tex = upload(device, input, w, h);
    const enc = device.createCommandEncoder();
    const out = stage.encode(enc, tex.createView(), w, h);
    device.queue.submit([enc.finish()]);
    // the stage owns its output texture (private field, test-only access); read it back through a copy
    const owned = (stage as unknown as { out: GPUTexture }).out;
    const output = await readback(device, owned, out.width, out.height);
    const err = await device.popErrorScope();
    if (err) errors.push(err.message);
    const live = stage.liveTextures();
    stage.destroy();
    tex.destroy();
    return { input: Array.from(input), output: Array.from(output), errors, liveTextures: live };
  },

  async bench(w: number, h: number, iters: number): Promise<BenchResult> {
    const { device, info } = await requestGpu();
    const errors: string[] = [];
    device.pushErrorScope('validation');
    const stage = await createFsrcnnx(device);
    const input = synth(w, h);
    const tex = upload(device, input, w, h);
    const view = tex.createView();
    const timestamps = device.features.has('timestamp-query');
    const nPass = stage.passes;
    const qs = timestamps ? device.createQuerySet({ type: 'timestamp', count: nPass * 2 }) : null;
    const resolve = qs ? device.createBuffer({ size: nPass * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
    const rb = qs ? device.createBuffer({ size: nPass * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null;
    const labels: string[] = [];
    const samples: number[][] = Array.from({ length: nPass }, () => []);
    const walls: number[] = [];
    let out = { width: 0, height: 0 };
    // first iteration is a warm-up (pipeline/driver caches)
    for (let it = 0; it < iters + 1; it++) {
      labels.length = 0;
      const enc = device.createCommandEncoder();
      let k = 0;
      const o = stage.encode(enc, view, w, h, qs ? (label) => { labels.push(label); const i = k++; return { querySet: qs, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 }; } : undefined);
      out = o;
      if (qs && resolve && rb) {
        enc.resolveQuerySet(qs, 0, nPass * 2, resolve, 0);
        enc.copyBufferToBuffer(resolve, 0, rb, 0, nPass * 16);
      }
      const t0 = performance.now();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      if (it > 0) walls.push(performance.now() - t0);
      if (rb && it > 0) {
        await rb.mapAsync(GPUMapMode.READ);
        const t = new BigUint64Array(rb.getMappedRange().slice(0));
        rb.unmap();
        for (let i = 0; i < nPass; i++) samples[i]!.push(Number(t[i * 2 + 1]! - t[i * 2]!) / 1e6);
      }
    }
    const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    const passes = labels.map((label, i) => ({ label, ms: timestamps ? med(samples[i]!) : null }));
    const owned = (stage as unknown as { out: GPUTexture }).out;
    const output = await readback(device, owned, out.width, out.height);
    const png = await toPngDataUrl(output, out.width, out.height);
    const err = await device.popErrorScope();
    if (err) errors.push(err.message);
    const live = stage.liveTextures();
    stage.destroy();
    tex.destroy();
    return {
      width: w,
      height: h,
      adapter: `${info.vendor} ${info.description || info.device}`.trim(),
      fallback: info.isFallback,
      timestamps,
      passes,
      totalMs: timestamps ? passes.reduce((s, p) => s + (p.ms ?? 0), 0) : null,
      wallMs: med(walls),
      liveTextures: live,
      png,
      errors,
    };
  },
};
(window as unknown as { __fsrcnnx: typeof harness & { synth: typeof synth } }).__fsrcnnx = { ...harness, synth };
document.title = 'FSRCNNX test page (ready)';
