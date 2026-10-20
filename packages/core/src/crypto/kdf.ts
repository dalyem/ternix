import { type KdfParams, kdfParamsSchema } from '../protocol/auth.js';
import { normalizeEmail } from '../protocol/common.js';
import { fromB64, toB64, utf8Encode } from './encoding.js';
import { CryptoError, getSodium, ready, requireLength } from './sodium.js';

export const KDF_ALG = 'argon2id13';
export const DEFAULT_KDF_OPSLIMIT = 3;
export const DEFAULT_KDF_MEMLIMIT = 67_108_864;
export const KDF_SALT_BYTES = 16;

/** libsodium KDF contexts: exactly 8 bytes each. */
export const KDF_CONTEXT_MASTER = 'tnxmastr';
export const KDF_CONTEXT_AUTH = 'tnxauth_';
const KDF_SUBKEY_ID_MASTER = 1;
const KDF_SUBKEY_ID_AUTH = 2;

export interface KdfLimits {
  opslimit: number;
  memlimit: number;
}

export interface DerivedKeys {
  /** Never leaves the client: decrypts the account private key. */
  masterKey: Uint8Array;
  /** Sent to the server as the login credential. */
  authKey: Uint8Array;
}

/** Fresh KDF parameters with a random 16-byte salt. Limits are overridable (tests only). */
export function newKdfParams(limits: Partial<KdfLimits> = {}): KdfParams {
  const sodium = getSodium();
  return {
    alg: KDF_ALG,
    salt: toB64(sodium.randombytes_buf(KDF_SALT_BYTES)),
    opslimit: limits.opslimit ?? DEFAULT_KDF_OPSLIMIT,
    memlimit: limits.memlimit ?? DEFAULT_KDF_MEMLIMIT,
  };
}

/**
 * Whether `kdf` is at least as strong as the defaults. A client should refuse weaker
 * server-supplied parameters at login (a malicious server could otherwise downgrade).
 */
export function isKdfStrongEnough(kdf: KdfParams): boolean {
  return kdf.opslimit >= DEFAULT_KDF_OPSLIMIT && kdf.memlimit >= DEFAULT_KDF_MEMLIMIT;
}

/**
 * `root = argon2id(NFKC(password), salt)`, then
 * `masterKey = kdf(1, "tnxmastr", root)` and `authKey = kdf(2, "tnxauth_", root)`.
 * Async only because it initialises libsodium itself; the work is synchronous and
 * takes about a second at the default limits.
 */
export async function deriveKeys(password: string, kdf: KdfParams): Promise<DerivedKeys> {
  await ready();
  const sodium = getSodium();
  const params = kdfParamsSchema.parse(kdf);
  if (password.length === 0) throw new CryptoError('password must not be empty');
  const salt = fromB64(params.salt);
  requireLength('salt', salt, KDF_SALT_BYTES);
  const root = sodium.crypto_pwhash(
    32,
    utf8Encode(password.normalize('NFKC')),
    salt,
    params.opslimit,
    params.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return {
      masterKey: sodium.crypto_kdf_derive_from_key(
        32,
        KDF_SUBKEY_ID_MASTER,
        KDF_CONTEXT_MASTER,
        root,
      ),
      authKey: sodium.crypto_kdf_derive_from_key(32, KDF_SUBKEY_ID_AUTH, KDF_CONTEXT_AUTH, root),
    };
  } finally {
    sodium.memzero(root);
  }
}

/**
 * Stable fake salt for unknown emails so prelogin does not reveal whether an account
 * exists: `HMAC-SHA256(server_secret, normalizeEmail(email))[0..16]`.
 * `serverSecret` may be any length (it is the HMAC key).
 */
export function fakeSaltForEmail(serverSecret: Uint8Array | string, email: string): Uint8Array {
  const sodium = getSodium();
  const key = typeof serverSecret === 'string' ? utf8Encode(serverSecret) : serverSecret;
  if (key.length === 0) throw new CryptoError('server secret must not be empty');
  const state = sodium.crypto_auth_hmacsha256_init(key);
  sodium.crypto_auth_hmacsha256_update(state, utf8Encode(normalizeEmail(email)));
  return sodium.crypto_auth_hmacsha256_final(state).slice(0, KDF_SALT_BYTES);
}

/** The prelogin response for an unknown email: fake salt with the default limits. */
export function fakeKdfForEmail(serverSecret: Uint8Array | string, email: string): KdfParams {
  return {
    alg: KDF_ALG,
    salt: toB64(fakeSaltForEmail(serverSecret, email)),
    opslimit: DEFAULT_KDF_OPSLIMIT,
    memlimit: DEFAULT_KDF_MEMLIMIT,
  };
}
