import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, fromB64 } from '@ternix/core/crypto';
import { createDispatcher } from '../src/main/ipc/dispatch.js';
import { createHandlers, type HandlerDeps } from '../src/main/ipc/handlers.js';
import { PageGate, SessionNotices } from '../src/main/ipc/pageGate.js';
import { rpcSchemas } from '../src/main/ipc/schemas.js';
import type { MessageBoxRequest } from '../src/main/app/trust.js';
import type { RpcMethodName, RpcMethods } from '../src/shared/ipc.js';
import {
  closeClients,
  type Registered,
  registerUser,
  startServer,
  type TestServer,
} from './helpers.js';

/**
 * The renderer is untrusted. These tests drive a real client and server through the IPC
 * dispatcher, as a compromised renderer would, and check what it can read and decide.
 */

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await closeClients();
  await server.close();
});

const HOST_PASSWORD = 'host-password-Q7';
const IDENTITY_PASSWORD = 'identity-password-W3';
const PASSPHRASE = 'passphrase-E9';
const PRIVATE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA-SECRET-KEY-BODY\n-----END OPENSSH PRIVATE KEY-----\n';
const SECRETS = [HOST_PASSWORD, IDENTITY_PASSWORD, PASSPHRASE, 'SECRET-KEY-BODY'];

/** Answers every native dialog with `answer` and records what it was asked. */
function fakeDialog(answer: { response: number; checkboxChecked?: boolean } = { response: 0 }) {
  const asked: MessageBoxRequest[] = [];
  const box = vi.fn(async (request: MessageBoxRequest) => {
    asked.push(request);
    return { response: answer.response, checkboxChecked: answer.checkboxChecked ?? false };
  });
  return { box, asked, answer };
}

function ipcFor(t: Registered, dialog = fakeDialog()) {
  const ssh = {
    cancelAllPrompts: vi.fn(),
    forgetAccount: vi.fn(),
    closeAll: vi.fn(async () => undefined),
    displayItems: <T>(vault: T) => vault,
  };
  const handlers = createHandlers({
    client: t.client,
    ssh,
    serverAddress: { get: () => null, set: async () => undefined },
    notices: new SessionNotices(),
    pages: new PageGate(() => undefined),
    messageBox: dialog.box,
  } as unknown as HandlerDeps);
  const dispatch = createDispatcher(rpcSchemas, handlers);
  const call = async <K extends RpcMethodName>(method: K, arg?: RpcMethods[K]['in']) => {
    const result = await dispatch(method, arg);
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
    return result.value as RpcMethods[K]['out'];
  };
  const failure = async (method: string, arg?: unknown) => {
    const result = await dispatch(method, arg);
    expect(result.ok, `${method} should fail`).toBe(false);
    return result.ok ? undefined! : result.error;
  };
  return { call, failure, dispatch, dialog };
}

async function withSecrets() {
  const a = await registerUser(server, { realtime: false });
  const ipc = ipcFor(a);
  const vaultId = a.personalVaultId;
  const key = await ipc.call('items.put', {
    vaultId,
    draft: { type: 'ssh_key', label: 'key', private_key: PRIVATE_KEY, passphrase: PASSPHRASE },
  });
  const identity = await ipc.call('items.put', {
    vaultId,
    draft: { type: 'identity', label: 'me', username: 'me', password: IDENTITY_PASSWORD },
  });
  const host = await ipc.call('items.put', {
    vaultId,
    draft: {
      type: 'host',
      label: 'box',
      address: 'box.example.com',
      password: HOST_PASSWORD,
      key_id: key.id,
      identity_id: identity.id,
    },
  });
  return { a, ipc, vaultId, keyId: key.id, identityId: identity.id, hostId: host.id };
}

