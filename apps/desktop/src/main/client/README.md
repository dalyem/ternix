# Ternix sync client

The client side of [`docs/protocol.md`](../../../../../docs/protocol.md), built on
`@ternix/core`. It runs in the Electron main process but depends on nothing from
Electron: the app passes in its stores, `fetch` and WebSocket factory. Every method
returns plain DTOs from [`src/shared`](../../shared) so results can cross IPC.

```ts
const client = new TernixClient({
  secretStore, // session (token, encrypted account key); Electron: safeStorage
  cacheStore, // per-account offline cache: ciphertext, wrapped keys, cursors
  fetch: net.fetch, // optional, default globalThis.fetch
});
await client.init(); // 'loggedOut' | 'locked' | 'expired'
```

## State

| `state`     | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| `loggedOut` | No session. `register` or `login`.                           |
| `locked`    | Session saved, no keys in memory. `unlock(password)`.        |
| `unlocked`  | Keys in memory; reads, writes and realtime sync work.        |
| `expired`   | The server revoked the token or answered 401. `login` again. |

`connection` is `offline`, `connecting` or `online` (the realtime socket).

## API

Server and account

- `probeServer(address)`: normalize the address and check it is a protocol-1 server.
- `register({serverUrl, email, name, password, inviteCode?})`, `login({serverUrl, email, password})`:
  both leave the client unlocked. Login refuses KDF parameters weaker than the protocol
  default (`KdfTooWeakError`) before deriving or sending anything.
- `unlock(password)` works offline from the saved session (`WrongPasswordError`);
  `lock()` zeroes and drops every key.
- `logout()` revokes the token (best effort) and clears session, cache and pinned keys.
- `lock()`, `close()` and `flush()` return promises that settle once the pending cache
  writes are stored; call `await client.flush()` from the app's quit hook.
- `revalidate()` (`GET /me`), `changePassword(current, next)` (other devices are revoked).
- `listDevices()`, `revokeDevice(id)`.
- Admin: `createInvite`, `listInvites`, `deleteInvite`, `listUsers`, `deleteUser`.

Vaults and sharing (unlocked)

- `listVaults()`, `getVault(id)`: from memory, so they work offline. A vault whose key or
  name cannot be opened has `name: null` and `error` set.
- `createVault(name)`, `renameVault(id, name)`, `deleteVault(id)`.
- `listMembers(id)` (with fingerprints and key-pin status), `changeMemberRole`, `leaveVault`.
- Sharing is two steps so the UI can show the fingerprint:
  `lookupUser(email)` returns `{id, publicKey, fingerprint}`; after the user compares the
  fingerprint out of band, `addMember(vaultId, id, role, publicKey)` wraps the vault key for
  exactly that key and refuses (`key_changed`) if the server now reports another one.
- Member keys are pinned per account (trust on first use, kept in the `SecretStore`, cleared
  on logout). `addMember` pins the key the user verified; members seen only in a list are
  pinned unverified. Members carry `verified`, `keyChanged` and `pinnedFingerprint`. Before a
  vault key is wrapped for anyone (rotation, sharing) every member's server-reported key must
  equal its pin, else `member_key_changed` (`change`/`keyChange`: `userId`, `email`,
  `pinnedFingerprint`, `serverFingerprint`) is thrown and nothing is sent. After comparing
  the new fingerprint out of band, `acceptMemberKey(userId, publicKey)` re-pins it as
  verified; `markMemberVerified(userId)` marks a pin verified. A changed key of your own
  account is `own_key_mismatch` everywhere the server reports it.
- `removeMember(vaultId, userId)`: an owner removing someone else rotates the key right
  after; the result says whether the rotation went through (`rotationError` can be a
  `member_key_changed`).
- `rotateVault(id)`: retries on `409` (refreshing members and items) up to
  `MAX_ROTATION_ATTEMPTS`, then `RotationError`.

Items (unlocked)

- `listItems(vaultId)` returns `{items, unreadable}`; `getItem(vaultId, id)`.
- `putItem(vaultId, id | undefined, draft)`, `deleteItem(vaultId, id)`,
  `applyBatch(vaultId, ops)`, `putMany(vaultId, items)`. Writes set `updated_at`, enforce
  the protocol limits before sending, and resolve conflicts with the protocol's rule: the
  result `status` is `saved` or `dropped` (the server kept a newer version). Writes need
  the server and throw `OfflineError` without it; there is no offline queue.
- `sync()`, `refreshVaults()`, `pullVault(id)`: realtime calls these by itself.

Cache writes: item documents (items and `since` cursor together) are held in memory and
written once per vault after 250 ms of quiet or 2 s at most (`cacheWrite` option), and on
`lock`, `logout`, `close` and `flush`. Reads see the pending state. A crash loses at most that
window; the cursor is never stored ahead of the items it covers.

Events: `on(event, listener)` returns an unsubscribe function. Events are `state`,
`connection`, `vaults-changed`, `items-changed` (`{vaultId}`), `session-revoked`
(`{reason}`) and `error` (background failures).

Errors all extend `TernixError` and carry a `code`: the server's error code for
`ApiError` (with `status`, and `current`, `expected`, `stale_item_ids` from 409 bodies),
or one of the client's own (`ClientErrorCode`). `toErrorDto(err)` makes any error IPC-safe.

## Options worth knowing

- `deriveKeys`: replace Argon2 (for example with a worker thread).
- `webSocketFactory`, `realtime` (intervals and backoff) or `realtime: false`.
- `isKdfStrongEnough`, `kdfLimits`: tests only. Production must keep the defaults.

`JsonFileSecretStore` stores the session in a plain file and is meant for tests and
development; the desktop app should back `SecretStore` with the OS keychain.
