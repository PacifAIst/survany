// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

/** Measurement runs, not unit tests: `pnpm bench:providers`. Not part of `pnpm test`. */
export default defineConfig({
  test: { name: 'bench', include: ['bench/*.run.ts'], environment: 'node', testTimeout: 6 * 3600_000, hookTimeout: 600_000, fileParallelism: false },
});
