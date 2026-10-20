import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprint, fromB64 } from '@ternix/core/crypto';
import {
  MemberKeyChangedError,
  OwnKeyMismatchError,
  toErrorDto,
} from '../src/main/client/index.js';
import { pinsKey } from '../src/main/client/pins.js';
import { accountKey } from '../src/main/client/session.js';
import {
  closeClients,
  makeClient,
  type Registered,
  registerUser,
  snippet,
  startServer,
  substituteKey,
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

const fp = (publicKey: string): string => fingerprint(fromB64(publicKey));
const idOf = (t: Registered): string => t.client.account!.user.id;

async function share(
  owner: Registered,
  vaultId: string,
  member: Registered,
  role: 'editor' | 'viewer' | 'owner' = 'editor',
) {
  const found = await owner.client.lookupUser(member.email);
  return owner.client.addMember(vaultId, found.id, role, found.publicKey);
}

const member = async (t: Registered, vaultId: string, who: Registered) =>
  (await t.client.listMembers(vaultId)).find((m) => m.userId === idOf(who))!;

/** The pins a device saved, as the secret store holds them. */
async function savedPins(
  t: Pick<Registered, 'secretStore'>,
  account: { serverUrl: string; user: { id: string } },
): Promise<Record<string, unknown> | undefined> {
  const doc = (await t.secretStore.get(pinsKey(accountKey(account.serverUrl, account.user.id)))) as
    { pins: Record<string, unknown> } | undefined;
  return doc?.pins;
}

describe('key pinning', () => {
  it('pins your own key as verified at register', async () => {
    const a = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    expect(await member(a, vault.id, a)).toMatchObject({
      isSelf: true,
      verified: true,
      keyChanged: false,
      pinnedFingerprint: a.client.account!.user.fingerprint,
    });
    expect(await savedPins(a, a.client.account!)).toMatchObject({
      [idOf(a)]: { public_key: a.client.account!.user.publicKey, verified: true },
    });
  });

  it('pins a member added by this device as verified, and unknown members as unverified', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const c = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    const added = await share(a, vault.id, b, 'owner');
    expect(added).toMatchObject({ verified: true, keyChanged: false });

    // B adds C; A never saw C's fingerprint, so trust on first use only.
    await b.client.sync();
    await share(b, vault.id, c);
    const seen = await member(a, vault.id, c);
    expect(seen).toMatchObject({
      verified: false,
      keyChanged: false,
      pinnedFingerprint: seen.fingerprint,
    });
    expect(await member(a, vault.id, b)).toMatchObject({ verified: true });
    expect((await savedPins(a, a.client.account!))![idOf(c)]).toMatchObject({ verified: false });

    // The user compares the fingerprint with C and marks it.
    await a.client.markMemberVerified(idOf(c), seen.publicKey);
    expect(await member(a, vault.id, c)).toMatchObject({ verified: true });
  });

  it('refuses to rotate when the server substituted a member key, and sends nothing', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    await a.client.putItem(vault.id, undefined, snippet('x'));
    await share(a, vault.id, b);
    const pinned = b.client.account!.user;
    const evil = substituteKey(server, idOf(b));

    const err = await a.client.rotateVault(vault.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemberKeyChangedError);
    expect(err).toMatchObject({
      code: 'member_key_changed',
      change: {
        userId: pinned.id,
        email: b.email,
        pinnedFingerprint: pinned.fingerprint,
        serverFingerprint: fp(evil),
      },
    });
    expect(toErrorDto(err)).toMatchObject({
      code: 'member_key_changed',
      keyChange: { userId: pinned.id, pinnedFingerprint: pinned.fingerprint },
    });
    expect(a.spy.count('POST', '/rotate')).toBe(0);
    expect(a.client.getVault(vault.id).keyVersion).toBe(1);

    // The member list shows the change instead of throwing.
    expect(await member(a, vault.id, b)).toMatchObject({
      keyChanged: true,
      verified: true,
      publicKey: evil,
      fingerprint: fp(evil),
      pinnedFingerprint: pinned.fingerprint,
    });

    // After the fingerprint is verified out of band, rotation goes through.
    await a.client.acceptMemberKey(pinned.id, evil);
    expect(await member(a, vault.id, b)).toMatchObject({ keyChanged: false, verified: true });
    expect((await a.client.rotateVault(vault.id)).keyVersion).toBe(2);
    expect(a.spy.count('POST', '/rotate')).toBe(1);
  });

  it('reports a key change from the rotation after removeMember and sends no rotate', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const c = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    await share(a, vault.id, b);
    await share(a, vault.id, c);
    const evil = substituteKey(server, idOf(c));

    const result = await a.client.removeMember(vault.id, idOf(b));
    expect(result.rotated).toBe(false);
    expect(result.rotationError).toMatchObject({
      code: 'member_key_changed',
      keyChange: {
        userId: idOf(c),
        email: c.email,
        pinnedFingerprint: c.client.account!.user.fingerprint,
        serverFingerprint: fp(evil),
      },
    });
    expect(a.spy.count('POST', '/rotate')).toBe(0);
    // B is gone but the key was not rotated.
    expect(a.client.getVault(vault.id)).toMatchObject({ keyVersion: 1, memberCount: 2 });

    await a.client.acceptMemberKey(idOf(c), evil);
    expect((await a.client.rotateVault(vault.id)).keyVersion).toBe(2);
  });

  it('refuses to add a member whose key differs from an earlier pin', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    await share(a, vault.id, b);
    await a.client.removeMember(vault.id, idOf(b));
    const evil = substituteKey(server, idOf(b));

    const found = await a.client.lookupUser(b.email);
    expect(found).toMatchObject({
      keyChanged: true,
      verified: true,
      pinnedFingerprint: b.client.account!.user.fingerprint,
      publicKey: evil,
    });
    const adds = a.spy.count('POST', '/members');
    await expect(
      a.client.addMember(vault.id, found.id, 'editor', found.publicKey),
    ).rejects.toMatchObject({
      code: 'member_key_changed',
      change: { userId: found.id, serverFingerprint: found.fingerprint },
    });
    expect(a.spy.count('POST', '/members')).toBe(adds);

    await a.client.acceptMemberKey(found.id, found.publicKey);
    const added = await a.client.addMember(vault.id, found.id, 'editor', found.publicKey);
    expect(added).toMatchObject({ verified: true, keyChanged: false, publicKey: evil });
  });

  it('treats a changed own key as a hard error everywhere the server reports it', async () => {
    const a = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    const evil = substituteKey(server, idOf(a));
    const before = a.client.account!.user.publicKey;

    await expect(a.client.revalidate()).rejects.toBeInstanceOf(OwnKeyMismatchError);
    await expect(a.client.revalidate()).rejects.toMatchObject({ code: 'own_key_mismatch' });
    await expect(a.client.listMembers(vault.id)).rejects.toMatchObject({
      code: 'own_key_mismatch',
    });
    await expect(a.client.lookupUser(a.email)).rejects.toMatchObject({ code: 'own_key_mismatch' });
    await expect(a.client.listUsers()).rejects.toMatchObject({ code: 'own_key_mismatch' });
    await expect(a.client.rotateVault(vault.id)).rejects.toMatchObject({
      code: 'own_key_mismatch',
    });
    expect(a.spy.count('POST', '/rotate')).toBe(0);
    // The saved account is untouched.
    expect(a.client.account!.user.publicKey).toBe(before);
    expect(before).not.toBe(evil);
  });

  it('keeps pins across lock, unlock and restart; logout clears them', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    await share(a, vault.id, b);
    expect(await savedPins(a, a.client.account!)).toHaveProperty(idOf(b));
    const evil = substituteKey(server, idOf(b));

    await a.client.lock();
    await a.client.unlock(a.password);
    await expect(a.client.rotateVault(vault.id)).rejects.toMatchObject({
      code: 'member_key_changed',
    });

    // A new process with the same stores still remembers.
    await a.client.close();
    const restarted = await makeClient({ realtime: false }, a);
    await restarted.client.unlock(a.password);
    await expect(restarted.client.rotateVault(vault.id)).rejects.toMatchObject({
      code: 'member_key_changed',
    });
    expect(restarted.spy.count('POST', '/rotate')).toBe(0);

    // Logout forgets the pins; the next login starts from trust on first use.
    const account = restarted.client.account!;
    await restarted.client.logout();
    expect(await savedPins(restarted, account)).toBeUndefined();
    await restarted.client.login({ serverUrl: server.url, email: a.email, password: a.password });
    await restarted.client.sync();
    const members = await restarted.client.listMembers(vault.id);
    expect(members.find((m) => m.userId === idOf(b))).toMatchObject({
      keyChanged: false,
      verified: false,
      publicKey: evil,
    });
    expect((await restarted.client.rotateVault(vault.id)).keyVersion).toBe(2);
  });

  it('validates acceptMemberKey and markMemberVerified', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    await expect(a.client.acceptMemberKey(idOf(b), 'not a key')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      a.client.acceptMemberKey(idOf(a), b.client.account!.user.publicKey),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      a.client.markMemberVerified(idOf(b), b.client.account!.user.publicKey),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
