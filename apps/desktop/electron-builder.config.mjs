// electron-builder configuration for the Ternix desktop app: the release installers.
//
// Signing and notarization are driven by environment variables and skipped when unset:
//   macOS   CSC_LINK, CSC_KEY_PASSWORD; notarization also APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
//           APPLE_TEAM_ID
//   Windows WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD
// Without them the build is unsigned (set CSC_IDENTITY_AUTO_DISCOVERY=false on a Mac that has
// a signing identity in its keychain that you do not want used).
//
// The end-to-end test package (inspector fuse on, `basic_text` escape hatch compiled in) has
// its own config, `electron-builder.e2e.mjs`, which only builds `--linux --dir`. This one
// refuses to run in that environment, and refuses a bundle built for it.

import { join } from 'node:path';
import { common, E2E_ENV, isE2eBundle, linux, releaseFuses } from './electron-builder.common.mjs';

if (process.env[E2E_ENV]) {
  throw new Error(
    `${E2E_ENV} is set: release packaging refuses the end-to-end build. ` +
      'Use `pnpm dist:e2e` for the test package.',
  );
}

const MAIN_BUNDLE = join(import.meta.dirname, 'out', 'main');

const notarize = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every(
  (name) => (process.env[name] ?? '') !== '',
);

/** @type {import('electron-builder').Configuration} */
export default {
  ...common,

  electronFuses: releaseFuses,

  // `out/` may still hold an e2e bundle from an earlier `TERNIX_E2E_BUILD=1 electron-vite build`.
  beforePack: async () => {
    if (isE2eBundle(MAIN_BUNDLE)) {
      throw new Error(
        'out/main was built for the end-to-end test (TERNIX_E2E_BUILD=1). Run `electron-vite build` again without it.',
      );
    }
  },

  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize,
  },
  dmg: { sign: false },

  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    buildUniversalInstaller: false,
    deleteAppDataOnUninstall: false,
  },

  linux,
};
