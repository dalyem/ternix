import { B64_RE } from '../b64.js';
import { fromB64, toB64, utf8Encode } from './encoding.js';
import { CryptoError, getSodium, requireLength } from './sodium.js';

export const ENVELOPE_PREFIX = 'v1.';
export const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

/**
 * Encrypt `plaintext` under a 32-byte key, binding it to `ad`:
 * `"v1." + b64(nonce(24) || xchacha20poly1305_ietf(plaintext, ad))`.
 */
export function seal(key: Uint8Array, plaintext: Uint8Array | string, ad: string): string {
  const sodium = getSodium();
  requireLength('key', key, KEY_BYTES);
  const message = typeof plaintext === 'string' ? utf8Encode(plaintext) : plaintext;
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    message,
    utf8Encode(ad),
    null,
    nonce,
    key,
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return ENVELOPE_PREFIX + toB64(out);
}

/**
 * Decrypt an envelope produced by `seal`. Throws `CryptoError` for a missing `v1.`
 * prefix, malformed input, a wrong key, a wrong AD or any tampering.
 */
export function open(key: Uint8Array, envelope: string, ad: string): Uint8Array {
  const sodium = getSodium();
  requireLength('key', key, KEY_BYTES);
  if (typeof envelope !== 'string' || !envelope.startsWith(ENVELOPE_PREFIX)) {
    throw new CryptoError('unsupported envelope version');
  }
  const body = envelope.slice(ENVELOPE_PREFIX.length);
  if (!B64_RE.test(body)) throw new CryptoError('malformed envelope');
  const raw = fromB64(body);
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new CryptoError('malformed envelope');
  const nonce = raw.subarray(0, NONCE_BYTES);
  const ct = raw.subarray(NONCE_BYTES);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, utf8Encode(ad), nonce, key);
  } catch {
    throw new CryptoError('decryption failed');
  }
}
