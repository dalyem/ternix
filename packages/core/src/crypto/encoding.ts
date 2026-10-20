import { B64_RE } from '../b64.js';
import { CryptoError, getSodium } from './sodium.js';

/** Standard base64 with padding (the protocol's `b64`). */
export function toB64(bytes: Uint8Array): string {
  const sodium = getSodium();
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export function fromB64(value: string): Uint8Array {
  const sodium = getSodium();
  if (typeof value !== 'string' || !B64_RE.test(value)) {
    throw new CryptoError('invalid base64');
  }
  try {
    return sodium.from_base64(value, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new CryptoError('invalid base64');
  }
}

export function utf8Encode(text: string): Uint8Array {
  return getSodium().from_string(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return getSodium().to_string(bytes);
}
