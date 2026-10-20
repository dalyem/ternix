import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonFileCacheStore,
  JsonFileSecretStore,
  MemoryCacheStore,
  MemorySecretStore,
} from '../src/main/client/index.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ternix-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('JsonFileSecretStore', () => {
  it('round-trips values and deletes them', async () => {
    const dir = tempDir();
    const store = new JsonFileSecretStore(dir);
    expect(await store.get('session')).toBeUndefined();
    await store.set('session', { token: 't', nested: { n: 1 } });
    expect(await new JsonFileSecretStore(dir).get('session')).toEqual({
      token: 't',
      nested: { n: 1 },
    });
    await store.delete('session');
    expect(await store.get('session')).toBeUndefined();
    await store.delete('session');
  });

  it('writes atomically and leaves no temp files', async () => {
    const dir = tempDir();
    const store = new JsonFileSecretStore(dir);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set('k', { i })));
    expect(await store.get('k')).toEqual({ i: 19 });
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('reads a corrupt file as empty', async () => {
    const dir = tempDir();
    const store = new JsonFileSecretStore(dir);
    await store.set('k', { a: 1 });
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file!), '{not json');
    expect(await store.get('k')).toBeUndefined();
  });

  it('keeps hostile keys inside its directory', async () => {
    const dir = tempDir();
    const store = new JsonFileSecretStore(join(dir, 'inner'));
    await store.set('../../escape', 1);
    expect(readdirSync(dir)).toEqual(['inner']);
    expect(await store.get('../../escape')).toBe(1);
  });
});

describe('JsonFileCacheStore', () => {
  it('namespaces by account and clears one account', async () => {
    const store = new JsonFileCacheStore(tempDir());
    await store.set('https://a\nuser-1', 'vaults', { v: 1 });
    await store.set('https://a\nuser-2', 'vaults', { v: 2 });
    expect(await store.get('https://a\nuser-1', 'vaults')).toEqual({ v: 1 });
    expect(await store.get('https://a\nuser-2', 'vaults')).toEqual({ v: 2 });
    await store.clear('https://a\nuser-1');
    expect(await store.get('https://a\nuser-1', 'vaults')).toBeUndefined();
    expect(await store.files('https://a\nuser-1')).toEqual([]);
    expect(await store.get('https://a\nuser-2', 'vaults')).toEqual({ v: 2 });
    await store.delete('https://a\nuser-2', 'vaults');
    expect(await store.get('https://a\nuser-2', 'vaults')).toBeUndefined();
  });

  it('lands concurrent writes in call order', async () => {
    const store = new JsonFileCacheStore(tempDir());
    const writes = Array.from({ length: 30 }, (_, i) =>
      store.set('acct', 'items-x', { seq: i, pad: 'x'.repeat(1000 * (30 - i)) }),
    );
    await Promise.all(writes);
    expect(await store.get('acct', 'items-x')).toMatchObject({ seq: 29 });
  });
});

describe('memory stores', () => {
  it('copy values so callers cannot mutate what is stored', async () => {
    const secrets = new MemorySecretStore();
    const value = { a: [1] };
    await secrets.set('k', value);
    value.a.push(2);
    expect(await secrets.get('k')).toEqual({ a: [1] });

    const cache = new MemoryCacheStore();
    await cache.set('acct', 'k', value);
    expect(JSON.parse(cache.dump())).toEqual({ acct: { k: { a: [1, 2] } } });
    await cache.clear('acct');
    expect(cache.dump()).toBe('{}');
  });
});
