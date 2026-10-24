// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Served from the site root (Cloudflare Pages); VITE_BASE overrides it for a sub-path deploy.
  base: process.env['VITE_BASE'] ?? '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
