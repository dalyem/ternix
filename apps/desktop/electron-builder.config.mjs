// electron-builder configuration for the Ternix desktop app.
//
// The app is fully bundled by electron-vite (main, preload, worker and renderer in `out/`),
// so the package contains `out/` and package.json and no node_modules: nothing to resolve
// through pnpm's symlinked workspace layout, and no native modules to rebuild.
//
// Signing and notarization are driven by environment variables and skipped when unset:
//   macOS   CSC_LINK, CSC_KEY_PASSWORD; notarization also APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
//           APPLE_TEAM_ID
//   Windows WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD
// Without them the build is unsigned (set CSC_IDENTITY_AUTO_DISCOVERY=false on a Mac that has
// a signing identity in its keychain that you do not want used).

const notarize = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every(
  (name) => (process.env[name] ?? '') !== '',
);

// Playwright drives Electron through the Node inspector, which the release build turns off.
// The end-to-end test builds a variant with this one fuse on (TERNIX_E2E_BUILD=1); installers
// are never built that way.
const e2eBuild = process.env.TERNIX_E2E_BUILD === '1';

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'dev.ternix.desktop',
  productName: 'Ternix',
  copyright: 'Copyright © Ternix contributors',
  directories: { output: 'dist', buildResources: 'build' },
  // electron-builder always starts from `**/*`; the leading exclusion makes this a whitelist.
  files: ['!**/*', 'out/**/*', 'package.json', '!**/*.map'],
  asar: true,
  npmRebuild: false,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',

  // Binary hardening (flipped in the Electron binary at package time).
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: e2eBuild,
    enableCookieEncryption: true,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
    grantFileProtocolExtraPrivileges: false,
    // Flipping fuses breaks the ad-hoc signature Apple Silicon needs; redo it (uses `codesign`).
    resetAdHocDarwinSignature: process.platform === 'darwin',
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

  // Linux is not a shipped target; `--linux --dir` is the packaging smoke test.
  linux: {
    target: [{ target: 'dir' }],
    executableName: 'ternix',
    category: 'Network',
  },
};
