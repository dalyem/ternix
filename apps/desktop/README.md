# @ternix/desktop

The Ternix desktop app: an Electron client for macOS and Windows with end-to-end encrypted
vaults, sharing, and SSH terminals. It hosts the sync client ([`src/main/client`](src/main/client),
see its [README](src/main/client/README.md)) and the SSH engine (`@ternix/ssh`) in the main
process; the renderer is a React app with xterm.js terminals that can reach main only through a
narrow, validated bridge.

## Layout

| Path                          | What                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/client`             | `TernixClient`: protocol client, vault engine, realtime sync (no Electron dependency)                                                                          |
| `src/main/index.ts`           | Startup: client, SSH manager, IPC, window, auto-lock, quit                                                                                                     |
| `src/main/app`                | Electron glue: `safeStorage` secret store, settings, Argon2 worker, window hardening, `ternix://` protocol, auto-lock, menu, native trust dialogs (`trust.ts`) |
| `src/main/ipc`                | The request table: zod schema per method (`schemas.ts`), dispatcher (`dispatch.ts`), handlers (`handlers.ts`), secret redaction and merging (`secrets.ts`)     |
| `src/main/ssh`                | `SshManager`: one `SshSession` per terminal tab, host-key and keyboard-interactive prompts, forwards                                                           |
| `src/preload`                 | The bridge: `window.ternix` with `invoke`, `onEvent`, `onTerminalData`                                                                                         |
| `src/renderer`                | React UI: sign-in screens, vault views, editors, terminals, sharing, settings                                                                                  |
| `src/shared`                  | Types shared by main and renderer: client DTOs (`types.ts`), shell DTOs (`app.ts`), the IPC contract (`ipc.ts`)                                                |
| `build`                       | Icon (`icon.png`, drawn by `generate-icon.mjs`), macOS entitlements                                                                                            |
| `e2e`                         | Playwright test of the packaged app                                                                                                                            |
| `electron-builder.config.mjs` | Release packaging, fuses, signing (shared parts in `electron-builder.common.mjs`)                                                                              |
| `electron-builder.e2e.mjs`    | The end-to-end test package only (`--linux --dir`, inspector fuse on); built by `scripts/package-e2e.mjs`                                                      |

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
pnpm dist:e2e     # the end-to-end test package (Linux only), dist-e2e/linux-unpacked
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
- **SSH.** Opening a host builds `resolveConnection(items, hostId)` over a snapshot of the
  decrypted items of every vault; the snapshot is dropped right after, and the connection's
  hooks keep only the known hosts of its hops and the personal vault ID. One `SshSession` runs
  per terminal tab in main. Terminal bytes travel on a channel per session (`ternix:term:<id>`,
  coalesced to a few messages per frame); keystrokes come back through the `ssh.write` method.
  Before a connection does anything on the network, main checks every hop (jump hosts and
  target) for a stored `known_host` item (host compared case-insensitively, port exactly, as
  the host-key check does). If any hop has none, main's native **"Connect to a new host?"**
  dialog lists the new `host:port` addresses verbatim (control and invisible characters shown
  as `\u{..}`) and, for a jump chain, the whole route in order; Cancel is the default. Until
  the user answers there is no DNS lookup and no socket, so a name such as
  `<encoded secret>.attacker.example` cannot leak through the resolver. Declining closes the
  tab with "Connection not approved" (`not_approved`). The approval holds for that attempt
  only; the host-key dialog that follows is what saves trust.
  Host keys are verified in a **native dialog that main opens** (`src/main/app/trust.ts`), not
  in the renderer: an unknown key shows host:port, key type and SHA256 fingerprint and, when
  accepted, is saved as a `known_host` item in the personal vault. A changed key shows both
  fingerprints, defaults to Disconnect, and is only accepted with "Replace stored key and
  connect" plus the "I know why the key changed" checkbox. Keyboard-interactive prompts go to
  the renderer as dialogs and are denied after 5 minutes without an answer. Every prompt
  belongs to one connection attempt: closing, failing or reconnecting the tab cancels it
  (closing a native dialog with its `AbortSignal`), and main checks that the attempt is still
  current before it saves a key or goes on. A connection whose shell cannot be opened is
  closed. Port forwards are started and stopped per open terminal, with status. A local or
  dynamic forward must listen on an IP address or `localhost` (main refuses any other bind
  address before starting it, since a name would be looked up in DNS). The agent socket comes
  from `defaultAgentPath(process.platform, process.env)` and is used for agent forwarding only:
  the engine signs in with a stored key, a password or keyboard-interactive, in that order,
  never with the agent. A quick-connect password is dropped once the session has signed in, so
  reconnecting that tab can only sign in through keyboard-interactive; a server that does not
  offer it needs a new quick connect.
