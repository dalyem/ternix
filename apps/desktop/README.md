# @ternix/desktop

The Ternix desktop app: an Electron client for macOS and Windows with end-to-end encrypted
vaults, sharing, and SSH terminals. It hosts the sync client ([`src/main/client`](src/main/client),
see its [README](src/main/client/README.md)) and the SSH engine (`@ternix/ssh`) in the main
process; the renderer is a React app with xterm.js terminals that can reach main only through a
narrow, validated bridge.

## Layout

| Path                          | What                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/main/client`             | `TernixClient`: protocol client, vault engine, realtime sync (no Electron dependency)                                       |
| `src/main/index.ts`           | Startup: client, SSH manager, IPC, window, auto-lock, quit                                                                  |
| `src/main/app`                | Electron glue: `safeStorage` secret store, settings, Argon2 worker, window hardening, `ternix://` protocol, auto-lock, menu |
| `src/main/ipc`                | The request table: zod schema per method (`schemas.ts`), dispatcher (`dispatch.ts`), handlers (`handlers.ts`)               |
| `src/main/ssh`                | `SshManager`: one `SshSession` per terminal tab, host-key and keyboard-interactive prompts, forwards                        |
| `src/preload`                 | The bridge: `window.ternix` with `invoke`, `onEvent`, `onTerminalData`                                                      |
| `src/renderer`                | React UI: sign-in screens, vault views, editors, terminals, sharing, settings                                               |
| `src/shared`                  | Types shared by main and renderer: client DTOs (`types.ts`), shell DTOs (`app.ts`), the IPC contract (`ipc.ts`)             |
| `build`                       | Icon (`icon.png`, drawn by `generate-icon.mjs`), macOS entitlements                                                         |
| `e2e`                         | Playwright test of the packaged app                                                                                         |
| `electron-builder.config.mjs` | Packaging, fuses, signing                                                                                                   |

## Commands

Run from `apps/desktop` (or with `pnpm --filter @ternix/desktop`). `@ternix/core` and
`@ternix/ssh` are built with `tsc` into `dist/` and must be built first: `pnpm build:deps`
does it, and the `dist:*` scripts call it.

```sh
pnpm dev          # electron-vite dev server + Electron (hot reload for the renderer)
pnpm build        # electron-vite build into out/ (main, preload, worker, renderer)
pnpm dist:mac     # dmg + zip for arm64 and x64 (run on a Mac)
pnpm dist:win     # nsis installers for x64 and arm64
pnpm dist:dir     # unpacked app for the current OS, no installer
pnpm typecheck    # main + preload (tsconfig.json), renderer (tsconfig.web.json), e2e
pnpm lint
pnpm test         # vitest: client tests, IPC validation, secret store, settings, auto-lock
```

On the orchestrator, do not run Electron or builds yourself; use Kiln (`kiln checks run lint
typecheck test` covers everything that does not need the Electron binary).

## How it fits together

- **Sync client.** `TernixClient` gets a `SecretStore` on top of Electron `safeStorage` (one
  encrypted file, `session.bin`, in `userData`), a JSON-file cache store in `userData/cache`,
  `net.fetch` as its `fetch` (Chromium's stack: system proxy, system certificates and the OS
  resolver, so Tailscale MagicDNS names work) and the default `ws` WebSocket. The device is
  reported as `{name: hostname, platform: 'macos' | 'windows' | 'linux'}`.
