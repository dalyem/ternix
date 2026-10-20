# @ternix/server

The Ternix sync server. It is zero-knowledge: it stores ciphertext, wrapped keys and public
keys, and never sees a master password, vault key or item plaintext. The wire contract is in
[`docs/protocol.md`](../../docs/protocol.md); request and response shapes come from
`@ternix/core`.

Node 22, Fastify 5, SQLite (`better-sqlite3`, WAL), one process, one file of state.

## Run it with Docker Compose

From the repository root:

```sh
docker compose up -d --build
curl http://127.0.0.1:8080/api/v1/server
```

This publishes the server on `127.0.0.1:8080` only. Clients send a password-derived login
credential, so put TLS in front of it before exposing it to a network you do not control.

### With automatic HTTPS (Caddy)

Point a DNS name at the host, open ports 80 and 443, then:

```sh
cat > .env <<'ENV'
TERNIX_DOMAIN=ternix.example.com
TERNIX_TRUST_PROXY=true
ENV
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

`docker-compose.tls.yml` is an override that adds the Caddy service; it is a separate file
rather than a Compose profile so that a plain `docker compose up` never needs `TERNIX_DOMAIN`.
Add the same two `-f` flags to later `docker compose` commands (`down`, `logs`, `pull`) so they
see Caddy too.

Caddy (`apps/server/deploy/Caddyfile`) gets and renews the certificate and proxies HTTP and
the WebSocket to the `ternix` service. Set `TERNIX_TRUST_PROXY=true` so rate limits see the
real client address, and only when the app port is not reachable except through the proxy
(the default loopback binding is fine).

On a trusted network such as a LAN or Tailscale you can skip TLS and publish the app port
with `TERNIX_BIND=0.0.0.0`.

## Configuration

All settings are environment variables. Put them in `.env` next to `docker-compose.yml`.

| Variable              | Default   | Meaning                                                                                                                                                                                                                                                                                                    |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TERNIX_DATA_DIR`     | `/data`   | Holds `ternix.db` (+ `-wal`, `-shm`) and the generated `server-secret`. Mount a volume here.                                                                                                                                                                                                               |
| `PORT`                | `8080`    | Listen port.                                                                                                                                                                                                                                                                                               |
| `HOST`                | `0.0.0.0` | Listen address.                                                                                                                                                                                                                                                                                            |
| `TERNIX_SERVER_NAME`  | `Ternix`  | Name shown to clients (`GET /api/v1/server`).                                                                                                                                                                                                                                                              |
| `TERNIX_REGISTRATION` | `invite`  | `open`: anyone may register. `invite`: an admin invite code is required. `closed`: nobody may. The first account can always register.                                                                                                                                                                      |
| `TERNIX_SECRET`       | generated | At least 16 characters. Keys the stable fake KDF salts that `prelogin` returns for unknown emails. If unset, 32 random bytes are generated once and stored in `$TERNIX_DATA_DIR/server-secret` (mode 0600). Changing it changes those fake salts, which lets someone notice the switch, so keep it stable. |
| `TERNIX_TRUST_PROXY`  | `false`   | Trust `X-Forwarded-For` (set `true` behind Caddy or another proxy).                                                                                                                                                                                                                                        |
| `TERNIX_LOG_LEVEL`    | `info`    | pino level. Tokens, auth keys and ciphertext bodies are never logged; request URLs are logged without their query string.                                                                                                                                                                                  |

Compose also reads `TERNIX_BIND` (host address for the published port, default `127.0.0.1`),
`TERNIX_PORT` (host port, default `8080`) and `TERNIX_DOMAIN` (`docker-compose.tls.yml` only,
required there).

## First admin

The first account registered on a fresh server becomes the admin, whatever
`TERNIX_REGISTRATION` says. Create it from the desktop app (it derives the keys and encrypts
the private key on your machine), then keep `TERNIX_REGISTRATION=invite` (the default) so
nobody else can sign up without a code.

## Invites

Invites are created by an admin. Log in with the desktop app, or call the API with the admin's
session token (`Authorization: Bearer <token>`, returned by `POST /api/v1/auth/login`):

```sh
# Single-use, valid 72 hours, optionally bound to one email address
curl -sS -X POST https://ternix.example.com/api/v1/admin/invites \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"email": "friend@example.com", "expires_in_hours": 72}'
# {"code":"...","expires_at":"2026-..."}

curl -sS https://ternix.example.com/api/v1/admin/invites -H "Authorization: Bearer $TOKEN"
curl -sS -X DELETE https://ternix.example.com/api/v1/admin/invites/CODE -H "Authorization: Bearer $TOKEN"
```

Send the code to the new user; they enter it when registering. `email` and `expires_in_hours`
are optional (the default lifetime is 7 days). An invite works once.

`GET /api/v1/admin/users` lists accounts and `DELETE /api/v1/admin/users/:id` removes one
(refused while that user is the only owner of a shared vault that still has other members).

## Backup and restore

All state is in the data volume. The database is SQLite in WAL mode, so do not copy `ternix.db`
alone while the server runs. Either:

```sh
# Online, consistent snapshot (sqlite3 CLI inside a throwaway container)
docker compose exec ternix node -e "
  const Database = require('better-sqlite3');
  new Database('/data/ternix.db').backup('/data/backup.db').then(() => console.log('ok'));
"
docker compose cp ternix:/data/backup.db ./ternix-backup.db

# or stop, copy the volume, start
docker compose stop ternix
docker run --rm -v ternix_ternix-data:/data -v "$PWD":/backup busybox tar czf /backup/ternix-data.tgz -C /data .
docker compose start ternix
```

Keep `server-secret` with the database (the tar above includes it). To restore, stop the
server and put `ternix.db` (and `server-secret`) back in the volume; remove any stale
`ternix.db-wal` and `ternix.db-shm`.

The server cannot read your data, so a backup contains only ciphertext. Losing a master
password still loses that account's keys; there is no recovery.

## Operational notes

- Sessions are device tokens (32 random bytes). Only their SHA-256 is stored. A password change
  revokes every other device and closes their sockets with `session.revoked`.
- The server keeps tombstones forever so a client that returns after any length of time still
  sees deletes.
- Login verifies a libsodium `crypto_pwhash_str` of the client's auth key (Argon2id, 3 passes,
  64 MiB) in-process; each login briefly blocks the event loop. Rate limits bound the cost.
- Item ciphertexts are capped at 32 KiB and a vault holds at most 5000 live items, so the
  rotation of even a full vault fits in one request (about 157 MiB, body limit 200 MiB).
  Parsing such a body takes several times its size in memory. See `docs/protocol.md`
  section 8.
- `GET /api/v1/server` is the health endpoint.

## Development

```sh
corepack pnpm install
corepack pnpm --filter @ternix/core build
corepack pnpm --filter @ternix/server dev      # tsx watch on $PORT (default 8080)
corepack pnpm --filter @ternix/server test
```

`better-sqlite3` ships prebuilt binaries for common platforms. If your pnpm tries to compile it
and fails for lack of a compiler, install with `--ignore-scripts`.

The data directory defaults to `/data`; for local development set `TERNIX_DATA_DIR`, for example
`TERNIX_DATA_DIR=./.data`.

Image build (context is the repository root):

```sh
docker build -f apps/server/Dockerfile -t ternix-server .
```
