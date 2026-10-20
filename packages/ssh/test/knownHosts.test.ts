import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';
import { knownHostPayloadSchema } from '@ternix/core/items';
import {
  checkHostKey,
  fingerprintSha256,
  knownHostItems,
  knownHostPayload,
  parseKeyType,
  preferredHostKeyAlgorithms,
} from '../src/index.js';
import { generateKey, host, itemMap, knownHost, uid, wirePublicKey } from './helpers.js';

const { utils } = ssh2;

const ed = wirePublicKey(generateKey().public);
const ed2 = wirePublicKey(generateKey().public);
const edB64 = ed.toString('base64');
const ed2B64 = ed2.toString('base64');

function entry(fields: { host?: string; port?: number; key_type?: string; public_key?: string }) {
  return knownHostPayloadSchema.parse({
    type: 'known_host',
    updated_at: '2026-01-01T00:00:00.000Z',
    host: 'example.com',
    port: 22,
    key_type: 'ssh-ed25519',
    public_key: edB64,
    ...fields,
  });
}

describe('parseKeyType', () => {
  it('reads the type from ed25519, ecdsa and rsa keys', () => {
    expect(parseKeyType(ed)).toBe('ssh-ed25519');
    expect(parseKeyType(edB64)).toBe('ssh-ed25519');
    const ecdsa = utils.generateKeyPairSync('ecdsa', { bits: 256 });
    expect(parseKeyType(wirePublicKey(ecdsa.public))).toBe('ecdsa-sha2-nistp256');
    const rsa = utils.generateKeyPairSync('rsa', { bits: 2048 });
    expect(parseKeyType(wirePublicKey(rsa.public))).toBe('ssh-rsa');
  });

  it('rejects data that is not a wire-format key', () => {
    expect(parseKeyType(Buffer.alloc(0))).toBeUndefined();
    expect(parseKeyType(Buffer.from([0, 0, 0, 0]))).toBeUndefined();
    expect(parseKeyType(Buffer.from([0, 0, 0, 200, 65]))).toBeUndefined();
    expect(parseKeyType(Buffer.from([0, 0, 0, 2, 0x01, 0x02]))).toBeUndefined();
  });
});

describe('fingerprintSha256', () => {
  it('is SHA256: plus the unpadded base64 digest, like OpenSSH', () => {
    const fp = fingerprintSha256(edB64);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fp).toBe(`SHA256:${createHash('sha256').update(ed).digest('base64').slice(0, 43)}`);
    expect(fingerprintSha256(ed)).toBe(fp);
  });

  it('differs for different keys', () => {
    expect(fingerprintSha256(ed2)).not.toBe(fingerprintSha256(ed));
  });
});

describe('checkHostKey', () => {
  const stored = entry({});

  it('trusts the stored key', () => {
    expect(checkHostKey([stored], 'example.com', 22, 'ssh-ed25519', edB64)).toEqual({
      status: 'trusted',
    });
  });

  it('matches the host case-insensitively', () => {
    expect(checkHostKey([stored], 'EXAMPLE.com', 22, 'ssh-ed25519', edB64).status).toBe('trusted');
    expect(
      checkHostKey([entry({ host: 'Example.COM' })], 'example.com', 22, 'ssh-ed25519', edB64)
        .status,
    ).toBe('trusted');
  });

  it('is unknown for another host, another port, or nothing stored', () => {
    expect(checkHostKey([], 'example.com', 22, 'ssh-ed25519', edB64).status).toBe('unknown');
    expect(checkHostKey([stored], 'other.com', 22, 'ssh-ed25519', edB64).status).toBe('unknown');
    expect(checkHostKey([stored], 'example.com', 2222, 'ssh-ed25519', edB64).status).toBe(
      'unknown',
    );
  });

  it('does not treat a different port as a mismatch', () => {
    expect(checkHostKey([stored], 'example.com', 2222, 'ssh-ed25519', ed2B64)).toEqual({
      status: 'unknown',
    });
  });

  it('reports a mismatch with the stored key when the same type changed', () => {
    const result = checkHostKey([stored], 'example.com', 22, 'ssh-ed25519', ed2B64);
    expect(result).toEqual({ status: 'mismatch', stored });
  });

  it('is unknown, not a mismatch, for a key type never stored for the host', () => {
    expect(checkHostKey([stored], 'example.com', 22, 'ssh-rsa', ed2B64).status).toBe('unknown');
  });

  it('trusts the key if any stored key of that type matches', () => {
    const entries = [entry({ public_key: ed2B64 }), stored];
    expect(checkHostKey(entries, 'example.com', 22, 'ssh-ed25519', edB64).status).toBe('trusted');
  });
});

describe('knownHostPayload and knownHostItems', () => {
  it('builds an item that passes the protocol schema, with a lowercase host', () => {
    const payload = knownHostPayload({
      host: 'Example.COM',
      port: 2222,
      keyType: 'ssh-ed25519',
      keyB64: edB64,
      updatedAt: new Date('2026-03-04T05:06:07.000Z'),
    });
    expect(knownHostPayloadSchema.parse(payload)).toMatchObject({
      type: 'known_host',
      host: 'example.com',
      port: 2222,
      key_type: 'ssh-ed25519',
      public_key: edB64,
      updated_at: '2026-03-04T05:06:07.000Z',
    });
  });

  it('round-trips through checkHostKey', () => {
    const payload = knownHostPayloadSchema.parse(
      knownHostPayload({ host: 'Box.example', port: 22, keyType: 'ssh-ed25519', keyB64: edB64 }),
    );
    expect(checkHostKey([payload], 'box.example', 22, 'ssh-ed25519', edB64).status).toBe('trusted');
  });

  it('picks the known_host items out of a lookup', () => {
    const items = itemMap([
      [uid(1), host()],
      [uid(2), knownHost({ host: 'a', port: 22, key_type: 'ssh-ed25519', public_key: edB64 })],
    ]);
    expect(knownHostItems(items.values())).toHaveLength(1);
  });
});

describe('preferredHostKeyAlgorithms', () => {
  it('leaves ssh2 defaults alone when nothing is stored for the host', () => {
    expect(preferredHostKeyAlgorithms([], 'example.com', 22)).toBeUndefined();
    expect(
      preferredHostKeyAlgorithms([entry({ host: 'other' })], 'example.com', 22),
    ).toBeUndefined();
  });

  it('puts the stored key types first and keeps the rest', () => {
    const list = preferredHostKeyAlgorithms([entry({ key_type: 'ssh-rsa' })], 'example.com', 22);
    expect(list?.slice(0, 3)).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
    expect(list).toContain('ssh-ed25519');
    expect(new Set(list).size).toBe(list?.length);
  });
});
