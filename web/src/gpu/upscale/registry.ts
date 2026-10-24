// SPDX-License-Identifier: GPL-3.0-or-later
// Registry of the world-scaler stages (dedither + ScaleFX / Super-xBR, FSRCNNX). Each stage module calls
// registerStage(mode, factory) with a concrete mode id; the renderer asks resolveStageMode() which concrete stage runs
// for a presentation mode at a given scale and builds it lazily through createStage(). A mode without a factory is
// "not available": the UI lists it disabled and planPresent falls back to FSR1. See docs/plans/upscalers.md.
import type { UpscaleStage } from './stage';

/** presentation modes that run a stage: 'smooth' is the auto choice between the two concrete smooth stages */
export type StageMode = 'smooth' | 'smooth-scalefx' | 'smooth-sxbr' | 'fsrcnnx';
export const STAGE_MODES: readonly StageMode[] = ['smooth', 'smooth-scalefx', 'smooth-sxbr', 'fsrcnnx'];
/** "smooth" uses ScaleFX (3x) from this output scale up, Super-xBR (2x) below it */
export const SMOOTH_SCALEFX_MIN_SCALE = 2.5;

/** A factory may be async (FSRCNNX fetches its weights and builds pipelines): the renderer presents FSR1 until it resolves. */
export type StageFactory = (device: GPUDevice) => UpscaleStage | Promise<UpscaleStage>;

const factories = new Map<string, StageFactory>();
const failed = new Set<string>();
const loading = new Set<string>();
const listeners = new Set<() => void>();

export function isStageMode(mode: string): mode is StageMode {
  return (STAGE_MODES as readonly string[]).includes(mode);
}

/** Register (or replace) the factory of a concrete stage mode ('smooth-scalefx', 'smooth-sxbr', 'fsrcnnx'). */
export function registerStage(mode: string, factory: StageFactory): void {
  factories.set(mode, factory);
  failed.delete(mode);
  for (const l of listeners) l();
}

export function unregisterStage(mode: string): void {
  factories.delete(mode);
  for (const l of listeners) l();
}

/** The renderer calls this when a stage's factory or encode threw: the mode becomes unavailable (falls back to FSR1). */
export function markStageFailed(mode: string): void {
  failed.add(mode);
  for (const l of listeners) l();
}

/** The renderer reports a mode whose async factory is in flight (the UI shows "loading\u2026"). */
export function setStageLoading(mode: string, on: boolean): void {
  if (on === loading.has(mode)) return;
  if (on) loading.add(mode);
  else loading.delete(mode);
  for (const l of listeners) l();
}

/** Whether a presentation mode is still loading (async factory pending); 'smooth' when its resolved candidates are. */
export function stageLoading(mode: string): boolean {
  if (mode === 'smooth') return ['smooth-scalefx', 'smooth-sxbr'].some((m) => loading.has(m));
  return loading.has(mode);
}

function concreteAvailable(mode: string): boolean {
  return factories.has(mode) && !failed.has(mode);
}

/** Whether a presentation mode can run a stage now ('smooth': either concrete smooth stage is registered). */
export function stageAvailable(mode: string): boolean {
  if (mode === 'smooth') return concreteAvailable('smooth-scalefx') || concreteAvailable('smooth-sxbr');
  return concreteAvailable(mode);
}

/**
 * The concrete stage mode that runs for `mode` at output scale `scale` (rect width / source width), or null when none
 * is available. 'smooth' prefers ScaleFX from SMOOTH_SCALEFX_MIN_SCALE up, else Super-xBR, and uses the other when
 * only one is registered.
 */
export function resolveStageMode(mode: string, scale: number): string | null {
  if (mode === 'smooth') {
    const order = scale >= SMOOTH_SCALEFX_MIN_SCALE ? ['smooth-scalefx', 'smooth-sxbr'] : ['smooth-sxbr', 'smooth-scalefx'];
    return order.find(concreteAvailable) ?? null;
  }
  return isStageMode(mode) && concreteAvailable(mode) ? mode : null;
}

export function createStage(mode: string, device: GPUDevice): UpscaleStage | Promise<UpscaleStage> {
  const f = factories.get(mode);
  if (!f) throw new Error(`no upscale stage registered for ${mode}`);
  return f(device);
}

/** Called whenever the registry changes (the UI re-enables its options). Returns an unsubscribe function. */
export function onStagesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only: forget every registration. */
export function resetStagesForTests(): void {
  factories.clear();
  failed.clear();
  loading.clear();
  listeners.clear();
}
