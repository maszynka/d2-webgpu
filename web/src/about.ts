// SPDX-License-Identifier: GPL-3.0-or-later

export const UPSTREAM_COMMIT = '7e730f0';

export interface AboutInfo {
  sourceUrl: string;
  commit: string;
}

export function aboutInfo(env: ImportMetaEnv = import.meta.env): AboutInfo {
  return {
    sourceUrl: env.VITE_SOURCE_URL || 'https://example.invalid/d2-webgpu (set VITE_SOURCE_URL)',
    commit: env.VITE_COMMIT || 'unknown',
  };
}
