import { createHash, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanComment,
  describePrivateKey,
  fingerprintOfPublicKey,
  generateSshKey,
  samePublicKey,
  SshError,
} from '../src/index.js';
import type { KeySpec } from '../src/index.js';

const { utils } = ssh2;

/** Few bcrypt rounds keep the passphrase tests fast; the default (16) is OpenSSH's. */
const ROUNDS = 4;

function parsed(text: string, passphrase?: string) {
  const key = utils.parseKey(text, passphrase);
  if (key instanceof Error) throw key;
  const first = Array.isArray(key) ? key[0] : key;
  if (!first) throw new Error('no key');
  return first;
}

/** A private key signs, and the public line it came with verifies: the two are one pair. */
function assertPair(privateKey: string, publicLine: string, passphrase?: string) {
  const data = Buffer.from('some data to sign');
  const signature = parsed(privateKey, passphrase).sign(data);
  if (signature instanceof Error) throw signature;
  expect(parsed(publicLine).verify(data, signature)).toBe(true);
}

/** `ssh-keygen -l` style, computed here rather than by the code under test. */
function sha256Of(publicLine: string): string {
  const wire = Buffer.from(publicLine.split(' ')[1]!, 'base64');
  return `SHA256:${createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;
}

const SPECS: { spec: KeySpec; keyType: string; wireBytes: number }[] = [
  { spec: { type: 'ed25519' }, keyType: 'ssh-ed25519', wireBytes: 51 },
  { spec: { type: 'rsa', bits: 2048 }, keyType: 'ssh-rsa', wireBytes: 279 },
  { spec: { type: 'rsa', bits: 3072 }, keyType: 'ssh-rsa', wireBytes: 407 },
  { spec: { type: 'rsa', bits: 4096 }, keyType: 'ssh-rsa', wireBytes: 535 },
  { spec: { type: 'ecdsa', bits: 256 }, keyType: 'ecdsa-sha2-nistp256', wireBytes: 104 },
  { spec: { type: 'ecdsa', bits: 384 }, keyType: 'ecdsa-sha2-nistp384', wireBytes: 136 },
  { spec: { type: 'ecdsa', bits: 521 }, keyType: 'ecdsa-sha2-nistp521', wireBytes: 172 },
];

afterEach(() => vi.restoreAllMocks());

type Pair = { private: string; public: string };

/** What `utils.generateKeyPair` calls back with instead of drawing a key. */
const answers = (outcome: Pair | Error) =>
  ((_type: string, _options: unknown, done: (err: Error | null, pair?: Pair) => void) =>
    outcome instanceof Error ? done(outcome) : done(null, outcome)) as never;

describe('generateSshKey', () => {
  it.each(SPECS)(
    '$keyType $spec.bits: the key parses back and its public line is its own',
    async ({ spec, keyType, wireBytes }) => {
      const key = await generateSshKey({ spec, comment: 'laptop' });
      expect(key.keyType).toBe(keyType);
      expect(key.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
      expect(key.publicKey).toMatch(new RegExp(`^${keyType} [A-Za-z0-9+/=]+ laptop$`));
      expect(parsed(key.publicKey).getPublicSSH()).toHaveLength(wireBytes);
      expect(describePrivateKey(key.privateKey)).toEqual({
        keyType,
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
      });
      expect(key.fingerprint).toBe(sha256Of(key.publicKey));
      assertPair(key.privateKey, key.publicKey);
    },
    60_000,
  );

  it('defaults to Ed25519, then to 4096-bit RSA and P-256', async () => {
    expect((await generateSshKey()).keyType).toBe('ssh-ed25519');
    const rsa = await generateSshKey({ spec: { type: 'rsa' } });
    expect(parsed(rsa.publicKey).getPublicSSH()).toHaveLength(535);
    expect((await generateSshKey({ spec: { type: 'ecdsa' } })).keyType).toBe('ecdsa-sha2-nistp256');
  }, 60_000);

  it('makes a different key every time', async () => {
    const [a, b] = await Promise.all([generateSshKey(), generateSshKey()]);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it('writes the comment into the key and the line, on one line', async () => {
    const key = await generateSshKey({ comment: '  work\n laptop\t2026  ' });
    expect(key.publicKey.endsWith(' work laptop 2026')).toBe(true);
    expect(key.publicKey.split('\n')).toHaveLength(1);
    expect(parsed(key.privateKey).comment).toBe('work laptop 2026');
    const bare = await generateSshKey({ comment: '   ' });
    expect(bare.publicKey.split(' ')).toHaveLength(2);
  });

  it.each(SPECS.filter((s) => s.spec.type !== 'rsa' || s.spec.bits === 2048))(
    '$keyType: a passphrase encrypts the private key',
    async ({ spec, keyType }) => {
      const key = await generateSshKey({ spec, passphrase: 'correct horse', rounds: ROUNDS });
      expect(key.privateKey).not.toContain('correct horse');
      expect(utils.parseKey(key.privateKey)).toBeInstanceOf(Error);
      expect(utils.parseKey(key.privateKey, 'wrong horse')).toBeInstanceOf(Error);
      assertPair(key.privateKey, key.publicKey, 'correct horse');
      expect(describePrivateKey(key.privateKey, 'correct horse').keyType).toBe(keyType);
      expect(() => describePrivateKey(key.privateKey)).toThrow(
        expect.objectContaining({ code: 'passphrase_required' }),
      );
      expect(() => describePrivateKey(key.privateKey, 'wrong horse')).toThrow(
        expect.objectContaining({ code: 'bad_passphrase' }),
      );
    },
    30_000,
  );

  it('treats an empty passphrase as none', async () => {
    const key = await generateSshKey({ passphrase: '' });
    assertPair(key.privateKey, key.publicKey);
  });

  describe('ssh2 quirk: an ed25519 key whose public half starts with a zero byte', () => {
    /** ssh2 strips every leading zero of the public key, so about 1 in 256 keys cannot be read. */
    function brokenPair() {
      for (let i = 0; i < 50_000; i++) {
        const pair = utils.generateKeyPairSync('ed25519');
        if (utils.parseKey(pair.private) instanceof Error) return pair;
      }
      throw new Error('ssh2 did not produce an unreadable key in 50000 tries');
    }

    it('is drawn again, never returned', async () => {
      const broken = brokenPair();
      const draw = vi.spyOn(utils, 'generateKeyPair').mockImplementationOnce(answers(broken));
      const key = await generateSshKey();
      expect(draw).toHaveBeenCalledTimes(2);
      expect(key.privateKey).not.toBe(broken.private);
      assertPair(key.privateKey, key.publicKey);
    });

    it('is drawn again for an encrypted key too', async () => {
      const broken = brokenPair();
      const encrypted = utils.generateKeyPairSync('ed25519', {
        passphrase: 'pw',
        cipher: 'aes256-ctr',
        rounds: ROUNDS,
      });
      vi.spyOn(utils, 'generateKeyPair').mockImplementationOnce(
        answers({ private: broken.private, public: encrypted.public }),
      );
      const key = await generateSshKey({ passphrase: 'pw', rounds: ROUNDS });
      assertPair(key.privateKey, key.publicKey, 'pw');
    });

    it('gives up with invalid_key when no draw reads back', async () => {
      const broken = brokenPair();
      const draw = vi.spyOn(utils, 'generateKeyPair').mockImplementation(answers(broken));
      await expect(generateSshKey()).rejects.toMatchObject({
        name: 'SshError',
        code: 'invalid_key',
      });
      expect(draw.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('refuses a pair whose public half belongs to another key', async () => {
    const a = utils.generateKeyPairSync('ed25519');
    const b = utils.generateKeyPairSync('ed25519');
    vi.spyOn(utils, 'generateKeyPair').mockImplementation(
      answers({ private: a.private, public: b.public }),
    );
    await expect(generateSshKey()).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('refuses a key of another type than asked for', async () => {
    const other = utils.generateKeyPairSync('ecdsa', { bits: 256 });
    vi.spyOn(utils, 'generateKeyPair').mockImplementation(answers(other));
    await expect(generateSshKey({ spec: { type: 'ed25519' } })).rejects.toMatchObject({
      code: 'invalid_key',
    });
  });

  it('passes a generator error on', async () => {
    vi.spyOn(utils, 'generateKeyPair').mockImplementation(answers(new Error('entropy')));
    await expect(generateSshKey()).rejects.toThrow('entropy');
  });
});

describe('describePrivateKey', () => {
  it('reads the comment stored in an OpenSSH key', () => {
    const pair = utils.generateKeyPairSync('ed25519', { comment: 'me@box' });
    expect(describePrivateKey(pair.private).publicKey).toBe(pair.public.trim());
  });

  it('reads a key without a comment', () => {
    const pair = utils.generateKeyPairSync('ecdsa', { bits: 256 });
    expect(describePrivateKey(pair.private).publicKey).toBe(pair.public.trim());
  });

  it('reads a traditional PEM RSA key', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const info = describePrivateKey(privateKey);
    expect(info.keyType).toBe('ssh-rsa');
    expect(info.fingerprint).toBe(sha256Of(info.publicKey));
    assertPair(privateKey, info.publicKey);
  });

  it('refuses what is not a usable private key', () => {
    const pair = utils.generateKeyPairSync('ed25519');
    for (const text of [
      '',
      'nonsense',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
    ]) {
      expect(() => describePrivateKey(text)).toThrow(
        expect.objectContaining({ name: 'SshError', code: 'invalid_key' }),
      );
    }
    // A public key is not a private key.
    expect(() => describePrivateKey(pair.public)).toThrow(SshError);
  });
});

describe('public key lines', () => {
  const a = utils.generateKeyPairSync('ed25519', { comment: 'one' });
  const b = utils.generateKeyPairSync('ed25519', { comment: 'two' });

  it('compares keys, not comments', () => {
    const wire = a.public.trim().split(' ').slice(0, 2).join(' ');
    expect(samePublicKey(a.public, `${wire} another comment`)).toBe(true);
    expect(samePublicKey(a.public, b.public)).toBe(false);
    expect(samePublicKey(a.public, 'garbage')).toBe(false);
    expect(samePublicKey('garbage', 'garbage')).toBe(false);
  });

  it('fingerprints a line the way ssh-keygen does', () => {
    expect(fingerprintOfPublicKey(a.public)).toBe(sha256Of(a.public));
    expect(fingerprintOfPublicKey('not a key')).toBeUndefined();
    expect(fingerprintOfPublicKey('')).toBeUndefined();
  });

  it('cleans comments', () => {
    expect(cleanComment(undefined)).toBe('');
    expect(cleanComment(' a\r\nb\u0000c​d ')).toBe('a b c d');
    expect(cleanComment('x'.repeat(500))).toHaveLength(200);
  });
});
