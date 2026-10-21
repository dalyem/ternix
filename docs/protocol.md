# Ternix protocol v1

This is the contract between `apps/server` and `apps/desktop`. Types live in
`packages/core` (zod schemas); this file is the reference they implement. Change
both sides and this file together. Where this file does not spell out a
response body (for example add-member, rotate, or admin list responses), the
schemas in `packages/core/src/protocol` are the definition.

The server is zero-knowledge for vault contents: it stores ciphertext, wrapped
keys and public keys, and never sees a master password, master key, vault key or
item plaintext.

## 1. Encoding

- JSON over HTTPS. Field names are `snake_case`.
- Server address: clients require TLS (`https://`, `wss://`) for every server except
  loopback (`localhost`, 127.0.0.0/8, `::1`), where plain `http://` is allowed. Tailscale
  names and addresses are no exception: serve Ternix with `tailscale serve` and use
  `https://<machine>.<tailnet>.ts.net`. Clients do not follow redirects; a 3xx answer is an
  error and the user enters the final address.
- Binary values are standard base64 with padding (`b64`).
- IDs are lowercase UUIDv4 strings. Clients generate vault and item IDs; the
  server generates user, device and invite IDs.
- Timestamps are ISO 8601 UTC strings.
- Errors: HTTP status plus `{"error": {"code": "<code>", "message": "<text>"}}`.
  Codes: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
  `rate_limited`, `registration_closed`, `invalid_invite`, `email_taken`,
  `key_version_mismatch`, `payload_too_large` (413), `vault_full` (409), `internal`.

## 2. Cryptography (libsodium)

All primitives come from `libsodium-wrappers-sumo`.

### 2.1 Password to keys

```
kdf = { alg: "argon2id13", salt: b64(16 bytes), opslimit: 3, memlimit: 67108864 }
root      = crypto_pwhash(32, utf8(NFKC(password)), salt, opslimit, memlimit, ALG_ARGON2ID13)
masterKey = crypto_kdf_derive_from_key(32, 1, "tnxmastr", root)
authKey   = crypto_kdf_derive_from_key(32, 2, "tnxauth_", root)
```

- `masterKey` never leaves the client. It decrypts the account private key.
- `authKey` is sent to the server as the login credential. The server stores
  only `crypto_pwhash_str(authKey)` (argon2id, `opslimit` 3, `memlimit` 64 MiB), because
  the auth key is already the output of a 64 MiB client-side Argon2id, so an offline
  guesser pays that cost per guess and a heavier server-side hash would only burden small servers.
- The email is lowercased and trimmed before any use.
- At login a client must refuse KDF parameters weaker than the defaults above
  (`isKdfStrongEnough`), so a malicious server cannot downgrade the KDF.

### 2.2 Account keypair

- `crypto_box_keypair()` gives an X25519 keypair.
- `public_key` = b64(pk), stored in plaintext on the server.
- `encrypted_private_key` = `seal(masterKey, sk, ad="ternix:account-key:v1")`
  (see 2.4).
- Fingerprint, shown for out-of-band verification:
  `hex(crypto_generichash(16, pk))`, grouped as 8 groups of 4 hex characters
  joined by spaces.

### 2.3 Vault keys

- Each vault has a random 32-byte key, `crypto_aead_xchacha20poly1305_ietf_keygen()`.
- Each vault key has a `key_version` integer, starting at 1 and incremented on
  rotation.
- Per member: `wrapped_key = b64(crypto_box_seal(vaultKey, memberPublicKey))`.
- The vault name is encrypted: `name_enc = seal(vaultKey, utf8(name), ad="ternix:vault-name:v1:{vault_id}")`.

### 2.4 `seal` / `open` envelope

```
seal(key, plaintext, ad):
  nonce = randombytes(24)
  ct    = crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, key)
  return "v1." + b64(nonce || ct)
```

`open` rejects any string without the `v1.` prefix and any authentication failure.

### 2.5 Items

- `ciphertext = seal(vaultKey[key_version], utf8(JSON(item_payload)), ad="ternix:item:v1:{vault_id}:{item_id}")`.
- The AD binds the ciphertext to its vault and ID, so the server cannot move it
  to another vault or item.

