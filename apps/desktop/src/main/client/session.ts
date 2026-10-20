import { z } from 'zod';
import {
  accountKeysSchema,
  liveItemSchema,
  seqSchema,
  userSchema,
  uuidSchema,
  vaultSchema,
  wrappedKeySchema,
} from '@ternix/core/protocol';

/**
 * What the client persists. The session goes to the `SecretStore`; the rest is the
 * per-account `CacheStore`, which holds only ciphertext, wrapped keys and cursors.
 */

export const SESSION_KEY = 'session';

export const storedSessionSchema = z.object({
  serverUrl: z.string().min(1),
  email: z.string().min(1),
  /** Null once the server revoked the session or it expired: log in again. */
  token: z.string().min(1).nullable(),
  deviceId: uuidSchema,
  user: userSchema,
  /** Everything needed to unlock offline. */
  keys: accountKeysSchema,
});
export type StoredSession = z.infer<typeof storedSessionSchema>;

export const VAULTS_CACHE_KEY = 'vaults';
export const itemsCacheKey = (vaultId: string): string => `items-${vaultId}`;
export const isItemsCacheKey = (key: string): boolean => key.startsWith('items-');

export const cachedVaultSchema = z.object({
  /** The vault as last listed by the server. */
  vault: vaultSchema,
  /** The caller's wrapped key per `key_version` still needed to read cached items. */
  wrapped_keys: z.record(z.string().regex(/^\d+$/), wrappedKeySchema),
});
export type CachedVault = z.infer<typeof cachedVaultSchema>;

export const vaultsCacheSchema = z.object({
  version: z.literal(1),
  vaults: z.array(cachedVaultSchema),
});

export const itemsCacheSchema = z.object({
  version: z.literal(1),
  /** Highest `seq` pulled for the vault. */
  since: seqSchema,
  items: z.array(liveItemSchema),
});

/** Cache namespace of one account on one server. */
export const accountKey = (serverUrl: string, userId: string): string => `${serverUrl}\n${userId}`;
