// SPDX-License-Identifier: GPL-3.0-or-later

export const UPSTREAM_COMMIT = '7e730f0';

export interface AboutInfo {
  sourceUrl: string;
  commit: string;
  date: string;
}

export function aboutInfo(env: ImportMetaEnv = import.meta.env): AboutInfo {
  return {
    sourceUrl: env.VITE_SOURCE_URL || 'https://example.invalid/d2-webgpu (set VITE_SOURCE_URL)',
    commit: env.VITE_COMMIT || 'unknown',
    date: env.VITE_BUILD_DATE || '',
  };
}

/** The build line over the game view: commit, its date, and the engine once the game runs (a stale tab shows an old commit). */
export function versionLabel(info: AboutInfo, engine: string | null = null): string {
  return [info.commit === 'unknown' ? 'dev build' : info.commit, info.date, engine].filter(Boolean).join(' · ');
}