## 3. Item payloads (inside the ciphertext)

Every payload has `type`, `schema: 1` and `updated_at` (client clock, used for
conflict resolution). References are item IDs; a client resolves them across all
vaults it can read and treats a missing reference as unset.

| type           | fields                                                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group`        | `label`, `parent_id?`, `username?`, `port?`, `identity_id?`                                                                                                                                                                              |
| `host`         | `label`, `address`, `port` (default 22), `username?`, `password?`, `identity_id?`, `key_id?`, `group_id?`, `jump_host_id?`, `tags: string[]`, `startup_snippet_id?`, `keepalive_interval?`, `agent_forwarding: bool`, `color?`, `notes?`, `os?` |
| `identity`     | `label`, `username`, `password?`, `key_id?`                                                                                                                                                                                              |
| `ssh_key`      | `label`, `private_key` (OpenSSH PEM), `passphrase?`, `public_key?`                                                                                                                                                                       |
| `snippet`      | `label`, `script`, `tags: string[]`                                                                                                                                                                                                      |
| `port_forward` | `label`, `host_id`, `kind: "local"\|"remote"\|"dynamic"`, `bind_address`, `bind_port`, `dest_host?`, `dest_port?`                                                                                                                        |
| `known_host`   | `host`, `port`, `key_type`, `public_key` (b64 wire format)                                                                                                                                                                               |

`os` on a host is the operating system a client detected when it connected: one of `ubuntu`,
`debian`, `fedora`, `centos`, `rhel`, `rocky`, `alma`, `arch`, `alpine`, `opensuse`, `nixos`,
`raspbian`, `amazon`, `oracle`, `gentoo`, `manjaro`, `mint`, `kali`, `freebsd`, `openbsd`,
`netbsd`, `macos`, `windows`, or `linux` (a Linux that is none of the others). It is a display
hint and may be stale. Clients treat a value they do not know as unset, so later versions can add
values; absent means unknown.

Effective connection settings resolve as: host fields, then identity, then group
chain (nearest first).

## 4. Authentication

A session token is an opaque random string returned at login or registration.
It is sent as `Authorization: Bearer <token>`. The server stores only
`sha256(token)`. Each token belongs to one device row.

### `GET /api/v1/server`

`200 {name, version, registration: "open"|"invite"|"closed", protocol: 1}`. No auth.

### `POST /api/v1/auth/prelogin`

`{email}` → `200 {kdf}`. For an unknown email the server returns a stable fake
salt, `HMAC-SHA256(server_secret, email)[0..16]`, with default limits, so the
response does not reveal whether an account exists. Rate limited.

### `POST /api/v1/auth/register`

```
{ email, name, invite_code?, kdf, auth_key: b64,
  public_key: b64, encrypted_private_key,
  personal_vault: { id, name_enc, wrapped_key },
  device: { name, platform } }
