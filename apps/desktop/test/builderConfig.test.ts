import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The release packaging must never get the end-to-end test's exceptions: the Node inspector
 * fuse, or a main bundle with the `basic_text` escape hatch compiled in.
 */

interface BuilderConfig {
  electronFuses: Record<string, boolean>;
  beforePack?: (context: unknown) => Promise<void>;
}
interface CommonModule {
  isE2eBundle(dir: string): boolean;
  E2E_BUNDLE_MARKER: string;
}
interface E2eModule {
  default: BuilderConfig;
  assertE2eTarget(context: { electronPlatformName: string; targets: { name: string }[] }): void;
}

// Specifiers in variables: these are plain JavaScript modules without type declarations.
const RELEASE = '../electron-builder.config.mjs';
const E2E = '../electron-builder.e2e.mjs';
const COMMON = '../electron-builder.common.mjs';

const load = async <T>(specifier: string): Promise<T> => {
  vi.resetModules();
  return (await import(/* @vite-ignore */ specifier)) as T;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('electron-builder configs', () => {
  it('the release config refuses to load for the e2e build', async () => {
    vi.stubEnv('TERNIX_E2E_BUILD', '1');
    await expect(load(RELEASE)).rejects.toThrow(/TERNIX_E2E_BUILD/);
  });

  it('the release config turns off the inspector and RunAsNode fuses', async () => {
    vi.stubEnv('TERNIX_E2E_BUILD', '');
    const { default: config } = await load<{ default: BuilderConfig }>(RELEASE);
    expect(config.electronFuses).toMatchObject({
      runAsNode: false,
      enableNodeCliInspectArguments: false,
      enableNodeOptionsEnvironmentVariable: false,
    });
  });

  it('the e2e config packs nothing but the Linux dir target', async () => {
    const e2e = await load<E2eModule>(E2E);
    expect(e2e.default.electronFuses).toMatchObject({
      enableNodeCliInspectArguments: true,
      runAsNode: false,
    });
    // `--linux --dir` reaches beforePack with no target objects.
    for (const targets of [[], [{ name: 'dir' }]]) {
      expect(() => e2e.assertE2eTarget({ electronPlatformName: 'linux', targets })).not.toThrow();
    }
    for (const context of [
      { electronPlatformName: 'darwin', targets: [] },
      { electronPlatformName: 'win32', targets: [] },
      { electronPlatformName: 'darwin', targets: [{ name: 'dmg' }] },
      { electronPlatformName: 'win32', targets: [{ name: 'nsis' }] },
      { electronPlatformName: 'linux', targets: [{ name: 'AppImage' }] },
      { electronPlatformName: 'linux', targets: [{ name: 'dir' }, { name: 'deb' }] },
    ]) {
      expect(() => e2e.assertE2eTarget(context)).toThrow(/--linux --dir/);
      await expect(e2e.default.beforePack!(context)).rejects.toThrow(/--linux --dir/);
    }
  });

  it('recognizes a main bundle built for the e2e test', async () => {
    const common = await load<CommonModule>(COMMON);
    const dir = await mkdtemp(join(tmpdir(), 'ternix-bundle-'));
    try {
      const main = join(dir, 'main');
      expect(common.isE2eBundle(main)).toBe(false); // no bundle yet
      await mkdir(main);
      await writeFile(join(main, 'index.cjs'), 'const release = true;');
      expect(common.isE2eBundle(main)).toBe(false);
      await writeFile(join(main, 'chunk.cjs'), `env["${common.E2E_BUNDLE_MARKER}"] === "1"`);
      expect(common.isE2eBundle(main)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
