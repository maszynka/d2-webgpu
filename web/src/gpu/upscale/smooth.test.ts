// SPDX-License-Identifier: GPL-3.0-or-later
// Bookkeeping of the smooth stages (ratio, pass count, texture lifecycle, bind-group reuse) against a mocked device, and sanity of
// the CPU references. The WGSL itself is checked against the references in e2e/upscale-smooth.spec.ts.
import { describe, expect, it } from 'vitest';
import { createDedither } from './dedither';
import { checkerboardDeditherReference, fromRgba8, stripeCheckerReference, superXbrReference, toRgba8, type RgbImage } from './reference';
import { createScaleFx } from './scalefx';
import { createSmoothScaleFx, createSmoothSuperXbr, register } from './smooth';
import type { UpscaleStage } from './stage';
import { createSuperXbr } from './superxbr';

interface FakeTex {
  w: number;
  h: number;
  format: string;
  destroyed: boolean;
  destroy(): void;
  createView(): { tex: FakeTex };
}

function mock(): { device: GPUDevice; tex: FakeTex[]; groups: { n: number }; passes: string[]; encoder: GPUCommandEncoder; view: () => GPUTextureView } {
  const tex: FakeTex[] = [];
  const groups = { n: 0 };
  const passes: string[] = [];
  const device = {
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createTexture: (d: { size: [number, number]; format: string }) => {
      const t: FakeTex = { w: d.size[0], h: d.size[1], format: d.format, destroyed: false, destroy() { this.destroyed = true; }, createView() { return { tex: t }; } };
      tex.push(t);
      return t;
    },
    createBindGroup: () => {
      groups.n++;
      return {};
    },
  } as unknown as GPUDevice;
  const encoder = {
    beginRenderPass: (d: { label: string }) => {
      passes.push(d.label);
      return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
    },
  } as unknown as GPUCommandEncoder;
  return { device, tex, groups, passes, encoder, view: () => ({}) as GPUTextureView };
}

const live = (m: ReturnType<typeof mock>): FakeTex[] => m.tex.filter((t) => !t.destroyed);

describe('ratio and pass bookkeeping', () => {
  const cases: [string, (d: GPUDevice) => UpscaleStage, number, number][] = [
    ['dedither (cbd + lines)', (d) => createDedither(d), 1, 4],
    ['dedither (cbd)', (d) => createDedither(d, { lines: false }), 1, 3],
    ['dedither (lines)', (d) => createDedither(d, { cbd: false }), 1, 1],
    ['scalefx', (d) => createScaleFx(d), 3, 5],
    ['superxbr', (d) => createSuperXbr(d), 2, 3],
    ['smooth scalefx', (d) => createSmoothScaleFx(d), 3, 9],
    ['smooth scalefx, no dedither', (d) => createSmoothScaleFx(d, { dedither: false }), 3, 5],
    ['smooth sxbr', (d) => createSmoothSuperXbr(d), 2, 7],
    ['smooth sxbr, no dedither', (d) => createSmoothSuperXbr(d, { dedither: false }), 2, 3],
  ];
  for (const [name, make, ratio, passes] of cases) {
    it(`${name}: ratio ${ratio}, ${passes} passes, output ${ratio}x, passes recorded = passes, timer called per pass`, () => {
      const m = mock();
      const st = make(m.device);
      expect(st.ratio).toBe(ratio);
      expect(st.passes).toBe(passes);
      const labels: string[] = [];
      const out = st.encode(m.encoder, m.view(), 40, 30, (l) => (labels.push(l), undefined));
      expect(out.width).toBe(40 * ratio);
      expect(out.height).toBe(30 * ratio);
      expect(m.passes).toHaveLength(passes);
      expect(labels).toHaveLength(passes);
      expect(new Set(labels).size).toBe(passes);
      st.destroy();
    });
  }

  it('dedither without cbd and lines is rejected', () => {
    expect(() => createDedither(mock().device, { cbd: false, lines: false })).toThrow();
  });
});

