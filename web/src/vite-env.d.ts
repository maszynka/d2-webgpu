// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SOURCE_URL?: string;
  readonly VITE_COMMIT?: string;
  /** the commit's date, YYYY-MM-DD (scripts/deploy.sh) */
  readonly VITE_BUILD_DATE?: string;
  /** where visits are sent; default /api/visit on the same origin (the GitHub Pages build points at the Worker) */
  readonly VITE_VISIT_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
