/**
 * electron-vite replaces `__TERNIX_E2E__` at build time. Under vitest it is a global, false
 * (the release build) unless a test switches it with `setE2eBuild` and switches it back.
 */
const flags = globalThis as { __TERNIX_E2E__?: boolean };
flags.__TERNIX_E2E__ = false;

export function setE2eBuild(on: boolean): void {
  flags.__TERNIX_E2E__ = on;
}
