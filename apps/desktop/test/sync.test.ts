import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ITEM_CIPHERTEXT_LENGTH, MAX_LIVE_ITEMS_PER_VAULT } from '@ternix/core/protocol';
import { OfflineError } from '../src/main/client/index.js';
import type { ItemDto, VaultItemsDto } from '../src/shared/types.js';
import {
  closeClients,
  HOUR,
  loginUser,
  nextEvent,
  registerUser,
  snippet,
  startServer,
  type TestServer,
  waitFor,
} from './helpers.js';

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await closeClients();
  await server.close();
});

const labels = (items: VaultItemsDto): string[] =>
  items.items.map((i) => ('label' in i.payload ? i.payload.label : '?')).sort();

const labelOf = (item: ItemDto | null): string | undefined =>
  item && 'label' in item.payload ? item.payload.label : undefined;

describe('items and realtime sync', () => {
  it('creates, updates and deletes; a second device follows through vault.changed', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await loginUser(server, a.email, a.password);
    await waitFor(() => b.client.connection === 'online', 'b online');
    const vaultId = a.personalVaultId;

    let changed = nextEvent(b.client, 'items-changed', (e) => e.vaultId === vaultId);
    const created = await a.client.putItem(vaultId, undefined, {
      type: 'host',
      label: 'web-1',
      address: '10.0.0.5',
      username: 'deploy',
    });
    expect(created.status).toBe('saved');
    expect(created.item!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.item!.payload).toMatchObject({ port: 22, tags: [], agent_forwarding: false });
    await changed;
    expect(b.client.getItem(vaultId, created.item!.id)?.payload).toMatchObject({
      type: 'host',
      label: 'web-1',
      address: '10.0.0.5',
    });

    changed = nextEvent(b.client, 'items-changed', (e) => e.vaultId === vaultId);
    const updated = await a.client.putItem(vaultId, created.item!.id, {
      type: 'host',
      label: 'web-1 (renamed)',
      address: '10.0.0.5',
    });
    expect(updated.item!.seq).toBeGreaterThan(created.item!.seq);
    await changed;
    expect(labelOf(b.client.getItem(vaultId, created.item!.id))).toBe('web-1 (renamed)');

    changed = nextEvent(b.client, 'items-changed', (e) => e.vaultId === vaultId);
    expect(await a.client.deleteItem(vaultId, created.item!.id)).toEqual({
      id: created.item!.id,
      status: 'saved',
      item: null,
    });
    await changed;
    expect(b.client.getItem(vaultId, created.item!.id)).toBeNull();
    expect(a.client.listItems(vaultId).items).toEqual([]);
  });

  it('validates payloads and IDs before sending', async () => {
    const a = await registerUser(server, { realtime: false });
    const before = a.spy.calls.length;
    await expect(
      a.client.putItem(a.personalVaultId, undefined, { type: 'host', label: '', address: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      a.client.putItem(a.personalVaultId, 'NOT-A-UUID', snippet('x')),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(a.spy.calls.length).toBe(before);
  });
});

describe('client conflict rule', () => {
  async function twoStaleDevices() {
    const a = await registerUser(server, { realtime: false });
    const b = await loginUser(server, a.email, a.password, { realtime: false });
    const vaultId = a.personalVaultId;
    const created = await a.client.putItem(vaultId, undefined, snippet('original'));
    const id = created.item!.id;
    await b.client.sync();
    return { a, b, vaultId, id };
  }

  it('newer local edit wins: retries with the server seq', async () => {
    const { a, b, vaultId, id } = await twoStaleDevices();
    await b.client.putItem(vaultId, id, snippet('from b'));
    a.clock.offsetMs = HOUR; // A's edit is newer by its clock.
    const res = await a.client.putItem(vaultId, id, snippet('from a'));
    expect(res.status).toBe('saved');
    expect(labelOf(res.item)).toBe('from a');
    expect(a.spy.count('PUT', `/items/${id}`)).toBe(3); // create, conflict, retry
    await b.client.sync();
    expect(labelOf(b.client.getItem(vaultId, id))).toBe('from a');
  });

  it('older local edit is dropped and the server version kept', async () => {
    const { a, b, vaultId, id } = await twoStaleDevices();
    b.clock.offsetMs = HOUR;
    await b.client.putItem(vaultId, id, snippet('from b'));
    const res = await a.client.putItem(vaultId, id, snippet('from a'));
    expect(res.status).toBe('dropped');
    expect(labelOf(res.item)).toBe('from b');
    expect(labelOf(a.client.getItem(vaultId, id))).toBe('from b');
    await b.client.sync();
    expect(labelOf(b.client.getItem(vaultId, id))).toBe('from b');
  });

  it('a delete loses to a newer edit', async () => {
    const { a, b, vaultId, id } = await twoStaleDevices();
    b.clock.offsetMs = HOUR;
    await b.client.putItem(vaultId, id, snippet('edited later'));
    const res = await a.client.deleteItem(vaultId, id);
    expect(res.status).toBe('dropped');
    expect(labelOf(res.item)).toBe('edited later');
    expect(labelOf(a.client.getItem(vaultId, id))).toBe('edited later');
    await b.client.sync();
    expect(labelOf(b.client.getItem(vaultId, id))).toBe('edited later');
  });

  it('a delete wins over an older edit', async () => {
    const { a, b, vaultId, id } = await twoStaleDevices();
    b.clock.offsetMs = -HOUR;
    await b.client.putItem(vaultId, id, snippet('edited earlier'));
    const res = await a.client.deleteItem(vaultId, id);
    expect(res).toEqual({ id, status: 'saved', item: null });
    await b.client.sync();
    expect(b.client.getItem(vaultId, id)).toBeNull();
  });

  it('an edit loses to a newer delete and wins over an older one', async () => {
    const { a, b, vaultId, id } = await twoStaleDevices();
    await b.client.deleteItem(vaultId, id);
    a.clock.offsetMs = -HOUR;
    const dropped = await a.client.putItem(vaultId, id, snippet('too old'));
    expect(dropped).toEqual({ id, status: 'dropped', item: null });
    expect(a.client.getItem(vaultId, id)).toBeNull();

    const second = await a.client.putItem(vaultId, undefined, snippet('second'));
    const id2 = second.item!.id;
    await b.client.sync();
    await b.client.deleteItem(vaultId, id2);
    a.clock.offsetMs = HOUR;
    const revived = await a.client.putItem(vaultId, id2, snippet('revived'));
    expect(revived.status).toBe('saved');
    await b.client.sync();
    expect(labelOf(b.client.getItem(vaultId, id2))).toBe('revived');
  });

  it('applies the rule per op in a batch', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await loginUser(server, a.email, a.password, { realtime: false });
    const vaultId = a.personalVaultId;
    const made = await a.client.putMany(
      vaultId,
      ['x', 'y', 'z', 'w'].map((l) => ({ payload: snippet(l) })),
    );
    const [x, y, z, w] = made.results.map((r) => r.id) as [string, string, string, string];
    await b.client.sync();
    b.clock.offsetMs = -HOUR;
    await b.client.putItem(vaultId, x, snippet('x by b, older'));
    await b.client.putItem(vaultId, w, snippet('w by b, older'));
    b.clock.offsetMs = HOUR;
    await b.client.putItem(vaultId, y, snippet('y by b, newer'));
    await b.client.putItem(vaultId, z, snippet('z by b, newer'));

    const res = await a.client.applyBatch(vaultId, [
      { op: 'put', id: x, payload: snippet('x by a') },
      { op: 'put', id: y, payload: snippet('y by a') },
      { op: 'delete', id: z },
      { op: 'delete', id: w },
    ]);
    expect(res.failed).toEqual([]);
    const byId = new Map(res.results.map((r) => [r.id, r]));
    expect(byId.get(x)).toMatchObject({ status: 'saved' });
    expect(labelOf(byId.get(x)!.item)).toBe('x by a');
    expect(byId.get(y)).toMatchObject({ status: 'dropped' });
    expect(labelOf(byId.get(y)!.item)).toBe('y by b, newer');
    expect(byId.get(z)).toMatchObject({ status: 'dropped' });
    expect(byId.get(w)).toEqual({ id: w, status: 'saved', item: null });

    await b.client.sync();
    expect(labels(b.client.listItems(vaultId))).toEqual([
      'x by a',
      'y by b, newer',
      'z by b, newer',
    ]);
    expect(labels(a.client.listItems(vaultId))).toEqual([
      'x by a',
      'y by b, newer',
      'z by b, newer',
    ]);
  });
});

describe('background writes', () => {
  async function stale() {
    const a = await registerUser(server, { realtime: false });
    const b = await loginUser(server, a.email, a.password, { realtime: false });
    const vaultId = a.personalVaultId;
    const created = await a.client.putItem(vaultId, undefined, snippet('original'));
    await b.client.sync();
    return { a, b, vaultId, id: created.item!.id, seq: created.item!.seq };
  }

  it('updates the version it was built from and keeps its updated_at', async () => {
    const { a, vaultId, id, seq } = await stale();
    const before = a.client.getItem(vaultId, id)!.payload;
    a.clock.offsetMs = HOUR;
    const res = await a.client.putItem(vaultId, id, snippet('tagged'), {
      background: { baseSeq: seq },
    });
    expect(res.status).toBe('saved');
    const after = a.client.getItem(vaultId, id)!;
    expect(labelOf(after)).toBe('tagged');
    expect(after.payload.updated_at).toBe(before.updated_at);
  });

  it('is skipped on a conflict, without a retry, and leaves the newer version alone', async () => {
    const { a, b, vaultId, id, seq } = await stale();
    await b.client.putItem(vaultId, id, snippet('from b'));
    a.clock.offsetMs = HOUR; // would win the conflict rule as a normal write
    const puts = a.spy.count('PUT', `/items/${id}`);
    const res = await a.client.putItem(vaultId, id, snippet('background'), {
      background: { baseSeq: seq },
    });
    expect(res).toEqual({ id, status: 'skipped', item: null });
    expect(a.spy.count('PUT', `/items/${id}`)).toBe(puts + 1);
    // This device learned the server's version; the server still has B's.
    expect(labelOf(a.client.getItem(vaultId, id))).toBe('from b');
    await b.client.sync();
    expect(labelOf(b.client.getItem(vaultId, id))).toBe('from b');
  });

  it('is skipped on a tombstone and never revives the item', async () => {
    const { a, b, vaultId, id, seq } = await stale();
    await b.client.deleteItem(vaultId, id);
    a.clock.offsetMs = HOUR;
    const res = await a.client.putItem(vaultId, id, snippet('background'), {
      background: { baseSeq: seq },
    });
    expect(res.status).toBe('skipped');
    expect(a.client.getItem(vaultId, id)).toBeNull();
    await b.client.sync();
    expect(b.client.getItem(vaultId, id)).toBeNull();
    // Once this device knows of the delete, nothing is sent at all.
    const puts = a.spy.count('PUT', `/items/${id}`);
    expect(
      (await a.client.putItem(vaultId, id, snippet('again'), { background: { baseSeq: seq } }))
        .status,
    ).toBe('skipped');
    expect(a.spy.count('PUT', `/items/${id}`)).toBe(puts);
  });

  it('sends nothing for a version this device has moved past, or an item it does not have', async () => {
    const { a, b, vaultId, id, seq } = await stale();
    await b.client.putItem(vaultId, id, snippet('from b'));
    await a.client.sync();
    const before = a.spy.calls.length;
    const moved = await a.client.putItem(vaultId, id, snippet('x'), {
      background: { baseSeq: seq },
    });
    const missing = await a.client.putItem(vaultId, crypto.randomUUID(), snippet('x'), {
      background: { baseSeq: 1 },
    });
    expect([moved.status, missing.status]).toEqual(['skipped', 'skipped']);
    expect(a.spy.calls.length).toBe(before);
    expect(labelOf(a.client.getItem(vaultId, id))).toBe('from b');
  });
});

describe('batch import', () => {
  it('imports more than MAX_BATCH_OPS items in chunks', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await loginUser(server, a.email, a.password, { realtime: false });
    const vaultId = a.personalVaultId;
    const items = Array.from({ length: 1201 }, (_, i) => ({ payload: snippet(`imported ${i}`) }));
    const res = await a.client.putMany(vaultId, items);
    expect(res.failed).toEqual([]);
    expect(res.results).toHaveLength(1201);
    expect(res.results.every((r) => r.status === 'saved')).toBe(true);
    expect(a.spy.count('POST', '/items/batch')).toBe(3);
    expect(a.client.getVault(vaultId).itemCount).toBe(1201);

    // A second device gets them in one pull of two pages (limit 1000).
    const pagesBefore = b.spy.count('GET', `/vaults/${vaultId}/items`);
    await b.client.pullVault(vaultId);
    expect(b.client.listItems(vaultId).items).toHaveLength(1201);
    expect(b.spy.count('GET', `/vaults/${vaultId}/items`) - pagesBefore).toBe(2);
  });
});

