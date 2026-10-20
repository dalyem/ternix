import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Everything is bundled into `out/` (the packaged app contains no node_modules), so the
 * main, preload and worker outputs are CommonJS: a sandboxed preload cannot be ESM, and
 * `ssh2` and `ws` are CommonJS packages. `type: module` in package.json makes `.cjs` the
 * extension for those outputs.
 */
const commonjsOutput = { format: 'cjs', entryFileNames: '[name].cjs' } as const;

/** `ssh2` and `ws` try optional native addons inside try/catch; they stay absent. */
const optionalNative = [/\.node$/, 'cpu-features', 'bufferutil', 'utf-8-validate'];

const baseCsp = [
  "default-src 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
];

/**
 * Content-Security-Policy for the renderer, as a <meta> tag (the app loads from file://, so
 * there is no response to carry a header). No remote content and no eval. `style-src` allows
 * inline styles because xterm.js writes a <style> element for its theme; scripts stay
 * 'self' only. The dev server needs inline scripts (React refresh) and a websocket (HMR).
 */
function csp(): Plugin {
  let serving = false;
  return {
    name: 'ternix:csp',
    configResolved(config) {
      serving = config.command === 'serve';
    },
    transformIndexHtml(html) {
      const policy = serving
        ? [
            ...baseCsp,
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "connect-src 'self' ws://localhost:* http://localhost:*",
          ]
        : [
            ...baseCsp,
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "connect-src 'none'",
          ];
      return html.replace('%CSP%', policy.join('; '));
    },
  };
}

/**
 * `__TERNIX_E2E__` is true only for the end-to-end test bundle (`TERNIX_E2E_BUILD=1`); in a
 * release bundle the code it guards is removed, and `electron-builder.config.mjs` refuses to
 * package an e2e bundle.
 */
const e2eBuild = process.env['TERNIX_E2E_BUILD'] === '1';

export default defineConfig({
  main: {
    define: { __TERNIX_E2E__: JSON.stringify(e2eBuild) },
    build: {
      externalizeDeps: false,
      rollupOptions: { external: optionalNative, output: commonjsOutput },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { output: commonjsOutput },
    },
  },
  renderer: {
    plugins: [react(), csp()],
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
  },
});
