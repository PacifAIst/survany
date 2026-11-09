import { defineConfig } from '@playwright/test';

/** M6 end to end: real extension + real backend + real confirm-gate-mcp 0.8.0 (deploy/test/compose.m6.yml). Needs Docker and `pnpm build:e2e`. */
export default defineConfig({
  testDir: '.',
  timeout: 15 * 60_000,
  workers: 1,
  reporter: [['list']],
});
