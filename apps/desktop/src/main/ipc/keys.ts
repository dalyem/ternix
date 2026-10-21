import {
  type GeneratedKey,
  type KeySpec,
  SshError,
  describePrivateKey,
  generateSshKey,
  samePublicKey,
} from '@ternix/ssh';
import type { GenerateKeyInput, ItemDraft, ItemPayload } from '../../shared/types.js';
import { AppError } from '../app/errors.js';

/**
 * Key generation and the public halves of SSH keys. The private key and the passphrase exist
 * here, in main, and nowhere else: the renderer gets the public line and the fingerprint.
 */

function specOf(input: GenerateKeyInput): KeySpec {
  switch (input.type) {
    case 'rsa':
      return { type: 'rsa', ...(input.bits ? { bits: input.bits } : {}) };
    case 'ecdsa':
      return { type: 'ecdsa', ...(input.bits ? { bits: input.bits } : {}) };
    default:
      return { type: 'ed25519' };
  }
}

/** A new key and the `ssh_key` draft that stores it. */
export async function generateKeyDraft(
  input: GenerateKeyInput,
): Promise<{ key: GeneratedKey; draft: ItemDraft }> {
  let key: GeneratedKey;
  try {
    key = await generateSshKey({
      spec: specOf(input),
      comment: input.comment ?? input.label,
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
    });
  } catch (err) {
    if (err instanceof SshError)
      throw new AppError('key_generation_failed', err.message, { cause: err });
    throw err;
  }
  const draft: ItemDraft = {
    type: 'ssh_key',
    label: input.label,
    private_key: key.privateKey,
    ...(input.passphrase ? { passphrase: input.passphrase } : {}),
    public_key: key.publicKey,
  };
  return { key, draft };
}

/**
 * Fills in the public half of an `ssh_key` draft whose private key is readable (decrypted with
 * the draft's passphrase when it has one): a missing `public_key` is derived, and one that
 * belongs to another key (the private key was replaced, the old public line stayed) is
 * replaced. A matching one is kept as typed, comment and all. When the key cannot be read
 * the draft goes through unchanged, as it always did; connecting reports the problem.
 *
 * `stored` is the item being edited: a draft that changes none of the private key, the
 * passphrase and the public key is left alone (decrypting costs time). A changed public key
 * alone is checked like a new one, so it cannot drift from the private key.
 */
export function withPublicKey(draft: ItemDraft, stored: ItemPayload | undefined): ItemDraft {
  if (draft.type !== 'ssh_key') return draft;
  const supplied = draft.public_key?.trim() ?? '';
  const oneLine = !/[\r\n]/.test(supplied);
  const unchanged =
    stored?.type === 'ssh_key' &&
    stored.private_key === draft.private_key &&
    (stored.passphrase ?? '') === (draft.passphrase ?? '') &&
    (stored.public_key?.trim() ?? '') === supplied;
  if (unchanged && supplied !== '') return draft;
  let derived: string;
  try {
    derived = describePrivateKey(draft.private_key, draft.passphrase).publicKey;
  } catch {
    // Unreadable here (encrypted without its passphrase, or not a key): keep what was typed,
    // but never a second line, which would become a second entry in authorized_keys.
    if (oneLine) return draft;
    const { public_key: _dropped, ...rest } = draft;
    return rest;
  }
  if (supplied !== '' && oneLine && samePublicKey(supplied, derived)) {
    return { ...draft, public_key: supplied };
  }
  return { ...draft, public_key: derived };
}
