// Packages the end-to-end test variant: Linux, unpacked (`dist-e2e/linux-unpacked`). Expects
// `TERNIX_E2E_BUILD=1 electron-vite build` to have run (`pnpm dist:e2e` does both).

import { join } from 'node:path';
import { build, Platform } from 'electron-builder';
import { E2E_ENV, isE2eBundle } from '../electron-builder.common.mjs';
import config from '../electron-builder.e2e.mjs';

const appDir = join(import.meta.dirname, '..');

if (process.platform !== 'linux') throw new Error('The end-to-end package is built on Linux only');
if (process.env[E2E_ENV] !== '1') throw new Error(`Run with ${E2E_ENV}=1`);
if (!isE2eBundle(join(appDir, 'out', 'main'))) {
  throw new Error(`out/main is not an end-to-end bundle: run ${E2E_ENV}=1 electron-vite build`);
}

await build({
  projectDir: appDir,
  targets: Platform.LINUX.createTarget('dir'),
  config,
  publish: 'never',
});
