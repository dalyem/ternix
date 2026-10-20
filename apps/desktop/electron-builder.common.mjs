// Settings shared by the release packaging (`electron-builder.config.mjs`) and the end-to-end
// test packaging (`electron-builder.e2e.mjs`).
//
// The app is fully bundled by electron-vite (main, preload, worker and renderer in `out/`),
// so the package contains `out/` and package.json and no node_modules: nothing to resolve
// through pnpm's symlinked workspace layout, and no native modules to rebuild.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Set while building and packaging the end-to-end test variant, never for a release. */
export const E2E_ENV = 'TERNIX_E2E_BUILD';

/**
 * Only the e2e bundle contains this name: the release main bundle drops the code that reads
 * it (`__TERNIX_E2E__` is false there).
 */
export const E2E_BUNDLE_MARKER = 'TERNIX_ALLOW_BASIC_TEXT_SECRET_STORE';

/** Binary hardening, flipped in the Electron binary at package time. */
export const releaseFuses = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableCookieEncryption: true,
  onlyLoadAppFromAsar: true,
  enableEmbeddedAsarIntegrityValidation: true,
  grantFileProtocolExtraPrivileges: false,
  // Flipping fuses breaks the ad-hoc signature Apple Silicon needs; redo it (uses `codesign`).
  resetAdHocDarwinSignature: process.platform === 'darwin',
};

/** @type {import('electron-builder').Configuration} */
export const common = {
  appId: 'dev.ternix.desktop',
  productName: 'Ternix',
  copyright: 'Copyright © Ternix contributors',
  directories: { output: 'dist', buildResources: 'build' },
  // electron-builder always starts from `**/*`; the leading exclusion makes this a whitelist.
  files: ['!**/*', 'out/**/*', 'package.json', '!**/*.map'],
  asar: true,
  npmRebuild: false,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
};

/** Linux is not a shipped target; `--linux --dir` is the packaging smoke test. */
export const linux = {
  target: [{ target: 'dir' }],
  executableName: 'ternix',
  category: 'Network',
};

/** Whether a bundle in `mainDir` (`out/main`) was built with `TERNIX_E2E_BUILD=1`. */
export function isE2eBundle(mainDir) {
  let files;
  try {
    files = readdirSync(mainDir);
  } catch {
    return false;
  }
  return files
    .filter((name) => /\.(c|m)?js$/.test(name))
    .some((name) => readFileSync(join(mainDir, name), 'utf8').includes(E2E_BUNDLE_MARKER));
}
