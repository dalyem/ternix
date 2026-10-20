import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `__TERNIX_E2E__` is a global here (false: the release build); see test/setup.ts.
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
