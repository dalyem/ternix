export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Append only. Each migration runs once, in its own transaction, and is recorded in
 * `schema_migrations`. Never edit one that has shipped.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE users (
        id                    TEXT PRIMARY KEY,
        email                 TEXT NOT NULL UNIQUE,
        name                  TEXT NOT NULL,
        role                  TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        auth_hash             TEXT NOT NULL,
        kdf                   TEXT NOT NULL,
        public_key            TEXT NOT NULL,
        encrypted_private_key TEXT NOT NULL,
        created_at            TEXT NOT NULL
      );

      CREATE TABLE devices (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        platform     TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE INDEX devices_user ON devices (user_id);

      CREATE TABLE invites (
        code       TEXT PRIMARY KEY,
        email      TEXT,
        created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at    TEXT,
        used_by    TEXT REFERENCES users (id) ON DELETE SET NULL
      );

      CREATE TABLE vaults (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
        name_enc    TEXT NOT NULL,
        key_version INTEGER NOT NULL CHECK (key_version >= 1),
        created_at  TEXT NOT NULL
      );

      CREATE TABLE vault_members (
        vault_id    TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
        wrapped_key TEXT NOT NULL,
        added_at    TEXT NOT NULL,
        PRIMARY KEY (vault_id, user_id)
      ) WITHOUT ROWID;
      CREATE INDEX vault_members_user ON vault_members (user_id);

      -- Single global sequence shared by every item write ('seq' row).
      CREATE TABLE counters (
        name  TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO counters (name, value) VALUES ('seq', 0);

      -- Tombstones (deleted = 1, ciphertext NULL) are kept forever.
      CREATE TABLE items (
        vault_id    TEXT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
        id          TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        deleted     INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        ciphertext  TEXT,
        key_version INTEGER NOT NULL,
        updated_at  TEXT NOT NULL,
        updated_by  TEXT NOT NULL,
        PRIMARY KEY (vault_id, id),
        CHECK ((deleted = 1) = (ciphertext IS NULL))
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX items_vault_seq ON items (vault_id, seq);
    `,
  },
];
