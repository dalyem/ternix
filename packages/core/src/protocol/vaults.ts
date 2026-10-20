import { z } from 'zod';
import { apiErrorSchema } from './errors.js';
import {
  envelopeSchema,
  keyVersionSchema,
  publicKeySchema,
  seqSchema,
  timestampSchema,
  uuidSchema,
  vaultKindSchema,
  vaultRoleSchema,
  wrappedKeySchema,
} from './common.js';

// Vaults (docs/protocol.md section 5)

/** `wrapped_key` is the caller's own wrapped key for the current `key_version`. */
export const vaultSchema = z.object({
  id: uuidSchema,
  kind: vaultKindSchema,
  name_enc: envelopeSchema,
  key_version: keyVersionSchema,
  role: vaultRoleSchema,
  wrapped_key: wrappedKeySchema,
  /** Highest item sequence number in the vault. */
  seq: seqSchema,
  member_count: z.number().int().min(1),
});
export type Vault = z.infer<typeof vaultSchema>;

export const listVaultsResponseSchema = z.object({ vaults: z.array(vaultSchema) });
export type ListVaultsResponse = z.infer<typeof listVaultsResponseSchema>;

/** POST /api/v1/vaults: creates a `shared` vault, caller is owner, `key_version: 1`. */
export const createVaultRequestSchema = z.object({
  id: uuidSchema,
  name_enc: envelopeSchema,
  wrapped_key: wrappedKeySchema,
});
export type CreateVaultRequest = z.infer<typeof createVaultRequestSchema>;

/** PATCH /api/v1/vaults/:id (owner). */
export const updateVaultRequestSchema = z.object({ name_enc: envelopeSchema });
export type UpdateVaultRequest = z.infer<typeof updateVaultRequestSchema>;

// Members

export const memberSchema = z.object({
  user_id: uuidSchema,
  email: z.string(),
  name: z.string(),
  public_key: publicKeySchema,
  role: vaultRoleSchema,
  added_at: timestampSchema,
});
export type Member = z.infer<typeof memberSchema>;

export const listMembersResponseSchema = z.object({ members: z.array(memberSchema) });
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;

/** POST /api/v1/vaults/:id/members (owner). Wrong `key_version` is `409 key_version_mismatch`. */
export const addMemberRequestSchema = z.object({
  user_id: uuidSchema,
  role: vaultRoleSchema,
  wrapped_key: wrappedKeySchema,
  key_version: keyVersionSchema,
});
export type AddMemberRequest = z.infer<typeof addMemberRequestSchema>;

/** PATCH /api/v1/vaults/:id/members/:user_id (owner). */
export const updateMemberRequestSchema = z.object({ role: vaultRoleSchema });
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;

// Key rotation

/** POST /api/v1/vaults/:id/rotate (owner). Sets must match the server's exactly. */
export const rotateRequestSchema = z.object({
  /** Current `key_version` plus one (so at least 2). */
  key_version: keyVersionSchema.min(2),
  name_enc: envelopeSchema,
  members: z.array(z.object({ user_id: uuidSchema, wrapped_key: wrappedKeySchema })),
  items: z.array(z.object({ id: uuidSchema, ciphertext: envelopeSchema })),
});
export type RotateRequest = z.infer<typeof rotateRequestSchema>;

/**
 * `409 conflict` from rotate when the member or item sets differ: carries the IDs the
 * server expected so the client can refresh and retry.
 */
export const rotateConflictResponseSchema = z.object({
  error: apiErrorSchema,
  expected: z.object({
    user_ids: z.array(uuidSchema),
    item_ids: z.array(uuidSchema),
  }),
});
export type RotateConflictResponse = z.infer<typeof rotateConflictResponseSchema>;
