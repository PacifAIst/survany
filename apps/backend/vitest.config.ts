import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'backend',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
  },
});
