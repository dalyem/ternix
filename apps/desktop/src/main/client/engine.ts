import { randomUUID } from 'node:crypto';
import {
  decryptItem,
  decryptVaultName,
  encryptItem,
  encryptVaultName,
  fingerprint,
  fromB64,
  itemAd,
  newVaultKey,
  open,
  seal,
  unwrapVaultKey,
  wrapVaultKey,
} from '@ternix/core/crypto';
import { type ItemPayload, itemPayloadSchema } from '@ternix/core/items';
import {
  type BatchOp,
  batchResponseSchema,
  type Item,
  itemResponseSchema,
  listItemsResponseSchema,
  listMembersResponseSchema,
  listVaultsResponseSchema,
  type LiveItem,
  lookupUserResponseSchema,
  MAX_BATCH_BODY_BYTES,
  MAX_BATCH_OPS,
  MAX_ITEM_CIPHERTEXT_LENGTH,
  MAX_LIST_LIMIT,
  MAX_LIVE_ITEMS_PER_VAULT,
  MAX_ROTATE_BODY_BYTES,
  type Member,
  memberSchema,
  normalizeEmail,
  publicKeySchema,
  routes,
  type RotateRequest,
  UUID_V4_RE,
  type Vault,
  type VaultRole,
  vaultSchema,
} from '@ternix/core/protocol';
import type { ClientEvents } from '../../shared/events.js';
import type {
  BatchFailureDto,
  BatchOpInput,
  BatchResultDto,
  ItemDraft,
  ItemDto,
  LookupUserDto,
  MemberDto,
  RemoveMemberResultDto,
  UnreadableItemDto,
  VaultDto,
  VaultItemsDto,
  WriteResultDto,
} from '../../shared/types.js';
import {
  ApiError,
  isApiError,
  MemberKeyChangedError,
  OfflineError,
  RotationError,
  TernixError,
  toErrorDto,
} from './errors.js';
import { type Http, LONG_TIMEOUT_MS } from './http.js';
import type { Keyring } from './keyring.js';
import { fingerprintOf, type PinObservation, type PinStore } from './pins.js';
import { itemsCacheKey, itemsCacheSchema, VAULTS_CACHE_KEY, vaultsCacheSchema } from './session.js';
import type { CacheStore } from './stores.js';

/** Conflict retries per write before giving up. */
const MAX_WRITE_ATTEMPTS = 5;
/** Rotation attempts (each refreshes members and items) before `RotationError`. */
export const MAX_ROTATION_ATTEMPTS = 5;

/** Options of `putItem`. */
export interface PutItemOptions {
  /**
   * A write the app makes by itself (a detected host OS), never one a person asked for. It
   * updates the item only while it is still at `baseSeq`, the version the draft was made from,
   * and keeps that version's `updated_at`, so an edit a person makes on any device wins the
   * conflict rule against it. It never creates an item or revives a deleted one, and it is not
   * retried: a `409` of any kind (conflict, tombstone, key version) leaves the server as it is
   * and returns `{status: 'skipped'}`.
   */
  background: { baseSeq: number };
}

/** A background write that was not made (see `PutItemOptions.background`). */
export interface SkippedWriteDto {
  id: string;
  status: 'skipped';
  item: null;
}
const MAX_VAULT_NAME_LENGTH = 200;

export interface EngineDeps {
  http: Http;
  cache: CacheStore;
  /** Cache namespace of this account (`accountKey`). */
  account: string;
  userId: string;
  keyring: Keyring;
  /** Pinned member keys; see `pins.ts`. */
  pins: PinStore;
  now: () => Date;
  emit: <K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]) => void;
}

interface VaultState {
  vault: Vault;
  /** The caller's wrapped key per `key_version` (older ones until no item needs them). */
  wrappedKeys: Map<number, string>;
  name: string | null;
  error: string | null;
  items: Map<string, LiveItem>;
  /** `seq` of deletes seen this session, so a late write response cannot revive an item. */
  tombstones: Map<string, number>;
  /** Highest `seq` pulled. */
  since: number;
}

/** A write on its way to the server, kept across conflict retries. */
interface PendingWrite {
  op: 'put' | 'delete';
  id: string;
  baseSeq: number | null;
  /** Client time of the change: the payload's `updated_at`, or when the delete was asked. */
  at: string;
  payload?: ItemPayload;
  ciphertext?: string;
  version?: number;
}

interface Decision {
  retry: boolean;
  status: 'saved' | 'dropped';
  payload: ItemPayload | null;
}

/** Runs a task at most once at a time; calls during a run queue exactly one more run. */
class Coalescer {
  private flight: { promise: Promise<void>; again: boolean } | null = null;

  constructor(private readonly task: () => Promise<void>) {}

  run(): Promise<void> {
    if (this.flight) {
      this.flight.again = true;
      return this.flight.promise;
    }
    const flight = { promise: Promise.resolve(), again: false };
    this.flight = flight;
    flight.promise = (async () => {
      await null;
      try {
        do {
          flight.again = false;
          await this.task();
        } while (flight.again);
      } finally {
        this.flight = null;
      }
    })();
    return flight.promise;
  }
}

