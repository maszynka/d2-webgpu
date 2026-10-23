// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SOURCE_URL?: string;
  readonly VITE_COMMIT?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
