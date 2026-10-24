// SPDX-License-Identifier: GPL-3.0-or-later
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Served from the site root (Cloudflare Pages); VITE_BASE overrides it for a sub-path deploy.
  base: process.env['VITE_BASE'] ?? '/',
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        // standalone GPU test pages (e2e only); set VITE_NO_TEST_PAGES=1 to leave them out of a deploy build
        ...(process.env['VITE_NO_TEST_PAGES'] ? {} : { 'test-fsrcnnx': resolve(import.meta.dirname, 'test-pages/fsrcnnx.html') }),
      },
    },
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