describe('item secrets over IPC', () => {
  it('lists items without secret values, with presence flags', async () => {
    const { a, ipc, keyId, identityId, hostId } = await withSecrets();
    const all = await ipc.call('items.all');
    const text = JSON.stringify(all);
    for (const secret of SECRETS) expect(text).not.toContain(secret);

    const items = new Map(all.flatMap((v) => v.items).map((i) => [i.id, i.payload]));
    expect(items.get(hostId)).toMatchObject({ type: 'host', label: 'box', has_password: true });
    expect(items.get(hostId)).not.toHaveProperty('password');
    expect(items.get(identityId)).toMatchObject({ has_password: true, username: 'me' });
    expect(items.get(keyId)).toMatchObject({ has_private_key: true, has_passphrase: true });
    expect(items.get(keyId)).not.toHaveProperty('private_key');
    expect(items.get(keyId)).not.toHaveProperty('passphrase');

    // The write results carry no secrets either.
    const written = await ipc.call('items.put', {
      vaultId: a.personalVaultId,
      draft: { type: 'host', label: 'other', address: 'o.example.com', password: HOST_PASSWORD },
    });
    expect(JSON.stringify(written)).not.toContain(HOST_PASSWORD);
  });

  it('reveals the secret fields of one item', async () => {
    const { ipc, vaultId, keyId, hostId } = await withSecrets();
    expect(await ipc.call('items.reveal', { vaultId, itemId: keyId })).toEqual({
      private_key: PRIVATE_KEY,
      passphrase: PASSPHRASE,
    });
    expect(await ipc.call('items.reveal', { vaultId, itemId: hostId })).toEqual({
      password: HOST_PASSWORD,
    });
    const missing = await ipc.failure('items.reveal', {
      vaultId,
      itemId: '3f1c9a52-8e6b-4d0a-9b7e-0a1b2c3d4e5f',
    });
    expect(missing.code).toBe('not_found');
  });

  it('keeps a secret field the edit leaves out, and clears it on null or empty', async () => {
    const { a, ipc, vaultId, keyId, hostId } = await withSecrets();
    const stored = () => a.client.getItem(vaultId, hostId)!.payload;

    // The renderer never had the password: an edit without it keeps it.
    await ipc.call('items.put', {
      vaultId,
      itemId: hostId,
      draft: { type: 'host', label: 'renamed', address: 'box.example.com' },
    });
    expect(stored()).toMatchObject({ label: 'renamed', password: HOST_PASSWORD });

    await ipc.call('items.put', {
      vaultId,
      itemId: hostId,
      draft: { type: 'host', label: 'renamed', address: 'box.example.com', password: 'new-pw' },
    });
    expect(stored()).toMatchObject({ password: 'new-pw' });

    await ipc.call('items.put', {
      vaultId,
      itemId: hostId,
      draft: { type: 'host', label: 'renamed', address: 'box.example.com', password: null },
    });
    expect(stored()).not.toHaveProperty('password');

    // ssh_key: an untouched private key and passphrase survive a relabel; '' clears the
    // optional passphrase; the required private key cannot be cleared.
    await ipc.call('items.put', {
      vaultId,
      itemId: keyId,
      draft: { type: 'ssh_key', label: 'relabelled', passphrase: '' },
    });
    expect(a.client.getItem(vaultId, keyId)!.payload).toEqual(
      expect.objectContaining({ label: 'relabelled', private_key: PRIVATE_KEY }),
    );
    expect(a.client.getItem(vaultId, keyId)!.payload).not.toHaveProperty('passphrase');
    const cleared = await ipc.failure('items.put', {
      vaultId,
      itemId: keyId,
      draft: { type: 'ssh_key', label: 'relabelled', private_key: null },
    });
    expect(cleared.code).toBe('invalid_input');
    // A new key needs its private key.
    expect(
      (await ipc.failure('items.put', { vaultId, draft: { type: 'ssh_key', label: 'k' } })).code,
    ).toBe('invalid_input');
  });

  it('keeps the detected OS through an edit that leaves it out, unless the address changed', async () => {
    const { a, ipc, vaultId, hostId } = await withSecrets();
    const stored = () => a.client.getItem(vaultId, hostId)!.payload;
    // Main stores what it detected (as SshManager does, through the client).
    const { updated_at: _stamp, ...payload } = stored();
    await a.client.putItem(vaultId, hostId, { ...payload, os: 'ubuntu' } as never);
    expect((await ipc.call('items.all')).flatMap((v) => v.items)).toContainEqual(
      expect.objectContaining({ id: hostId, payload: expect.objectContaining({ os: 'ubuntu' }) }),
    );

    // The editor does not send `os`: a relabel keeps it, with the password.
    await ipc.call('items.put', {
      vaultId,
      itemId: hostId,
      draft: { type: 'host', label: 'renamed', address: 'BOX.example.com' },
    });
    expect(stored()).toMatchObject({ label: 'renamed', os: 'ubuntu', password: HOST_PASSWORD });

    // An explicit value wins (an import, a test seeding hosts).
    await ipc.call('items.put', {
      vaultId,
      itemId: hostId,
      draft: { type: 'host', label: 'renamed', address: 'box.example.com', os: 'debian' },
    });
    expect(stored()).toMatchObject({ os: 'debian' });

    // A new address may be another machine: the stale OS goes.
    await ipc.call('items.put', {
      vaultId,
      itemId: hostId,
      draft: { type: 'host', label: 'renamed', address: 'other.example.com' },
    });
    expect(stored()).not.toHaveProperty('os');

    // A value this version does not know is dropped, not stored and not an error.
    await ipc.call('items.put', {
      vaultId,
      itemId: hostId,
      draft: { type: 'host', label: 'renamed', address: 'other.example.com', os: 'haiku' } as never,
    });
    expect(stored()).not.toHaveProperty('os');
  });

  it('does not carry secrets over to another item type', async () => {
    const { a, ipc, vaultId, identityId } = await withSecrets();
    await ipc.call('items.put', {
      vaultId,
      itemId: identityId,
      draft: { type: 'host', label: 'was identity', address: 'x.example.com' },
    });
    expect(a.client.getItem(vaultId, identityId)!.payload).not.toHaveProperty('password');
  });

  it('refuses to create or overwrite known_host items, but deletes them', async () => {
    const a = await registerUser(server, { realtime: false });
    const ipc = ipcFor(a);
    const vaultId = a.personalVaultId;
    const knownHost = {
      type: 'known_host' as const,
      host: 'evil.example.com',
      port: 22,
      key_type: 'ssh-ed25519',
      public_key: 'AAAAC3NzaC1lZDI1NTE5AAAAIA==',
    };
    const created = await ipc.failure('items.put', { vaultId, draft: knownHost });
    expect(created.code).toBe('forbidden');
    expect(a.client.listItems(vaultId).items).toHaveLength(0);

    // One saved by main (after the host-key dialog), which the renderer then tries to change.
    const saved = await a.client.putItem(vaultId, undefined, knownHost);
    const replaced = await ipc.failure('items.put', {
      vaultId,
      itemId: saved.id,
      draft: { ...knownHost, public_key: 'AAAAC3NzaC1lZDI1NTE5AAAAIQ==' },
    });
    expect(replaced.code).toBe('forbidden');
    const retyped = await ipc.failure('items.put', {
      vaultId,
      itemId: saved.id,
      draft: { type: 'snippet', label: 'x', script: '' },
    });
    expect(retyped.code).toBe('forbidden');
    expect(a.client.getItem(vaultId, saved.id)!.payload).toMatchObject(knownHost);

    expect((await ipc.call('items.delete', { vaultId, itemId: saved.id })).status).toBe('saved');
    expect(a.client.getItem(vaultId, saved.id)).toBeNull();
  });
});

