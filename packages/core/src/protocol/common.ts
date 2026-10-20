import { z } from 'zod';
import { B64_RE, b64Pattern } from '../b64.js';
import { MAX_ITEM_CIPHERTEXT_LENGTH, PAYLOAD_TOO_LARGE_ISSUE } from './limits.js';

/** Protocol version reported by `GET /api/v1/server`. */
export const PROTOCOL_VERSION = 1;

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Lowercase UUIDv4. */
export const uuidSchema = z.string().regex(UUID_V4_RE, 'expected a lowercase UUIDv4');

/** ISO 8601 UTC timestamp. */
export const timestampSchema = z.string().datetime();

/** Standard base64 with padding, any length. */
export const b64Schema = z.string().regex(B64_RE, 'expected standard padded base64');

/** Standard base64 with padding encoding exactly `byteLength` bytes. */
export const b64BytesSchema = (byteLength: number) =>
  z.string().regex(b64Pattern(byteLength), `expected base64 of ${byteLength} bytes`);

/** X25519 public key (32 bytes). */
export const publicKeySchema = b64BytesSchema(32);
/** Login credential derived from the password (32 bytes). */
export const authKeySchema = b64BytesSchema(32);
/** `crypto_box_seal` of a 32-byte vault key: 32 + 48 bytes. */
export const wrappedKeySchema = b64BytesSchema(80);

/** Minimum envelope: 24-byte nonce plus 16-byte tag, base64-encoded (56 chars). */
const MIN_ENVELOPE_B64_LENGTH = 56;

/** `seal` output: `v1.` followed by base64(nonce || ciphertext). */
export const envelopeSchema = z
  .string()
  .refine(
    (s) =>
      s.startsWith('v1.') && s.length >= 3 + MIN_ENVELOPE_B64_LENGTH && B64_RE.test(s.slice(3)),
    'expected a v1 envelope (v1.<base64>)',
  );

/** An envelope of at most `MAX_ITEM_CIPHERTEXT_LENGTH` characters; longer is `payload_too_large`. */
export const itemCiphertextSchema = envelopeSchema.refine(
  (s) => s.length <= MAX_ITEM_CIPHERTEXT_LENGTH,
  {
    message: `ciphertext is longer than ${MAX_ITEM_CIPHERTEXT_LENGTH} characters`,
    params: { code: PAYLOAD_TOO_LARGE_ISSUE },
  },
);

/** Lowercased and trimmed, then validated as an email address. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const emailSchema = z
  .string()
  .max(320)
  .transform(normalizeEmail)
  .pipe(z.string().email().max(254));

export const displayNameSchema = z.string().trim().min(1).max(100);

export const vaultRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export type VaultRole = z.infer<typeof vaultRoleSchema>;

export const userRoleSchema = z.enum(['admin', 'user']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const vaultKindSchema = z.enum(['personal', 'shared']);
export type VaultKind = z.infer<typeof vaultKindSchema>;

/** Item sequence numbers and key versions. */
export const seqSchema = z.number().int().min(0);
export const keyVersionSchema = z.number().int().min(1);
