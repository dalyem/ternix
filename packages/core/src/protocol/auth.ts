import { z } from 'zod';
import {
  authKeySchema,
  b64BytesSchema,
  displayNameSchema,
  emailSchema,
  envelopeSchema,
  PROTOCOL_VERSION,
  publicKeySchema,
  timestampSchema,
  userRoleSchema,
  uuidSchema,
  wrappedKeySchema,
} from './common.js';

// KDF parameters (docs/protocol.md 2.1)

/** Argon2id parameter bounds accepted on the wire (libsodium minimums, sanity maximums). */
export const KDF_LIMITS = {
  opslimit: { min: 1, max: 32 },
  memlimit: { min: 8192, max: 1024 * 1024 * 1024 },
} as const;

export const kdfParamsSchema = z.object({
  alg: z.literal('argon2id13'),
  salt: b64BytesSchema(16),
  opslimit: z.number().int().min(KDF_LIMITS.opslimit.min).max(KDF_LIMITS.opslimit.max),
  memlimit: z.number().int().min(KDF_LIMITS.memlimit.min).max(KDF_LIMITS.memlimit.max),
});
export type KdfParams = z.infer<typeof kdfParamsSchema>;

// Server info

export const registrationModeSchema = z.enum(['open', 'invite', 'closed']);
export type RegistrationMode = z.infer<typeof registrationModeSchema>;

export const serverInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  registration: registrationModeSchema,
  protocol: z.literal(PROTOCOL_VERSION),
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;

// Shared shapes

export const deviceInfoSchema = z.object({
  name: z.string().trim().min(1).max(200),
  platform: z.string().trim().min(1).max(100),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

export const userSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  public_key: publicKeySchema,
  created_at: timestampSchema,
});
export type User = z.infer<typeof userSchema>;

export const accountKeysSchema = z.object({
  public_key: publicKeySchema,
  encrypted_private_key: envelopeSchema,
  kdf: kdfParamsSchema,
});
export type AccountKeys = z.infer<typeof accountKeysSchema>;

/** Returned by register and login: the session token plus who/what it belongs to. */
const sessionBase = {
  token: z.string().min(1),
  user: userSchema,
  device_id: uuidSchema,
};

// POST /api/v1/auth/prelogin

export const preloginRequestSchema = z.object({ email: emailSchema });
export type PreloginRequest = z.infer<typeof preloginRequestSchema>;
export const preloginResponseSchema = z.object({ kdf: kdfParamsSchema });
export type PreloginResponse = z.infer<typeof preloginResponseSchema>;

// POST /api/v1/auth/register

export const personalVaultInputSchema = z.object({
  id: uuidSchema,
  name_enc: envelopeSchema,
  wrapped_key: wrappedKeySchema,
});
export type PersonalVaultInput = z.infer<typeof personalVaultInputSchema>;

export const registerRequestSchema = z.object({
  email: emailSchema,
  name: displayNameSchema,
  invite_code: z.string().min(1).optional(),
  kdf: kdfParamsSchema,
  auth_key: authKeySchema,
  public_key: publicKeySchema,
  encrypted_private_key: envelopeSchema,
  personal_vault: personalVaultInputSchema,
  device: deviceInfoSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export const registerResponseSchema = z.object(sessionBase);
export type RegisterResponse = z.infer<typeof registerResponseSchema>;

// POST /api/v1/auth/login

export const loginRequestSchema = z.object({
  email: emailSchema,
  auth_key: authKeySchema,
  device: deviceInfoSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export const loginResponseSchema = z.object({ ...sessionBase, keys: accountKeysSchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

// GET /api/v1/me

export const meResponseSchema = z.object({ user: userSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

// POST /api/v1/me/password

export const changePasswordRequestSchema = z.object({
  current_auth_key: authKeySchema,
  new_auth_key: authKeySchema,
  new_kdf: kdfParamsSchema,
  new_encrypted_private_key: envelopeSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

// Devices

export const deviceSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  platform: z.string(),
  created_at: timestampSchema,
  last_seen_at: timestampSchema.nullable(),
  current: z.boolean(),
});
export type Device = z.infer<typeof deviceSchema>;
export const listDevicesResponseSchema = z.object({ devices: z.array(deviceSchema) });
export type ListDevicesResponse = z.infer<typeof listDevicesResponseSchema>;

// GET /api/v1/users/lookup?email=

export const lookupUserQuerySchema = z.object({ email: emailSchema });
export type LookupUserQuery = z.infer<typeof lookupUserQuerySchema>;
export const lookupUserResponseSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  name: z.string(),
  public_key: publicKeySchema,
});
export type LookupUserResponse = z.infer<typeof lookupUserResponseSchema>;

// Admin

export const createInviteRequestSchema = z.object({
  email: emailSchema.optional(),
  expires_in_hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .optional(),
});
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;
export const createInviteResponseSchema = z.object({
  code: z.string().min(1),
  expires_at: timestampSchema,
});
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

export const inviteSchema = z.object({
  code: z.string().min(1),
  email: z.string().nullable(),
  expires_at: timestampSchema,
  created_at: timestampSchema,
  used_at: timestampSchema.nullable(),
});
export type Invite = z.infer<typeof inviteSchema>;
export const listInvitesResponseSchema = z.object({ invites: z.array(inviteSchema) });
export type ListInvitesResponse = z.infer<typeof listInvitesResponseSchema>;

export const listUsersResponseSchema = z.object({ users: z.array(userSchema) });
export type ListUsersResponse = z.infer<typeof listUsersResponseSchema>;
