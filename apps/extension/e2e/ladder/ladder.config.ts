import { defineConfig } from '@playwright/test';

/** M5 §9 UDP-blocked viewer ladder (deploy/test/compose.m5-ladder.yml). Needs Docker. */
export default defineConfig({
  testDir: '.',
  timeout: 20 * 60_000,
  workers: 1,
  reporter: [['list']],
});
