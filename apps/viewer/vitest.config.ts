import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'viewer', include: ['test/**/*.test.ts'], environment: 'happy-dom' },
});
