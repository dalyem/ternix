import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/main/app/errors.js';
import {
  ALLOW_BASIC_TEXT_ENV,
  SafeStorageSecretStore,
  type SafeStorageLike,
} from '../src/main/app/secretStore.js';

/** A reversible fake: not secure, but nothing in the ciphertext looks like the plaintext. */
class FakeSafeStorage implements SafeStorageLike {
  available = true;
  backend: string | undefined;
  readonly encrypted: string[] = [];

  isEncryptionAvailable() {
    return this.available;
  }
  encryptString(plain: string) {
    this.encrypted.push(plain);
    return Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a));
  }
  decryptString(encrypted: Buffer) {
    return Buffer.from(encrypted.map((b) => b ^ 0x5a)).toString('utf8');
  }
  getSelectedStorageBackend() {
    return this.backend ?? 'gnome_libsecret';
  }
}

let dir: string;
let safe: FakeSafeStorage;
const session = { token: 'tok-SECRET-123', keys: { encrypted_private_key: 'k' } };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ternix-secrets-'));
  safe = new FakeSafeStorage();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SafeStorageSecretStore', () => {
  it('round-trips values through the OS encryption', async () => {
    const store = new SafeStorageSecretStore(dir, safe, {});
    expect(await store.get('session')).toBeUndefined();
    await store.set('session', session);
    expect(await store.get('session')).toEqual(session);
    expect(await new SafeStorageSecretStore(dir, safe, {}).get('session')).toEqual(session);
  });

  it('never writes plaintext to disk', async () => {
    const store = new SafeStorageSecretStore(dir, safe, {});
    await store.set('session', session);
    const onDisk = await readFile(join(dir, 'session.bin'));
    expect(onDisk.toString('utf8')).not.toContain('SECRET');
    expect(onDisk.toString('latin1')).not.toContain('tok-');
    expect(safe.encrypted).toHaveLength(1);
  });

  it('refuses to store anything when encryption is unavailable', async () => {
    safe.available = false;
    const store = new SafeStorageSecretStore(dir, safe, {});
    await expect(store.set('session', session)).rejects.toMatchObject({
      name: 'AppError',
      code: 'secret_storage_unavailable',
    });
    await expect(store.set('session', session)).rejects.toBeInstanceOf(AppError);
    await expect(readFile(join(dir, 'session.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(safe.encrypted).toHaveLength(0);
    expect(store.status()).toMatchObject({ available: false });
  });

  it('reads as empty, and does not throw, when encryption is unavailable', async () => {
    const store = new SafeStorageSecretStore(dir, safe, {});
    await store.set('session', session);
    safe.available = false;
    expect(await store.get('session')).toBeUndefined();
  });

  it('treats the Linux basic_text backend as unavailable unless explicitly allowed', async () => {
    safe.backend = 'basic_text';
    const refused = new SafeStorageSecretStore(dir, safe, {});
    expect(refused.status().available).toBe(false);
    await expect(refused.set('a', 1)).rejects.toMatchObject({ code: 'secret_storage_unavailable' });
    const allowed = new SafeStorageSecretStore(dir, safe, { [ALLOW_BASIC_TEXT_ENV]: '1' });
    expect(allowed.status().available).toBe(true);
    await allowed.set('a', 1);
    expect(await allowed.get('a')).toBe(1);
  });

  it('reads an undecryptable or corrupt file as empty', async () => {
    const store = new SafeStorageSecretStore(dir, safe, {});
    await writeFile(join(dir, 'session.bin'), Buffer.from('garbage-not-json'));
    expect(await store.get('session')).toBeUndefined();
    await store.set('session', session); // and can be overwritten
    expect(await store.get('session')).toEqual(session);
  });

  it('keeps other keys when one is deleted', async () => {
    const store = new SafeStorageSecretStore(dir, safe, {});
    await store.set('a', { n: 1 });
    await store.set('b', { n: 2 });
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toEqual({ n: 2 });
    await store.delete('missing');
  });

  it('serializes concurrent writes without losing any', async () => {
    const store = new SafeStorageSecretStore(dir, safe, {});
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set(`k${i}`, i)));
    for (let i = 0; i < 20; i++) expect(await store.get(`k${i}`)).toBe(i);
  });

  it('can delete the session while encryption is off without throwing', async () => {
    const store = new SafeStorageSecretStore(dir, safe, {});
    await store.set('session', session);
    safe.available = false;
    await expect(store.delete('session')).resolves.toBeUndefined();
  });
});