describe('texture lifecycle', () => {
  it('scalefx: 4 textures, only the output at 3x, native ones rgba16float/rgba8', () => {
    const m = mock();
    const st = createScaleFx(m.device);
    st.encode(m.encoder, m.view(), 100, 50);
    expect(st.liveTextures()).toBe(4);
    const big = m.tex.filter((t) => t.w === 300);
    expect(big).toHaveLength(1);
    expect(big[0]!.format).toBe('rgba8unorm');
    expect(m.tex.filter((t) => t.w === 100).map((t) => t.format).sort()).toEqual(['rgba16float', 'rgba16float', 'rgba8unorm']);
  });

  it('superxbr: 3 textures, at most two per resolution, sRGB intermediates', () => {
    const m = mock();
    const st = createSuperXbr(m.device);
    st.encode(m.encoder, m.view(), 100, 50);
    expect(st.liveTextures()).toBe(3);
    expect(m.tex.filter((t) => t.w === 200)).toHaveLength(2);
    expect(m.tex.filter((t) => t.w === 100)).toHaveLength(1);
    expect(m.tex.filter((t) => t.format === 'rgba8unorm-srgb')).toHaveLength(2);
  });

  it('dedither: two working textures + the output at native size', () => {
    const m = mock();
    const st = createDedither(m.device);
    st.encode(m.encoder, m.view(), 64, 64);
    expect(st.liveTextures()).toBe(3);
    expect(createDedither(mock().device, { cbd: false }).liveTextures()).toBe(0);
  });

  it('textures are kept for the same size and the same source, recreated on resize and destroyed with the stage', () => {
    const m = mock();
    const st = createSmoothScaleFx(m.device);
    const src = m.view();
    st.encode(m.encoder, src, 64, 32);
    const first = st.liveTextures();
    expect(first).toBe(7);
    const groupsAfterFirst = m.groups.n;
    st.encode(m.encoder, src, 64, 32);
    expect(m.tex).toHaveLength(first); // nothing recreated
    expect(m.groups.n).toBe(groupsAfterFirst); // bind groups reused
    st.encode(m.encoder, m.view(), 64, 32); // a new source view: bind groups only
    expect(m.tex).toHaveLength(first);
    expect(m.groups.n).toBeGreaterThan(groupsAfterFirst);
    st.encode(m.encoder, src, 128, 64);
    expect(m.tex).toHaveLength(first * 2);
    expect(live(m)).toHaveLength(first); // the old size was destroyed
    expect(live(m).every((t) => t.w >= 128)).toBe(true);
    st.destroy();
    expect(st.liveTextures()).toBe(0);
    expect(live(m)).toHaveLength(0);
  });

  it('cycling sizes and modes never accumulates textures', () => {
    const m = mock();
    const stages = [createSmoothScaleFx(m.device), createSmoothSuperXbr(m.device)];
    for (let i = 0; i < 20; i++) {
      const st = stages[i % 2]!;
      st.encode(m.encoder, m.view(), 50 + i * 3, 40);
    }
    expect(live(m).length).toBeLessThanOrEqual(7 + 6);
    for (const s of stages) s.destroy();
    expect(live(m)).toHaveLength(0);
  });

  it('rejects empty or fractional source sizes', () => {
    const m = mock();
    const st = createScaleFx(m.device);
    expect(() => st.encode(m.encoder, m.view(), 0, 10)).toThrow();
    expect(() => st.encode(m.encoder, m.view(), 10.5, 10)).toThrow();
  });
});

describe('register', () => {
  it('registers smooth-scalefx and smooth-sxbr with working factories', () => {
    const modes: Record<string, (d: GPUDevice) => UpscaleStage> = {};
    register((mode, factory) => {
      modes[mode] = factory;
    });
    expect(Object.keys(modes).sort()).toEqual(['smooth-scalefx', 'smooth-sxbr']);
    const m = mock();
    expect(modes['smooth-scalefx']!(m.device).ratio).toBe(3);
    expect(modes['smooth-sxbr']!(m.device).ratio).toBe(2);
  });
});

