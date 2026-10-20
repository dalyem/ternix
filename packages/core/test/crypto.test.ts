import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AD_ACCOUNT_KEY,
  CryptoError,
  DEFAULT_KDF_MEMLIMIT,
  DEFAULT_KDF_OPSLIMIT,
  KDF_CONTEXT_AUTH,
  KDF_CONTEXT_MASTER,
  decryptItem,
  decryptPrivateKey,
  decryptVaultName,
  deriveKeys,
  encryptItem,
  encryptPrivateKey,
  encryptVaultName,
  fakeKdfForEmail,
  fakeSaltForEmail,
  fingerprint,
  fromB64,
  generateAccountKeypair,
  isKdfStrongEnough,
  kdfParamsSchema,
  newKdfParams,
  newVaultKey,
  normalizeEmail,
  open,
  publicKeyFromPrivateKey,
  ready,
  seal,
  toB64,
  unwrapVaultKey,
  wrapVaultKey,
  type ItemPayloadInput,
} from '../src/index.js';
import {
  ITEM_ID,
  NOW,
  OTHER_ITEM_ID,
  OTHER_VAULT_ID,
  TEST_KDF_LIMITS,
  VAULT_ID,
  tamper,
  testKdf,
} from './helpers.js';

beforeAll(async () => {
  await ready();
});

