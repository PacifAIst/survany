// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  base: '/v/',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2020',
    modulePreload: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        ack: resolve(__dirname, 'ack.html'),
        pin: resolve(__dirname, 'pin.html'),
      },
    },
  },
});