```

→ `201 {token, user, device_id}`. The first account on a server becomes `admin`.
The personal vault is created with `kind: "personal"`, `key_version: 1`, and the
user as `owner`. Errors: `registration_closed`, `invalid_invite`, `email_taken`.

### `POST /api/v1/auth/login`

`{email, auth_key, device: {name, platform}}` →
`200 {token, user, device_id, keys: {public_key, encrypted_private_key, kdf}}`.
Bad credentials return `401 unauthorized`. Rate limited per IP and per email.

### `POST /api/v1/auth/logout`

Revokes the current token. `204`.

### `GET /api/v1/me`

`200 {user}`. `user = {id, email, name, role: "admin"|"user", public_key, created_at}`.

### `POST /api/v1/me/password`

`{current_auth_key, new_auth_key, new_kdf, new_encrypted_private_key}` → `204`.
The keypair stays the same, so no vault keys change. All other devices' tokens
are revoked.

`401 unauthorized` if the session is gone or `current_auth_key` is wrong.
`409 conflict` if a concurrent password change landed while this request was in
flight: the server applies the update only to the password hash it verified, so
nothing is overwritten and no device is revoked. The client reloads its session
(`GET /me`) and tries again.

### Devices

`GET /api/v1/devices` → `{devices: [{id, name, platform, created_at, last_seen_at, current}]}`.
`DELETE /api/v1/devices/:id` revokes that device's token. `204`.

### Users

`GET /api/v1/users/lookup?email=` → `200 {id, email, name, public_key}` or `404`.
Requires auth.

### Admin (role `admin`)

- `POST /api/v1/admin/invites {email?, expires_in_hours?}` → `201 {code, expires_at}`.
- `GET /api/v1/admin/invites`, `DELETE /api/v1/admin/invites/:code`.
- `GET /api/v1/admin/users`, `DELETE /api/v1/admin/users/:id`.

## 5. Vaults and members

Roles: `owner` (everything), `editor` (write items), `viewer` (read only). A
vault always has at least one owner; the last owner cannot leave or be demoted.

- `GET /api/v1/vaults` → `{vaults: [{id, kind: "personal"|"shared", name_enc, key_version, role, wrapped_key, seq, member_count}]}`.
  `wrapped_key` is the caller's own wrapped key for the current `key_version`.
  `seq` is the highest item sequence number in the vault.
- `POST /api/v1/vaults {id, name_enc, wrapped_key}` → `201 vault`. Creates a
  `shared` vault with the caller as `owner`, `key_version: 1`.
- `PATCH /api/v1/vaults/:id {name_enc, key_version}` (owner). `name_enc` is sealed with
  the key of `key_version`, which must equal the vault's current one, otherwise
  `409 key_version_mismatch` and the name is unchanged (a client holding a pre-rotation
  key cannot write a name nobody can decrypt). The check is atomic with the update.
- `DELETE /api/v1/vaults/:id` (owner, `shared` only). Deletes all items.
- `GET /api/v1/vaults/:id/members` → `{members: [{user_id, email, name, public_key, role, added_at}]}`.
- `POST /api/v1/vaults/:id/members {user_id, role, wrapped_key, key_version}` (owner).
  `key_version` must equal the vault's current one, otherwise `409 key_version_mismatch`.
- `PATCH /api/v1/vaults/:id/members/:user_id {role}` (owner).
- `DELETE /api/v1/vaults/:id/members/:user_id` (owner, or the member removing
  themself). This does not rotate the key; the owner's client should call
  rotate afterwards, and the desktop app does so automatically.

### Key rotation

`POST /api/v1/vaults/:id/rotate` (owner):

```
{ key_version: <current + 1>, name_enc,
  members: [{user_id, wrapped_key}],         // must be exactly the current member set
  items:   [{id, ciphertext, base_seq}] }    // must be exactly the current non-deleted item set
```

`base_seq` is the `seq` of the item the owner decrypted and re-encrypted `ciphertext` from.

The server applies it in one transaction. Before writing anything it checks, against
the stored state, that the member set and the item set match exactly and that every item's
current `seq` equals its `base_seq`. If anything differs it changes nothing and returns

```
409 { error: {code: "conflict", ...},
      expected: { user_ids: [...], item_ids: [...] },   // the server's member and live item IDs
      stale_item_ids: [...] }                           // requested items whose seq is not base_seq
