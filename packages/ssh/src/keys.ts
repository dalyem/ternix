import ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2';
import { SshError } from './errors.js';
import { fingerprintSha256 } from './knownHosts.js';

const { utils } = ssh2;

export const RSA_BITS = [2048, 3072, 4096] as const;
export const ECDSA_BITS = [256, 384, 521] as const;

/** Which key to generate. Ed25519 is the default; RSA defaults to 4096 bits, ECDSA to P-256. */
export type KeySpec =
  | { type: 'ed25519' }
  | { type: 'rsa'; bits?: (typeof RSA_BITS)[number] }
  | { type: 'ecdsa'; bits?: (typeof ECDSA_BITS)[number] };

export interface GenerateKeyOptions {
  spec?: KeySpec;
  /** Written into the private key and the public line. Whitespace is collapsed. */
  comment?: string;
  /** Encrypts the private key (aes256-ctr with bcrypt_pbkdf, as `ssh-keygen` does). */
  passphrase?: string;
  /** bcrypt_pbkdf rounds for a passphrase; the default is OpenSSH's 16. Tests lower it. */
  rounds?: number;
}

/** What can be told about a private key without keeping it. */
export interface KeyInfo {
  /** SSH name of the algorithm: `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`, ... */
  keyType: string;
  /** The `authorized_keys` line: type, base64 wire key and the comment, if any. */
  publicKey: string;
  /** `SHA256:...` of the wire key, as `ssh-keygen -l` prints it. */
  fingerprint: string;
}

export interface GeneratedKey extends KeyInfo {
  /** OpenSSH PEM, encrypted when a passphrase was given. */
  privateKey: string;
}

const COMMENT_MAX = 200;
const DEFAULT_ROUNDS = 16;
const CIPHER = 'aes256-ctr';
/**
 * ssh2's generator now and then emits an ed25519 key its own parser rejects: it strips every
 * leading zero byte from the public key, so a public key that really starts with 0x00 (1 in
 * 256) comes out one byte short. Generation draws again until the key reads back; this many
 * failures in a row (p = 256^-N for that bug) means something else is wrong.
 */
const MAX_ATTEMPTS = 16;

/** A comment fit for one `authorized_keys` line: no control characters or line breaks. */
export function cleanComment(comment: string | undefined): string {
  return (comment ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ')
    .trim()
    .slice(0, COMMENT_MAX)
    .trim();
}

function publicLine(key: ParsedKey, comment: string): string {
  const wire = key.getPublicSSH().toString('base64');
  return `${key.type} ${wire}${comment ? ` ${comment}` : ''}`;
}

function parseOne(privateKey: string, passphrase: string | undefined): ParsedKey {
  const parsed = utils.parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error) {
    const text = parsed.message.toLowerCase();
    if (text.includes('no passphrase given')) {
      throw new SshError('passphrase_required', 'The key is encrypted and needs a passphrase', {
        cause: parsed,
      });
    }
    if (text.includes('passphrase')) {
      throw new SshError('bad_passphrase', 'Wrong passphrase for the key', { cause: parsed });
    }
    throw new SshError('invalid_key', `The key cannot be read: ${parsed.message}`, {
      cause: parsed,
    });
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || !first.isPrivateKey()) {
    throw new SshError('invalid_key', 'That is not a private key');
  }
  return first;
}

/**
 * Public half of a private key (OpenSSH or PEM, decrypted with `passphrase` when encrypted).
 * The comment is the one stored in the key, if there is one. Throws `SshError`
 * (`invalid_key`, `passphrase_required`, `bad_passphrase`).
 */
export function describePrivateKey(privateKey: string, passphrase?: string): KeyInfo {
  const key = parseOne(privateKey, passphrase);
  return {
    keyType: key.type,
    publicKey: publicLine(key, cleanComment(key.comment)),
    fingerprint: fingerprintSha256(key.getPublicSSH()),
  };
}

