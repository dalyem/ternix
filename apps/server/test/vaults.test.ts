import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  encryptVaultName,
  newVaultKey,
  unwrapVaultKey,
  wrapVaultKey,
  decryptItem,
} from '@ternix/core';
import {
  batchResponseSchema,
  errorEnvelopeSchema,
  itemConflictResponseSchema,
  itemResponseSchema,
  listItemsResponseSchema,
  listMembersResponseSchema,
  listVaultsResponseSchema,
  MAX_ITEM_CIPHERTEXT_LENGTH,
  MAX_LIVE_ITEMS_PER_VAULT,
  memberSchema,
  rotateConflictResponseSchema,
  vaultSchema,
} from '@ternix/core/protocol';
import { register, startServer, type Client, type TestServer } from './helpers.js';

describe('vaults, sharing, sync and rotation', () => {
  let s: TestServer;
  let alice: Client; // admin, vault owner
  let bob: Client; // editor, then removed
  let carol: Client; // viewer
  let dave: Client; // never a member
  let vault: string;

  beforeAll(async () => {
    s = await startServer({ registration: 'open' });
    alice = await register(s.app, { email: 'alice@example.com', name: 'Alice' });
    bob = await register(s.app, { email: 'bob@example.com', name: 'Bob' });
    carol = await register(s.app, { email: 'carol@example.com', name: 'Carol' });
    dave = await register(s.app, { email: 'dave@example.com', name: 'Dave' });
  });
  afterAll(() => s.close());

  it('creates a personal vault at registration', async () => {
    const res = await alice.req('GET', '/api/v1/vaults');
    const { vaults } = listVaultsResponseSchema.parse(res.body);
    expect(vaults).toHaveLength(1);
    expect(vaults[0]).toMatchObject({
      id: alice.personalVaultId,
      kind: 'personal',
      key_version: 1,
      role: 'owner',
      seq: 0,
      member_count: 1,
    });
    await alice.syncKeys();
    expect(alice.decryptName(vaults[0]!)).toBe('Personal');
  });

  it('creates a shared vault with the caller as owner', async () => {
    vault = await alice.createVault('Team servers');
    const { vaults } = listVaultsResponseSchema.parse(
      (await alice.req('GET', '/api/v1/vaults')).body,
    );
    const shared = vaults.find((v) => v.id === vault)!;
    expect(shared).toMatchObject({
      kind: 'shared',
      key_version: 1,
      role: 'owner',
      member_count: 1,
    });
    expect(alice.decryptName(shared)).toBe('Team servers');

    const dup = await alice.req('POST', '/api/v1/vaults', {
      body: { id: vault, name_enc: shared.name_enc, wrapped_key: shared.wrapped_key },
    });
    expect(dup.status).toBe(409);
  });

  it('does not let a personal vault be shared or deleted', async () => {
    const share = await alice.addMember(alice.personalVaultId, bob, 'viewer');
    expect(share.status).toBe(403);
    const del = await alice.req('DELETE', `/api/v1/vaults/${alice.personalVaultId}`);
    expect(del.status).toBe(403);
    const leave = await alice.req(
      'DELETE',
      `/api/v1/vaults/${alice.personalVaultId}/members/${alice.id}`,
    );
    expect(leave.status).toBe(409);
  });

  it('adds members with wrapped keys; they list and decrypt', async () => {
    const own = await alice.putItem(vault, randomUUID(), 'first', null);
    expect(own.status).toBe(200);

    const addBob = await alice.addMember(vault, bob, 'editor');
    expect(addBob.status).toBe(201);
    expect(memberSchema.parse(addBob.body)).toMatchObject({ user_id: bob.id, role: 'editor' });
    expect((await alice.addMember(vault, carol, 'viewer')).status).toBe(201);

    // Adding twice, unknown users and stale key versions are refused.
    expect((await alice.addMember(vault, bob, 'viewer')).status).toBe(409);
    const ghost = await alice.req('POST', `/api/v1/vaults/${vault}/members`, {
      body: {
        user_id: randomUUID(),
        role: 'viewer',
        wrapped_key: wrapVaultKey(alice.keyFor(vault), bob.keypair.publicKey),
        key_version: 1,
      },
    });
    expect(ghost.status).toBe(404);
    const stale = await alice.req('POST', `/api/v1/vaults/${vault}/members`, {
      body: {
        user_id: dave.id,
        role: 'viewer',
        wrapped_key: wrapVaultKey(alice.keyFor(vault), dave.keypair.publicKey),
        key_version: 2,
      },
    });
    expect(stale.status).toBe(409);
    expect(errorEnvelopeSchema.parse(stale.body).error.code).toBe('key_version_mismatch');

    await bob.syncKeys();
    await carol.syncKeys();
    const { vaults } = listVaultsResponseSchema.parse(
      (await bob.req('GET', '/api/v1/vaults')).body,
    );
    const seen = vaults.find((v) => v.id === vault)!;
    expect(seen).toMatchObject({ role: 'editor', member_count: 3, seq: 1 });
    expect(bob.decryptName(seen)).toBe('Team servers');

    const items = listItemsResponseSchema.parse(
      (await bob.req('GET', `/api/v1/vaults/${vault}/items`, { query: { since: 0 } })).body,
    );
    expect(items.items.map((i) => bob.decrypt(i))).toEqual(['first']);

    const members = listMembersResponseSchema.parse(
      (await carol.req('GET', `/api/v1/vaults/${vault}/members`)).body,
    );
    expect(members.members.map((m) => [m.name, m.role]).sort()).toEqual([
      ['Alice', 'owner'],
      ['Bob', 'editor'],
      ['Carol', 'viewer'],
    ]);
  });

  it('hides the vault from non-members (404) and forbids viewers from writing (403)', async () => {
    const id = randomUUID();
    for (const [method, path, body] of [
      ['GET', `/api/v1/vaults/${vault}/items`, undefined],
      ['GET', `/api/v1/vaults/${vault}/members`, undefined],
      [
        'PATCH',
        `/api/v1/vaults/${vault}`,
        { name_enc: alice.encrypt(vault, id, 'x'), key_version: 1 },
      ],
      ['DELETE', `/api/v1/vaults/${vault}`, undefined],
      ['POST', `/api/v1/vaults/${vault}/items/batch`, { ops: [] }],
      ['PUT', `/api/v1/vaults/${vault}/items/${id}`, {}],
    ] as const) {
      const res = await dave.req(method, path, { body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // A vault that does not exist looks the same as one you are not in.
    const missing = await dave.req('GET', `/api/v1/vaults/${randomUUID()}/items`);
    const hidden = await dave.req('GET', `/api/v1/vaults/${vault}/items`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(hidden.body);

    // Viewer: reads, never writes.
    expect((await carol.req('GET', `/api/v1/vaults/${vault}/items`)).status).toBe(200);
    const item = randomUUID();
    expect((await carol.putItem(vault, item, 'nope', null)).status).toBe(403);
    expect(
      (
        await carol.req('DELETE', `/api/v1/vaults/${vault}/items/${item}`, {
          query: { base_seq: 1 },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await carol.req('POST', `/api/v1/vaults/${vault}/items/batch`, {
          body: { ops: [{ op: 'delete', id: item, base_seq: 1 }] },
        })
      ).status,
    ).toBe(403);
    // Editors cannot manage members or the vault.
    expect((await bob.addMember(vault, dave, 'viewer')).status).toBe(403);
    expect((await bob.req('DELETE', `/api/v1/vaults/${vault}`)).status).toBe(403);
    expect(
      (
        await bob.req('PATCH', `/api/v1/vaults/${vault}/members/${carol.id}`, {
          body: { role: 'editor' },
        })
      ).status,
    ).toBe(403);
    expect((await bob.req('DELETE', `/api/v1/vaults/${vault}/members/${carol.id}`)).status).toBe(
      403,
    );
  });

  it('applies base_seq optimistic concurrency and keeps tombstones', async () => {
    const id = randomUUID();
    const created = await bob.putItem(vault, id, 'v1', null);
    expect(created.status).toBe(200);
    const item1 = itemResponseSchema.parse(created.body).item;
    expect(item1).toMatchObject({ deleted: false, key_version: 1, updated_by: bob.id });

    // Creating an id that exists conflicts.
    const again = await bob.putItem(vault, id, 'dup', null);
    expect(again.status).toBe(409);
    expect(itemConflictResponseSchema.parse(again.body).current.seq).toBe(item1.seq);
    // Updating against a missing item is a 404, not a conflict.
    expect((await bob.putItem(vault, randomUUID(), 'ghost', 5)).status).toBe(404);

    // Update with the right base_seq, then a stale one.
    const updated = itemResponseSchema.parse(
      (await alice.putItem(vault, id, 'v2', item1.seq)).body,
    ).item;
    expect(updated.seq).toBeGreaterThan(item1.seq);
    const stale = await bob.putItem(vault, id, 'stale', item1.seq);
    expect(stale.status).toBe(409);
    const conflict = itemConflictResponseSchema.parse(stale.body);
    expect(conflict.error.code).toBe('conflict');
    expect(conflict.current).toEqual(updated);
    expect(bob.decrypt(conflict.current)).toBe('v2');

    // Wrong key_version is its own error.
    const kv = await bob.req('PUT', `/api/v1/vaults/${vault}/items/${id}`, {
      body: { ciphertext: bob.encrypt(vault, id, 'x'), key_version: 2, base_seq: updated.seq },
    });
    expect(kv.status).toBe(409);
    expect(kv.body.error.code).toBe('key_version_mismatch');

    // Delete: stale base_seq conflicts, correct one leaves a tombstone.
    const staleDel = await bob.req('DELETE', `/api/v1/vaults/${vault}/items/${id}`, {
      query: { base_seq: item1.seq },
    });
    expect(staleDel.status).toBe(409);
    const del = await bob.req('DELETE', `/api/v1/vaults/${vault}/items/${id}`, {
      query: { base_seq: updated.seq },
    });
    expect(del.status).toBe(200);
    const tomb = itemResponseSchema.parse(del.body).item;
    expect(tomb).toMatchObject({ id, deleted: true, ciphertext: null });
    expect(tomb.seq).toBeGreaterThan(updated.seq);
    expect(
      (
        await bob.req('DELETE', `/api/v1/vaults/${vault}/items/${randomUUID()}`, {
          query: { base_seq: 1 },
        })
      ).status,
    ).toBe(404);
    expect((await bob.req('DELETE', `/api/v1/vaults/${vault}/items/${id}`)).status).toBe(400);

    // The tombstone shows up through `since`.
    const sync = listItemsResponseSchema.parse(
      (await carol.req('GET', `/api/v1/vaults/${vault}/items`, { query: { since: updated.seq } }))
        .body,
    );
    expect(sync.items).toEqual([tomb]);
    expect(sync.next_since).toBe(tomb.seq);
    expect(sync.has_more).toBe(false);

    // A deleted id can be re-created by passing the tombstone's seq.
    const revived = itemResponseSchema.parse(
      (await bob.putItem(vault, id, 'back', tomb.seq)).body,
    ).item;
    expect(revived.deleted).toBe(false);
    expect(bob.decrypt(revived)).toBe('back');
  });

  it('paginates with since and limit, in seq order', async () => {
    const v = await alice.createVault('Paging');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      ids.push(id);
      expect((await alice.putItem(v, id, `item ${i}`, null)).status).toBe(200);
    }
    const page1 = listItemsResponseSchema.parse(
      (await alice.req('GET', `/api/v1/vaults/${v}/items`, { query: { since: 0, limit: 2 } })).body,
    );
    expect(page1.items.map((i) => i.id)).toEqual(ids.slice(0, 2));
    expect(page1.has_more).toBe(true);
    const page2 = listItemsResponseSchema.parse(
      (
        await alice.req('GET', `/api/v1/vaults/${v}/items`, {
          query: { since: page1.next_since, limit: 2 },
        })
      ).body,
    );
    expect(page2.items.map((i) => i.id)).toEqual(ids.slice(2, 4));
    const page3 = listItemsResponseSchema.parse(
      (
        await alice.req('GET', `/api/v1/vaults/${v}/items`, {
          query: { since: page2.next_since, limit: 2 },
        })
      ).body,
    );
    expect(page3.items.map((i) => i.id)).toEqual(ids.slice(4));
    expect(page3.has_more).toBe(false);
    const empty = listItemsResponseSchema.parse(
      (await alice.req('GET', `/api/v1/vaults/${v}/items`, { query: { since: page3.next_since } }))
        .body,
    );
    expect(empty).toEqual({ items: [], next_since: page3.next_since, has_more: false });
    expect(
      (await alice.req('GET', `/api/v1/vaults/${v}/items`, { query: { limit: 5000 } })).status,
    ).toBe(400);
    expect(
      (await alice.req('GET', `/api/v1/vaults/${v}/items`, { query: { since: 'abc' } })).status,
    ).toBe(400);
  });

  it('batches ops, reporting each result on its own', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    const existing = itemResponseSchema.parse((await bob.putItem(vault, c, 'c1', null)).body).item;
    const res = await bob.req('POST', `/api/v1/vaults/${vault}/items/batch`, {
      body: {
        ops: [
          {
            op: 'put',
            id: a,
            ciphertext: bob.encrypt(vault, a, 'a'),
            key_version: 1,
            base_seq: null,
          },
          {
            op: 'put',
            id: b,
            ciphertext: bob.encrypt(vault, b, 'b'),
            key_version: 1,
            base_seq: null,
          },
          {
            op: 'put',
            id: c,
            ciphertext: bob.encrypt(vault, c, 'stale'),
            key_version: 1,
            base_seq: existing.seq - 1,
          },
          {
            op: 'put',
            id: randomUUID(),
            ciphertext: bob.encrypt(vault, a, 'bad'),
            key_version: 9,
            base_seq: null,
          },
          { op: 'delete', id: a, base_seq: 0 },
          { op: 'delete', id: randomUUID(), base_seq: 1 },
          {
            op: 'put',
            id: a,
            ciphertext: bob.encrypt(vault, a, 'a2'),
            key_version: 1,
            base_seq: null,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const { results } = batchResponseSchema.parse(res.body);
    expect(results.map((r) => r.status)).toEqual([
      'ok',
      'ok',
      'conflict',
      'error',
      'conflict',
      'error',
      'conflict',
    ]);
    const [ra, , rc, rkv, , rmissing] = results;
    expect(ra?.status === 'ok' && bob.decrypt(ra.item)).toBe('a');
    expect(rc?.status === 'conflict' && rc.current.seq).toBe(existing.seq);
    expect(rkv?.status === 'error' && rkv.error.code).toBe('key_version_mismatch');
    expect(rmissing?.status === 'error' && rmissing.error.code).toBe('not_found');

    // In-order semantics: a later op sees the earlier one.
    const first = ra?.status === 'ok' ? ra.item : undefined;
    const seq = await bob.req('POST', `/api/v1/vaults/${vault}/items/batch`, {
      body: {
        ops: [
          { op: 'delete', id: a, base_seq: first!.seq },
          {
            op: 'put',
            id: a,
            ciphertext: bob.encrypt(vault, a, 'a3'),
            key_version: 1,
            base_seq: first!.seq,
          },
        ],
      },
    });
    expect(batchResponseSchema.parse(seq.body).results.map((r) => r.status)).toEqual([
      'ok',
      'conflict',
    ]);

    // Size limits come from the core schema.
    const tooMany = Array.from({ length: 501 }, () => ({
      op: 'delete',
      id: randomUUID(),
      base_seq: 0,
    }));
    expect(
      (await bob.req('POST', `/api/v1/vaults/${vault}/items/batch`, { body: { ops: tooMany } }))
        .status,
    ).toBe(400);
    expect(
      (await bob.req('POST', `/api/v1/vaults/${vault}/items/batch`, { body: { ops: [] } })).status,
    ).toBe(400);
  });

  it('changes roles, protects the last owner, and lets members leave', async () => {
    const patch = (who: Client, role: string, by = alice) =>
      by.req('PATCH', `/api/v1/vaults/${vault}/members/${who.id}`, { body: { role } });
    expect(memberSchema.parse((await patch(carol, 'editor')).body).role).toBe('editor');
    expect((await carol.putItem(vault, randomUUID(), 'now allowed', null)).status).toBe(200);
    expect((await patch(carol, 'viewer')).status).toBe(200);

    // Last owner cannot be demoted, removed, or leave.
    expect((await patch(alice, 'editor')).status).toBe(409);
    expect((await alice.req('DELETE', `/api/v1/vaults/${vault}/members/${alice.id}`)).status).toBe(
      409,
    );
    expect((await patch(dave, 'viewer')).status).toBe(404);

    // With a second owner, the first may step down and leave.
    expect((await patch(bob, 'owner')).status).toBe(200);
    expect((await patch(alice, 'editor', bob)).status).toBe(200);
    expect((await alice.req('DELETE', `/api/v1/vaults/${vault}/members/${alice.id}`)).status).toBe(
      204,
    );
    expect((await alice.req('GET', `/api/v1/vaults/${vault}/items`)).status).toBe(404);
    // Put the original owner back so later tests have their cast.
    await bob.syncKeys();
    expect((await bob.addMember(vault, alice, 'owner')).status).toBe(201);
    await alice.syncKeys();
    expect((await patch(bob, 'editor', alice)).status).toBe(200);
  });

  it('removes a member; they get 404 afterwards', async () => {
    expect(
      (await alice.req('DELETE', `/api/v1/vaults/${vault}/members/${randomUUID()}`)).status,
    ).toBe(404);
    const removed = await alice.req('DELETE', `/api/v1/vaults/${vault}/members/${bob.id}`);
    expect(removed.status).toBe(204);
    expect((await bob.req('GET', `/api/v1/vaults/${vault}/items`)).status).toBe(404);
    expect((await bob.req('GET', `/api/v1/vaults/${vault}/members`)).status).toBe(404);
    expect((await bob.putItem(vault, randomUUID(), 'x', null)).status).toBe(404);
    const { vaults } = listVaultsResponseSchema.parse(
      (await bob.req('GET', '/api/v1/vaults')).body,
    );
    expect(vaults.map((v) => v.id)).not.toContain(vault);
  });

  it('rotates the key: success, then 409 for mismatched member and item sets', async () => {
    const live = listItemsResponseSchema.parse(
      (
        await alice.req('GET', `/api/v1/vaults/${vault}/items`, {
          query: { since: 0, limit: 1000 },
        })
      ).body,
    );
    const liveItems = live.items.filter((i) => !i.deleted);
    const tombstones = live.items.filter((i) => i.deleted);
    expect(liveItems.length).toBeGreaterThan(1);

    const newKey = newVaultKey();
    const labels = new Map(liveItems.map((i) => [i.id, alice.decrypt(i)]));
    alice.setKey(vault, 2, newKey);
    const seqBefore = Math.max(...live.items.map((i) => i.seq));
    const rotation = (over: Record<string, unknown> = {}) => ({
      key_version: 2,
      name_enc: encryptVaultName(newKey, vault, 'Team servers (rotated)'),
      members: [alice, carol].map((m) => ({
        user_id: m.id,
        wrapped_key: wrapVaultKey(newKey, m.keypair.publicKey),
      })),
      items: liveItems.map((i) => ({
        id: i.id,
        ciphertext: alice.encrypt(vault, i.id, labels.get(i.id)!, 2),
        base_seq: i.seq,
      })),
      ...over,
    });
    const url = `/api/v1/vaults/${vault}/rotate`;

    // Missing a member (bob was removed; dave was never in; omit carol), unknown member, missing item.
    const missingMember = await alice.req('POST', url, {
      body: rotation({ members: rotation().members.slice(0, 1) }),
    });
    expect(missingMember.status).toBe(409);
    const detail = rotateConflictResponseSchema.parse(missingMember.body);
    expect(detail.error.code).toBe('conflict');
    expect(detail.expected.user_ids.sort()).toEqual([alice.id, carol.id].sort());
    expect(detail.expected.item_ids.sort()).toEqual(liveItems.map((i) => i.id).sort());
    expect(detail.stale_item_ids).toEqual([]);

    const extraMember = await alice.req('POST', url, {
      body: rotation({
        members: [
          ...rotation().members,
          { user_id: dave.id, wrapped_key: wrapVaultKey(newKey, dave.keypair.publicKey) },
        ],
      }),
    });
    expect(extraMember.status).toBe(409);
    const missingItem = await alice.req('POST', url, {
      body: rotation({ items: rotation().items.slice(1) }),
    });
    expect(missingItem.status).toBe(409);
    const tombItems = tombstones.map((t) => ({
      id: t.id,
      ciphertext: alice.encrypt(vault, t.id, 'x', 2),
      base_seq: t.seq,
    }));
    if (tombItems.length > 0) {
      const withTomb = await alice.req('POST', url, {
        body: rotation({ items: [...rotation().items, ...tombItems] }),
      });
      expect(withTomb.status).toBe(409);
    }
    const dupItem = await alice.req('POST', url, {
      body: rotation({ items: [...rotation().items, rotation().items[0]] }),
    });
    expect(dupItem.status).toBe(409);

    // Wrong version.
    const badVersion = await alice.req('POST', url, { body: rotation({ key_version: 3 }) });
    expect(badVersion.status).toBe(409);
    expect(badVersion.body.error.code).toBe('key_version_mismatch');

    // Non-owners cannot rotate.
    expect((await carol.req('POST', url, { body: rotation() })).status).toBe(403);

    // Nothing changed so far.
    const unchanged = listVaultsResponseSchema
      .parse((await alice.req('GET', '/api/v1/vaults')).body)
      .vaults.find((v) => v.id === vault)!;
    expect(unchanged.key_version).toBe(1);

    const ok = await alice.req('POST', url, { body: rotation() });
    expect(ok.status).toBe(200);
    const rotated = vaultSchema.parse(ok.body);
    expect(rotated.key_version).toBe(2);
    expect(rotated.seq).toBeGreaterThan(seqBefore);
    expect(
      unwrapVaultKey(rotated.wrapped_key, alice.keypair.publicKey, alice.keypair.privateKey),
    ).toEqual(newKey);
    expect(alice.decryptName(rotated)).toBe('Team servers (rotated)');

    // Items were re-encrypted in place with fresh seqs; tombstones were untouched.
    const after = listItemsResponseSchema.parse(
      (
        await carol.req('GET', `/api/v1/vaults/${vault}/items`, {
          query: { since: seqBefore, limit: 1000 },
        })
      ).body,
    );
    expect(after.items.map((i) => i.id).sort()).toEqual(liveItems.map((i) => i.id).sort());
    await carol.syncKeys();
    for (const item of after.items) {
      expect(item.key_version).toBe(2);
      expect(carol.decrypt(item)).toBe(labels.get(item.id));
      expect(() => decryptItem(alice.keyFor(vault, 1), vault, item.id, item.ciphertext!)).toThrow();
    }
    const full = listItemsResponseSchema.parse(
      (
        await alice.req('GET', `/api/v1/vaults/${vault}/items`, {
          query: { since: 0, limit: 1000 },
        })
      ).body,
    );
    for (const t of tombstones) expect(full.items.find((i) => i.id === t.id)).toEqual(t);

    // The old key version is refused for writes now.
    const old = await alice.putItem(vault, randomUUID(), 'old key', null, 1);
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('key_version_mismatch');
    expect((await alice.putItem(vault, randomUUID(), 'new key', null, 2)).status).toBe(200);
  });

  it('renames and deletes a shared vault', async () => {
    const v = await alice.createVault('Temp');
    await alice.addMember(v, carol, 'viewer');
    const key = alice.keyFor(v);
    const renamed = await alice.req('PATCH', `/api/v1/vaults/${v}`, {
      body: { name_enc: encryptVaultName(key, v, 'Renamed'), key_version: 1 },
    });
    expect(renamed.status).toBe(200);
    await carol.syncKeys();
    const seen = listVaultsResponseSchema
      .parse((await carol.req('GET', '/api/v1/vaults')).body)
      .vaults.find((x) => x.id === v)!;
    expect(carol.decryptName(seen)).toBe('Renamed');
    expect((await carol.req('DELETE', `/api/v1/vaults/${v}`)).status).toBe(403);
    expect((await alice.req('DELETE', `/api/v1/vaults/${v}`)).status).toBe(204);
    expect((await carol.req('GET', `/api/v1/vaults/${v}/items`)).status).toBe(404);
    expect(
      s.db.prepare('SELECT COUNT(*) AS n FROM vault_members WHERE vault_id = ?').get(v),
    ).toEqual({ n: 0 });
  });

  it('uses one global monotonic seq across vaults', async () => {
    const x = await alice.createVault('X');
    const y = await alice.createVault('Y');
    const seqs: number[] = [];
    for (const v of [x, y, x, y]) {
      const res = await alice.putItem(v, randomUUID(), 'n', null);
      seqs.push(itemResponseSchema.parse(res.body).item.seq);
    }
    expect(seqs).toEqual([...seqs].sort((p, q) => p - q));
    expect(new Set(seqs).size).toBe(4);
  });

  it('validates path ids and bodies', async () => {
    expect((await alice.req('GET', '/api/v1/vaults/not-a-uuid/items')).status).toBe(404);
    expect((await alice.req('POST', '/api/v1/vaults', { body: { id: 'x' } })).status).toBe(400);
    const bad = await alice.req('PUT', `/api/v1/vaults/${vault}/items/${randomUUID()}`, {
      body: { ciphertext: 'plain text', key_version: 2, base_seq: null },
    });
    expect(bad.status).toBe(400);
    expect(bad.raw).not.toContain('plain text');
    expect(errorEnvelopeSchema.parse(bad.body).error.code).toBe('bad_request');
  });

  it('lets batch carry bodies well over the 1 MiB default', async () => {
    const v = await alice.createVault('Bulk');
    const ops = Array.from({ length: 400 }, () => ({
      op: 'put',
      id: randomUUID(),
      ciphertext: 'v1.' + 'A'.repeat(4000),
      key_version: 1,
      base_seq: null,
    }));
    const res = await alice.req('POST', `/api/v1/vaults/${v}/items/batch`, { body: { ops } });
    expect(res.status).toBe(200);
    expect(batchResponseSchema.parse(res.body).results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('refuses oversized bodies outside rotate and batch', async () => {
    const big = 'v1.' + 'A'.repeat(2 * 1024 * 1024); // over the 1 MiB default limit
    const tooBig = await alice.req('PUT', `/api/v1/vaults/${vault}/items/${randomUUID()}`, {
      body: { ciphertext: big, key_version: 2, base_seq: null },
    });
    expect(tooBig.status).toBe(413);
    expect(errorEnvelopeSchema.parse(tooBig.body).error.code).toBe('payload_too_large');
  });
  describe('rotation, rename and limits on fresh vaults', () => {
    const vaultOf = async (who: Client, id: string) =>
      listVaultsResponseSchema
        .parse((await who.req('GET', '/api/v1/vaults')).body)
        .vaults.find((v) => v.id === id)!;
    const itemsOf = async (who: Client, id: string) =>
      listItemsResponseSchema.parse(
        (await who.req('GET', `/api/v1/vaults/${id}/items`, { query: { limit: 1000 } })).body,
      ).items;
    const liveCount = (id: string) =>
      (
        s.db
          .prepare('SELECT COUNT(*) AS n FROM items WHERE vault_id = ? AND deleted = 0')
          .get(id) as { n: number }
      ).n;

    /** Insert live items straight into the database, as if they had been written one by one. */
    function seedLiveItems(vaultId: string, count: number): { id: string; seq: number }[] {
      const first =
        (s.db.prepare("SELECT value FROM counters WHERE name = 'seq'").get() as { value: number })
          .value + 1;
      const placeholder = 'v1.' + 'A'.repeat(76);
      const insert = s.db.prepare(
        `INSERT INTO items (vault_id, id, seq, deleted, ciphertext, key_version, updated_at, updated_by)
         VALUES (?, ?, ?, 0, ?, 1, ?, ?)`,
      );
      const seeded = Array.from({ length: count }, (_, i) => ({
        id: randomUUID(),
        seq: first + i,
      }));
      s.db.transaction(() => {
        for (const item of seeded) {
          insert.run(vaultId, item.id, item.seq, placeholder, new Date().toISOString(), alice.id);
        }
        s.db.prepare("UPDATE counters SET value = ? WHERE name = 'seq'").run(first + count - 1);
      })();
      return seeded;
    }

    it('refuses a rotation built from items that were edited meanwhile, and writes nothing', async () => {
      const v = await alice.createVault('Race');
      expect((await alice.addMember(v, carol, 'editor')).status).toBe(201);
      await carol.syncKeys();
      const [one, two] = [randomUUID(), randomUUID()];
      const first = itemResponseSchema.parse((await alice.putItem(v, one, 'one', null)).body).item;
      const second = itemResponseSchema.parse((await alice.putItem(v, two, 'two', null)).body).item;

      // The owner snapshots both items to re-encrypt them; meanwhile the editor changes the first.
      const newKey = newVaultKey();
      alice.setKey(v, 2, newKey);
      const rotation = (snapshot: { id: string; seq: number }[], labels: string[]) => ({
        key_version: 2,
        name_enc: encryptVaultName(newKey, v, 'Race (rotated)'),
        members: [alice, carol].map((m) => ({
          user_id: m.id,
          wrapped_key: wrapVaultKey(newKey, m.keypair.publicKey),
        })),
        items: snapshot.map((item, i) => ({
          id: item.id,
          ciphertext: alice.encrypt(v, item.id, labels[i]!, 2),
          base_seq: item.seq,
        })),
      });
      const edited = itemResponseSchema.parse(
        (await carol.putItem(v, one, 'one edited', first.seq)).body,
      ).item;

      const url = `/api/v1/vaults/${v}/rotate`;
      const stale = await alice.req('POST', url, {
        body: rotation([first, second], ['one', 'two']),
      });
      expect(stale.status).toBe(409);
      const detail = rotateConflictResponseSchema.parse(stale.body);
      expect(detail.error.code).toBe('conflict');
      expect(detail.stale_item_ids).toEqual([one]);
      expect(detail.expected.item_ids.sort()).toEqual([one, two].sort());

      // Nothing was written: the old key, the editor's change and the other item are intact.
      expect((await vaultOf(alice, v)).key_version).toBe(1);
      const after = await itemsOf(alice, v);
      const afterOne = after.find((i) => i.id === one)!;
      const afterTwo = after.find((i) => i.id === two)!;
      expect(afterOne).toMatchObject({ seq: edited.seq, key_version: 1 });
      expect(alice.decrypt(afterOne)).toBe('one edited');
      expect(afterTwo).toMatchObject({ seq: second.seq, key_version: 1 });

      // A rotation rebuilt from the fresh state goes through and keeps the edit.
      const ok = await alice.req('POST', url, {
        body: rotation([afterOne, afterTwo], ['one edited', 'two']),
      });
      expect(ok.status).toBe(200);
      const rotated = await itemsOf(alice, v);
      expect(rotated.map((i) => i.key_version)).toEqual([2, 2]);
      expect(rotated.map((i) => alice.decrypt(i)).sort()).toEqual(['one edited', 'two']);
    });

    it('refuses to rename a vault with a key version that has been rotated away', async () => {
      const v = await alice.createVault('Rename');
      const oldKey = alice.keyFor(v);
      const newKey = newVaultKey();
      alice.setKey(v, 2, newKey);
      const rotated = await alice.req('POST', `/api/v1/vaults/${v}/rotate`, {
        body: {
          key_version: 2,
          name_enc: encryptVaultName(newKey, v, 'After rotation'),
          members: [
            { user_id: alice.id, wrapped_key: wrapVaultKey(newKey, alice.keypair.publicKey) },
          ],
          items: [],
        },
      });
      expect(rotated.status).toBe(200);

      const url = `/api/v1/vaults/${v}`;
      const stale = await alice.req('PATCH', url, {
        body: { name_enc: encryptVaultName(oldKey, v, 'Stale'), key_version: 1 },
      });
      expect(stale.status).toBe(409);
      expect(errorEnvelopeSchema.parse(stale.body).error.code).toBe('key_version_mismatch');
      expect(alice.decryptName(await vaultOf(alice, v))).toBe('After rotation');

      const missing = await alice.req('PATCH', url, {
        body: { name_enc: encryptVaultName(newKey, v, 'No version') },
      });
      expect(missing.status).toBe(400);

      const fresh = await alice.req('PATCH', url, {
        body: { name_enc: encryptVaultName(newKey, v, 'Fresh'), key_version: 2 },
      });
      expect(fresh.status).toBe(200);
      expect(alice.decryptName(await vaultOf(alice, v))).toBe('Fresh');
    });

    it('rejects item ciphertexts over the size limit with 413 payload_too_large', async () => {
      const v = await alice.createVault('Sizes');
      const body = (b64: number) => 'v1.' + 'A'.repeat(b64);
      const largest = body(Math.floor((MAX_ITEM_CIPHERTEXT_LENGTH - 3) / 4) * 4);
      const tooLong = body(Math.floor((MAX_ITEM_CIPHERTEXT_LENGTH - 3) / 4) * 4 + 4);
      expect(largest.length).toBeLessThanOrEqual(MAX_ITEM_CIPHERTEXT_LENGTH);
      expect(tooLong.length).toBeGreaterThan(MAX_ITEM_CIPHERTEXT_LENGTH);

      const put = (id: string, ciphertext: string) =>
        alice.req('PUT', `/api/v1/vaults/${v}/items/${id}`, {
          body: { ciphertext, key_version: 1, base_seq: null },
        });
      expect((await put(randomUUID(), largest)).status).toBe(200);
      const refused = await put(randomUUID(), tooLong);
      expect(refused.status).toBe(413);
      expect(errorEnvelopeSchema.parse(refused.body).error.code).toBe('payload_too_large');
      expect(liveCount(v)).toBe(1);

      // A batch with one oversized put is refused whole.
      const okId = randomUUID();
      const batch = await alice.req('POST', `/api/v1/vaults/${v}/items/batch`, {
        body: {
          ops: [
            { op: 'put', id: okId, ciphertext: largest, key_version: 1, base_seq: null },
            { op: 'put', id: randomUUID(), ciphertext: tooLong, key_version: 1, base_seq: null },
          ],
        },
      });
      expect(batch.status).toBe(413);
      expect(errorEnvelopeSchema.parse(batch.body).error.code).toBe('payload_too_large');
      expect(liveCount(v)).toBe(1);

      // So is a rotation that carries one.
      const key = newVaultKey();
      const rotate = await alice.req('POST', `/api/v1/vaults/${v}/rotate`, {
        body: {
          key_version: 2,
          name_enc: encryptVaultName(key, v, 'x'),
          members: [{ user_id: alice.id, wrapped_key: wrapVaultKey(key, alice.keypair.publicKey) }],
          items: [{ id: randomUUID(), ciphertext: tooLong, base_seq: 0 }],
        },
      });
      expect(rotate.status).toBe(413);
      expect((await vaultOf(alice, v)).key_version).toBe(1);
    });

    it('stops creating items at the live-item limit with 409 vault_full, and still rotates', async () => {
      const v = await alice.createVault('Full');
      const seeded = seedLiveItems(v, MAX_LIVE_ITEMS_PER_VAULT);
      expect(liveCount(v)).toBe(MAX_LIVE_ITEMS_PER_VAULT);

      const refused = await alice.putItem(v, randomUUID(), 'one too many', null);
      expect(refused.status).toBe(409);
      expect(errorEnvelopeSchema.parse(refused.body).error.code).toBe('vault_full');
      expect(liveCount(v)).toBe(MAX_LIVE_ITEMS_PER_VAULT);

      // In a batch the create fails on its own and the edit of an existing item still applies.
      const extraId = randomUUID();
      const batch = await alice.req('POST', `/api/v1/vaults/${v}/items/batch`, {
        body: {
          ops: [
            {
              op: 'put',
              id: extraId,
              ciphertext: alice.encrypt(v, extraId, 'extra'),
              key_version: 1,
              base_seq: null,
            },
            {
              op: 'put',
              id: seeded[1]!.id,
              ciphertext: alice.encrypt(v, seeded[1]!.id, 'edit'),
              key_version: 1,
              base_seq: seeded[1]!.seq,
            },
          ],
        },
      });
      expect(batch.status).toBe(200);
      const [created, edited] = batchResponseSchema.parse(batch.body).results;
      expect(created?.status === 'error' && created.error.code).toBe('vault_full');
      expect(edited?.status).toBe('ok');
      expect(liveCount(v)).toBe(MAX_LIVE_ITEMS_PER_VAULT);

      // Deleting frees a slot, which one create takes; a tombstone cannot be revived past it.
      const removed = await alice.req('DELETE', `/api/v1/vaults/${v}/items/${seeded[2]!.id}`, {
        query: { base_seq: seeded[2]!.seq },
      });
      expect(removed.status).toBe(200);
      const tombstone = itemResponseSchema.parse(removed.body).item;
      expect(liveCount(v)).toBe(MAX_LIVE_ITEMS_PER_VAULT - 1);
      expect((await alice.putItem(v, randomUUID(), 'fits', null)).status).toBe(200);
      const revive = await alice.putItem(v, tombstone.id, 'revived', tombstone.seq);
      expect(revive.status).toBe(409);
      expect(revive.body.error.code).toBe('vault_full');

      // A vault at the limit can still be rotated.
      const key = newVaultKey();
      const current = s.db
        .prepare('SELECT id, seq FROM items WHERE vault_id = ? AND deleted = 0')
        .all(v) as { id: string; seq: number }[];
      expect(current).toHaveLength(MAX_LIVE_ITEMS_PER_VAULT);
      const rotate = await alice.req('POST', `/api/v1/vaults/${v}/rotate`, {
        body: {
          key_version: 2,
          name_enc: encryptVaultName(key, v, 'Full (rotated)'),
          members: [{ user_id: alice.id, wrapped_key: wrapVaultKey(key, alice.keypair.publicKey) }],
          items: current.map((i) => ({
            id: i.id,
            ciphertext: 'v1.' + 'B'.repeat(76),
            base_seq: i.seq,
          })),
        },
      });
      expect(rotate.status).toBe(200);
      expect(vaultSchema.parse(rotate.body).key_version).toBe(2);
    });
  });
});
