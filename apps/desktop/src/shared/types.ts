import type { ItemPayload, ItemPayloadInput } from '@ternix/core/items';
import type { RegistrationMode, UserRole, VaultKind, VaultRole } from '@ternix/core/protocol';

/**
 * Plain, serializable shapes the sync client returns. They cross Electron IPC to the
 * renderer, so: no classes, no `Uint8Array`, no functions. Field names are camelCase;
 * item payloads keep the protocol's snake_case.
 */

export type { ItemPayload, ItemPayloadInput, RegistrationMode, UserRole, VaultKind, VaultRole };

/** `loggedOut`: no session. `locked`: session, keys not in memory. `expired`: token gone. */
export type ClientState = 'loggedOut' | 'locked' | 'unlocked' | 'expired';
export type ConnectionState = 'offline' | 'connecting' | 'online';

export interface ServerInfoDto {
  serverUrl: string;
  name: string;
  version: string;
  registration: RegistrationMode;
  protocol: number;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export interface AccountDto {
  serverUrl: string;
  email: string;
  deviceId: string;
  user: UserDto;
}

export interface DeviceDto {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string | null;
  current: boolean;
}

/**
 * A user found by email, with the fingerprint to compare out of band before sharing. The
 * `pinned*` fields say what this device already knows about the user's key: `pinnedFingerprint`
 * is null for a user it has never seen; `keyChanged` means the server now reports another key.
 */
export interface LookupUserDto {
  id: string;
  email: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  pinnedFingerprint: string | null;
  /** The pinned key was confirmed out of band (false for a trust-on-first-use pin). */
  verified: boolean;
  keyChanged: boolean;
}

export interface InviteDto {
  code: string;
  email: string | null;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export interface CreatedInviteDto {
  code: string;
  expiresAt: string;
}

/**
 * A vault the account can see. `name` is null and `error` set when the vault key or name
 * could not be opened (for example a wrapped key this account cannot unwrap).
 */
export interface VaultDto {
  id: string;
  kind: VaultKind;
  role: VaultRole;
  name: string | null;
  keyVersion: number;
  memberCount: number;
  itemCount: number;
  error: string | null;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: VaultRole;
  publicKey: string;
  fingerprint: string;
  addedAt: string;
  isSelf: boolean;
  /** Fingerprint of the key this device pinned for the user (equals `fingerprint` unless `keyChanged`). */
  pinnedFingerprint: string;
  /** The pinned key was confirmed out of band; false means trust on first use ("unverified"). */
  verified: boolean;
  /** The server reports a key other than the pinned one. Sharing and rotation refuse until
   * `acceptMemberKey` is called after comparing the new fingerprint out of band. */
  keyChanged: boolean;
}

export interface ItemDto {
  id: string;
  vaultId: string;
  seq: number;
  keyVersion: number;
  /** Server time of the last write. */
  updatedAt: string;
  updatedBy: string;
  payload: ItemPayload;
}

/** An item the client holds but cannot decrypt or parse (reported, never fatal). */
export interface UnreadableItemDto {
  id: string;
  vaultId: string;
  seq: number;
  keyVersion: number;
  error: string;
}

export interface VaultItemsDto {
  vaultId: string;
  items: ItemDto[];
  unreadable: UnreadableItemDto[];
}

/**
 * A payload as callers write it: `updated_at` is set by the client at write time and
 * `schema` defaults to 1.
 */
export type ItemDraft = ItemPayloadInput extends infer T
  ? T extends unknown
    ? Omit<T, 'updated_at' | 'schema'> & { schema?: 1 }
    : never
  : never;

/**
 * Outcome of one write under the protocol's conflict rule (section 6). `saved`: the server
 * has the local change. `dropped`: the server had a newer version, which is kept; `item` is
 * that version, or null when it is a tombstone (or the delete went through).
 */
export interface WriteResultDto {
  id: string;
  status: 'saved' | 'dropped';
  item: ItemDto | null;
}

export type BatchOpInput =
  { op: 'put'; id?: string; payload: ItemDraft } | { op: 'delete'; id: string };

export interface BatchFailureDto {
  id: string;
  code: string;
  message: string;
}

export interface BatchResultDto {
  results: WriteResultDto[];
  failed: BatchFailureDto[];
}

export interface RemoveMemberResultDto {
  /** True when the vault key was rotated after the removal (owner removing someone else). */
  rotated: boolean;
  /** Set when the removal succeeded but the automatic rotation did not. */
  rotationError: ErrorDto | null;
}

export interface LogoutResultDto {
  /** False when the server could not be reached or the token was already gone. */
  serverRevoked: boolean;
}

/** Details of `member_key_changed`: the pinned key and the one the server reports now. */
export interface KeyChangeDto {
  userId: string;
  email: string;
  pinnedFingerprint: string;
  serverFingerprint: string;
}

/** Every error the client throws carries a `code`; this is its IPC-safe form. */
export interface ErrorDto {
  name: string;
  code: string;
  message: string;
  status?: number;
  /** Set for `member_key_changed`. */
  keyChange?: KeyChangeDto;
  /** Set for `unexpected_redirect` when the server said where it redirects to. */
  location?: string;
}

// Secrets in item payloads

/**
 * Item fields that hold secrets. List DTOs never carry them; the renderer reads them one item
 * at a time through `items.reveal`, for an open editor.
 */
export type SecretField = 'password' | 'passphrase' | 'private_key';

/** Which secret fields each item type has. */
export const SECRET_FIELDS: Readonly<Record<ItemPayload['type'], readonly SecretField[]>> = {
  group: [],
  host: ['password'],
  identity: ['password'],
  ssh_key: ['private_key', 'passphrase'],
  snippet: [],
  port_forward: [],
  known_host: [],
};

/**
 * A payload without its secret fields; `has_<field>` says whether the stored item has a
 * non-empty value there (`has_password`, `has_passphrase`, `has_private_key`).
 */
export type ListedPayload = ItemPayload extends infer T
  ? T extends unknown
    ? Omit<T, SecretField> & { [K in Extract<keyof T, SecretField> as `has_${K}`]: boolean }
    : never
  : never;

/** An item as lists show it: `payload` is redacted. */
export interface ListedItemDto extends Omit<ItemDto, 'payload'> {
  payload: ListedPayload;
}

export interface ListedVaultItemsDto {
  vaultId: string;
  items: ListedItemDto[];
  unreadable: UnreadableItemDto[];
}

/** `WriteResultDto` with the redacted item. */
export interface ListedWriteResultDto {
  id: string;
  status: 'saved' | 'dropped';
  item: ListedItemDto | null;
}

/** The secret fields of one item that have a value (`items.reveal`). */
export type ItemSecretsDto = Partial<Record<SecretField, string>>;

/**
 * An item draft as the renderer sends it to `items.put`. Secret fields are tri-state:
 * absent keeps the value stored in the item being updated (nothing for a new item, or when
 * the stored item has another type), a non-empty string sets it, and `null` or `''` clears
 * it. Clearing a required field (`ssh_key.private_key`) is refused.
 */
export type ItemDraftInput = ItemDraft extends infer T
  ? T extends unknown
    ? Omit<T, SecretField> & { [K in Extract<keyof T, SecretField>]?: string | null }
    : never
  : never;

// Key generation

/** Sizes `keys.generate` accepts (RSA bits, ECDSA curve size). */
export const RSA_KEY_BITS = [2048, 3072, 4096] as const;
export const ECDSA_KEY_BITS = [256, 384, 521] as const;

/** Which key `keys.generate` makes: Ed25519 by default, RSA of 4096 bits, ECDSA P-256. */
export type KeySpecInput =
  | { type?: 'ed25519' }
  | { type: 'rsa'; bits?: (typeof RSA_KEY_BITS)[number] }
  | { type: 'ecdsa'; bits?: (typeof ECDSA_KEY_BITS)[number] };

export type GenerateKeyInput = {
  vaultId: string;
  /** The key's name in the vault. */
  label: string;
  /** Written into the key and its public line; defaults to the label. */
  comment?: string;
  /** Encrypts the private key. */
  passphrase?: string;
} & KeySpecInput;

/**
 * A key main generated and saved: the redacted item, plus its public half. The private key and
 * the passphrase stay in main (`items.reveal` is the only way to read them).
 */
export interface GeneratedKeyDto {
  item: ListedItemDto;
  /** SSH name of the algorithm, for example `ssh-ed25519`. */
  keyType: string;
  /** The `authorized_keys` line. */
  publicKey: string;
  /** `SHA256:...`, as `ssh-keygen -l` prints it. */
  fingerprint: string;
}