describe('base64', () => {
  it('round-trips with standard padded encoding', () => {
    for (const len of [0, 1, 2, 3, 16, 31, 32, 33]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      const encoded = toB64(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(encoded.length % 4).toBe(0);
      expect(fromB64(encoded)).toEqual(bytes);
    }
  });

  it('uses + and / rather than the URL-safe alphabet', () => {
    expect(toB64(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('+/+/');
  });

  it('rejects unpadded, URL-safe and garbage input', () => {
    expect(() => fromB64('AAA')).toThrow(CryptoError);
    expect(() => fromB64('-_-_')).toThrow(CryptoError);
    expect(() => fromB64('not base64!')).toThrow(CryptoError);
  });
});

describe('seal / open', () => {
  const key = () => newVaultKey();

  it('round-trips bytes and strings', () => {
    const k = key();
    expect(open(k, seal(k, new Uint8Array([1, 2, 3]), 'ad'), 'ad')).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(new TextDecoder().decode(open(k, seal(k, 'héllo ✓', 'ad'), 'ad'))).toBe('héllo ✓');
    expect(open(k, seal(k, '', 'ad'), 'ad')).toEqual(new Uint8Array());
  });

  it('produces a v1 envelope with a fresh nonce each time', () => {
    const k = key();
    const a = seal(k, 'same', 'ad');
    const b = seal(k, 'same', 'ad');
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toBe(b);
    // nonce(24) + ciphertext(4) + tag(16)
    expect(fromB64(a.slice(3)).length).toBe(24 + 4 + 16);
  });

  it('rejects a wrong key', () => {
    const envelope = seal(key(), 'secret', 'ad');
    expect(() => open(key(), envelope, 'ad')).toThrow(CryptoError);
  });

  it('rejects a wrong AD', () => {
    const k = key();
    expect(() => open(k, seal(k, 'secret', 'ad-1'), 'ad-2')).toThrow(CryptoError);
  });

  it('rejects tampered ciphertext', () => {
    const k = key();
    const envelope = seal(k, 'secret', 'ad');
    expect(() => open(k, tamper(envelope), 'ad')).toThrow(CryptoError);
  });

  it('rejects a truncated envelope', () => {
    const k = key();
    const envelope = seal(k, 'secret', 'ad');
    const raw = fromB64(envelope.slice(3));
    expect(() => open(k, 'v1.' + toB64(raw.subarray(0, raw.length - 1)), 'ad')).toThrow(
      CryptoError,
    );
    expect(() => open(k, 'v1.' + toB64(raw.subarray(0, 20)), 'ad')).toThrow(CryptoError);
  });

  it('rejects a missing or different version prefix', () => {
    const k = key();
    const envelope = seal(k, 'secret', 'ad');
    expect(() => open(k, envelope.slice(3), 'ad')).toThrow(CryptoError);
    expect(() => open(k, 'v2.' + envelope.slice(3), 'ad')).toThrow(CryptoError);
    expect(() => open(k, 'V1.' + envelope.slice(3), 'ad')).toThrow(CryptoError);
    expect(() => open(k, '', 'ad')).toThrow(CryptoError);
  });

  it('rejects keys of the wrong length', () => {
    expect(() => seal(new Uint8Array(16), 'x', 'ad')).toThrow(CryptoError);
    expect(() => open(new Uint8Array(31), 'v1.AAAA', 'ad')).toThrow(CryptoError);
  });
});

describe('deriveKeys', () => {
  it('uses the specified contexts (8 bytes each)', () => {
    expect(KDF_CONTEXT_MASTER).toBe('tnxmastr');
    expect(KDF_CONTEXT_AUTH).toBe('tnxauth_');
    expect(new TextEncoder().encode(KDF_CONTEXT_MASTER).length).toBe(8);
    expect(new TextEncoder().encode(KDF_CONTEXT_AUTH).length).toBe(8);
  });

  it('is deterministic and splits master from auth', async () => {
    const kdf = testKdf();
    const a = await deriveKeys('correct horse battery staple', kdf);
    const b = await deriveKeys('correct horse battery staple', kdf);
    expect(a.masterKey).toEqual(b.masterKey);
    expect(a.authKey).toEqual(b.authKey);
    expect(a.masterKey.length).toBe(32);
    expect(a.authKey.length).toBe(32);
    expect(a.masterKey).not.toEqual(a.authKey);
  });

  it('changes with the password, the salt and the limits', async () => {
    const kdf = testKdf();
    const base = await deriveKeys('pw', kdf);
    expect((await deriveKeys('pw2', kdf)).authKey).not.toEqual(base.authKey);
    expect((await deriveKeys('pw', testKdf())).authKey).not.toEqual(base.authKey);
    expect((await deriveKeys('pw', { ...kdf, memlimit: kdf.memlimit * 2 })).authKey).not.toEqual(
      base.authKey,
    );
  });

  it('normalises the password with NFKC', async () => {
    const kdf = testKdf();
    // "é" precomposed vs "e" + combining acute; fullwidth "ａ" folds to "a" under NFKC.
    expect((await deriveKeys('café', kdf)).authKey).toEqual(
      (await deriveKeys('café', kdf)).authKey,
    );
    expect((await deriveKeys('ａbc', kdf)).authKey).toEqual((await deriveKeys('abc', kdf)).authKey);
  });

  it('rejects invalid parameters and empty passwords', async () => {
    const kdf = testKdf();
    await expect(deriveKeys('', kdf)).rejects.toThrow(CryptoError);
    await expect(deriveKeys('pw', { ...kdf, salt: toB64(new Uint8Array(8)) })).rejects.toThrow();
    await expect(deriveKeys('pw', { ...kdf, opslimit: 0 })).rejects.toThrow();
    await expect(
      deriveKeys('pw', { ...kdf, alg: 'argon2i13' as unknown as 'argon2id13' }),
    ).rejects.toThrow();
  });
});

describe('newKdfParams', () => {
  it('defaults to opslimit 3, memlimit 64 MiB and a random 16-byte salt', () => {
    const a = newKdfParams();
    const b = newKdfParams();
    expect(a.alg).toBe('argon2id13');
    expect(a.opslimit).toBe(3);
    expect(a.memlimit).toBe(67_108_864);
    expect(DEFAULT_KDF_OPSLIMIT).toBe(3);
    expect(DEFAULT_KDF_MEMLIMIT).toBe(67_108_864);
    expect(fromB64(a.salt).length).toBe(16);
    expect(a.salt).not.toBe(b.salt);
    expect(kdfParamsSchema.safeParse(a).success).toBe(true);
  });

  it('accepts overrides and flags weak parameters', () => {
    const weak = newKdfParams(TEST_KDF_LIMITS);
    expect(weak.opslimit).toBe(1);
    expect(isKdfStrongEnough(weak)).toBe(false);
    expect(isKdfStrongEnough(newKdfParams())).toBe(true);
  });
});

describe('account keypair', () => {
  it('encrypts and decrypts the private key under the master key', async () => {
    const { masterKey } = await deriveKeys('pw', testKdf());
    const { publicKey, privateKey } = generateAccountKeypair();
    const encrypted = encryptPrivateKey(masterKey, privateKey);
    expect(encrypted.startsWith('v1.')).toBe(true);
    const decrypted = decryptPrivateKey(masterKey, encrypted);
    expect(decrypted).toEqual(privateKey);
    expect(publicKeyFromPrivateKey(decrypted)).toEqual(publicKey);
  });

  it('rejects the wrong master key and tampering', async () => {
    const a = await deriveKeys('pw', testKdf());
    const b = await deriveKeys('other', testKdf());
    const encrypted = encryptPrivateKey(a.masterKey, generateAccountKeypair().privateKey);
    expect(() => decryptPrivateKey(b.masterKey, encrypted)).toThrow(CryptoError);
    expect(() => decryptPrivateKey(a.masterKey, tamper(encrypted))).toThrow(CryptoError);
  });

  it('binds the private key to its AD', async () => {
    const { masterKey } = await deriveKeys('pw', testKdf());
    const { privateKey } = generateAccountKeypair();
    const encrypted = encryptPrivateKey(masterKey, privateKey);
    expect(open(masterKey, encrypted, AD_ACCOUNT_KEY)).toEqual(privateKey);
    expect(() => open(masterKey, encrypted, 'ternix:account-key:v2')).toThrow(CryptoError);
  });
});

describe('fingerprint', () => {
  it('is 8 groups of 4 lowercase hex characters', () => {
    const fp = fingerprint(generateAccountKeypair().publicKey);
    expect(fp).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
  });

  it('is stable per key and differs between keys', () => {
    const a = generateAccountKeypair().publicKey;
    const b = generateAccountKeypair().publicKey;
    expect(fingerprint(a)).toBe(fingerprint(a));
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('rejects keys of the wrong length', () => {
    expect(() => fingerprint(new Uint8Array(31))).toThrow(CryptoError);
  });
});

describe('vault keys', () => {
  it('generates distinct 32-byte keys', () => {
    const a = newVaultKey();
    expect(a.length).toBe(32);
    expect(a).not.toEqual(newVaultKey());
  });

  it('wraps and unwraps for a member', () => {
    const { publicKey, privateKey } = generateAccountKeypair();
    const vaultKey = newVaultKey();
    const wrapped = wrapVaultKey(vaultKey, publicKey);
    expect(fromB64(wrapped).length).toBe(32 + 48);
    expect(unwrapVaultKey(wrapped, publicKey, privateKey)).toEqual(vaultKey);
  });

  it('does not unwrap for another member or a tampered blob', () => {
    const alice = generateAccountKeypair();
    const bob = generateAccountKeypair();
    const wrapped = wrapVaultKey(newVaultKey(), alice.publicKey);
    expect(() => unwrapVaultKey(wrapped, bob.publicKey, bob.privateKey)).toThrow(CryptoError);
    const bytes = fromB64(wrapped);
    bytes[40] = bytes[40]! ^ 0x01;
    expect(() => unwrapVaultKey(toB64(bytes), alice.publicKey, alice.privateKey)).toThrow(
      CryptoError,
    );
  });

  it('rejects a vault key of the wrong length', () => {
    expect(() => wrapVaultKey(new Uint8Array(16), generateAccountKeypair().publicKey)).toThrow(
      CryptoError,
    );
  });
});

describe('vault name', () => {
  it('round-trips', () => {
    const k = newVaultKey();
    expect(decryptVaultName(k, VAULT_ID, encryptVaultName(k, VAULT_ID, 'Prod ✓'))).toBe('Prod ✓');
  });

  it('cannot be decrypted for another vault or key', () => {
    const k = newVaultKey();
    const enc = encryptVaultName(k, VAULT_ID, 'Prod');
    expect(() => decryptVaultName(k, OTHER_VAULT_ID, enc)).toThrow(CryptoError);
    expect(() => decryptVaultName(newVaultKey(), VAULT_ID, enc)).toThrow(CryptoError);
  });
});

describe('items', () => {
  const host: ItemPayloadInput = {
    type: 'host',
    updated_at: NOW,
    label: 'web-1',
    address: 'web-1.example.com',
  };

  it('round-trips and writes defaults into the plaintext', () => {
    const k = newVaultKey();
    const decrypted = decryptItem(k, VAULT_ID, ITEM_ID, encryptItem(k, VAULT_ID, ITEM_ID, host));
    expect(decrypted).toEqual({
      type: 'host',
      schema: 1,
      updated_at: NOW,
      label: 'web-1',
      address: 'web-1.example.com',
      port: 22,
      tags: [],
      agent_forwarding: false,
    });
  });

  it('cannot be decrypted under a different vault_id or item_id', () => {
    const k = newVaultKey();
    const ciphertext = encryptItem(k, VAULT_ID, ITEM_ID, host);
    expect(() => decryptItem(k, OTHER_VAULT_ID, ITEM_ID, ciphertext)).toThrow(CryptoError);
    expect(() => decryptItem(k, VAULT_ID, OTHER_ITEM_ID, ciphertext)).toThrow(CryptoError);
    expect(() => decryptItem(newVaultKey(), VAULT_ID, ITEM_ID, ciphertext)).toThrow(CryptoError);
    expect(() => decryptItem(k, VAULT_ID, ITEM_ID, tamper(ciphertext))).toThrow(CryptoError);
  });

  it('refuses to encrypt an invalid payload', () => {
    const k = newVaultKey();
    expect(() =>
      encryptItem(k, VAULT_ID, ITEM_ID, { ...host, port: 70_000 } as ItemPayloadInput),
    ).toThrow();
  });

  it('validates decrypted plaintext against the item schema', () => {
    const k = newVaultKey();
    const forged = seal(
      k,
      JSON.stringify({ type: 'host', label: 'x' }),
      `ternix:item:v1:${VAULT_ID}:${ITEM_ID}`,
    );
    expect(() => decryptItem(k, VAULT_ID, ITEM_ID, forged)).toThrow();
    const unknownType = seal(
      k,
      JSON.stringify({ type: 'teleporter', schema: 1, updated_at: NOW }),
      `ternix:item:v1:${VAULT_ID}:${ITEM_ID}`,
    );
    expect(() => decryptItem(k, VAULT_ID, ITEM_ID, unknownType)).toThrow();
    const notJson = seal(k, 'not json', `ternix:item:v1:${VAULT_ID}:${ITEM_ID}`);
    expect(() => decryptItem(k, VAULT_ID, ITEM_ID, notJson)).toThrow(CryptoError);
  });
});

describe('fakeSaltForEmail', () => {
  it('is HMAC-SHA256(secret, email)[0..16] and stable', () => {
    const secret = new TextEncoder().encode('server-secret-of-any-length');
    const salt = fakeSaltForEmail(secret, 'alice@example.com');
    const expected = createHmac('sha256', secret)
      .update('alice@example.com')
      .digest()
      .subarray(0, 16);
    expect(salt.length).toBe(16);
    expect(Buffer.from(salt).equals(expected)).toBe(true);
    expect(fakeSaltForEmail(secret, 'alice@example.com')).toEqual(salt);
  });

  it('matches Node HMAC for a 32-byte secret and a string secret', () => {
    const secret = new Uint8Array(32).fill(7);
    const expected = createHmac('sha256', secret)
      .update('bob@example.com')
      .digest()
      .subarray(0, 16);
    expect(Buffer.from(fakeSaltForEmail(secret, 'bob@example.com')).equals(expected)).toBe(true);
    expect(fakeSaltForEmail('s3cret', 'bob@example.com')).toEqual(
      fakeSaltForEmail(new TextEncoder().encode('s3cret'), 'bob@example.com'),
    );
  });

  it('normalises the email and depends on the secret', () => {
    expect(fakeSaltForEmail('s', '  Alice@Example.COM ')).toEqual(
      fakeSaltForEmail('s', 'alice@example.com'),
    );
    expect(fakeSaltForEmail('s1', 'a@example.com')).not.toEqual(
      fakeSaltForEmail('s2', 'a@example.com'),
    );
    expect(fakeSaltForEmail('s', 'a@example.com')).not.toEqual(
      fakeSaltForEmail('s', 'b@example.com'),
    );
  });

  it('builds default-strength KDF params that satisfy the schema', () => {
    const kdf = fakeKdfForEmail('s', 'a@example.com');
    expect(kdfParamsSchema.safeParse(kdf).success).toBe(true);
    expect(kdf.opslimit).toBe(3);
    expect(kdf.memlimit).toBe(67_108_864);
  });

  it('rejects an empty secret', () => {
    expect(() => fakeSaltForEmail('', 'a@example.com')).toThrow(CryptoError);
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Alice@Example.COM\n')).toBe('alice@example.com');
  });
});
