import { defineConfig } from '@playwright/test';

/**
 * End-to-end test of the packaged app (see e2e/README in apps/desktop/README.md). It needs
 * a display (xvfb on Linux), the built `@ternix/server` and an app packaged with
 * `pnpm dist:e2e` (`TERNIX_E2E_BUILD=1`, Linux `--dir` only).
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  outputDir: 'artifacts/playwright',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
