// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { comparePass, planCompare } from './compare';
import { PRESENT_MODES, modeAvailable, parsePresentMode, planPresent } from './fsr';
import { resampleKind } from './resample';
import { SMOOTH_SCALEFX_MIN_SCALE, clearStageFailed, markStageFailed, registerStage, resetStagesForTests, resolveStageMode, stageAvailable, unregisterStage } from './upscale/registry';
import type { UpscaleStage } from './upscale/stage';

const fake = (): UpscaleStage => ({ ratio: 2, passes: 1, encode: () => ({ view: {} as GPUTextureView, width: 0, height: 0 }), liveTextures: () => 0, destroy: () => undefined });

afterEach(() => resetStagesForTests());

describe('stage modes without registered stages', () => {
  it('are listed but not available, and parse', () => {
    for (const id of ['smooth', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx'] as const) {
      expect(PRESENT_MODES.some((m) => m.id === id)).toBe(true);
      expect(parsePresentMode(id)).toBe(id);
      expect(modeAvailable(id)).toBe(false);
    }
    expect(modeAvailable('fsr1')).toBe(true);
  });

  it('planPresent falls back to fsr1 (EASU+RCAS upscaling, bilinear below 1x)', () => {
    for (const mode of ['smooth', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx'] as const) {
      expect(planPresent(mode, 1066, 600, 3200, 1800)).toEqual(planPresent('fsr1', 1066, 600, 3200, 1800));
      expect(planPresent(mode, 1066, 600, 800, 450).pass).toBe('bilinear');
      expect(comparePass(mode, planCompare(mode, 'fsr1', 0.5, 1066, 600, 3200, 1800).rect, 1066, 600)).toBe('easu-rcas');
    }
  });
});

describe('stage modes with registered stages', () => {
  it('plan a stage pass at an upscale and resolve smooth by scale', () => {
    registerStage('smooth-scalefx', fake);
    registerStage('smooth-sxbr', fake);
    expect(planPresent('smooth-sxbr', 1066, 600, 3200, 1800)).toMatchObject({ pass: 'stage', stage: 'smooth-sxbr' });
    expect(planPresent('smooth', 800, 600, 3200, 2400)).toMatchObject({ pass: 'stage', stage: 'smooth-scalefx' }); // 4x
    expect(planPresent('smooth', 1066, 600, 3198, 1800)).toMatchObject({ pass: 'stage', stage: 'smooth-scalefx' }); // 3x
    expect(planPresent('smooth', 1066, 600, 1866, 1050)).toMatchObject({ pass: 'stage', stage: 'smooth-sxbr' }); // 1.75x
    expect(resolveStageMode('smooth', SMOOTH_SCALEFX_MIN_SCALE)).toBe('smooth-scalefx');
    expect(resolveStageMode('smooth', SMOOTH_SCALEFX_MIN_SCALE - 0.01)).toBe('smooth-sxbr');
    // fsrcnnx has no stage: falls back
    expect(planPresent('fsrcnnx', 1066, 600, 3200, 1800).pass).toBe('easu-rcas');
  });

  it('smooth uses the one concrete stage that exists; below 1x or at 1x without upscale there is no stage', () => {
    registerStage('smooth-sxbr', fake);
    expect(resolveStageMode('smooth', 4)).toBe('smooth-sxbr');
    expect(stageAvailable('smooth')).toBe(true);
    expect(stageAvailable('smooth-scalefx')).toBe(false);
    expect(planPresent('smooth-sxbr', 1066, 600, 800, 450).pass).toBe('bilinear');
    unregisterStage('smooth-sxbr');
    expect(stageAvailable('smooth')).toBe(false);
  });

  it('a failed stage falls back until cleared (the renderer retries a failed load after a back-off)', () => {
    registerStage('fsrcnnx', fake);
    markStageFailed('fsrcnnx');
    expect(stageAvailable('fsrcnnx')).toBe(false);
    expect(planPresent('fsrcnnx', 1066, 600, 3200, 1800).pass).toBe('easu-rcas');
    clearStageFailed('fsrcnnx');
    expect(stageAvailable('fsrcnnx')).toBe(true);
    expect(planPresent('fsrcnnx', 1066, 600, 3200, 1800)).toMatchObject({ pass: 'stage', stage: 'fsrcnnx' });
  });

  it('compare plans carry the stage per side', () => {
    registerStage('fsrcnnx', fake);
    const c = planCompare('fsrcnnx', 'fsr1', 0.5, 1066, 600, 3200, 1800);
    expect(c.a).toMatchObject({ pass: 'stage', stage: 'fsrcnnx' });
    expect(c.b.pass).toBe('easu-rcas');
    expect(c.b.stage).toBeUndefined();
  });
});

describe('resample kind', () => {
  it('upscales with EASU, downsamples with the area pass, copies when equal', () => {
    expect(resampleKind(2132, 1200, { w: 3198, h: 1800 })).toBe('easu-rcas');
    expect(resampleKind(3198, 1800, { w: 1866, h: 1050 })).toBe('down');
    expect(resampleKind(2132, 1200, { w: 2132, h: 1200 })).toBe('copy');
    expect(resampleKind(2132, 1200, { w: 2133, h: 1200 })).toBe('easu-rcas');
  });
});
