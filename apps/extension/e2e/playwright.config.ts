import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testIgnore: ['ome/**', 'm6/**'],
  timeout: 10 * 60_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'off' },
});