/** Split batch operations into requests of at most `MAX_BATCH_OPS` and `MAX_BATCH_BODY_BYTES`. */
export function chunkBatch<T>(ops: T[], wire: (op: T) => BatchOp): T[][] {
  const overhead = Buffer.byteLength('{"ops":[]}');
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = overhead;
  for (const op of ops) {
    const size = Buffer.byteLength(JSON.stringify(wire(op)));
    const full =
      current.length >= MAX_BATCH_OPS ||
      bytes + size + (current.length > 0 ? 1 : 0) > MAX_BATCH_BODY_BYTES;
    if (current.length > 0 && full) {
      chunks.push(current);
      current = [];
      bytes = overhead;
    }
    bytes += size + (current.length > 0 ? 1 : 0);
    current.push(op);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const vaultSignature = (v: Vault): string =>
  [v.kind, v.role, v.key_version, v.name_enc, v.member_count].join('|');

const isNewer = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b);

/**
 * Vaults, members, items, sync and rotation for one unlocked account. Holds decrypted
 * vault keys (in the `Keyring`) and ciphertext; plaintext exists only in returned DTOs.
 * `close` makes every later call throw `locked` and stops late results from being cached.
 */
export class VaultEngine {
  private readonly vaults = new Map<string, VaultState>();
  private readonly pulls = new Map<string, Coalescer>();
  private readonly refresher = new Coalescer(() => this.doRefresh());
  /**
   * The running or queued rotation per vault, with the membership epoch it started at (null
   * while queued: it will read the epoch when it starts).
   */
  private readonly rotations = new Map<string, { task: Promise<VaultDto>; epoch: number | null }>();
  /** Per vault, bumped when this device removes a member. */
  private readonly membershipEpochs = new Map<string, number>();
  private readonly lookups = new Map<string, { email: string; publicKey: string }>();
  /** Emails of users seen in member lists and lookups, for key-change errors. */
  private readonly emails = new Map<string, string>();
  private closed = false;

  constructor(private readonly deps: EngineDeps) {}

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.vaults.clear();
    this.pulls.clear();
    this.lookups.clear();
    this.emails.clear();
    this.deps.keyring.wipe();
  }

  private assertOpen(): void {
    if (this.closed) throw new TernixError('locked', 'Ternix is locked');
  }

  /** Report a failure of background work (realtime-triggered pulls, automatic rotation). */
  reportBackground(err: unknown): void {
    if (this.closed || err instanceof OfflineError) return;
    if (err instanceof TernixError && (err.code === 'session_expired' || err.code === 'locked')) {
      return;
    }
    this.deps.emit('error', toErrorDto(err));
  }

  private background(task: Promise<unknown>): void {
    task.catch((err: unknown) => this.reportBackground(err));
  }

  /** Wait for follow-up work after a write that already succeeded; report, do not throw. */
  private async settleQuietly(task: Promise<unknown>): Promise<void> {
    try {
      await task;
    } catch (err) {
      this.reportBackground(err);
    }
  }

  // Cache

  /** Restore vaults and item ciphertext saved by an earlier session (offline reads). */
  async loadFromCache(): Promise<void> {
    const { cache, account } = this.deps;
    const doc = vaultsCacheSchema.safeParse(await cache.get(account, VAULTS_CACHE_KEY));
    if (!doc.success) return;
    for (const cached of doc.data.vaults) {
      const state = this.newState(cached.vault);
      for (const [version, wrapped] of Object.entries(cached.wrapped_keys)) {
        state.wrappedKeys.set(Number(version), wrapped);
      }
      state.wrappedKeys.set(cached.vault.key_version, cached.vault.wrapped_key);
      const items = itemsCacheSchema.safeParse(
        await cache.get(account, itemsCacheKey(cached.vault.id)),
      );
      if (items.success) {
        state.since = items.data.since;
        for (const item of items.data.items) state.items.set(item.id, item);
      }
      this.assertOpen();
      this.vaults.set(state.vault.id, state);
      this.openName(state);
    }
  }

  private async persistVaults(): Promise<void> {
    if (this.closed) return;
    const vaults = [...this.vaults.values()].map((s) => ({
      vault: s.vault,
      wrapped_keys: Object.fromEntries([...s.wrappedKeys].map(([v, w]) => [String(v), w])),
    }));
    await this.deps.cache.set(this.deps.account, VAULTS_CACHE_KEY, { version: 1, vaults });
  }

  /**
   * Hand the vault's items and cursor to the cache, which writes them once changes pause
   * (`CoalescingCacheStore`). Cursor and items go in one document, so the cursor never
   * covers items that were not stored with it.
   */
  private persistItems(state: VaultState): void {
    if (this.closed || this.vaults.get(state.vault.id) !== state) return;
    this.deps.cache
      .set(this.deps.account, itemsCacheKey(state.vault.id), {
        version: 1,
        since: state.since,
        items: [...state.items.values()],
      })
      .catch((err: unknown) => this.reportBackground(err));
  }

  // Keys and vault state

  private newState(vault: Vault): VaultState {
    return {
      vault,
      wrappedKeys: new Map([[vault.key_version, vault.wrapped_key]]),
      name: null,
      error: null,
      items: new Map(),
      tombstones: new Map(),
      since: 0,
    };
  }

  private keyFor(state: VaultState, version: number): Uint8Array {
    const { keyring } = this.deps;
    const id = state.vault.id;
    const known = keyring.get(id, version);
    if (known) return known;
    const wrapped = state.wrappedKeys.get(version);
    if (!wrapped) {
      throw new TernixError('vault_unavailable', `No key for version ${version} of this vault`);
    }
    try {
      const key = unwrapVaultKey(wrapped, keyring.publicKey, keyring.privateKey);
      keyring.set(id, version, key);
      return key;
    } catch (err) {
      throw new TernixError(
        'vault_unavailable',
        'This vault key cannot be opened with your account key',
        {
          cause: err,
        },
      );
    }
  }

  private openName(state: VaultState): void {
    try {
      const key = this.keyFor(state, state.vault.key_version);
      state.name = decryptVaultName(key, state.vault.id, state.vault.name_enc);
      state.error = null;
    } catch (err) {
      state.name = null;
      state.error = err instanceof TernixError ? err.message : 'The vault name cannot be decrypted';
    }
  }

  /** Insert or update a vault from the server. Returns whether anything visible changed. */
  private upsertVault(v: Vault): boolean {
    let state = this.vaults.get(v.id);
    let changed = false;
    if (!state) {
      state = this.newState(v);
      this.vaults.set(v.id, state);
      changed = true;
    } else if (vaultSignature(state.vault) !== vaultSignature(v)) {
      changed = true;
    }
    const previous = state.wrappedKeys.get(v.key_version);
    if (previous !== undefined && previous !== v.wrapped_key) {
      this.deps.keyring.drop(v.id, v.key_version);
    }
    state.vault = v;
    state.wrappedKeys.set(v.key_version, v.wrapped_key);
    this.openName(state);
    return changed;
  }

  private async forgetVault(vaultId: string): Promise<void> {
    this.vaults.delete(vaultId);
    this.pulls.delete(vaultId);
    this.deps.keyring.dropVault(vaultId);
    if (!this.closed) await this.deps.cache.delete(this.deps.account, itemsCacheKey(vaultId));
  }

  /** Drop wrapped keys of old versions no cached item uses any more. */
  private pruneKeys(state: VaultState): void {
    const inUse = new Set([state.vault.key_version]);
    for (const item of state.items.values()) inUse.add(item.key_version);
    for (const version of [...state.wrappedKeys.keys()]) {
      if (!inUse.has(version) && version < state.vault.key_version) {
        state.wrappedKeys.delete(version);
        this.deps.keyring.drop(state.vault.id, version);
      }
    }
  }

  /** Apply one server item if it is newer than what we hold. Returns whether it changed. */
  private applyItem(state: VaultState, item: Item): boolean {
    const existing = state.items.get(item.id);
    const known = Math.max(existing?.seq ?? -1, state.tombstones.get(item.id) ?? -1);
    if (item.seq <= known) return false;
    if (item.deleted) {
      state.items.delete(item.id);
      state.tombstones.set(item.id, item.seq);
      return existing !== undefined;
    }
    state.tombstones.delete(item.id);
    state.items.set(item.id, item);
    return true;
  }

  private state(vaultId: string): VaultState {
    this.assertOpen();
    const state = this.vaults.get(vaultId);
    if (!state) throw new TernixError('not_found', 'Vault not found');
    return state;
  }

  private writable(vaultId: string): VaultState {
    const state = this.state(vaultId);
    if (state.vault.role === 'viewer') {
      throw new TernixError('permission_denied', 'Viewers cannot change items in this vault');
    }
    return state;
  }

  private owned(vaultId: string, action: string): VaultState {
    const state = this.state(vaultId);
    if (state.vault.role !== 'owner') {
      throw new TernixError('permission_denied', `Only an owner can ${action}`);
    }
    return state;
  }

  // Sync

  /** Refresh the vault list (new, removed, rotated, renamed vaults) and pull what is behind. */
  refreshVaults(): Promise<void> {
    this.assertOpen();
    return this.refresher.run();
  }

  private async doRefresh(): Promise<void> {
    const res = await this.deps.http.request(routes.listVaults, {
      schema: listVaultsResponseSchema,
    });
    this.assertOpen();
    let changed = false;
    const seen = new Set<string>();
    for (const v of res.vaults) {
      seen.add(v.id);
      if (this.upsertVault(v)) changed = true;
    }
    for (const id of [...this.vaults.keys()]) {
      if (!seen.has(id)) {
        await this.forgetVault(id);
        changed = true;
      }
    }
    await this.persistVaults();
    if (changed) this.deps.emit('vaults-changed', undefined);
    const behind = [...this.vaults.values()].filter((s) => s.vault.seq > s.since);
    await Promise.all(behind.map((s) => this.pullVault(s.vault.id)));
  }

  /** Pull one vault's changes since its cursor. Concurrent calls coalesce. */
  pullVault(vaultId: string): Promise<void> {
    this.assertOpen();
    if (!this.vaults.has(vaultId)) {
      // A vault we have not listed yet: the list refresh pulls it.
      return this.refreshVaults();
    }
    let pull = this.pulls.get(vaultId);
    if (!pull) this.pulls.set(vaultId, (pull = new Coalescer(() => this.pullOnce(vaultId))));
    return pull.run();
  }

  /** Full catch-up: the vault list, then every vault. */
  async syncAll(): Promise<void> {
    await this.refreshVaults();
    await Promise.all([...this.vaults.keys()].map((id) => this.pullVault(id)));
  }

  private async pullOnce(vaultId: string): Promise<void> {
    const state = this.vaults.get(vaultId);
    if (!state || this.closed) return;
    let since = state.since;
    let changed = false;
    try {
      for (;;) {
        const page = await this.deps.http.request(routes.listItems, {
          params: { id: vaultId },
          query: { since, limit: MAX_LIST_LIMIT },
          schema: listItemsResponseSchema,
        });
        if (this.closed || this.vaults.get(vaultId) !== state) return;
        for (const item of page.items) if (this.applyItem(state, item)) changed = true;
        since = Math.max(since, page.next_since);
        if (!page.has_more || page.items.length === 0) break;
      }
    } catch (err) {
      if (isApiError(err, 'not_found') || isApiError(err, 'forbidden')) {
        // Removed from the vault or it was deleted: the list refresh forgets it.
        this.background(this.refreshVaults());
        return;
      }
      throw err;
    }
    const moved = since !== state.since;
    state.since = Math.max(state.since, since);
    this.pruneKeys(state);
    if (changed || moved) this.persistItems(state);
    if (changed) this.deps.emit('items-changed', { vaultId });
  }

  /** React to a realtime hint without blocking the socket. */
  onVaultChanged(vaultId: string): void {
    if (this.closed) return;
    this.background(this.pullVault(vaultId));
  }

  onVaultsChanged(): void {
    if (this.closed) return;
    this.background(this.refreshVaults());
  }

  // Reads

  private toVaultDto(state: VaultState): VaultDto {
    const v = state.vault;
    return {
      id: v.id,
      kind: v.kind,
      role: v.role,
      name: state.name,
      keyVersion: v.key_version,
      memberCount: v.member_count,
      itemCount: state.items.size,
      error: state.error,
    };
  }

  listVaults(): VaultDto[] {
    this.assertOpen();
    return [...this.vaults.values()]
      .map((s) => this.toVaultDto(s))
      .sort(
        (a, b) =>
          (a.kind === 'personal' ? 0 : 1) - (b.kind === 'personal' ? 0 : 1) ||
          (a.name ?? '').localeCompare(b.name ?? '') ||
          a.id.localeCompare(b.id),
      );
  }

  getVault(vaultId: string): VaultDto {
    return this.toVaultDto(this.state(vaultId));
  }

  private toItemDto(item: LiveItem, payload: ItemPayload): ItemDto {
    return {
      id: item.id,
      vaultId: item.vault_id,
      seq: item.seq,
      keyVersion: item.key_version,
      updatedAt: item.updated_at,
      updatedBy: item.updated_by,
      payload,
    };
  }

  private readItem(state: VaultState, item: LiveItem): ItemDto | UnreadableItemDto {
    try {
      const key = this.keyFor(state, item.key_version);
      return this.toItemDto(item, decryptItem(key, item.vault_id, item.id, item.ciphertext));
    } catch (err) {
      const error =
        err instanceof TernixError
          ? err.message
          : err instanceof Error && err.name === 'ZodError'
            ? 'This item has a type or format this version of Ternix does not understand'
            : 'This item cannot be decrypted';
      return {
        id: item.id,
        vaultId: item.vault_id,
        seq: item.seq,
        keyVersion: item.key_version,
        error,
      };
    }
  }

  listItems(vaultId: string): VaultItemsDto {
    const state = this.state(vaultId);
    const out: VaultItemsDto = { vaultId, items: [], unreadable: [] };
    for (const item of state.items.values()) {
      const read = this.readItem(state, item);
      if ('payload' in read) out.items.push(read);
      else out.unreadable.push(read);
    }
    return out;
  }

  getItem(vaultId: string, itemId: string): ItemDto | null {
    const state = this.state(vaultId);
    const item = state.items.get(itemId);
    if (!item) return null;
    const read = this.readItem(state, item);
    if (!('payload' in read)) throw new TernixError('vault_unavailable', read.error);
    return read;
  }

  // Writes

  private preparePayload(draft: ItemDraft, at: string): ItemPayload {
    if (typeof draft !== 'object' || draft === null) {
      throw new TernixError('invalid_input', 'An item must be an object');
    }
    const parsed = itemPayloadSchema.safeParse({ ...draft, updated_at: at });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
      throw new TernixError(
        'invalid_input',
        `Invalid item${where}: ${issue?.message ?? 'invalid'}`,
      );
    }
    return parsed.data;
  }

  private checkId(id: string): string {
    if (typeof id !== 'string' || !UUID_V4_RE.test(id)) {
      throw new TernixError('invalid_input', 'Item IDs must be lowercase UUIDv4 strings');
    }
    return id;
  }

  /** Encrypt puts under the vault's current key; enforce the ciphertext limit before sending. */
  private encryptPending(state: VaultState, writes: PendingWrite[]): void {
    const version = state.vault.key_version;
    for (const w of writes) {
      if (w.op !== 'put' || w.version === version) continue;
      const ciphertext = encryptItem(this.keyFor(state, version), state.vault.id, w.id, w.payload!);
      if (ciphertext.length > MAX_ITEM_CIPHERTEXT_LENGTH) {
        const label = w.payload && 'label' in w.payload ? ` "${w.payload.label}"` : '';
        throw new TernixError(
          'limit_exceeded',
          `Item${label} is too large to sync: ${ciphertext.length} characters encrypted, ` +
            `the limit is ${MAX_ITEM_CIPHERTEXT_LENGTH}`,
        );
      }
      w.ciphertext = ciphertext;
      w.version = version;
    }
  }

  private wireOf(w: PendingWrite): BatchOp {
    return w.op === 'put'
      ? {
          op: 'put',
          id: w.id,
          ciphertext: w.ciphertext!,
          key_version: w.version!,
          base_seq: w.baseSeq,
        }
      : { op: 'delete', id: w.id, base_seq: w.baseSeq! };
  }

  /** Decrypt the server's version of an item for the conflict rule. */
  private async decryptRemote(vaultId: string, item: LiveItem): Promise<ItemPayload> {
    let state = this.state(vaultId);
    if (!state.wrappedKeys.has(item.key_version)) {
      await this.refreshVaults();
      state = this.state(vaultId);
    }
    try {
      return decryptItem(this.keyFor(state, item.key_version), vaultId, item.id, item.ciphertext);
    } catch (err) {
      throw new TernixError(
        'conflict_unresolved',
        'The server has another version of this item that this app cannot read',
        { cause: err },
      );
    }
  }

  /**
   * The protocol's client conflict rule (section 6). A put retries when its `updated_at`
   * is newer than the server's version (or the server's delete), else it is dropped. A
   * delete loses to an edit whose `updated_at` is newer than the delete.
   */
  private async decide(vaultId: string, w: PendingWrite, current: Item): Promise<Decision> {
    if (w.op === 'put') {
      if (current.deleted) {
        // The server's tombstone carries no payload; its server time stands in.
        const retry = isNewer(w.at, current.updated_at);
        return { retry, status: 'dropped', payload: null };
      }
      const remote = await this.decryptRemote(vaultId, current);
      return { retry: isNewer(w.at, remote.updated_at), status: 'dropped', payload: remote };
    }
    if (current.deleted) return { retry: false, status: 'saved', payload: null };
    const remote = await this.decryptRemote(vaultId, current);
    return { retry: !isNewer(remote.updated_at, w.at), status: 'dropped', payload: remote };
  }

  private result(item: Item, status: 'saved' | 'dropped', payload: ItemPayload | null) {
    return {
      id: item.id,
      status,
      item: item.deleted || !payload ? null : this.toItemDto(item, payload),
    } satisfies WriteResultDto;
  }

  /** One PUT or DELETE with conflict handling. */
  private async writeOne(vaultId: string, w: PendingWrite): Promise<WriteResultDto>;
  /** A background put: a `409` of any kind skips the write instead of applying the rule. */
  private async writeOne(
    vaultId: string,
    w: PendingWrite,
    background: true,
  ): Promise<WriteResultDto | SkippedWriteDto>;
  private async writeOne(
    vaultId: string,
    w: PendingWrite,
    background = false,
  ): Promise<WriteResultDto | SkippedWriteDto> {
    const { http } = this.deps;
    let refreshedForKey = false;
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const state = this.writable(vaultId);
      let outcome: { item: Item; status: 'saved' | 'dropped'; payload: ItemPayload | null };
      try {
        let item: Item;
        if (w.op === 'put') {
          this.encryptPending(state, [w]);
          ({ item } = await http.request(routes.putItem, {
            params: { id: vaultId, item_id: w.id },
            body: { ciphertext: w.ciphertext, key_version: w.version, base_seq: w.baseSeq },
            schema: itemResponseSchema,
          }));
        } else {
          ({ item } = await http.request(routes.deleteItem, {
            params: { id: vaultId, item_id: w.id },
            query: { base_seq: w.baseSeq ?? 0 },
            schema: itemResponseSchema,
          }));
        }
        outcome = { item, status: 'saved', payload: w.payload ?? null };
      } catch (err) {
        if (background && err instanceof ApiError && err.status === 409) {
          // Learn the newer version the server has; the write itself is not made.
          const local = this.vaults.get(vaultId);
          if (err.current && !this.closed && local && this.applyItem(local, err.current)) {
            this.persistItems(local);
            this.deps.emit('items-changed', { vaultId });
          }
          return { id: w.id, status: 'skipped', item: null };
        }
        if (isApiError(err, 'conflict') && err.current) {
          const decision = await this.decide(vaultId, w, err.current);
          if (decision.retry) {
            w.baseSeq = err.current.seq;
            continue;
          }
          outcome = { item: err.current, status: decision.status, payload: decision.payload };
        } else if (isApiError(err, 'key_version_mismatch') && !refreshedForKey) {
          // Rotated under us: learn the new key and encrypt again.
          refreshedForKey = true;
          await this.refreshVaults();
          continue;
        } else if (w.op === 'delete' && isApiError(err, 'not_found')) {
          const local = this.vaults.get(vaultId);
          if (local?.items.delete(w.id)) {
            this.persistItems(local);
            this.deps.emit('items-changed', { vaultId });
          }
          return { id: w.id, status: 'saved', item: null };
        } else {
          throw err;
        }
      }
      const local = this.vaults.get(vaultId);
      if (!this.closed && local && this.applyItem(local, outcome.item)) {
        this.persistItems(local);
        this.deps.emit('items-changed', { vaultId });
      }
      return this.result(outcome.item, outcome.status, outcome.payload);
    }
    throw new TernixError(
      'conflict_unresolved',
      'The item kept changing on the server; reload it and try again',
    );
  }

  /**
   * Create (no `itemId`) or update an item. Sets `updated_at` to now, encrypts, and applies
   * the conflict rule. Needs the server: throws `OfflineError` without a connection.
   */
  async putItem(
    vaultId: string,
    itemId: string | undefined,
    draft: ItemDraft,
  ): Promise<WriteResultDto>;
  async putItem(
    vaultId: string,
    itemId: string,
    draft: ItemDraft,
    options: PutItemOptions,
  ): Promise<WriteResultDto | SkippedWriteDto>;
  async putItem(
    vaultId: string,
    itemId: string | undefined,
    draft: ItemDraft,
    options?: PutItemOptions,
  ): Promise<WriteResultDto | SkippedWriteDto> {
    const state = this.writable(vaultId);
    const id = this.checkId(itemId ?? randomUUID());
    if (options?.background) {
      return this.putInBackground(state, id, draft, options.background.baseSeq);
    }
    const payload = this.preparePayload(draft, this.deps.now().toISOString());
    const baseSeq = state.items.get(id)?.seq ?? null;
    if (baseSeq === null && state.items.size >= MAX_LIVE_ITEMS_PER_VAULT) {
      throw new TernixError(
        'limit_exceeded',
        `A vault holds at most ${MAX_LIVE_ITEMS_PER_VAULT} items`,
      );
    }
    const write: PendingWrite = { op: 'put', id, baseSeq, at: payload.updated_at, payload };
    this.encryptPending(state, [write]);
    return this.writeOne(vaultId, write);
  }

  private async putInBackground(
    state: VaultState,
    id: string,
    draft: ItemDraft,
    baseSeq: number,
  ): Promise<WriteResultDto | SkippedWriteDto> {
    const skipped: SkippedWriteDto = { id, status: 'skipped', item: null };
    // An update of the version the draft was made from, nothing else: no create, no revive.
    const live = state.items.get(id);
    if (!live || live.seq !== baseSeq) return skipped;
    const base = this.readItem(state, live);
    if (!('payload' in base)) return skipped;
    const payload = this.preparePayload(draft, base.payload.updated_at);
    const write: PendingWrite = { op: 'put', id, baseSeq, at: payload.updated_at, payload };
    this.encryptPending(state, [write]);
    return this.writeOne(state.vault.id, write, true);
  }

  async deleteItem(vaultId: string, itemId: string): Promise<WriteResultDto> {
    const state = this.writable(vaultId);
    const existing = state.items.get(this.checkId(itemId));
    if (!existing) throw new TernixError('not_found', 'Item not found');
    return this.writeOne(vaultId, {
      op: 'delete',
      id: itemId,
      baseSeq: existing.seq,
      at: this.deps.now().toISOString(),
    });
  }

  /**
   * Many puts and deletes through the batch endpoint, in chunks of `MAX_BATCH_OPS` and
   * `MAX_BATCH_BODY_BYTES`, with the conflict rule per op. Limits are checked before
   * anything is sent. If a later chunk fails to send, earlier chunks stay applied.
   */
  async applyBatch(vaultId: string, inputs: BatchOpInput[]): Promise<BatchResultDto> {
    let state = this.writable(vaultId);
    const results: WriteResultDto[] = [];
    const failed: BatchFailureDto[] = [];
    const at = this.deps.now().toISOString();
    const seen = new Set<string>();
    let queue: PendingWrite[] = [];
    for (const input of inputs) {
      const id = this.checkId(input.op === 'put' ? (input.id ?? randomUUID()) : input.id);
      if (seen.has(id))
        throw new TernixError('invalid_input', `Item ${id} appears twice in one batch`);
      seen.add(id);
      if (input.op === 'put') {
        const payload = this.preparePayload(input.payload, at);
        queue.push({ op: 'put', id, baseSeq: state.items.get(id)?.seq ?? null, at, payload });
      } else if (input.op === 'delete') {
        const existing = state.items.get(id);
        if (!existing) {
          failed.push({ id, code: 'not_found', message: 'Item not found' });
          continue;
        }
        queue.push({ op: 'delete', id, baseSeq: existing.seq, at });
      } else {
        throw new TernixError('invalid_input', 'Batch operations are "put" or "delete"');
      }
    }
    // The server applies ops in order; refuse a batch that would overfill the vault.
    let live = state.items.size;
    for (const w of queue) {
      if (w.op === 'put' && w.baseSeq === null) live += 1;
      if (w.op === 'delete') live -= 1;
      if (live > MAX_LIVE_ITEMS_PER_VAULT) {
        throw new TernixError(
          'limit_exceeded',
          `A vault holds at most ${MAX_LIVE_ITEMS_PER_VAULT} items; this import would exceed it`,
        );
      }
    }
    this.encryptPending(state, queue);

    let changed = false;
    try {
      for (let round = 0; queue.length > 0 && round < MAX_WRITE_ATTEMPTS; round++) {
        state = this.writable(vaultId);
        this.encryptPending(state, queue);
        const next: PendingWrite[] = [];
        let keyMismatch = false;
        for (const chunk of chunkBatch(queue, (w) => this.wireOf(w))) {
          const res = await this.deps.http.request(routes.batchItems, {
            params: { id: vaultId },
            body: { ops: chunk.map((w) => this.wireOf(w)) },
            schema: batchResponseSchema,
            timeoutMs: LONG_TIMEOUT_MS,
          });
          this.assertOpen();
          for (const [i, w] of chunk.entries()) {
            const r = res.results[i];
            if (!r || r.id !== w.id) {
              throw new TernixError('protocol_error', 'Batch results do not match the request');
            }
            if (r.status === 'ok') {
              if (this.applyItem(state, r.item)) changed = true;
              results.push(this.result(r.item, 'saved', w.payload ?? null));
            } else if (r.status === 'conflict') {
              const decision = await this.decide(vaultId, w, r.current);
              if (decision.retry) {
                w.baseSeq = r.current.seq;
                next.push(w);
              } else {
                if (this.applyItem(state, r.current)) changed = true;
                results.push(this.result(r.current, decision.status, decision.payload));
              }
            } else if (r.error.code === 'key_version_mismatch') {
              keyMismatch = true;
              next.push(w);
            } else if (w.op === 'delete' && r.error.code === 'not_found') {
              if (state.items.delete(w.id)) changed = true;
              results.push({ id: w.id, status: 'saved', item: null });
            } else {
              failed.push({ id: w.id, code: r.error.code, message: r.error.message });
            }
          }
        }
        if (keyMismatch) await this.refreshVaults();
        queue = next;
      }
      for (const w of queue) {
        failed.push({
          id: w.id,
          code: 'conflict_unresolved',
          message: 'The item kept changing on the server',
        });
      }
    } finally {
      if (changed) {
        this.persistItems(state);
        this.deps.emit('items-changed', { vaultId });
      }
    }
    return { results, failed };
  }

  // Vaults

  private checkName(name: string): string {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (clean.length === 0 || clean.length > MAX_VAULT_NAME_LENGTH) {
      throw new TernixError(
        'invalid_input',
        `A vault name must be 1 to ${MAX_VAULT_NAME_LENGTH} characters`,
      );
    }
    return clean;
  }

  async createVault(name: string): Promise<VaultDto> {
    this.assertOpen();
    const clean = this.checkName(name);
    const { keyring } = this.deps;
    const id = randomUUID();
    const key = newVaultKey();
    const vault = await this.deps.http.request(routes.createVault, {
      body: {
        id,
        name_enc: encryptVaultName(key, id, clean),
        wrapped_key: wrapVaultKey(key, keyring.publicKey),
      },
      schema: vaultSchema,
    });
    this.assertOpen();
    keyring.set(id, vault.key_version, key);
    this.upsertVault(vault);
    await this.persistVaults();
    this.deps.emit('vaults-changed', undefined);
    return this.getVault(id);
  }

  async renameVault(vaultId: string, name: string): Promise<VaultDto> {
    const clean = this.checkName(name);
    for (let attempt = 0; ; attempt++) {
      const state = this.owned(vaultId, 'rename a vault');
      const version = state.vault.key_version;
      try {
        const vault = await this.deps.http.request(routes.updateVault, {
          params: { id: vaultId },
          body: {
            name_enc: encryptVaultName(this.keyFor(state, version), vaultId, clean),
            key_version: version,
          },
          schema: vaultSchema,
        });
        this.assertOpen();
        this.upsertVault(vault);
        await this.persistVaults();
        this.deps.emit('vaults-changed', undefined);
        return this.getVault(vaultId);
      } catch (err) {
        if (attempt === 0 && isApiError(err, 'key_version_mismatch')) {
          await this.refreshVaults();
          continue;
        }
        throw err;
      }
    }
  }

  async deleteVault(vaultId: string): Promise<void> {
    const state = this.owned(vaultId, 'delete a vault');
    if (state.vault.kind === 'personal') {
      throw new TernixError('permission_denied', 'The personal vault cannot be deleted');
    }
    await this.deps.http.request(routes.deleteVault, { params: { id: vaultId } });
    await this.dropLocally(vaultId);
  }

  private async dropLocally(vaultId: string): Promise<void> {
    this.assertOpen();
    await this.forgetVault(vaultId);
    await this.persistVaults();
    this.deps.emit('vaults-changed', undefined);
  }

  // Members and sharing

  private toMemberDto(m: Member, obs: PinObservation): MemberDto {
    return {
      userId: m.user_id,
      email: m.email,
      name: m.name,
      role: m.role,
      publicKey: m.public_key,
      fingerprint: fingerprint(fromB64(m.public_key)),
      addedAt: m.added_at,
      isSelf: m.user_id === this.deps.userId,
      pinnedFingerprint: fingerprintOf(obs.pin.public_key),
      verified: obs.pin.verified,
      keyChanged: obs.status === 'mismatch',
    };
  }

  /** Compare listed members' keys with the pins, pinning new ones (TOFU). */
  private observeMembers(members: Member[]): Promise<PinObservation[]> {
    return this.deps.pins.observe(
      members.map((m) => ({ userId: m.user_id, publicKey: m.public_key })),
    );
  }

  private async memberDtos(members: Member[]): Promise<MemberDto[]> {
    for (const m of members) this.emails.set(m.user_id, m.email);
    const observed = await this.observeMembers(members);
    return members.map((m, i) => this.toMemberDto(m, observed[i]!));
  }

  /** Throws `MemberKeyChangedError` for the first member whose key is not the pinned one. */
  private assertKeysPinned(members: Member[], observed: PinObservation[]): void {
    for (const [i, m] of members.entries()) {
      const obs = observed[i]!;
      if (obs.status === 'mismatch') throw this.keyChanged(m.user_id, m.email, obs);
    }
  }

  private keyChanged(
    userId: string,
    email: string,
    obs: Extract<PinObservation, { status: 'mismatch' }>,
  ): MemberKeyChangedError {
    return new MemberKeyChangedError({
      userId,
      email,
      pinnedFingerprint: fingerprintOf(obs.pin.public_key),
      serverFingerprint: fingerprintOf(obs.serverKey),
    });
  }

  private async fetchMembers(vaultId: string): Promise<Member[]> {
    const res = await this.deps.http.request(routes.listMembers, {
      params: { id: vaultId },
      schema: listMembersResponseSchema,
    });
    this.assertOpen();
    return res.members;
  }

  async listMembers(vaultId: string): Promise<MemberDto[]> {
    this.state(vaultId);
    return this.memberDtos(await this.fetchMembers(vaultId));
  }

  /**
   * The user compared the new fingerprint out of band and trusts `publicKey`: pin it as
   * verified, replacing the old pin. Rotation and sharing proceed once the server reports it.
   */
  async acceptMemberKey(userId: string, publicKey: string): Promise<void> {
    this.assertOpen();
    if (userId === this.deps.userId) {
      throw new TernixError('invalid_input', 'Your own key cannot be replaced');
    }
    if (!publicKeySchema.safeParse(publicKey).success) {
      throw new TernixError('invalid_input', 'Not a valid public key');
    }
    await this.deps.pins.pin(userId, publicKey, true);
  }

  /**
   * The user compared the fingerprint of `publicKey` out of band: mark the pin verified. Refuses
   * (`member_key_changed`) when the pin is another key by now, so a pin that changed after the
   * user looked is never the one marked.
   */
  async markMemberVerified(userId: string, publicKey: string): Promise<void> {
    this.assertOpen();
    if (!publicKeySchema.safeParse(publicKey).success) {
      throw new TernixError('invalid_input', 'Not a valid public key');
    }
    const result = await this.deps.pins.markVerified(userId, publicKey);
    if (!result) throw new TernixError('not_found', 'No key is pinned for this user yet');
    if (result.status === 'mismatch') {
      throw this.keyChanged(userId, this.emails.get(userId) ?? '', result);
    }
  }

  /** Find a user to share with. Show `fingerprint` and have it compared out of band. */
  async lookupUser(email: string): Promise<LookupUserDto> {
    this.assertOpen();
    const res = await this.deps.http.request(routes.lookupUser, {
      query: { email: normalizeEmail(email) },
      schema: lookupUserResponseSchema,
    });
    this.assertOpen();
    this.deps.pins.checkSelf(res.id, res.public_key);
    this.lookups.set(res.id, { email: res.email, publicKey: res.public_key });
    this.emails.set(res.id, res.email);
    const pin = this.deps.pins.get(res.id);
    return {
      id: res.id,
      email: res.email,
      name: res.name,
      publicKey: res.public_key,
      fingerprint: fingerprint(fromB64(res.public_key)),
      pinnedFingerprint: pin ? fingerprintOf(pin.public_key) : null,
      verified: pin?.verified ?? false,
      keyChanged: pin !== undefined && pin.public_key !== res.public_key,
    };
  }

  /**
   * Share a vault with a user found by `lookupUser`. `expectedPublicKey` is the key whose
   * fingerprint the user confirmed; the vault key is wrapped for exactly that key, and the
   * call refuses if the server now returns a different key for the user. The key is then
   * pinned as verified; a different earlier pin refuses (`member_key_changed`) until
   * `acceptMemberKey`.
   */
  async addMember(
    vaultId: string,
    userId: string,
    role: VaultRole,
    expectedPublicKey: string,
  ): Promise<MemberDto> {
    this.owned(vaultId, 'share a vault');
    const looked = this.lookups.get(userId);
    if (!looked) {
      throw new TernixError('invalid_input', 'Look the user up by email before adding them');
    }
    const fresh = await this.lookupUser(looked.email);
    if (fresh.id !== userId || fresh.publicKey !== expectedPublicKey) {
      throw new TernixError(
        'key_changed',
        "This user's key is not the one you verified. Look them up again and compare the fingerprint before sharing.",
      );
    }
    const pinned = this.deps.pins.get(userId);
    if (pinned && pinned.public_key !== expectedPublicKey) {
      throw this.keyChanged(userId, fresh.email, {
        status: 'mismatch',
        pin: pinned,
        serverKey: expectedPublicKey,
      });
    }
    await this.deps.pins.pin(userId, expectedPublicKey, true);
    const publicKey = fromB64(expectedPublicKey);
    for (let attempt = 0; ; attempt++) {
      const state = this.owned(vaultId, 'share a vault');
      const version = state.vault.key_version;
      try {
        const member = await this.deps.http.request(routes.addMember, {
          params: { id: vaultId },
          body: {
            user_id: userId,
            role,
            wrapped_key: wrapVaultKey(this.keyFor(state, version), publicKey),
            key_version: version,
          },
          schema: memberSchema,
        });
        await this.settleQuietly(this.refreshVaults());
        return (await this.memberDtos([member]))[0]!;
      } catch (err) {
        if (attempt === 0 && isApiError(err, 'key_version_mismatch')) {
          await this.refreshVaults();
          continue;
        }
        throw err;
      }
    }
  }

  async changeMemberRole(vaultId: string, userId: string, role: VaultRole): Promise<MemberDto> {
    this.owned(vaultId, 'change roles');
    const member = await this.deps.http.request(routes.updateMember, {
      params: { id: vaultId, user_id: userId },
      body: { role },
      schema: memberSchema,
    });
    await this.settleQuietly(this.refreshVaults());
    return (await this.memberDtos([member]))[0]!;
  }

  /**
   * Remove a member. When an owner removes someone else, the vault key is rotated right
   * after (protocol section 5) so the removed user cannot read anything written later.
   */
  async removeMember(vaultId: string, userId: string): Promise<RemoveMemberResultDto> {
    if (userId === this.deps.userId) {
      await this.leaveVault(vaultId);
      return { rotated: false, rotationError: null };
    }
    this.owned(vaultId, 'remove other members');
    await this.deps.http.request(routes.removeMember, {
      params: { id: vaultId, user_id: userId },
    });
    // A rotation already running may have listed the members before the removal (or even
    // committed, with the removed user holding the new key): this one must not reuse it.
    this.membershipEpochs.set(vaultId, (this.membershipEpochs.get(vaultId) ?? 0) + 1);
    try {
      await this.rotateVault(vaultId);
      return { rotated: true, rotationError: null };
    } catch (err) {
      if (err instanceof TernixError && err.code === 'locked') throw err;
      return { rotated: false, rotationError: toErrorDto(err) };
    }
  }

  async leaveVault(vaultId: string): Promise<void> {
    this.state(vaultId);
    await this.deps.http.request(routes.removeMember, {
      params: { id: vaultId, user_id: this.deps.userId },
    });
    await this.dropLocally(vaultId);
  }

  // Rotation

  /**
   * Re-key a vault (owner): new key at `key_version + 1`, name re-sealed, the key wrapped
   * for exactly the current members, and every live item re-encrypted with its `base_seq`.
   * On `409` it refreshes members and items and retries, up to `MAX_ROTATION_ATTEMPTS`.
   *
   * A call joins a rotation in progress only if that rotation started after the last member
   * removal on this device; otherwise it queues a new one behind it, which lists the members
   * again.
   */
  rotateVault(vaultId: string): Promise<VaultDto> {
    const required = this.membershipEpochs.get(vaultId) ?? 0;
    const running = this.rotations.get(vaultId);
    if (running && (running.epoch === null || running.epoch >= required)) return running.task;
    const previous = running?.task.then(
      () => undefined,
      () => undefined,
    );
    const task = (previous ?? Promise.resolve())
      .then(() => {
        entry.epoch = this.membershipEpochs.get(vaultId) ?? 0;
        return this.rotate(vaultId);
      })
      .finally(() => {
        if (this.rotations.get(vaultId) === entry) this.rotations.delete(vaultId);
      });
    const entry: { task: Promise<VaultDto>; epoch: number | null } = { task, epoch: null };
    this.rotations.set(vaultId, entry);
    return task;
  }

  private async rotate(vaultId: string): Promise<VaultDto> {
    const { http, keyring } = this.deps;
    let newKey: Uint8Array | null = null;
    let newVersion = 0;
    let installed = false;
    // Re-encrypted ciphertext per item, reused across attempts while its seq is unchanged.
    const sealed = new Map<string, { seq: number; ciphertext: string }>();
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt < MAX_ROTATION_ATTEMPTS; attempt++) {
        await this.refreshVaults();
        this.owned(vaultId, 'rotate the vault key');
        const members = await this.fetchMembers(vaultId);
        // Before any key exists for them: a member whose key is not the pinned one gets nothing.
        this.assertKeysPinned(members, await this.observeMembers(members));
        await this.pullVault(vaultId);
        const state = this.owned(vaultId, 'rotate the vault key');

        const version = state.vault.key_version + 1;
        if (version !== newVersion || !newKey) {
          newKey?.fill(0);
          newKey = newVaultKey();
          newVersion = version;
          sealed.clear();
        }
        const currentKey = this.keyFor(state, state.vault.key_version);
        const name = decryptVaultName(currentKey, vaultId, state.vault.name_enc);

        const items: RotateRequest['items'] = [];
        for (const item of state.items.values()) {
          let entry = sealed.get(item.id);
          if (!entry || entry.seq !== item.seq) {
            // Re-seal the exact plaintext, so items of types this app does not know survive.
            const ad = itemAd(vaultId, item.id);
            let plaintext: Uint8Array;
            try {
              plaintext = open(this.keyFor(state, item.key_version), item.ciphertext, ad);
            } catch (err) {
              throw new RotationError(
                `Item ${item.id} cannot be decrypted, so the vault cannot be re-keyed`,
                { cause: err },
              );
            }
            entry = { seq: item.seq, ciphertext: seal(newKey, plaintext, ad) };
            plaintext.fill(0);
            sealed.set(item.id, entry);
          }
          items.push({ id: item.id, ciphertext: entry.ciphertext, base_seq: item.seq });
        }
        for (const id of [...sealed.keys()]) if (!state.items.has(id)) sealed.delete(id);

        const body: RotateRequest = {
          key_version: version,
          name_enc: encryptVaultName(newKey, vaultId, name),
          members: members.map((m) => ({
            user_id: m.user_id,
            wrapped_key: wrapVaultKey(newKey!, fromB64(m.public_key)),
          })),
          items,
        };
        if (Buffer.byteLength(JSON.stringify(body)) > MAX_ROTATE_BODY_BYTES) {
          throw new TernixError(
            'limit_exceeded',
            'This vault is too large to rotate in one request',
          );
        }

        try {
          const vault = await http.request(routes.rotateVault, {
            params: { id: vaultId },
            body,
            schema: vaultSchema,
            timeoutMs: LONG_TIMEOUT_MS,
          });
          this.assertOpen();
          keyring.set(vaultId, version, newKey);
          installed = true;
          this.upsertVault(vault);
          await this.persistVaults();
          this.deps.emit('vaults-changed', undefined);
          await this.settleQuietly(this.pullVault(vaultId));
          return this.getVault(vaultId);
        } catch (err) {
          if (isApiError(err, 'conflict') || isApiError(err, 'key_version_mismatch')) {
            lastError = err;
            continue;
          }
          throw err;
        }
      }
    } finally {
      if (!installed) newKey?.fill(0);
    }
    throw new RotationError(
      `The vault kept changing during key rotation; gave up after ${MAX_ROTATION_ATTEMPTS} attempts`,
      { cause: lastError },
    );
  }
}