- **Secrets in the renderer.** `items.all` and every write result carry payloads without
  `password`, `passphrase` and `private_key`; `has_password`, `has_passphrase` and
  `has_private_key` say whether a value is stored. An editor fetches one item's secrets with
  `items.reveal` when the user clicks "Show". `items.put` merges: a secret field left out keeps
  the stored value, `null` or `''` clears it (see `ItemDraftInput` in `src/shared/types.ts`).
  `known_host` items cannot be created or changed through `items.put` (only deleted); main
  writes them after the host-key dialog.
- **Locking.** The vault locks on the auto-lock timeout (settings, default 15 minutes of system
  idle time via `powerMonitor.getSystemIdleTime`), when the computer suspends, when the screen
  locks, from "Lock now", and when the window is closed (macOS keeps the app running).
  Locking zeroes the client's keys (`client.lock()` is awaited, so the pending cache writes are
  stored) and clears the vault data from the renderer: on every way out of `unlocked` (lock,
  logout, expiry, revocation) the store drops items and the open editor, and the vault views,
  editors and settings forms unmount, taking revealed secrets and typed passwords with them.
  Only the terminal panes stay mounted. **Leaving the session** (logout, expiry, revocation,
  signing out from the key-mismatch screen; switching accounts logs out first) goes further:
  main reloads the window, so nothing the old page kept in its own JavaScript survives, and
  refuses every request from the old page (see the security table). Terminals that stay
  connected through an expiry reattach to the new page, but its terminal starts blank: the
  scrollback starts over, and the modes the shell had set (mouse reporting, application cursor
  keys, the alternate screen) are gone, because main keeps no copy of the display. The tab
  shows a note saying so (written to the terminal only, never sent to the server): full-screen
  apps may need a redraw (Ctrl+L) or a restart. Main
  keeps why the session ended (revoked, expired, logout could not reach the server) and the
  new page shows it. **Open SSH
  sessions stay connected** (as in Termius): their output keeps arriving, and the lock screen
  is drawn over the terminals, whose scrollback stays in renderer memory until the tab is closed.
  Unanswered SSH prompts are denied. New connections need an unlocked vault.
- **Quitting.** Every quit request (`before-quit` and `will-quit`, so also the last window
  closing on Windows and Linux) is held back with `preventDefault` until the SSH sessions are
  closed (2 s at most) and `client.close()` has stored the pending cache writes (5 s at most);
  then the app quits for real (`src/main/app/quit.ts`). "Shutdown running" and "exit allowed"
  are separate states: a second quit while the work runs is held back too, and only the request
  made after the work finished goes through.
