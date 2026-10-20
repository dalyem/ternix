import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptItem,
  decryptPrivateKey,
  deriveKeys,
  fromB64,
  unwrapVaultKey,
} from '@ternix/core/crypto';
import type { Item } from '@ternix/core/protocol';
import { MAX_ROTATION_ATTEMPTS, RotationError } from '../src/main/client/index.js';
import type { ItemDto, VaultItemsDto } from '../src/shared/types.js';
import {
  closeClients,
  nextEvent,
  rawRequest,
  type Registered,
  registerUser,
  snippet,
  startServer,
  storedSession,
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

async function share(
  owner: Registered,
  vaultId: string,
  member: Registered,
  role: 'editor' | 'viewer' | 'owner',
) {
  const found = await owner.client.lookupUser(member.email);
  return owner.client.addMember(vaultId, found.id, role, found.publicKey);
}

/**
 * What a removed member's device still holds on disk: the session with the encrypted
 * account key. With the password it yields the private key and every vault key it was given.
 */
async function stealKeys(t: Registered, vaultId: string) {
  const session = await storedSession(t);
  const { masterKey } = await deriveKeys(t.password, session.keys.kdf);
  const privateKey = decryptPrivateKey(masterKey, session.keys.encrypted_private_key);
  const publicKey = fromB64(session.keys.public_key);
  const res = await rawRequest(server, 'GET', '/api/v1/vaults', session.token!);
  const vault = (
    res.body as { vaults: { id: string; key_version: number; wrapped_key: string }[] }
  ).vaults.find((v) => v.id === vaultId)!;
  return {
    token: session.token!,
    version: vault.key_version,
    key: unwrapVaultKey(vault.wrapped_key, publicKey, privateKey),
  };
}

describe('sharing', () => {
  it('shares a vault; the member decrypts names and items, and writes back', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server);
    await waitFor(() => b.client.connection === 'online', 'b online');
    const vault = await a.client.createVault('Team');
    await a.client.putItem(vault.id, undefined, snippet('from owner'));

    const found = await a.client.lookupUser(`  ${b.email.toUpperCase()}`);
    expect(found).toMatchObject({ id: b.client.account!.user.id, email: b.email });
    // The fingerprint the owner sees is the one B sees for its own account.
    expect(found.fingerprint).toBe(b.client.account!.user.fingerprint);

    const listed = nextEvent(b.client, 'items-changed', (e) => e.vaultId === vault.id);
    const member = await a.client.addMember(vault.id, found.id, 'editor', found.publicKey);
    expect(member).toMatchObject({
      userId: found.id,
      role: 'editor',
      fingerprint: found.fingerprint,
    });
    await listed;
    expect(b.client.getVault(vault.id)).toMatchObject({
      name: 'Team',
      role: 'editor',
      kind: 'shared',
    });
    expect(labels(b.client.listItems(vault.id))).toEqual(['from owner']);

    await b.client.putItem(vault.id, undefined, snippet('from member'));
    await a.client.pullVault(vault.id);
    expect(labels(a.client.listItems(vault.id))).toEqual(['from member', 'from owner']);
    expect(a.client.getVault(vault.id).memberCount).toBe(2);

    const members = await b.client.listMembers(vault.id);
    expect(members.map((m) => [m.email, m.role, m.isSelf]).sort()).toEqual(
      [
        [a.email, 'owner', false],
        [b.email, 'editor', true],
      ].sort(),
    );

    // Role change is visible to the member.
    await a.client.changeMemberRole(vault.id, found.id, 'viewer');
    await waitFor(() => b.client.getVault(vault.id).role === 'viewer', 'role change');
  });

  it('refuses to add a member whose key differs from the verified one', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const c = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    await expect(
      a.client.addMember(
        vault.id,
        b.client.account!.user.id,
        'editor',
        b.client.account!.user.publicKey,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    const found = await a.client.lookupUser(b.email);
    await expect(
      a.client.addMember(vault.id, found.id, 'editor', c.client.account!.user.publicKey),
    ).rejects.toMatchObject({ code: 'key_changed' });
    expect(a.spy.count('POST', '/members')).toBe(0);
  });

  it('a member can leave; the vault disappears from their device', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    await share(a, vault.id, b, 'editor');
    await b.client.sync();
    await b.client.leaveVault(vault.id);
    expect(b.client.listVaults().map((v) => v.id)).not.toContain(vault.id);
    expect((await a.client.listMembers(vault.id)).map((m) => m.email)).toEqual([a.email]);
  });

  it('renames after a rotation it had not seen (key_version_mismatch, refresh, retry)', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Old name');
    await share(a, vault.id, b, 'owner');
    await b.client.sync();
    await b.client.rotateVault(vault.id); // A still holds key_version 1
    expect(a.client.getVault(vault.id).keyVersion).toBe(1);
    const renamed = await a.client.renameVault(vault.id, 'New name');
    expect(renamed).toMatchObject({ name: 'New name', keyVersion: 2 });
    await b.client.refreshVaults();
    expect(b.client.getVault(vault.id).name).toBe('New name');
  });
});

