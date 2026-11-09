import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 15 * 60_000,
  workers: 1,
  reporter: [['list']],
});