- **Argon2id off the main thread.** `deriveKeys` runs in a short-lived `worker_threads`
  worker (`src/main/app/deriveWorker.ts`, built as its own chunk by electron-vite's `?modulePath`),
  so unlock and login do not freeze the window.
- **SSH.** Opening a host builds `resolveConnection(items, hostId)` over the decrypted items of
  every vault, then one `SshSession` runs per terminal tab in main. Terminal bytes travel on a
  channel per session (`ternix:term:<id>`, coalesced to a few messages per frame); keystrokes
  come back through the `ssh.write` method. Host-key verification and keyboard-interactive
  prompts round-trip to the renderer as dialogs. An unknown key shows its SHA256 fingerprint and,
  when accepted, is saved as a `known_host` item in the personal vault. A changed key shows a
  warning, defaults to disconnect, and is only accepted through the explicit "Replace stored key"
  action. Port forwards are started and stopped per open terminal, with status. The agent
  socket comes from `defaultAgentPath(process.platform, process.env)`.
- **Locking.** The vault locks on the auto-lock timeout (settings, default 15 minutes of system
  idle time via `powerMonitor.getSystemIdleTime`), when the computer suspends, when the screen
  locks, from "Lock now", and when the window is closed (macOS keeps the app running).
  Locking zeroes the client's keys and clears the vault data from the renderer. **Open SSH
  sessions stay connected** (as in Termius): their output keeps arriving, and the lock screen
  is drawn over the terminals, whose scrollback stays in renderer memory until the tab is closed.
  Unanswered SSH prompts are denied. New connections need an unlocked vault.
- **Offline.** Reading works from the cache after unlock. Writes need the server (the client
  throws `OfflineError`, shown in the editor).

## Security model

The renderer is untrusted: anything it can do, an XSS in it could do. So:

| Control                                                                                                                        | Where                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`                                                            | `src/main/app/window.ts` (`webPreferences`); `app.enableSandbox()` in `src/main/index.ts`  |
| Preload exposes three functions, never `ipcRenderer`                                                                           | `src/preload/index.ts`                                                                     |
| Every IPC argument validated with zod in main, unknown keys refused                                                            | `src/main/ipc/schemas.ts`, `dispatch.ts`; sender, frame and page URL checked in `index.ts` |
| CSP: `default-src 'none'`, `script-src 'self'`, no remote content, no eval                                                     | `<meta>` injected by `electron.vite.config.ts` into `index.html`                           |
| Renderer served from `ternix://app/`, not `file://`                                                                            | `src/main/app/protocol.ts`; fuse `grantFileProtocolExtraPrivileges` off                    |
| No navigation away, no `window.open`, no webviews                                                                              | `lockDownWebContents` in `window.ts`                                                       |
| All permission requests and checks denied                                                                                      | `lockDownSession` in `window.ts`                                                           |
| Single instance                                                                                                                | `requestSingleInstanceLock` in `index.ts`                                                  |
| Opening a link from a terminal needs http(s) and a native confirmation                                                         | `shell.openLink` in `src/main/index.ts` (`openLink`)                                       |
| Session on disk only through `safeStorage`; refuses when unavailable                                                           | `src/main/app/secretStore.ts`; login and register check it first                           |
| Fuses: `runAsNode` off, `NODE_OPTIONS` off, `--inspect` off, `onlyLoadAppFromAsar` on, ASAR integrity on, cookie encryption on | `electron-builder.config.mjs` (`electronFuses`)                                            |
| DevTools only in development                                                                                                   | `devTools: !app.isPackaged`                                                                |

`style-src` allows inline styles because xterm.js writes a `<style>` element for its theme.
On Linux without a keyring, `safeStorage` falls back to a hard-coded key (`basic_text`); the app
treats that as unavailable. `TERNIX_ALLOW_BASIC_TEXT_SECRET_STORE=1` overrides this for
development and CI only.

## Packaging

`electron-vite build` bundles everything into `out/`: the main process, preload and the Argon2
worker as CommonJS, and the renderer. **The packaged app contains no `node_modules`.** All
dependencies (including `ssh2`, `ws`, libsodium and the `@ternix/*` workspace packages) are
`devDependencies` that Vite bundles, so electron-builder never has to resolve pnpm's symlinked
workspace layout, and there are no native modules to rebuild. `ssh2` and `ws` look for optional
native addons (`cpu-features`, `sshcrypto.node`, `bufferutil`, `utf-8-validate`) inside
`try/catch`; the config marks them external so the bundle never tries to include them, and the
runtime falls back to JavaScript.

electron-builder (`electron-builder.config.mjs`): appId `dev.ternix.desktop`, product name
`Ternix`; macOS `dmg` and `zip` for arm64 and x64 with the hardened runtime and
`build/entitlements.mac.plist`; Windows `nsis` for x64 and arm64 (per-user install allowed);
asar on. Signing and notarization read the usual environment variables and are skipped when they
are not set (see the comment at the top of the file). The icon is a placeholder:
`build/icon.png` is committed (regenerate with `node build/generate-icon.mjs`) and
electron-builder converts it to `.icns` and `.ico` while packaging.

CI: [`.github/workflows/desktop.yml`](../../.github/workflows/desktop.yml) builds the installers
on `macos-latest` and `windows-latest` on pushes to `main`, on `v*` tags and on manual dispatch,
and uploads them as artifacts.

## End-to-end test

`e2e/desktop.e2e.ts` drives the packaged app with Playwright's Electron support against a real
`@ternix/server` and an SSH server: it enters the server address, registers, creates a host,
connects, verifies the host key, runs `echo`, checks the saved `known_host`, locks and unlocks,
restarts the app and unlocks again. By default the SSH server is an in-process `ssh2` server
with a fake shell; set `E2E_SSH_ADDRESS`, `E2E_SSH_PORT`, `E2E_SSH_USER` and `E2E_SSH_PASSWORD`
to use a real OpenSSH `sshd`. Screenshots go to `e2e/artifacts/` (ignored by git).

```sh
pnpm run build:packages && pnpm --filter @ternix/server build
cd apps/desktop
pnpm exec electron-vite build
TERNIX_E2E_BUILD=1 pnpm exec electron-builder --config electron-builder.config.mjs --linux --dir --publish never
TERNIX_E2E_EXECUTABLE=$PWD/dist/linux-unpacked/ternix xvfb-run -a pnpm e2e
```

`TERNIX_E2E_BUILD=1` flips one fuse (`enableNodeCliInspectArguments`) on, because Playwright
attaches through the Node inspector; installers are never built that way. On Linux the sandbox
helper `chrome-sandbox` must be setuid root (or user namespaces must be allowed) and the test
should run as a normal user.