function img(w: number, h: number, f: (x: number, y: number) => [number, number, number]): RgbImage {
  const d = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 3);
  return { w, h, d };
}
const energy = (im: RgbImage, x0: number, x1: number, y0: number, y1: number): number => {
  let e = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const g = (xx: number, yy: number): number => im.d[(yy * im.w + xx) * 3 + 1]!;
      const lap = g(x, y) - 0.25 * (g(x - 1, y) + g(x + 1, y) + g(x, y - 1) + g(x, y + 1));
      e += lap * lap;
      n++;
    }
  }
  return e / n;
};

describe('CPU references', () => {
  it('Super-xBR: flat stays flat, output is 2x, an edge keeps only values between its two colours', () => {
    const flat = superXbrReference(img(8, 8, () => [0.4, 0.5, 0.6]));
    expect([flat.w, flat.h]).toEqual([16, 16]);
    for (let i = 0; i < flat.d.length; i += 3) expect(Math.abs(flat.d[i + 1]! - 0.5)).toBeLessThan(1 / 255);
    const edge = superXbrReference(img(16, 16, (x, y) => (y > x ? [0.9, 0.9, 0.9] : [0.1, 0.1, 0.1])));
    for (let i = 0; i < edge.d.length; i++) {
      expect(edge.d[i]!).toBeGreaterThanOrEqual(0.1 - 1 / 255);
      expect(edge.d[i]!).toBeLessThanOrEqual(0.9 + 1 / 255);
    }
  });

  it('checkerboard dedither: removes a checkerboard, keeps flat areas', () => {
    const a: [number, number, number] = [0.8, 0.5, 0.3];
    const b: [number, number, number] = [0.6, 0.4, 0.2];
    const src = img(32, 32, (x, y) => (x >= 4 && x < 20 ? ((x + y) % 2 === 0 ? a : b) : [0.2, 0.2, 0.2]));
    const out = checkerboardDeditherReference(src);
    expect(energy(out, 8, 16, 8, 24)).toBeLessThan(energy(src, 8, 16, 8, 24) * 0.5);
    // flat region far from the pattern is untouched
    const px = (im: RgbImage, x: number, y: number): number => im.d[(y * im.w + x) * 3]!;
    expect(Math.abs(px(out, 28, 16) - 0.2)).toBeLessThan(1 / 255);
  });

  it('own stripe/checker detector: merges stripes, keeps a lone 1-px line and a 2-px bar', () => {
    const lo: [number, number, number] = [0.4, 0.3, 0.2];
    const hi: [number, number, number] = [0.6, 0.45, 0.3];
    const stripes = stripeCheckerReference(img(24, 16, (x) => (x >= 4 && x < 20 ? (x % 2 === 0 ? hi : lo) : [0.1, 0.1, 0.1])));
    const c = (x: number): number => stripes.d[(8 * stripes.w + x) * 3]!;
    expect(Math.abs(c(10) - c(11))).toBeLessThan(0.01); // interior stripes merged
    const line = img(24, 16, (x) => (x === 10 ? [0.9, 0.9, 0.9] : [0.1, 0.1, 0.1]));
    expect(Array.from(stripeCheckerReference(line).d)).toEqual(Array.from(line.d));
    const bar = img(24, 16, (x) => (x === 10 || x === 11 ? [0.9, 0.9, 0.9] : [0.1, 0.1, 0.1]));
    expect(Array.from(stripeCheckerReference(bar).d)).toEqual(Array.from(bar.d));
  });

  it('rgba8 round trip', () => {
    const rgba = Uint8Array.from([0, 128, 255, 255, 10, 20, 30, 255]);
    expect(Array.from(toRgba8(fromRgba8(rgba, 2, 1)))).toEqual(Array.from(rgba));
  });
});