describe('server probe', () => {
  it('is refused while signed in, locked or unlocked', async () => {
    const a = await registerUser(server, { realtime: false });
    const ipc = ipcFor(a);
    const before = a.spy.calls.length;
    const unlocked = await ipc.failure('server.probe', { address: 'https://attacker.example/x' });
    expect(unlocked.code).toBe('forbidden');
    await a.client.lock();
    const locked = await ipc.failure('server.probe', { address: 'https://attacker.example/x' });
    expect(locked.code).toBe('forbidden');
    expect(a.spy.calls.length).toBe(before);

    await a.client.logout();
    expect(await ipc.call('server.probe', { address: server.url })).toMatchObject({
      serverUrl: server.url,
    });
  });
});

describe('member trust decisions are main-owned', () => {
  async function pair(dialog = fakeDialog()) {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    return { a, b, vault, ipc: ipcFor(a, dialog), dialog };
  }
  const membersOf = async (t: Registered, vaultId: string) =>
    (await t.client.listMembers(vaultId)).map((m) => m.email).sort();

  it('adds a member only after the native dialog, which shows email and fingerprint', async () => {
    const { a, b, vault, ipc, dialog } = await pair();
    const found = await ipc.call('vaults.lookupUser', { email: b.email });
    const add = {
      vaultId: vault.id,
      userId: found.id,
      role: 'editor' as const,
      expectedPublicKey: found.publicKey,
    };

    // Declined (the default and cancel button): nothing is sent.
    const declined = await ipc.failure('vaults.addMember', add);
    expect(declined.code).toBe('cancelled');
    expect(await membersOf(a, vault.id)).toEqual([a.email]);
    const asked = dialog.asked.at(-1)!;
    expect(asked.message).toContain(b.email);
    expect(asked.detail).toContain(fingerprint(fromB64(found.publicKey)));
    expect(asked.defaultId).toBe(asked.cancelId);
    expect(asked.buttons[asked.defaultId]).toBe('Cancel');

    dialog.answer.response = 1;
    await ipc.call('vaults.addMember', add);
    expect(await membersOf(a, vault.id)).toEqual([a.email, b.email].sort());
  });

  it('refuses to add someone main never saw, without asking', async () => {
    const { a, b, vault, dialog } = await pair(fakeDialog({ response: 1 }));
    // A fresh IPC table: the renderer skips the lookup and names a user and key itself.
    const ipc = ipcFor(a, dialog);
    const userId = b.client.account!.user.id;
    const refused = await ipc.failure('vaults.addMember', {
      vaultId: vault.id,
      userId,
      role: 'owner',
      expectedPublicKey: b.client.account!.user.publicKey,
    });
    expect(refused.code).toBe('invalid_input');
    expect(dialog.box).not.toHaveBeenCalled();
  });

  it('marks a member verified and accepts a key only after the native dialog', async () => {
    const { a, b, vault, dialog } = await pair(fakeDialog({ response: 1 }));
    const ipc = ipcFor(a, dialog);
    const found = await ipc.call('vaults.lookupUser', { email: b.email });
    await a.client.addMember(vault.id, found.id, 'viewer', found.publicKey);
    await b.client.sync();
    // Bob sees Alice only in the member list: pinned, unverified.
    const bob = ipcFor(b, fakeDialog({ response: 0 }));
    const alice = (await bob.call('vaults.members', { vaultId: vault.id })).find(
      (m) => m.email === a.email,
    )!;
    expect(alice.verified).toBe(false);

    const declined = await bob.failure('vaults.markMemberVerified', {
      userId: alice.userId,
      publicKey: alice.publicKey,
    });
    expect(declined.code).toBe('cancelled');
    expect(bob.dialog.asked.at(-1)!.detail).toContain(alice.fingerprint);
    expect((await b.client.listMembers(vault.id)).find((m) => m.email === a.email)!.verified).toBe(
      false,
    );

    const refusedAccept = await bob.failure('vaults.acceptMemberKey', {
      userId: alice.userId,
      publicKey: alice.publicKey,
    });
    expect(refusedAccept.code).toBe('cancelled');
    expect((await b.client.listMembers(vault.id)).find((m) => m.email === a.email)!.verified).toBe(
      false,
    );

    bob.dialog.answer.response = 1;
    await bob.call('vaults.markMemberVerified', {
      userId: alice.userId,
      publicKey: alice.publicKey,
    });
    expect((await b.client.listMembers(vault.id)).find((m) => m.email === a.email)!.verified).toBe(
      true,
    );
  });

  it('has no IPC method through which the renderer answers a host-key prompt', async () => {
    expect(Object.keys(rpcSchemas)).not.toContain('ssh.answerHostKey');
    const a = await registerUser(server, { realtime: false });
    const result = await ipcFor(a).dispatch('ssh.answerHostKey', {
      promptId: '3f1c9a52-8e6b-4d0a-9b7e-0a1b2c3d4e5f',
      decision: 'trust',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});
