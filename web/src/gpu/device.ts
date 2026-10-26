// SPDX-License-Identifier: GPL-3.0-or-later

export interface AdapterSummary {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallback: boolean;
  features: string[];
}

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  info: AdapterSummary;
}

export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu;
}

export async function requestGpu(): Promise<GpuContext> {
  if (!hasWebGPU()) throw new Error('navigator.gpu is not available');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter available');
  // timestamp queries time the presentation passes (debug panel); optional
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has('timestamp-query') ? (['timestamp-query'] as GPUFeatureName[]) : [] });
  const ai = adapter.info;
  const info: AdapterSummary = {
    vendor: ai.vendor,
    architecture: ai.architecture,
    device: ai.device,
    description: ai.description,
    isFallback: (ai as { isFallbackAdapter?: boolean }).isFallbackAdapter ?? false,
    features: [...adapter.features],
  };
  return { adapter, device, info };
}
