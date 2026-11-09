// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

// Docker-backed acceptance tests. Not part of the default `pnpm test` projects; run explicitly:
//   pnpm vitest run -c apps/backend/vitest.docker.config.ts
export default defineConfig({
  test: {
    name: 'backend-docker',
    root: __dirname,
    include: ['test-docker/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 10 * 60_000,
    hookTimeout: 15 * 60_000,
    fileParallelism: false,
  },
});