describe('removal and key rotation', () => {
  it('rotates after an owner removes a member; the removed member cannot read new items', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const c = await registerUser(server);
    await waitFor(() => c.client.connection === 'online', 'c online');
    const vault = await a.client.createVault('Team');
    await a.client.putItem(vault.id, undefined, snippet('before removal'));
    await share(a, vault.id, b, 'editor');
    await share(a, vault.id, c, 'editor');
    await b.client.sync();
    await waitFor(() => c.client.listVaults().some((v) => v.id === vault.id), 'c sees vault');
    const stolen = await stealKeys(c, vault.id);
    expect(stolen.version).toBe(1);

    const gone = nextEvent(c.client, 'vaults-changed');
    const result = await a.client.removeMember(vault.id, c.client.account!.user.id);
    expect(result).toEqual({ rotated: true, rotationError: null });
    expect(a.client.getVault(vault.id)).toMatchObject({ keyVersion: 2, memberCount: 2 });
    await gone;
    await waitFor(() => !c.client.listVaults().some((v) => v.id === vault.id), 'vault gone on c');
    expect(c.cacheStore.dump()).not.toContain(`items-${vault.id}`);

    const after = await a.client.putItem(vault.id, undefined, snippet('after removal'));
    expect(after.item!.keyVersion).toBe(2);

    // The remaining member reads old and new items under the new key.
    await b.client.sync();
    expect(b.client.getVault(vault.id).keyVersion).toBe(2);
    expect(labels(b.client.listItems(vault.id))).toEqual(['after removal', 'before removal']);

    // The removed member's token no longer reaches the vault...
    const denied = await rawRequest(
      server,
      'GET',
      `/api/v1/vaults/${vault.id}/items`,
      stolen.token,
    );
    expect(denied.status).toBe(404);
    // ...and the old key it kept opens none of the current ciphertext (taken from the owner).
    const ownerToken = (await storedSession(a)).token!;
    const res = await rawRequest(server, 'GET', `/api/v1/vaults/${vault.id}/items`, ownerToken);
    const items = (res.body as { items: Item[] }).items.filter((i) => !i.deleted);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.key_version).toBe(2);
      expect(() => decryptItem(stolen.key, vault.id, item.id, item.ciphertext as string)).toThrow();
    }
  });

  it('retries a rotation when an item is edited mid-rotation (stale_item_ids)', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    const x = await a.client.putItem(vault.id, undefined, snippet('x original'));
    await a.client.putItem(vault.id, undefined, snippet('y'));
    await share(a, vault.id, b, 'editor');
    await b.client.sync();

    const conflicts: { stale: string[]; expected: string[] }[] = [];
    let edited = false;
    a.spy.before = async (method, path) => {
      if (method === 'POST' && path.endsWith('/rotate') && !edited) {
        edited = true;
        // B edits after A has re-encrypted everything, before A's request lands.
        await b.client.putItem(vault.id, x.item!.id, snippet('x edited by b'));
      }
    };
    a.spy.after = async (method, path, res) => {
      if (method === 'POST' && path.endsWith('/rotate') && res.status === 409) {
        const body = (await res.json()) as {
          stale_item_ids: string[];
          expected: { item_ids: string[] };
        };
        conflicts.push({ stale: body.stale_item_ids, expected: body.expected.item_ids });
      }
    };

    const rotated = await a.client.rotateVault(vault.id);
    expect(rotated.keyVersion).toBe(2);
    expect(a.spy.count('POST', '/rotate')).toBe(2);
    expect(conflicts).toEqual([{ stale: [x.item!.id], expected: expect.any(Array) }]);

    // B's edit survived the rotation and is readable under the new key by both.
    expect(labelOf(a.client.getItem(vault.id, x.item!.id))).toBe('x edited by b');
    await b.client.sync();
    expect(b.client.getItem(vault.id, x.item!.id)).toMatchObject({ keyVersion: 2 });
    expect(labels(b.client.listItems(vault.id))).toEqual(['x edited by b', 'y']);
  });

  it('gives up with a typed error after repeated conflicts', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Busy');
    const x = await a.client.putItem(vault.id, undefined, snippet('x'));
    await share(a, vault.id, b, 'editor');
    await b.client.sync();
    let n = 0;
    a.spy.before = async (method, path) => {
      if (method === 'POST' && path.endsWith('/rotate')) {
        n += 1;
        await b.client.putItem(vault.id, x.item!.id, snippet(`edit ${n}`));
      }
    };
    await expect(a.client.rotateVault(vault.id)).rejects.toBeInstanceOf(RotationError);
    expect(a.spy.count('POST', '/rotate')).toBe(MAX_ROTATION_ATTEMPTS);
    expect(a.client.getVault(vault.id).keyVersion).toBe(1);
  });
});
