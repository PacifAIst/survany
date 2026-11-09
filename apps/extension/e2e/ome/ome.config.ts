// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 15 * 60_000,
  workers: 1,
  reporter: [['list']],
});
