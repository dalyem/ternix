import { fromB64, toB64, utf8Decode, utf8Encode } from './encoding.js';
import { open, seal } from './envelope.js';
import { CryptoError, getSodium, requireLength } from './sodium.js';

export const PUBLIC_KEY_BYTES = 32;
export const PRIVATE_KEY_BYTES = 32;
export const VAULT_KEY_BYTES = 32;

/** AD for the account private key envelope. */
export const AD_ACCOUNT_KEY = 'ternix:account-key:v1';
export const vaultNameAd = (vaultId: string): string => `ternix:vault-name:v1:${vaultId}`;
export const itemAd = (vaultId: string, itemId: string): string =>
  `ternix:item:v1:${vaultId}:${itemId}`;

export interface AccountKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** X25519 keypair (`crypto_box_keypair`). */
export function generateAccountKeypair(): AccountKeypair {
  const { publicKey, privateKey } = getSodium().crypto_box_keypair();
  return { publicKey, privateKey };
}

/** Derive the public key for a private key. */
export function publicKeyFromPrivateKey(privateKey: Uint8Array): Uint8Array {
  requireLength('private key', privateKey, PRIVATE_KEY_BYTES);
  return getSodium().crypto_scalarmult_base(privateKey);
}

/** `encrypted_private_key`: the private key sealed under the master key. */
export function encryptPrivateKey(masterKey: Uint8Array, privateKey: Uint8Array): string {
  requireLength('private key', privateKey, PRIVATE_KEY_BYTES);
  return seal(masterKey, privateKey, AD_ACCOUNT_KEY);
}

export function decryptPrivateKey(masterKey: Uint8Array, encrypted: string): Uint8Array {
  const privateKey = open(masterKey, encrypted, AD_ACCOUNT_KEY);
  if (privateKey.length !== PRIVATE_KEY_BYTES) throw new CryptoError('invalid private key');
  return privateKey;
}

/**
 * `hex(crypto_generichash(16, pk))` grouped as 8 groups of 4 hex characters joined by
 * spaces, for out-of-band verification.
 */
export function fingerprint(publicKey: Uint8Array): string {
  const sodium = getSodium();
  requireLength('public key', publicKey, PUBLIC_KEY_BYTES);
  const hex = sodium.to_hex(sodium.crypto_generichash(16, publicKey, null));
  return hex.match(/.{4}/g)!.join(' ');
}

// Vault keys

/** Random 32-byte XChaCha20-Poly1305 key. */
export function newVaultKey(): Uint8Array {
  return getSodium().crypto_aead_xchacha20poly1305_ietf_keygen();
}

/** `wrapped_key`: `b64(crypto_box_seal(vaultKey, memberPublicKey))`. */
export function wrapVaultKey(vaultKey: Uint8Array, publicKey: Uint8Array): string {
  requireLength('vault key', vaultKey, VAULT_KEY_BYTES);
  requireLength('public key', publicKey, PUBLIC_KEY_BYTES);
  return toB64(getSodium().crypto_box_seal(vaultKey, publicKey));
}

export function unwrapVaultKey(
  wrapped: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Uint8Array {
  requireLength('public key', publicKey, PUBLIC_KEY_BYTES);
  requireLength('private key', privateKey, PRIVATE_KEY_BYTES);
  let vaultKey: Uint8Array;
  try {
    vaultKey = getSodium().crypto_box_seal_open(fromB64(wrapped), publicKey, privateKey);
  } catch {
    throw new CryptoError('unwrapping the vault key failed');
  }
  if (vaultKey.length !== VAULT_KEY_BYTES) throw new CryptoError('invalid vault key');
  return vaultKey;
}

/** `name_enc`: the vault name sealed under the vault key. */
export function encryptVaultName(vaultKey: Uint8Array, vaultId: string, name: string): string {
  return seal(vaultKey, utf8Encode(name), vaultNameAd(vaultId));
}

export function decryptVaultName(vaultKey: Uint8Array, vaultId: string, nameEnc: string): string {
  return utf8Decode(open(vaultKey, nameEnc, vaultNameAd(vaultId)));
}