/** Whether two public key lines name the same key (the comments may differ). */
export function samePublicKey(a: string, b: string): boolean {
  const parse = (line: string) => {
    const key = utils.parseKey(line.trim());
    return key instanceof Error ? undefined : (Array.isArray(key) ? key[0] : key)?.getPublicSSH();
  };
  const left = parse(a);
  const right = parse(b);
  return left !== undefined && right !== undefined && left.equals(right);
}

/** SHA256 fingerprint of an `authorized_keys` line; undefined when it is not a public key. */
export function fingerprintOfPublicKey(line: string): string | undefined {
  const key = utils.parseKey(line.trim());
  const first = key instanceof Error ? undefined : Array.isArray(key) ? key[0] : key;
  return first ? fingerprintSha256(first.getPublicSSH()) : undefined;
}

function expectedType(spec: KeySpec): string {
  switch (spec.type) {
    case 'ed25519':
      return 'ssh-ed25519';
    case 'rsa':
      return 'ssh-rsa';
    case 'ecdsa':
      return `ecdsa-sha2-nistp${spec.bits ?? 256}`;
  }
}

function drawPair(
  spec: KeySpec,
  comment: string,
  passphrase: string | undefined,
  rounds: number,
): Promise<{ private: string; public: string }> {
  const encryption = passphrase ? { passphrase, cipher: CIPHER, rounds } : {};
  const options = { ...(comment ? { comment } : {}), ...encryption };
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, pair?: { private: string; public: string }) =>
      err || !pair ? reject(err ?? new Error('no key pair')) : resolve(pair);
    switch (spec.type) {
      case 'ed25519':
        return utils.generateKeyPair('ed25519', options, done);
      case 'rsa':
        return utils.generateKeyPair('rsa', { bits: spec.bits ?? 4096, ...options }, done);
      case 'ecdsa':
        return utils.generateKeyPair('ecdsa', { bits: spec.bits ?? 256, ...options }, done);
    }
  });
}

/**
 * Never hand out a key we cannot read back: the private key must parse (with the passphrase),
 * be of the requested type, and sign something the public half verifies.
 */
function readBack(
  pair: { private: string; public: string },
  spec: KeySpec,
  comment: string,
  passphrase: string | undefined,
): GeneratedKey {
  const key = parseOne(pair.private, passphrase);
  if (key.type !== expectedType(spec)) {
    throw new SshError(
      'invalid_key',
      `Generated a ${key.type} key, expected ${expectedType(spec)}`,
    );
  }
  const probe = Buffer.from('ternix key self-test');
  const signature = key.sign(probe);
  const publicHalf = utils.parseKey(pair.public.trim());
  const verifier = Array.isArray(publicHalf) ? publicHalf[0] : publicHalf;
  if (
    signature instanceof Error ||
    !verifier ||
    verifier instanceof Error ||
    verifier.verify(probe, signature) !== true
  ) {
    throw new SshError('invalid_key', 'The generated key pair does not match');
  }
  const wire = key.getPublicSSH();
  if (!verifier.getPublicSSH().equals(wire)) {
    throw new SshError('invalid_key', 'The generated key pair does not match');
  }
  return {
    privateKey: pair.private,
    keyType: key.type,
    publicKey: publicLine(key, comment),
    fingerprint: fingerprintSha256(wire),
  };
}

/**
 * Generates a key pair, off the event loop for the key search itself (RSA 4096 takes seconds).
 * Throws `SshError` `invalid_key` when no attempt produced a key that reads back.
 */
export async function generateSshKey(options: GenerateKeyOptions = {}): Promise<GeneratedKey> {
  const spec = options.spec ?? { type: 'ed25519' };
  const comment = cleanComment(options.comment);
  const passphrase = options.passphrase || undefined;
  const rounds = options.rounds ?? DEFAULT_ROUNDS;
  let last: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pair = await drawPair(spec, comment, passphrase, rounds);
    try {
      return readBack(pair, spec, comment, passphrase);
    } catch (err) {
      last = err;
    }
  }
  throw new SshError('invalid_key', 'Could not generate a key that reads back; try again', {
    cause: last,
  });
}
