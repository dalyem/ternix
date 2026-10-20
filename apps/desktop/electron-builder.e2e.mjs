// electron-builder configuration for the end-to-end test package only: an unpacked Linux app
// (`--linux --dir`) whose Electron binary keeps the Node inspector fuse on, because Playwright
// attaches through it. Build it with `pnpm dist:e2e` (scripts/package-e2e.mjs). Any other
// platform or target is refused before packing, so no installer is ever built this way.

import { common, linux, releaseFuses } from './electron-builder.common.mjs';

/**
 * Throws unless electron-builder is about to pack for Linux with no installer target: `--dir`
 * reaches `beforePack` with no target objects at all (or a `dir` one), anything else (AppImage,
 * deb, ...) with its own.
 */
export function assertE2eTarget(context) {
  const targets = (context.targets ?? []).map((target) => target.name);
  if (context.electronPlatformName !== 'linux' || targets.some((name) => name !== 'dir')) {
    throw new Error(
      `The end-to-end package is only built for --linux --dir (asked: ${context.electronPlatformName} ${targets.join(', ') || 'no target'}).`,
    );
  }
}

/** @type {import('electron-builder').Configuration} */
export default {
  ...common,
  directories: { ...common.directories, output: 'dist-e2e' },
  electronFuses: { ...releaseFuses, enableNodeCliInspectArguments: true },
  beforePack: async (context) => assertE2eTarget(context),
  linux,
};