- **Server address.** It is chosen only while signed out: `server.probe` and `server.remember`
  are refused in the `locked` and `unlocked` states (a renderer could otherwise send vault data
  out in a URL), and the client refuses `login`/`register` unless signed out. Main remembers
  the address the sign-in screen starts with (`server.json` in `userData`; set by a signed-out
  page or by a successful sign-in, forgotten by "Sign out and change"), not the renderer's
  `localStorage`, where a signed-in page could plant an address for the page after sign-out
  to probe. `https://` is required, except plain
  `http://` for loopback. A Tailscale
  address (`*.ts.net`, 100.64.0.0/10) is no exception: use `tailscale serve` and
  `https://<machine>.<tailnet>.ts.net`. The setup screen says so, and shows a "Tailscale" badge
  next to the normalized URL (`server.probe` adds `tailnet` using the client's `isTailnetHost`).
  The client never follows a redirect; `unexpected_redirect` is shown as "The server answered
  with a redirect to <location>. Enter the final address instead."
- **Member keys.** Members are shown with a pin badge: `verified` (the fingerprint was compared
  out of band), `unverified` (trusted on first use; "Mark verified" calls
  `vaults.markMemberVerified`) and `key changed` (the server reports another key than the
  pinned one). Adding a member, marking one verified and accepting a changed key are each
  confirmed in a **native dialog main opens**, showing the email the server reported for the
  user (main remembers it from `vaults.lookupUser`, `vaults.members` and `admin.users.list`, and
  refuses users it has not seen) and the fingerprint of the exact key that will be pinned; the
  default button is Cancel, and declining fails with `cancelled`, which the UI ignores. A
  refused rotation, add or verify (`member_key_changed`, with `ErrorDto.keyChange`) opens the
  renderer's key change dialog with both fingerprints; "I verified the new fingerprint with
  <email>" calls `vaults.acceptMemberKey` (main asks again) and runs the operation again.
  `own_key_mismatch` with a session replaces the app with a blocking screen that only offers
  sign out, which reloads into the sign-in screen. Raised by a register or login, it leaves no
  session: the sign-in screen shows it with a "Back" button instead. `auth.logout` succeeds
  when there is no session.
- **Cancelled operations.** `cancelled` (an unlock, login, register or password change that
  lock, logout or quit superseded) never shows as an error. Login, register, unlock and sign
  out run one at a time in the UI: their buttons are disabled while any of them is pending.
- **Group ports.** A host's own port is authoritative (`@ternix/ssh`); a group's "Default port"
  only pre-fills the port when creating a host in the group, or when the group changes while the
  port is untouched (the nearest group up the chain that has a port).
- **Offline.** Reading works from the cache after unlock. Writes need the server (the client
  throws `OfflineError`, shown in the editor).

## Security model

The renderer is untrusted: anything it can do, an XSS in it could do. So:

| Control                                                                                                                        | Where                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`                                                            | `src/main/app/window.ts` (`webPreferences`); `app.enableSandbox()` in `src/main/index.ts`   |
| Preload exposes three functions, never `ipcRenderer`                                                                           | `src/preload/index.ts`                                                                      |
| Every IPC argument validated with zod in main, unknown keys refused                                                            | `src/main/ipc/schemas.ts`, `dispatch.ts`; sender, frame and page URL checked in `index.ts`  |
| CSP: `default-src 'none'`, `script-src 'self'`, no remote content, no eval                                                     | `<meta>` injected by `electron.vite.config.ts` into `index.html`                            |
| Renderer served from `ternix://app/`, not `file://`                                                                            | `src/main/app/protocol.ts`; fuse `grantFileProtocolExtraPrivileges` off                     |
| No navigation away, no `window.open`, no webviews                                                                              | `lockDownWebContents` in `window.ts`                                                        |
| All permission requests and checks denied                                                                                      | `lockDownSession` in `window.ts`                                                            |
| Single instance                                                                                                                | `requestSingleInstanceLock` in `index.ts`                                                   |
| Opening a link from a terminal needs http(s) and a native confirmation                                                         | `shell.openLink` in `src/main/index.ts` (`openLink`)                                        |
| Host keys, adding members, accepting and verifying member keys: answered in main's native dialog, default deny; no IPC answer  | `src/main/app/trust.ts`, `ssh/manager.ts`, `ipc/handlers.ts`                                |
| Item lists carry no secret fields; one item at a time through `items.reveal`; untouched secrets kept on edit                   | `src/main/ipc/secrets.ts`, `handlers.ts`                                                    |
| `known_host` items written only by main after the host-key dialog                                                              | `items.put` in `handlers.ts`                                                                |
| `server.probe`, `server.remember`, `auth.login`, `auth.register` only while signed out, never from a page logging out          | `choosingServer` in `handlers.ts`, `src/main/app/serverAddress.ts`                          |
| Leaving a session reloads the window; requests from the page before the reload are refused (`stale_page`)                      | `src/main/ipc/pageGate.ts`, `PAGE_CHANNEL` in `src/preload/index.ts`                        |
| A hop without a stored host key is approved in main's dialog before any DNS lookup or connection                               | `confirmNewHosts` in `trust.ts`, `ssh/manager.ts`                                           |
| Local and dynamic forwards listen only on an IP address or `localhost`, never a name to look up                                | `startForward` in `ssh/manager.ts`; the forward editor checks too                           |
| Locking unmounts everything but the terminals and clears decrypted state                                                       | `src/renderer/src/screens/Shell.tsx`, `store.ts` (`clearData`)                              |
| Session on disk only through `safeStorage`; refuses when unavailable                                                           | `src/main/app/secretStore.ts`; login and register check it first                            |
| Fuses: `runAsNode` off, `NODE_OPTIONS` off, `--inspect` off, `onlyLoadAppFromAsar` on, ASAR integrity on, cookie encryption on | `electron-builder.common.mjs` (`releaseFuses`); read back in CI by `scripts/check-fuses.sh` |
| DevTools only in development                                                                                                   | `devTools: !app.isPackaged`                                                                 |

`style-src` allows inline styles because xterm.js writes a `<style>` element for its theme.
On Linux without a keyring, `safeStorage` falls back to a hard-coded key (`basic_text`); the app
treats that as unavailable. Only the end-to-end test build honours
`TERNIX_ALLOW_BASIC_TEXT_SECRET_STORE=1`: the check sits behind `__TERNIX_E2E__`, a build-time
constant (electron-vite `define`, true only with `TERNIX_E2E_BUILD=1`), so release bundles do
not contain it, and the release packaging refuses a main bundle that does.

### Residual risks

These controls are defence in depth, not isolation of secret editing. Code running in a
compromised renderer can still:

- call `items.reveal` and read items' secrets one at a time (an editor needs them), and keep
  them in its own memory while the session lasts. It has no network access of its own (CSP
  `connect-src 'none'`, no navigation), `server.probe`, `server.remember`, `auth.login` and
  `auth.register` are refused while signed in and from a page whose logout is still running,
  and leaving the session reloads the page and refuses the old page's requests.
  It can write what it read to the page's web storage (`localStorage`, `sessionStorage`),
  which survives the reload; the app never reads either (except the theme choice, a value
  checked against `system`, `dark` and `light`), so only a new compromise of the
  fresh page could pick it up;
- read snippets and notes in bulk with `items.all` (only `password`, `passphrase` and
  `private_key` are held back): do not keep secrets in snippet scripts or notes;
- type into open terminals with `ssh.write`, and so run commands on hosts that are connected;
- start connections to saved hosts and quick-connect targets. A host with a stored key
  connects without asking; an address without one waits for the user in main's "Connect to a
  new host?" dialog before any lookup, and a new host key still needs the host-key dialog;
- start a saved port forward on a connected, trusted host. A remote forward's destination
  (`dest_host`) is resolved and connected to locally each time the server sends a connection
  through it, without a dialog, so an attacker-chosen forward on a trusted host can make the
  computer look up a name. Local and dynamic forwards hand their destinations to the SSH
  server, and their bind address cannot be a name;
- show misleading information next to a native dialog; the dialog's own text comes from main.

The review recommended moving secret editing out of the renderer entirely (a separate,
minimal window or native forms owned by main). That is out of scope for v1.
`@ternix/ssh` keeps the resolved credentials inside its `ssh2` clients for the life of a
session. The desktop app drops its own references once the session has signed in: the
resolved connection right after `connect`, and a typed quick-connect password (kept in the
tab's source until then, so a failed first attempt can be retried) as soon as that attempt has
signed in.

## Look and feel

The renderer follows a documented design system (palette, metrics and component anatomy of
a desktop SSH client; no third-party assets): `styles.css` defines every colour as a custom
property and components use only those tokens. The light theme is the same set resolved with
`light-dark()`; Settings → Appearance picks Dark (default), Light or System (`theme.ts`, kept
in the page's own storage because it is not security relevant). The tab bar is the title bar
(`titleBarStyle: 'hiddenInset'` on macOS, a `titleBarOverlay` on Windows and Linux; the page
pads for the window buttons with `env(titlebar-area-*)`), the vault filter is a menu under the
Vaults tab, hosts and keys are cards, and every item editor is a 340px drawer (a floating panel
over a terminal) instead of a dialog. The terminals use the "Termius Dark" colour scheme
whatever the UI theme. Fonts are bundled (Inter, Source Code Pro; both OFL) and icons come from
`lucide-react`, so the CSP stays `font-src 'self'` (the build never inlines fonts as `data:`).

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
reads the fuses back from the packaged app (`scripts/check-fuses.sh`, which fails when
`RunAsNode` or `EnableNodeCliInspectArguments` is enabled), and uploads the installers as
artifacts. Actions are pinned to commit SHAs.

## End-to-end test

`e2e/desktop.e2e.ts` drives the packaged app with Playwright's Electron support against a real
`@ternix/server` and an SSH server: it enters the server address, registers, creates a host,
checks that the renderer gets no secrets and cannot probe, declines and then approves the
"Connect to a new host?" dialog, verifies the host key, runs `echo`, checks the saved
`known_host`, locks and unlocks, checks that locking with a revealed private key in an open
editor leaves no secret in the page, restarts the app and unlocks again, checks that a quick
connect to an unknown name stops at the new-host dialog, and signs out: the page is replaced
(a value the old page left in `window` is gone) and the fresh page can probe. Another test
covers own-key mismatches: signed in, the blocking screen signs out into a fresh sign-in page;
during registration (through a proxy that swaps the key), the sign-in form shows the warning
with "Back". Native dialogs are answered through `e2e/support/dialogs.ts`, which replaces
`dialog.showMessageBox` in the main process through the Node inspector (only the e2e package
has that fuse on; the app has no hook for it). It also covers sharing (the verified/unverified badges and
the mark-verified flow) and a malicious server: the test rewrites a member's `public_key` in
the server's SQLite database and checks that removal and rotation open the key change dialog,
send nothing until the new fingerprint is accepted, and then go through. By default the SSH server is an in-process `ssh2` server
with a fake shell; set `E2E_SSH_ADDRESS`, `E2E_SSH_PORT`, `E2E_SSH_USER` and `E2E_SSH_PASSWORD`
to use a real OpenSSH `sshd`. Screenshots go to `e2e/artifacts/` (ignored by git); `e2e/restyle.e2e.ts` writes a full-window
PNG of each main screen (`restyle-*.png`) for design review.

```sh
pnpm run build:packages && pnpm --filter @ternix/server build
cd apps/desktop
TERNIX_E2E_BUILD=1 pnpm exec electron-vite build
TERNIX_E2E_BUILD=1 node scripts/package-e2e.mjs
TERNIX_ALLOW_BASIC_TEXT_SECRET_STORE=1 TERNIX_E2E_EXECUTABLE=$PWD/dist-e2e/linux-unpacked/ternix xvfb-run -a pnpm e2e
```

The e2e package differs from a release in two ways: the `enableNodeCliInspectArguments` fuse
is on, because Playwright attaches through the Node inspector, and the `basic_text` escape
hatch is compiled in (CI machines have no keyring). `electron-builder.e2e.mjs` refuses any
platform or target but `--linux --dir`, and `electron-builder.config.mjs` refuses to load
while `TERNIX_E2E_BUILD` is set or to pack an e2e main bundle, so installers are never built
that way. On Linux the sandbox
helper `chrome-sandbox` must be setuid root (or user namespaces must be allowed) and the test
should run as a normal user.
