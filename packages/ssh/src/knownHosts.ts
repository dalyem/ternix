import { createHash } from 'node:crypto';
import type { ServerHostKeyAlgorithm } from 'ssh2';
import type { ItemPayload, ItemPayloadInput, KnownHostPayload } from '@ternix/core/items';

export type HostKeyStatus = 'trusted' | 'unknown' | 'mismatch';

export type HostKeyCheck =
  | { status: 'trusted' }
  | { status: 'unknown' }
  /** The host presents a different key of a type already stored for it. */
  | { status: 'mismatch'; stored: KnownHostPayload };

/** Algorithm names ssh2 offers for host keys, strongest first. */
const HOST_KEY_ALGORITHMS: readonly ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
];

function toBuffer(key: Uint8Array | string): Buffer {
  return typeof key === 'string' ? Buffer.from(key, 'base64') : Buffer.from(key);
}

/** The key type string at the start of an SSH wire-format public key, e.g. `ssh-ed25519`. */
export function parseKeyType(key: Uint8Array | string): string | undefined {
  const buf = toBuffer(key);
  if (buf.length < 4) return undefined;
  const length = buf.readUInt32BE(0);
  if (length === 0 || length > 64 || buf.length < 4 + length) return undefined;
  const type = buf.subarray(4, 4 + length).toString('latin1');
  return /^[\x21-\x7e]+$/.test(type) ? type : undefined;
}

/** OpenSSH-style fingerprint of a wire-format key: `SHA256:` + unpadded base64 digest. */
export function fingerprintSha256(key: Uint8Array | string): string {
  const digest = createHash('sha256').update(toBuffer(key)).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

export function knownHostItems(items: Iterable<ItemPayload>): KnownHostPayload[] {
  const out: KnownHostPayload[] = [];
  for (const item of items) if (item.type === 'known_host') out.push(item);
  return out;
}

function sameHost(entry: KnownHostPayload, host: string, port: number): boolean {
  return entry.port === port && entry.host.toLowerCase() === host.toLowerCase();
}

/**
 * Compare the key a server presented with the stored keys for `host:port` (host is matched
 * case-insensitively, the port exactly). Only stored keys of the same type are compared: a
 * server that offers a type we have never stored is `unknown`, and a different key of a stored
 * type is a `mismatch`.
 */
export function checkHostKey(
  entries: readonly KnownHostPayload[],
  host: string,
  port: number,
  keyType: string,
  keyB64: string,
): HostKeyCheck {
  let mismatch: KnownHostPayload | undefined;
  for (const entry of entries) {
    if (!sameHost(entry, host, port) || entry.key_type !== keyType) continue;
    if (entry.public_key === keyB64) return { status: 'trusted' };
    mismatch ??= entry;
  }
  return mismatch ? { status: 'mismatch', stored: mismatch } : { status: 'unknown' };
}

/**
 * Host-key algorithm order for ssh2 that puts the types already stored for `host:port` first,
 * so a known server is not asked to negotiate a key type we have never seen. Returns undefined
 * when nothing is stored (use ssh2's defaults).
 */
export function preferredHostKeyAlgorithms(
  entries: readonly KnownHostPayload[],
  host: string,
  port: number,
): ServerHostKeyAlgorithm[] | undefined {
  const stored = new Set(entries.filter((e) => sameHost(e, host, port)).map((e) => e.key_type));
  if (stored.size === 0) return undefined;
  // An RSA key can be proven with any of the three RSA signature algorithms.
  const wire = (algo: string) => (algo.startsWith('rsa-sha2-') ? 'ssh-rsa' : algo);
  const first = HOST_KEY_ALGORITHMS.filter((a) => stored.has(wire(a)));
  return [...first, ...HOST_KEY_ALGORITHMS.filter((a) => !first.includes(a))];
}

export interface NewKnownHost {
  host: string;
  port: number;
  keyType: string;
  /** Wire-format key, standard base64. */
  keyB64: string;
  /** Defaults to now. */
  updatedAt?: Date;
}

/** The `known_host` item to save once the user trusts a key. */
export function knownHostPayload(
  entry: NewKnownHost,
): Extract<ItemPayloadInput, { type: 'known_host' }> {
  return {
    type: 'known_host',
    schema: 1,
    updated_at: (entry.updatedAt ?? new Date()).toISOString(),
    host: entry.host.toLowerCase(),
    port: entry.port,
    key_type: entry.keyType,
    public_key: entry.keyB64,
  };
}
