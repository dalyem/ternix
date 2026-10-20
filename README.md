# Ternix

Ternix is a self-hosted SSH client with end-to-end encrypted shared vaults. The
server stores only ciphertext, wrapped keys and public keys; it never sees a
master password, vault key or item plaintext. The protocol and the encryption
design are Ternix's own and are not compatible with any other product.

The wire contract is in [`docs/protocol.md`](docs/protocol.md). Change it together
with the schemas in `packages/core`.

## Layout

| Path            | What                                                                  |
| --------------- | --------------------------------------------------------------------- |
| `packages/core` | `@ternix/core`: zod protocol schemas, item payloads, libsodium crypto |
| `packages/ssh`  | `@ternix/ssh`: resolves vault items into live `ssh2` sessions         |
| `apps/server`   | Sync server (Node), imports `@ternix/core`                            |
| `apps/desktop`  | Electron desktop app (macOS, Windows): UI, sync client, SSH terminals |
| `docs/`         | Protocol reference                                                    |

## Using `@ternix/core`

`@ternix/core` is built with `tsc` into `packages/core/dist`, and its `exports`
point there, so build it before anything that imports it runs or typechecks:

```sh
pnpm build:core
```

The root `typecheck` and `test` scripts do this first (`pnpm build:packages` also builds `@ternix/ssh`). Subpath imports are available:
`@ternix/core/protocol` and `@ternix/core/items` need no libsodium; `@ternix/core/crypto`
needs `await ready()` once at startup.

## Checks

Requires Node 22 and pnpm 9 (`corepack enable`).

```sh
pnpm install
pnpm lint        # eslint + prettier --check
pnpm typecheck   # builds core, then tsc in every package
pnpm test        # builds core, then vitest in every package
pnpm format      # prettier --write
```

On the orchestrator, run these through Kiln instead of locally:
`kiln checks run lint typecheck test`.
