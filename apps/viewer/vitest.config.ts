// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'viewer', include: ['test/**/*.test.ts'], environment: 'happy-dom' },
});
