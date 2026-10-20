import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Item } from '@ternix/core/protocol';
import {
  closeClients,
  deferred,
  rawRequest,
  type Registered,
  registerUser,
  snippet,
  startServer,
  storedSession,
  type TestServer,
} from './helpers.js';

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await closeClients();
  await server.close();
});

const idOf = (t: Registered): string => t.client.account!.user.id;

describe('removal during a running rotation', () => {
  it('rotates again after the removal instead of reusing a rotation that predates it', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    const found = await a.client.lookupUser(b.email);
    await a.client.addMember(vault.id, found.id, 'editor', found.publicKey);
    await b.client.sync();

    // The first rotation is committed by the server, but its response is held back.
    const committed = deferred();
    const release = deferred();
    const removed = deferred();
    let held = false;
    a.spy.after = async (method, path) => {
      if (method === 'POST' && path.endsWith('/rotate') && !held) {
        held = true;
        committed.resolve();
        await release.promise;
      }
      if (method === 'DELETE' && path.endsWith(`/members/${idOf(b)}`)) removed.resolve();
    };

    const rotating = a.client.rotateVault(vault.id);
    await committed.promise;
    // B learns key_version 2 while A still waits for the response.
    await b.client.refreshVaults();
    expect(b.client.getVault(vault.id).keyVersion).toBe(2);

    const removing = a.client.removeMember(vault.id, idOf(b));
    await removed.promise;
    release.resolve();

    expect((await rotating).keyVersion).toBe(2);
    expect(await removing).toEqual({ rotated: true, rotationError: null });
    // A key B never received protects everything written from now on.
    expect(a.client.getVault(vault.id)).toMatchObject({ keyVersion: 3, memberCount: 1 });
    const after = await a.client.putItem(vault.id, undefined, snippet('after removal'));
    expect(after.item!.keyVersion).toBe(3);
    const res = await rawRequest(
      server,
      'GET',
      `/api/v1/vaults/${vault.id}/items`,
      (await storedSession(a)).token!,
    );
    const items = (res.body as { items: Item[] }).items.filter((i) => !i.deleted);
    expect(items.map((i) => i.key_version)).toEqual([3]);
    expect(a.spy.count('POST', '/rotate')).toBe(2);
  });

  it('an explicit rotation with no removal in between still joins the running one', async () => {
    const a = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Solo');
    const [one, two] = await Promise.all([
      a.client.rotateVault(vault.id),
      a.client.rotateVault(vault.id),
    ]);
    expect(one.keyVersion).toBe(2);
    expect(two.keyVersion).toBe(2);
    expect(a.spy.count('POST', '/rotate')).toBe(1);
  });
});
