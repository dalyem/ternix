import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '@ternix/core/protocol';
import {
  CoalescingCacheStore,
  MemoryCacheStore,
  MemorySecretStore,
} from '../src/main/client/index.js';
import { accountKey, itemsCacheKey } from '../src/main/client/session.js';
import {
  CountingCacheStore,
  closeClients,
  makeClient,
  rawRequest,
  registerUser,
  snippet,
  startServer,
  storedSession,
  type TestClient,
  type TestServer,
} from './helpers.js';

/** Records the order of every call that reaches the store underneath. */
class LoggingStore extends MemoryCacheStore {
  readonly log: string[] = [];
  failNext = 0;

  override async set(account: string, key: string, value: unknown): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('disk full');
    }
    this.log.push(`set ${key}`);
    return super.set(account, key, value);
  }

  override async delete(account: string, key: string): Promise<void> {
    this.log.push(`delete ${key}`);
    return super.delete(account, key);
  }

  override async clear(account: string): Promise<void> {
    this.log.push(`clear ${account}`);
    return super.clear(account);
  }
}

const isItems = (key: string): boolean => key.startsWith('items-');

describe('CoalescingCacheStore', () => {
  let inner: LoggingStore;
  let errors: unknown[];
  let store: CoalescingCacheStore;

  beforeEach(() => {
    vi.useFakeTimers();
    inner = new LoggingStore();
    errors = [];
    store = new CoalescingCacheStore(inner, isItems, (err) => errors.push(err), {
      debounceMs: 250,
      maxDelayMs: 1_000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns a burst of writes into one write of the newest value', async () => {
    for (let i = 0; i < 20; i++) {
      await store.set('acct', 'items-v1', { n: i });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(inner.log).toEqual([]);
    expect(store.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(inner.log).toEqual(['set items-v1']);
    expect(await inner.get('acct', 'items-v1')).toEqual({ n: 19 });
    expect(store.pending).toBe(0);
  });

  it('serves pending values to reads, as copies', async () => {
    await store.set('acct', 'items-v1', { n: 1 });
    const read = (await store.get('acct', 'items-v1')) as { n: number };
    expect(read).toEqual({ n: 1 });
    read.n = 99;
    expect(await store.get('acct', 'items-v1')).toEqual({ n: 1 });
    expect(await inner.get('acct', 'items-v1')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(await store.get('acct', 'items-v1')).toEqual({ n: 1 });
    expect(await store.get('acct', 'other')).toBeUndefined();
  });

  it('writes after the max delay even when changes never pause', async () => {
    for (let elapsed = 0; elapsed < 2_400; elapsed += 100) {
      await store.set('acct', 'items-v1', { n: elapsed });
      await vi.advanceTimersByTimeAsync(100);
    }
    // Debounce alone would have written nothing; the cap forces a write about every second.
    expect(inner.log.length).toBeGreaterThanOrEqual(2);
    expect(inner.log.length).toBeLessThanOrEqual(3);
  });

  it('keeps vaults apart', async () => {
    await store.set('acct', 'items-a', 1);
    await store.set('acct', 'items-b', 2);
    await vi.advanceTimersByTimeAsync(250);
    expect(inner.log.sort()).toEqual(['set items-a', 'set items-b']);
  });

  it('flush writes everything now and waits for it', async () => {
    await store.set('acct', 'items-a', 1);
    await store.set('acct', 'items-b', 2);
    await store.flush();
    expect(await inner.get('acct', 'items-a')).toBe(1);
    expect(await inner.get('acct', 'items-b')).toBe(2);
    expect(store.pending).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inner.log).toHaveLength(2);
    // A flush with nothing pending is a no-op.
    await store.flush();
    expect(inner.log).toHaveLength(2);
  });

  it('writes other keys through, after the pending values of the same account', async () => {
    await store.set('acct', 'items-a', 1);
    await store.set('other', 'items-z', 1);
    await store.set('acct', 'vaults', { v: 1 });
    expect(inner.log).toEqual(['set items-a', 'set vaults']);
    expect(await inner.get('acct', 'vaults')).toEqual({ v: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(inner.log).toEqual(['set items-a', 'set vaults', 'set items-z']);
  });

  it('delete cancels a pending write; clear cancels an account', async () => {
    await store.set('acct', 'items-a', 1);
    await store.delete('acct', 'items-a');
    expect(await store.get('acct', 'items-a')).toBeUndefined();
    await store.set('acct', 'items-b', 1);
    await store.set('other', 'items-c', 1);
    await store.clear('acct');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inner.log).toEqual(['delete items-a', 'clear acct', 'set items-c']);
    expect(await store.get('acct', 'items-b')).toBeUndefined();
  });

  it('a write after a delete is written after it', async () => {
    await store.set('acct', 'items-a', 1);
    await store.flush();
    const deleting = store.delete('acct', 'items-a');
    await store.set('acct', 'items-a', 2);
    await deleting;
    await store.flush();
    expect(inner.log).toEqual(['set items-a', 'delete items-a', 'set items-a']);
    expect(await inner.get('acct', 'items-a')).toBe(2);
  });

  it('reports a failed timed write, keeps the value, and writes it on the next flush', async () => {
    inner.failNext = 1;
    await store.set('acct', 'items-a', { n: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(errors).toHaveLength(1);
    expect(store.pending).toBe(1);
    expect(await store.get('acct', 'items-a')).toEqual({ n: 1 });
    await store.flush();
    expect(await inner.get('acct', 'items-a')).toEqual({ n: 1 });
    expect(store.pending).toBe(0);
  });

  it('rejects a flush whose write fails, and retries on the next', async () => {
    await store.set('acct', 'items-a', { n: 1 });
    inner.failNext = 1;
    await expect(store.flush()).rejects.toThrow('disk full');
    expect(errors).toEqual([]);
    await store.flush();
    expect(await inner.get('acct', 'items-a')).toEqual({ n: 1 });
  });
});

describe('item cache against the server', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await closeClients();
    await server.close();
  });

  const SLOW = { debounceMs: 60_000, maxDelayMs: 60_000 };

  function stores() {
    return { secretStore: new MemorySecretStore(), cacheStore: new CountingCacheStore() };
  }

  const itemsKey = (t: { personalVaultId: string }) => itemsCacheKey(t.personalVaultId);

  it('writes a burst of changes to the cache once, not once per change', async () => {
    const s = stores();
    const a = await registerUser(
      server,
      { realtime: false, cacheWrite: { debounceMs: 300, maxDelayMs: 10_000 } },
      { stores: s },
    );
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        a.client.putItem(a.personalVaultId, undefined, snippet(`n${i}`)),
      ),
    );
    expect(s.cacheStore.setsOf(itemsKey(a))).toBe(0);
    await vi.waitFor(() => expect(s.cacheStore.setsOf(itemsKey(a))).toBeGreaterThan(0), {
      timeout: 3_000,
    });
    expect(s.cacheStore.setsOf(itemsKey(a))).toBeLessThanOrEqual(2);
    const doc = (await s.cacheStore.get(
      accountKey(server.url, a.client.account!.user.id),
      itemsKey(a),
    )) as { items: unknown[] };
    expect(doc.items).toHaveLength(30);
  });

  it('lock stores everything pending, so an offline unlock sees it', async () => {
    const s = stores();
    const a = await registerUser(server, { realtime: false, cacheWrite: SLOW }, { stores: s });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        a.client.putItem(a.personalVaultId, undefined, snippet(`n${i}`)),
      ),
    );
    expect(s.cacheStore.setsOf(itemsKey(a))).toBe(0);
    await a.client.lock();
    expect(s.cacheStore.setsOf(itemsKey(a))).toBe(1);

    const b = await makeClient({ realtime: false }, s);
    b.spy.offline = true;
    await b.client.unlock(a.password);
    expect(b.client.listItems(a.personalVaultId).items).toHaveLength(5);
  });

  it('flush, close and logout store pending changes; logout leaves nothing behind', async () => {
    const s = stores();
    const a = await registerUser(server, { realtime: false, cacheWrite: SLOW }, { stores: s });
    const account = accountKey(server.url, a.client.account!.user.id);
    await a.client.putItem(a.personalVaultId, undefined, snippet('one'));
    expect(await s.cacheStore.get(account, itemsKey(a))).toBeUndefined();
    await a.client.flush();
    expect(await s.cacheStore.get(account, itemsKey(a))).toMatchObject({ items: [{}] });

    await a.client.putItem(a.personalVaultId, undefined, snippet('two'));
    await a.client.close();
    expect(await s.cacheStore.get(account, itemsKey(a))).toMatchObject({ items: [{}, {}] });

    // A pending write never lands after logout cleared the cache.
    const b = await registerUser(
      server,
      { realtime: false, cacheWrite: SLOW },
      { stores: stores() },
    );
    const bAccount = accountKey(server.url, b.client.account!.user.id);
    await b.client.putItem(b.personalVaultId, undefined, snippet('gone'));
    await b.client.logout();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((b.cacheStore as MemoryCacheStore).dump()).not.toContain(bAccount);
    expect(await b.cacheStore.get(bAccount, itemsKey(b))).toBeUndefined();
  });

  /** Every live item the server holds for a vault. */
  async function serverItems(t: TestClient, vaultId: string): Promise<Item[]> {
    const token = (await storedSession(t)).token!;
    const res = await rawRequest(
      server,
      'GET',
      `/api/v1/vaults/${vaultId}/items?since=0&limit=500`,
      token,
    );
    return (res.body as { items: Item[] }).items.filter((i) => !i.deleted);
  }

  it('after a crash the cache never claims a cursor beyond the items it holds', async () => {
    const s = stores();
    const first = await registerUser(server, { realtime: false });
    const vaultId = first.personalVaultId;
    for (let i = 0; i < 4; i++) {
      await first.client.putItem(vaultId, undefined, snippet(`early ${i}`));
    }

    // Device two syncs and stores its cache.
    const two = await makeClient({ realtime: false, cacheWrite: SLOW }, s);
    await two.client.login({ serverUrl: server.url, email: first.email, password: first.password });
    await two.client.sync();
    await two.client.flush();
    const account = accountKey(server.url, two.client.account!.user.id);

    // More arrives; device two pulls it but dies before the pending window closes.
    for (let i = 0; i < 4; i++) {
      await first.client.putItem(vaultId, undefined, snippet(`late ${i}`));
    }
    await two.client.sync();
    expect(two.client.listItems(vaultId).items).toHaveLength(8);

    const doc = (await s.cacheStore.get(account, itemsCacheKey(vaultId))) as {
      since: number;
      items: Item[];
    };
    const held = new Set(doc.items.map((i) => i.id));
    const covered = (await serverItems(first, vaultId)).filter((i) => i.seq <= doc.since);
    expect(covered.length).toBeGreaterThan(0);
    for (const item of covered) expect(held.has(item.id)).toBe(true);
    expect(doc.items).toHaveLength(4);

    // The restarted device resumes from that cursor and catches up on the rest.
    const restarted = await makeClient({ realtime: false }, s);
    await restarted.client.unlock(first.password);
    expect(restarted.client.listItems(vaultId).items).toHaveLength(4);
    await restarted.client.sync();
    expect(restarted.client.listItems(vaultId).items).toHaveLength(8);
  });
});
