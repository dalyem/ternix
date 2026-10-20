import { type ItemPayload, type ItemPayloadInput, itemPayloadSchema } from '../items.js';
import { utf8Decode, utf8Encode } from './encoding.js';
import { open, seal } from './envelope.js';
import { itemAd } from './keys.js';
import { CryptoError } from './sodium.js';

/**
 * `ciphertext = seal(vaultKey, utf8(JSON(payload)), "ternix:item:v1:{vault_id}:{item_id}")`.
 * The payload is validated first, so defaults (port 22, tags [], ...) are written out.
 */
export function encryptItem(
  vaultKey: Uint8Array,
  vaultId: string,
  itemId: string,
  payload: ItemPayloadInput,
): string {
  const parsed = itemPayloadSchema.parse(payload);
  return seal(vaultKey, utf8Encode(JSON.stringify(parsed)), itemAd(vaultId, itemId));
}

/**
 * Decrypt and validate an item. Throws `CryptoError` if decryption fails (wrong key,
 * vault, item ID or tampering) or the plaintext is not JSON; throws `ZodError` if the
 * JSON is not a valid payload (for example an item type this client does not know).
 */
export function decryptItem(
  vaultKey: Uint8Array,
  vaultId: string,
  itemId: string,
  ciphertext: string,
): ItemPayload {
  const plaintext = utf8Decode(open(vaultKey, ciphertext, itemAd(vaultId, itemId)));
  let json: unknown;
  try {
    json = JSON.parse(plaintext);
  } catch {
    throw new CryptoError('item plaintext is not valid JSON');
  }
  return itemPayloadSchema.parse(json);
}