```

so a rotation can never overwrite an edit made while the owner was re-encrypting. The
client refreshes (`GET .../items?since=`), re-encrypts the stale items and retries. If it
passes, the server stores the new wrapped keys, replaces each item's ciphertext in place with
a new `seq`, and bumps `key_version`. A wrong `key_version` is `409 key_version_mismatch`.

A rotation carries every live item, so for a full vault (section 8) it is one request of
about 157 MiB. Clients should rotate on a good connection and expect `409` when others are
editing.

## 6. Items and sync

Every write to an item gets a new server-wide `seq` (monotonic integer). Deletes
leave a tombstone (`deleted: true`, `ciphertext: null`) that is kept forever,
so a client that comes back after any length of time still sees the delete.

`item = {id, vault_id, seq, deleted, ciphertext, key_version, updated_at, updated_by}`.

- `GET /api/v1/vaults/:id/items?since=<seq>&limit=<n≤1000>` →
  `{items: [...], next_since, has_more}`, ordered by `seq` ascending, only items
  with `seq > since`. A full sync is `since=0`.
- `PUT /api/v1/vaults/:id/items/:item_id {ciphertext, key_version, base_seq}` (editor+).
  `ciphertext` is at most `MAX_ITEM_CIPHERTEXT_LENGTH` characters (`413 payload_too_large`).
  Creating an item in a vault that already has `MAX_LIVE_ITEMS_PER_VAULT` live items is
  `409 vault_full` (as is reviving a tombstone). Section 8 has the limits.
  `base_seq` is `null` to create, or the `seq` the client last saw. If the stored
  `seq` differs from `base_seq` (or the item exists and `base_seq` is null), the server
  returns `409 {error, current: item}`. `key_version` must match the vault's current one.
  `200 {item}` on success.
- `DELETE /api/v1/vaults/:id/items/:item_id?base_seq=<seq>` (editor+). Same
  conflict rule. `200 {item}` (the tombstone).
- `POST /api/v1/vaults/:id/items/batch {ops: [{op: "put"|"delete", id, ciphertext?, key_version?, base_seq}]}`
  (editor+, at most `MAX_BATCH_OPS` = 500 ops). Each op is applied on its own, in order:
  `200 {results: [{id, status: "ok"|"conflict"|"error", item?, current?, error?}]}`.
  An op that would exceed `MAX_LIVE_ITEMS_PER_VAULT` gets `status: "error"` with code
  `vault_full`. A put whose `ciphertext` is over the limit rejects the whole request with
  `413 payload_too_large`.

### Client conflict rule

On a conflict the client decrypts `current`. If the local payload's `updated_at`
is newer, it retries the write with `base_seq = current.seq`; otherwise it drops
the local change and keeps the server version. A delete conflicting with an edit
loses to the edit if the edit's `updated_at` is newer.

## 7. Realtime

`GET /api/v1/ws` upgrades to a WebSocket. The first client message must be
`{"type": "auth", "token": "<token>"}` within 10 seconds, or the server closes
the socket with code 4401. The server then sends `{"type": "ready"}`.

Server events (they are hints; the client pulls with `GET .../items?since=`):

- `{"type": "vault.changed", "vault_id", "seq"}`: items changed.
- `{"type": "vaults.changed"}`: the caller's vault list, roles or keys changed
  (membership added or removed, rotation, rename, delete).
- `{"type": "session.revoked"}`: the device's token was revoked (logout, device
  revoked, password change on another device, user deleted). The server sends it
  to every socket of that device and then closes each with code 1008 (reason
  `session revoked`). The client must not reconnect with that token. Code 4401
  (bad or missing auth, auth timeout) means the same.

The client sends `{"type": "ping"}` every 30 s; the server answers `{"type": "pong"}`.

## 8. Limits

These bound the data so that every vault the server accepts can still be rotated in one
request. The constants are exported from `@ternix/core/protocol`; clients enforce them
before sending.

| Constant                     | Value       | Effect                                                                                                         |
| ---------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `MAX_ITEM_CIPHERTEXT_LENGTH` | 32768 chars | Longest item `ciphertext`, `v1.` prefix included (about 24 KiB of plaintext). Larger: `413 payload_too_large`. |
| `MAX_LIVE_ITEMS_PER_VAULT`   | 5000        | Most non-deleted items per vault. A create beyond it: `409 vault_full`. Tombstones do not count.               |
| `MAX_BATCH_OPS`              | 500         | Operations per batch request.                                                                                  |
| `MAX_BATCH_BODY_BYTES`       | 20 MiB      | Body limit of the batch endpoint (500 maximal puts are about 16 MiB).                                          |
| `MAX_ROTATE_BODY_BYTES`      | 200 MiB     | Body limit of the rotate endpoint.                                                                             |
| `DEFAULT_BODY_LIMIT_BYTES`   | 1 MiB       | Body limit of every other endpoint; larger: `413 payload_too_large`.                                           |

The rotate limit follows from the others: a full vault is 5000 items of about
32,858 bytes of JSON each (32768 characters of ciphertext, a UUID, `base_seq`, and field
names), which is about 157 MiB, and the remaining room holds member keys.
