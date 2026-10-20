import type { z } from 'zod';
import { ApiError, badRequest, forbidden, notFound } from './errors.js';
import { PAYLOAD_TOO_LARGE_ISSUE, uuidSchema, type VaultRole } from '@ternix/core/protocol';
import type { Store, VaultRow } from './store.js';

/**
 * Parse with a core schema; the error message names fields but never echoes values. An
 * over-long item ciphertext is `413 payload_too_large`, any other failure `400`.
 */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const tooLarge = result.error.issues.some(
    (i) => i.code === 'custom' && i.params?.code === PAYLOAD_TOO_LARGE_ISSUE,
  );
  if (tooLarge) {
    throw new ApiError('payload_too_large', 'An item ciphertext exceeds the size limit');
  }
  const issues = result.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`.slice(0, 160));
  throw badRequest(`Invalid request: ${issues.join('; ')}`);
}

/** A path parameter that must be a UUID; anything else is a 404 so IDs cannot be probed. */
export function uuidParam(value: unknown, what = 'Resource'): string {
  const result = uuidSchema.safeParse(value);
  if (!result.success) throw notFound(`${what} not found`);
  return result.data;
}

const RANK: Record<VaultRole, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * Load a vault for a user with at least `min` role. Non-members get 404 so the vault's
 * existence is not leaked; members below `min` get 403.
 */
export function requireVault(
  store: Store,
  userId: string,
  rawVaultId: unknown,
  min: VaultRole,
): { vault: VaultRow; role: VaultRole } {
  const id = uuidParam(rawVaultId, 'Vault');
  const vault = store.getVault(id);
  const membership = vault && store.membership(id, userId);
  if (!vault || !membership) throw notFound('Vault not found');
  if (RANK[membership.role] < RANK[min]) throw forbidden(`This action requires the ${min} role`);
  return { vault, role: membership.role };
}

export { ApiError };
