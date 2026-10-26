// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { clampSplit, clipColumns, comparePass, planCompare, splitPx } from './compare';
import { backingSize, fitRectFree, nativeRect } from './fit';
import { PRESENT_MODES, parsePresentMode, pixelPrescale, planPresent, presentLabel } from './fsr';
import { LOUPE_ZOOMS, clampLoupeZoom, loupeCoverage, loupeLayout, loupeSourceIndex, stepLoupeZoom } from './loupe';
import { splitFromKey, splitFromPointer } from '../ui/divider';
import { formatHud, presentSummary, RateMeter } from '../ui/hud';

describe('present modes', () => {
  it('parses every ?present= value and falls back to fsr1', () => {
    for (const id of ['fsr1', 'fsr1-pixel', 'easu', 'bilinear', 'nearest', 'nearest-stretch', 'native', 'smooth', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx']) expect(parsePresentMode(id)).toBe(id);
    expect(parsePresentMode('nope')).toBe('fsr1');
    expect(PRESENT_MODES.map((m) => m.id)).toEqual(['fsr1', 'fsr1-pixel', 'smooth', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx', 'easu', 'bilinear', 'nearest', 'nearest-stretch', 'native']);
    expect(presentLabel('native')).toBe('Off (1:1)');
    expect(presentLabel('nearest-stretch')).toBe('Nearest (stretch)');
  });
  it('native is 1:1 and centred, nearest-stretch is the fractional fit with nearest sampling', () => {
    expect(planPresent('native', 800, 600, 1951, 1000)).toEqual({ pass: 'nearest', rect: { x: 575, y: 200, w: 800, h: 600 } });
    expect(planPresent('nearest-stretch', 800, 600, 1950, 1000)).toEqual({ pass: 'nearest', rect: fitRectFree(800, 600, 1950, 1000) });
    // larger than the canvas: downscaled to fit rather than cropped
    const big = nativeRect(1400, 600, 1000, 500);
    expect(big.w).toBeLessThanOrEqual(1000);
    expect(big.h).toBeLessThanOrEqual(500);
  });
});

describe('EASU only and backing size', () => {
  it('easu shows the EASU upscale without RCAS, bilinear when not upscaling', () => {
    expect(planPresent('easu', 800, 600, 1950, 1000).pass).toBe('easu');
    expect(planPresent('easu', 800, 600, 640, 480).pass).toBe('bilinear');
    expect(comparePass('easu', { x: 0, y: 0, w: 1600, h: 1200 }, 800, 600)).toBe('easu');
    const p = planCompare('fsr1', 'easu', 0.5, 800, 600, 1950, 1000);
    expect([p.a.pass, p.b.pass]).toEqual(['easu-rcas', 'easu']);
  });
  it('backing size prefers the observer device-pixel box, falls back to client * dpr, caps at the limit', () => {
    expect(backingSize({ w: 1921, h: 1079 }, 1280.4, 719.6, 1.5, 8192)).toEqual({ w: 1921, h: 1079 });
    expect(backingSize(null, 1280.4, 719.6, 1.5, 8192)).toEqual({ w: 1921, h: 1079 });
    expect(backingSize(null, 0, 0, 2, 8192)).toEqual({ w: 1, h: 1 });
    expect(backingSize({ w: 20000, h: 100 }, 1, 1, 1, 8192)).toEqual({ w: 8192, h: 100 });
  });
});

describe('FSR1 (pixel-art) prescale', () => {
  it('floor of the fit scale, 1 below 2x, capped by the texture limit', () => {
    expect(pixelPrescale({ x: 0, y: 0, w: 2536, h: 1902 }, 800, 600)).toBe(3); // 3.17x
    expect(pixelPrescale({ x: 0, y: 0, w: 1600, h: 1200 }, 800, 600)).toBe(2);
    expect(pixelPrescale({ x: 0, y: 0, w: 1599, h: 1199 }, 800, 600)).toBe(1);
    expect(pixelPrescale({ x: 0, y: 0, w: 1024, h: 768 }, 800, 600)).toBe(1); // plain FSR1
    expect(pixelPrescale({ x: 0, y: 0, w: 640, h: 480 }, 800, 600)).toBe(1); // downscale
    expect(pixelPrescale({ x: 0, y: 0, w: 20000, h: 10000 }, 800, 600, 4096)).toBe(5); // 4096 / 800
  });
  it('plans like fsr1 (same rect, EASU + RCAS when upscaling)', () => {
    expect(planPresent('fsr1-pixel', 800, 600, 1950, 1000)).toEqual(planPresent('fsr1', 800, 600, 1950, 1000));
    expect(planPresent('fsr1-pixel', 800, 600, 640, 480).pass).toBe('bilinear');
  });
  it('summarises pass and scale for the tooltip', () => {
    const base = { mode: 'fsr1-pixel', pass: 'easu-rcas', srcW: 800, srcH: 600, canvasW: 2536, canvasH: 1902, rect: { x: 0, y: 0, w: 2536, h: 1902 }, gpuMs: null, gpuParts: [], chains: 0, compare: null, loupe: null, prescale: 3 } as never;
    expect(presentSummary(base)).toBe('fsr1-pixel \u00b7 easu-rcas \u00b7 3.17\u00d7 (3\u00d7 nearest + 1.06\u00d7 EASU)');
  });
});

describe('compare rect and scissors', () => {
  it('both sides share the fractional fit rect', () => {
    const p = planCompare('nearest-stretch', 'fsr1', 0.5, 800, 600, 1950, 1000);
    expect(p.rect).toEqual(fitRectFree(800, 600, 1950, 1000));
    expect(p.splitPx).toBe(975);
    expect(p.a.scissor).toEqual({ x: p.rect.x, y: 0, w: 975 - p.rect.x, h: 1000 });
    expect(p.b.scissor).toEqual({ x: 975, y: 0, w: p.rect.x + p.rect.w - 975, h: 1000 });
    expect(p.a.pass).toBe('nearest');
    expect(p.b.pass).toBe('easu-rcas');
  });
  it('the two scissors tile the rect exactly', () => {
    for (const s of [0.02, 0.3, 0.5, 0.77, 0.98]) {
      const p = planCompare('bilinear', 'nearest', s, 1066, 600, 1920, 1080);
      const wa = p.a.scissor?.w ?? 0;
      const wb = p.b.scissor?.w ?? 0;
      expect(wa + wb).toBe(p.rect.w);
    }
  });
  it('a divider outside the letterboxed rect gives one side nothing', () => {
    const p = planCompare('bilinear', 'fsr1', 0.02, 800, 600, 2000, 600);
    expect(p.rect.x).toBe(600);
    expect(p.a.scissor).toBeNull();
    expect(p.b.scissor).toEqual(p.rect);
  });
  it('mode passes in compare: nearest family samples nearest, fsr1 falls back to bilinear without upscale', () => {
    const r = { x: 0, y: 0, w: 640, h: 480 };
    expect(comparePass('native', r, 800, 600)).toBe('nearest');
    expect(comparePass('nearest', r, 800, 600)).toBe('nearest');
    expect(comparePass('fsr1', r, 800, 600)).toBe('bilinear');
    expect(comparePass('fsr1', { ...r, w: 1600, h: 1200 }, 800, 600)).toBe('easu-rcas');
  });
  it('clamps and converts the split', () => {
    expect(clampSplit(-1)).toBe(0.02);
    expect(clampSplit(2)).toBe(0.98);
    expect(clampSplit(NaN)).toBe(0.5);
    expect(splitPx(0.5, 1001)).toBe(501);
    expect(clipColumns({ x: 10, y: 0, w: 10, h: 5 }, 0, 10)).toBeNull();
  });
  it('divider pointer / key math', () => {
    expect(splitFromPointer(300, 100, 400)).toBe(0.5);
    expect(splitFromPointer(0, 100, 400)).toBe(0.02);
    expect(splitFromKey(0.5, 'ArrowRight', false)).toBeCloseTo(0.51);
    expect(splitFromKey(0.5, 'ArrowLeft', true)).toBeCloseTo(0.4);
    expect(splitFromKey(0.5, 'End', false)).toBe(0.98);
    expect(splitFromKey(0.5, 'a', false)).toBeNull();
  });
});

describe('loupe', () => {
  it('zoom steps stay in 2..16', () => {
    expect(LOUPE_ZOOMS[0]).toBe(2);
    expect(LOUPE_ZOOMS.at(-1)).toBe(16);
    expect(stepLoupeZoom(16, 1)).toBe(16);
    expect(stepLoupeZoom(2, -1)).toBe(2);
    expect(stepLoupeZoom(8, 1)).toBe(12);
    expect(clampLoupeZoom(13)).toBe(12);
    expect(clampLoupeZoom(3.2)).toBe(3);
    expect(clampLoupeZoom(NaN)).toBe(8);
  });
  it('sits bottom-right of the pointer, flips and clamps at the edges', () => {
    const a = loupeLayout(100, 100, 256, 1920, 1080);
    expect(a.box).toEqual({ x: 124, y: 124, w: 256, h: 256 });
    expect(a.center).toEqual({ x: 100, y: 100 });
    const b = loupeLayout(1900, 1070, 256, 1920, 1080);
    expect(b.box).toEqual({ x: 1900 - 24 - 256, y: 1070 - 24 - 256, w: 256, h: 256 });
    const c = loupeLayout(5, 5, 256, 300, 200); // canvas smaller than the square: shrinks
    expect(c.box.w).toBe(200);
    expect(c.box.x).toBeGreaterThanOrEqual(0);
    const d = loupeLayout(-50, 5000, 128, 800, 600);
    expect(d.center).toEqual({ x: 0, y: 599 });
    expect(d.box.x).toBeGreaterThanOrEqual(0);
    expect(d.box.y + d.box.h).toBeLessThanOrEqual(600);
  });
  it('maps loupe pixels to canvas pixels in k x k blocks around the centre pixel', () => {
    const size = 256;
    for (const k of [2, 4, 8, 16]) {
      const c = 500;
      const idx = Array.from({ length: size }, (_, l) => loupeSourceIndex(l, size, k, c));
      // runs of identical indices are exactly k long (except the clipped edge runs)
      let run = 1;
      const runs: number[] = [];
      for (let i = 1; i < size; i++) {
        if (idx[i] === idx[i - 1]) run++;
        else {
          runs.push(run);
          run = 1;
        }
      }
      expect(new Set(runs.slice(1))).toEqual(new Set([k]));
      expect(idx[128]).toBe(c);
      expect(loupeCoverage(size, k)).toBe(size / k);
    }
  });
});

describe('HUD', () => {
  const info = { mode: 'fsr1', pass: 'easu-rcas', srcW: 1066, srcH: 600, canvasW: 1920, canvasH: 1080, rect: { x: 0, y: 0, w: 1919, h: 1080 }, gpuMs: 0.5, gpuParts: [{ side: 0, label: 'EASU+RCAS', ms: 0.5 }], chains: 1, compare: null, loupe: null, prescale: 1, stage: null, ui: { scaler: 'sharp', screen: 1, kind: 'rects', rects: 7, applied: true }, density: 'auto', dprEffective: 2 } as const;
  it('shows fps, resolutions, scale and mode', () => {
    const t = formatHud({ fps: 59.96, gameFps: 29.7, info: info as never, dpr: 2 });
    expect(t).toContain('60.0 fps');
    expect(t).toContain('game 29.7/s');
    expect(t).toContain('source 1066x600');
    expect(t).toContain('output 1920x1080 px');
    expect(t).toContain('x1.80');
    expect(t).toContain('dpr 2');
    expect(t).toContain('mode FSR1 (easu-rcas)');
    expect(t).toContain('gpu 0.50 ms (EASU+RCAS)');
  });
  it('shows both modes in compare', () => {
    const t = formatHud({ fps: 1, gameFps: null, info: { ...info, gpuMs: null, gpuParts: [], compare: { a: 'bilinear', b: 'fsr1', passA: 'bilinear', passB: 'easu-rcas', splitPx: 960, prescaleA: 1, prescaleB: 3 } } as never, dpr: 1 });
    expect(t).toContain('A Bilinear (bilinear) | B FSR1 (easu-rcas, 3x pre)');
    expect(t).toContain('gpu - ms');
  });
  it('labels the timed span per side in compare', () => {
    const cmp = { a: 'easu', b: 'fsr1-pixel', passA: 'easu', passB: 'easu-rcas', splitPx: 960, prescaleA: 1, prescaleB: 3 };
    const parts = [{ side: 0, label: 'EASU', ms: 0.2 }, { side: 1, label: 'prescale+EASU+RCAS', ms: 0.9 }];
    const t = formatHud({ fps: 1, gameFps: null, info: { ...info, gpuMs: 1.1, gpuParts: parts, compare: cmp } as never, dpr: 1 });
    expect(t).toContain('A gpu 0.20 ms (EASU) / B gpu 0.90 ms (prescale+EASU+RCAS)');
  });
  it('lists the stage passes, the menus/HUD scaler and the render density', () => {
    const parts = [{ side: 0, label: 'smooth-sxbr: pass 1', ms: 0.4 }, { side: 0, label: 'smooth-sxbr: EASU', ms: 0.9 }, { side: 2, label: 'UI', ms: 0.1 }];
    const t = formatHud({ fps: 1, gameFps: null, info: { ...info, stage: 'smooth-sxbr', gpuMs: 1.4, gpuParts: parts, dprEffective: 1, density: '1', ui: { scaler: 'sharp', screen: 0, kind: 'all', rects: 0, applied: true } } as never, dpr: 2 });
    expect(t).toContain('stage smooth-sxbr');
    expect(t).toContain('gpu 1.40 ms');
    expect(t).toContain('  smooth-sxbr: pass 1 0.40 ms');
    expect(t).toContain('  UI 0.10 ms');
    expect(t).toContain('dpr 2 (render 1.00, density 1)');
    expect(t).toContain('menus/HUD sharp (whole frame)  screen menu');
  });
  it('rate meter smooths a counter', () => {
    const m = new RateMeter();
    m.sample(0, 0);
    expect(m.sample(500, 30)).toBeCloseTo(60);
    expect(m.sample(1000, 60)).toBeCloseTo(60);
    expect(m.sample(1100, 63)).toBeCloseTo(60); // inside the window: unchanged
  });
});
