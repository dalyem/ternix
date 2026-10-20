import type {
  Device,
  Invite,
  Item,
  KdfParams,
  Member,
  RotateRequest,
  User,
  UserRole,
  Vault,
  VaultKind,
  VaultRole,
} from '@ternix/core/protocol';
import type { Db, Sql } from './db.js';

// Row shapes

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  auth_hash: string;
  kdf: string;
  public_key: string;
  encrypted_private_key: string;
  created_at: string;
}

export interface SessionRow {
  device_id: string;
  user_id: string;
  last_seen_at: string | null;
}

export interface VaultRow {
  id: string;
  kind: VaultKind;
  name_enc: string;
  key_version: number;
  created_at: string;
}

interface ItemRow {
  vault_id: string;
  id: string;
  seq: number;
  deleted: 0 | 1;
  ciphertext: string | null;
  key_version: number;
  updated_at: string;
  updated_by: string;
}

interface InviteRow {
  code: string;
  email: string | null;
  expires_at: string;
  created_at: string;
  used_at: string | null;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    public_key: row.public_key,
    created_at: row.created_at,
  };
}

export function kdfOf(row: UserRow): KdfParams {
  return JSON.parse(row.kdf) as KdfParams;
}

export function toItem(row: ItemRow): Item {
  const base = {
    id: row.id,
    vault_id: row.vault_id,
    seq: row.seq,
    key_version: row.key_version,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
  return row.deleted === 1 || row.ciphertext === null
    ? { ...base, deleted: true, ciphertext: null }
    : { ...base, deleted: false, ciphertext: row.ciphertext };
}

const now = () => new Date().toISOString();

export type ItemOutcome =
  | { status: 'ok'; item: Item }
  | { status: 'conflict'; current: Item }
  | { status: 'error'; code: 'key_version_mismatch' | 'not_found'; message: string };

export type RotateOutcome =
  | { ok: true }
  | { ok: false; reason: 'conflict'; expected: { user_ids: string[]; item_ids: string[] } }
  | { ok: false; reason: 'key_version_mismatch' };

export class Store {
  constructor(
    readonly db: Db,
    private readonly sql: Sql,
  ) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // Users

  userCount(): number {
    return this.sql.q<[], { n: number }>('SELECT COUNT(*) AS n FROM users').get()!.n;
  }

  getUserByEmail(email: string): UserRow | undefined {
    return this.sql.q<[string], UserRow>('SELECT * FROM users WHERE email = ?').get(email);
  }

  getUserById(id: string): UserRow | undefined {
    return this.sql.q<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(id);
  }

  listUsers(): UserRow[] {
    return this.sql.q<[], UserRow>('SELECT * FROM users ORDER BY created_at, id').all();
  }

  insertUser(row: UserRow): void {
    this.sql
      .q(
        `INSERT INTO users (id, email, name, role, auth_hash, kdf, public_key, encrypted_private_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.email,
        row.name,
        row.role,
        row.auth_hash,
        row.kdf,
        row.public_key,
        row.encrypted_private_key,
        row.created_at,
      );
  }

  updatePassword(userId: string, authHash: string, kdf: KdfParams, encryptedPrivateKey: string) {
    this.sql
      .q('UPDATE users SET auth_hash = ?, kdf = ?, encrypted_private_key = ? WHERE id = ?')
      .run(authHash, JSON.stringify(kdf), encryptedPrivateKey, userId);
  }

  // Devices (one per session token)

  insertDevice(d: {
    id: string;
    userId: string;
    name: string;
    platform: string;
    tokenHash: string;
  }): void {
    const t = now();
    this.sql
      .q(
        `INSERT INTO devices (id, user_id, name, platform, token_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.userId, d.name, d.platform, d.tokenHash, t, t);
  }

  findSession(tokenHash: string): (SessionRow & { user: UserRow }) | undefined {
    const device = this.sql
      .q<[string], SessionRow>(
        'SELECT id AS device_id, user_id, last_seen_at FROM devices WHERE token_hash = ?',
      )
      .get(tokenHash);
    if (!device) return undefined;
    const user = this.getUserById(device.user_id);
    return user ? { ...device, user } : undefined;
  }

  touchDevice(id: string): void {
    this.sql.q('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now(), id);
  }

  listDevices(userId: string, currentDeviceId: string): Device[] {
    return this.sql
      .q<[string], Omit<Device, 'current'>>(
        `SELECT id, name, platform, created_at, last_seen_at FROM devices
         WHERE user_id = ? ORDER BY created_at, id`,
      )
      .all(userId)
      .map((d) => ({ ...d, current: d.id === currentDeviceId }));
  }

  /** Deletes the device if it belongs to `userId`; true when a row was removed. */
  deleteDevice(id: string, userId: string): boolean {
    return (
      this.sql.q('DELETE FROM devices WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
    );
  }

  deleteOtherDevices(userId: string, keepDeviceId: string): string[] {
    const ids = this.sql
      .q<[string, string], { id: string }>('SELECT id FROM devices WHERE user_id = ? AND id != ?')
      .all(userId, keepDeviceId)
      .map((r) => r.id);
    this.sql.q('DELETE FROM devices WHERE user_id = ? AND id != ?').run(userId, keepDeviceId);
    return ids;
  }

  deviceIdsOfUser(userId: string): string[] {
    return this.sql
      .q<[string], { id: string }>('SELECT id FROM devices WHERE user_id = ?')
      .all(userId)
      .map((r) => r.id);
  }

  // Invites

  insertInvite(i: { code: string; email: string | null; createdBy: string; expiresAt: string }) {
    this.sql
      .q('INSERT INTO invites (code, email, created_by, created_at, expires_at) VALUES (?,?,?,?,?)')
      .run(i.code, i.email, i.createdBy, now(), i.expiresAt);
  }

  listInvites(): Invite[] {
    return this.sql
      .q<[], InviteRow>(
        'SELECT code, email, expires_at, created_at, used_at FROM invites ORDER BY created_at DESC, code',
      )
      .all();
  }

  deleteInvite(code: string): boolean {
    return this.sql.q('DELETE FROM invites WHERE code = ?').run(code).changes > 0;
  }

  /**
   * Single-use redemption. Fails (false) when the code is unknown, used, expired, or bound to a
   * different email. Call inside the registration transaction, after the user row exists.
   */
  consumeInvite(code: string, email: string, userId: string): boolean {
    return (
      this.sql
        .q(
          `UPDATE invites SET used_at = ?, used_by = ?
           WHERE code = ? AND used_at IS NULL AND expires_at > ? AND (email IS NULL OR email = ?)`,
        )
        .run(now(), userId, code, now(), email).changes === 1
    );
  }

  // Vaults

  getVault(id: string): VaultRow | undefined {
    return this.sql.q<[string], VaultRow>('SELECT * FROM vaults WHERE id = ?').get(id);
  }

  insertVault(v: { id: string; kind: VaultKind; nameEnc: string }): void {
    this.sql
      .q('INSERT INTO vaults (id, kind, name_enc, key_version, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(v.id, v.kind, v.nameEnc, now());
  }

  updateVaultName(id: string, nameEnc: string): void {
    this.sql.q('UPDATE vaults SET name_enc = ? WHERE id = ?').run(nameEnc, id);
  }

  deleteVault(id: string): void {
    this.sql.q('DELETE FROM vaults WHERE id = ?').run(id);
  }

  membership(
    vaultId: string,
    userId: string,
  ): { role: VaultRole; wrapped_key: string } | undefined {
    return this.sql
      .q<[string, string], { role: VaultRole; wrapped_key: string }>(
        'SELECT role, wrapped_key FROM vault_members WHERE vault_id = ? AND user_id = ?',
      )
      .get(vaultId, userId);
  }

  insertMember(m: { vaultId: string; userId: string; role: VaultRole; wrappedKey: string }) {
    this.sql
      .q(
        'INSERT INTO vault_members (vault_id, user_id, role, wrapped_key, added_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(m.vaultId, m.userId, m.role, m.wrappedKey, now());
  }

  setMemberRole(vaultId: string, userId: string, role: VaultRole): void {
    this.sql
      .q('UPDATE vault_members SET role = ? WHERE vault_id = ? AND user_id = ?')
      .run(role, vaultId, userId);
  }

  deleteMember(vaultId: string, userId: string): void {
    this.sql.q('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?').run(vaultId, userId);
  }

  ownerCount(vaultId: string): number {
    return this.sql
      .q<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM vault_members WHERE vault_id = ? AND role = 'owner'",
      )
      .get(vaultId)!.n;
  }

  memberUserIds(vaultId: string): string[] {
    return this.sql
      .q<[string], { user_id: string }>(
        'SELECT user_id FROM vault_members WHERE vault_id = ? ORDER BY user_id',
      )
      .all(vaultId)
      .map((r) => r.user_id);
  }

  listMembers(vaultId: string): Member[] {
    return this.sql
      .q<[string], Member>(
        `SELECT m.user_id, u.email, u.name, u.public_key, m.role, m.added_at
         FROM vault_members m JOIN users u ON u.id = m.user_id
         WHERE m.vault_id = ? ORDER BY m.added_at, m.user_id`,
      )
      .all(vaultId);
  }

  getMember(vaultId: string, userId: string): Member | undefined {
    return this.sql
      .q<[string, string], Member>(
        `SELECT m.user_id, u.email, u.name, u.public_key, m.role, m.added_at
         FROM vault_members m JOIN users u ON u.id = m.user_id
         WHERE m.vault_id = ? AND m.user_id = ?`,
      )
      .get(vaultId, userId);
  }

  private static readonly VAULT_SELECT = `
    SELECT v.id, v.kind, v.name_enc, v.key_version, m.role, m.wrapped_key,
      COALESCE((SELECT MAX(i.seq) FROM items i WHERE i.vault_id = v.id), 0) AS seq,
      (SELECT COUNT(*) FROM vault_members x WHERE x.vault_id = v.id) AS member_count
    FROM vault_members m JOIN vaults v ON v.id = m.vault_id`;

  listVaultsForUser(userId: string): Vault[] {
    return this.sql
      .q<[string], Vault>(`${Store.VAULT_SELECT} WHERE m.user_id = ? ORDER BY v.created_at, v.id`)
      .all(userId);
  }

  getVaultForUser(vaultId: string, userId: string): Vault | undefined {
    return this.sql
      .q<[string, string], Vault>(`${Store.VAULT_SELECT} WHERE v.id = ? AND m.user_id = ?`)
      .get(vaultId, userId);
  }

  /** Vaults a user belongs to, with whether they are the only member. */
  vaultsOwnedBy(
    userId: string,
  ): { id: string; kind: VaultKind; members: number; owners: number }[] {
    return this.sql
      .q<[string], { id: string; kind: VaultKind; members: number; owners: number }>(
        `SELECT v.id, v.kind,
           (SELECT COUNT(*) FROM vault_members x WHERE x.vault_id = v.id) AS members,
           (SELECT COUNT(*) FROM vault_members x WHERE x.vault_id = v.id AND x.role = 'owner') AS owners
         FROM vault_members m JOIN vaults v ON v.id = m.vault_id
         WHERE m.user_id = ? AND m.role = 'owner'`,
      )
      .all(userId);
  }

  vaultIdsOfUser(userId: string): string[] {
    return this.sql
      .q<[string], { vault_id: string }>('SELECT vault_id FROM vault_members WHERE user_id = ?')
      .all(userId)
      .map((r) => r.vault_id);
  }

  /** Delete a user and everything that cannot outlive them. Returns users to notify. */
  deleteUser(userId: string): string[] {
    const affected = new Set<string>();
    for (const vaultId of this.vaultIdsOfUser(userId)) {
      for (const id of this.memberUserIds(vaultId)) affected.add(id);
    }
    for (const v of this.vaultsOwnedBy(userId)) {
      if (v.kind === 'personal' || v.members === 1) this.deleteVault(v.id);
    }
    this.sql.q('DELETE FROM users WHERE id = ?').run(userId);
    affected.delete(userId);
    return [...affected];
  }

  // Items

  vaultSeq(vaultId: string): number {
    return this.sql
      .q<[string], { seq: number }>(
        'SELECT COALESCE(MAX(seq), 0) AS seq FROM items WHERE vault_id = ?',
      )
      .get(vaultId)!.seq;
  }

  private nextSeq(): number {
    return this.sql
      .q<[], { value: number }>(
        "UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value",
      )
      .get()!.value;
  }

  getItem(vaultId: string, itemId: string): Item | undefined {
    const row = this.sql
      .q<[string, string], ItemRow>('SELECT * FROM items WHERE vault_id = ? AND id = ?')
      .get(vaultId, itemId);
    return row && toItem(row);
  }

  listItems(vaultId: string, since: number, limit: number): { items: Item[]; hasMore: boolean } {
    const rows = this.sql
      .q<[string, number, number], ItemRow>(
        'SELECT * FROM items WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      )
      .all(vaultId, since, limit + 1);
    return { items: rows.slice(0, limit).map(toItem), hasMore: rows.length > limit };
  }

  /** Create or update. Call inside a transaction. */
  putItem(
    vault: Pick<VaultRow, 'id' | 'key_version'>,
    userId: string,
    itemId: string,
    ciphertext: string,
    keyVersion: number,
    baseSeq: number | null,
  ): ItemOutcome {
    if (keyVersion !== vault.key_version) {
      return {
        status: 'error',
        code: 'key_version_mismatch',
        message: `Vault key_version is ${vault.key_version}`,
      };
    }
    const current = this.getItem(vault.id, itemId);
    if (baseSeq === null) {
      if (current) return { status: 'conflict', current };
    } else {
      if (!current) {
        return {
          status: 'error',
          code: 'not_found',
          message: 'Item does not exist; use base_seq null to create it',
        };
      }
      if (current.seq !== baseSeq) return { status: 'conflict', current };
    }
    const seq = this.nextSeq();
    const t = now();
    this.sql
      .q(
        `INSERT INTO items (vault_id, id, seq, deleted, ciphertext, key_version, updated_at, updated_by)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT (vault_id, id) DO UPDATE SET
           seq = excluded.seq, deleted = 0, ciphertext = excluded.ciphertext,
           key_version = excluded.key_version, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(vault.id, itemId, seq, ciphertext, keyVersion, t, userId);
    return { status: 'ok', item: this.getItem(vault.id, itemId)! };
  }

  /** Leave a tombstone. Call inside a transaction. */
  deleteItem(
    vault: Pick<VaultRow, 'id' | 'key_version'>,
    userId: string,
    itemId: string,
    baseSeq: number,
  ): ItemOutcome {
    const current = this.getItem(vault.id, itemId);
    if (!current) return { status: 'error', code: 'not_found', message: 'Item does not exist' };
    if (current.seq !== baseSeq) return { status: 'conflict', current };
    if (current.deleted) return { status: 'ok', item: current };
    const seq = this.nextSeq();
    this.sql
      .q(
        `UPDATE items SET seq = ?, deleted = 1, ciphertext = NULL, key_version = ?,
           updated_at = ?, updated_by = ? WHERE vault_id = ? AND id = ?`,
      )
      .run(seq, vault.key_version, now(), userId, vault.id, itemId);
    return { status: 'ok', item: this.getItem(vault.id, itemId)! };
  }

  // Rotation

  /**
   * Re-key a vault in one transaction. The member set and the non-deleted item set in the
   * request must equal the server's, otherwise nothing changes and the expected IDs return.
   */
  rotate(vault: VaultRow, userId: string, req: RotateRequest): RotateOutcome {
    return this.transaction((): RotateOutcome => {
      if (req.key_version !== vault.key_version + 1) {
        return { ok: false, reason: 'key_version_mismatch' };
      }
      const memberIds = this.memberUserIds(vault.id);
      const itemIds = this.sql
        .q<[string], { id: string }>(
          'SELECT id FROM items WHERE vault_id = ? AND deleted = 0 ORDER BY id',
        )
        .all(vault.id)
        .map((r) => r.id);
      const sameSet = (expected: string[], given: string[]) =>
        given.length === expected.length &&
        new Set(given).size === given.length &&
        sameMembers(expected, given);
      if (
        !sameSet(
          memberIds,
          req.members.map((m) => m.user_id),
        ) ||
        !sameSet(
          itemIds,
          req.items.map((i) => i.id),
        )
      ) {
        return {
          ok: false,
          reason: 'conflict',
          expected: { user_ids: memberIds, item_ids: itemIds },
        };
      }
      const setWrapped = this.sql.q(
        'UPDATE vault_members SET wrapped_key = ? WHERE vault_id = ? AND user_id = ?',
      );
      for (const m of req.members) setWrapped.run(m.wrapped_key, vault.id, m.user_id);
      const setItem = this.sql.q(
        `UPDATE items SET seq = ?, ciphertext = ?, key_version = ?, updated_at = ?, updated_by = ?
         WHERE vault_id = ? AND id = ?`,
      );
      const t = now();
      for (const item of req.items) {
        setItem.run(this.nextSeq(), item.ciphertext, req.key_version, t, userId, vault.id, item.id);
      }
      this.sql
        .q('UPDATE vaults SET key_version = ?, name_enc = ? WHERE id = ?')
        .run(req.key_version, req.name_enc, vault.id);
      return { ok: true };
    });
  }
}

function sameMembers(expected: string[], given: string[]): boolean {
  const set = new Set(expected);
  return given.every((id) => set.has(id));
}