describe('client-side limits and permissions', () => {
  it('rejects an oversized item before sending it', async () => {
    const a = await registerUser(server, { realtime: false });
    const huge = {
      type: 'snippet' as const,
      label: 'huge',
      script: 'x'.repeat(MAX_ITEM_CIPHERTEXT_LENGTH),
    };
    await expect(a.client.putItem(a.personalVaultId, undefined, huge)).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    await expect(
      a.client.putMany(a.personalVaultId, [{ payload: snippet('fine') }, { payload: huge }]),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(a.spy.count('PUT', '/items/')).toBe(0);
    expect(a.spy.count('POST', '/items/batch')).toBe(0);
    expect(a.client.listItems(a.personalVaultId).items).toEqual([]);
  });

  it('refuses to create beyond MAX_LIVE_ITEMS_PER_VAULT', async () => {
    const a = await registerUser(server, { realtime: false });
    const vaultId = a.personalVaultId;
    const fill = Array.from({ length: MAX_LIVE_ITEMS_PER_VAULT - 1 }, (_, i) => ({
      payload: snippet(`n${i}`, ''),
    }));
    await expect(
      a.client.putMany(vaultId, [
        ...fill,
        { payload: snippet('one') },
        { payload: snippet('two') },
      ]),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(a.spy.count('POST', '/items/batch')).toBe(0);
    await a.client.putMany(vaultId, [...fill, { payload: snippet('last') }]);
    const batches = a.spy.count('POST', '/items/batch');
    await expect(a.client.putItem(vaultId, undefined, snippet('over'))).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    await expect(a.client.putMany(vaultId, [{ payload: snippet('over') }])).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    expect(a.spy.count('PUT', '/items/')).toBe(0);
    expect(a.spy.count('POST', '/items/batch')).toBe(batches);
    // Updating an existing item is still fine.
    const first = a.client.listItems(vaultId).items[0]!;
    expect((await a.client.putItem(vaultId, first.id, snippet('updated'))).status).toBe('saved');
  }, 60_000);

  it('does not let a viewer write', async () => {
    const owner = await registerUser(server, { realtime: false });
    const viewer = await registerUser(server, { realtime: false });
    const vault = await owner.client.createVault('Read only');
    await owner.client.putItem(vault.id, undefined, snippet('visible'));
    const found = await owner.client.lookupUser(viewer.email);
    await owner.client.addMember(vault.id, found.id, 'viewer', found.publicKey);
    await viewer.client.sync();
    expect(labels(viewer.client.listItems(vault.id))).toEqual(['visible']);
    const before = viewer.spy.calls.length;
    await expect(viewer.client.putItem(vault.id, undefined, snippet('nope'))).rejects.toMatchObject(
      {
        code: 'permission_denied',
      },
    );
    const item = viewer.client.listItems(vault.id).items[0]!;
    await expect(viewer.client.deleteItem(vault.id, item.id)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(viewer.spy.calls.length).toBe(before);
  });

  it('throws OfflineError for writes without a connection; reads keep working', async () => {
    const a = await registerUser(server, { realtime: false });
    await a.client.putItem(a.personalVaultId, undefined, snippet('there'));
    a.spy.offline = true;
    await expect(
      a.client.putItem(a.personalVaultId, undefined, snippet('not')),
    ).rejects.toBeInstanceOf(OfflineError);
    expect(labels(a.client.listItems(a.personalVaultId))).toEqual(['there']);
  });
});
