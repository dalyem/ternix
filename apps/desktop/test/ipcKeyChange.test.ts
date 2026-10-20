import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, fromB64 } from '@ternix/core/crypto';
import { UnexpectedRedirectError } from '../src/main/client/index.js';
import { errorToDto } from '../src/main/app/errors.js';
import { createDispatcher } from '../src/main/ipc/dispatch.js';
import { createHandlers, type HandlerDeps } from '../src/main/ipc/handlers.js';
import { PageGate, SessionNotices } from '../src/main/ipc/pageGate.js';
import { rpcSchemas } from '../src/main/ipc/schemas.js';
import type { RpcMethodName, RpcMethods } from '../src/shared/ipc.js';
import {
  closeClients,
  type Registered,
  registerUser,
  startServer,
  substituteKey,
  type TestServer,
} from './helpers.js';

/**
 * The renderer only sees what crosses the IPC layer. These tests drive a real client and a
 * real server through the dispatcher the app uses, with a server that swaps a member's key,
 * and check what the renderer gets back and what the server was sent.
 */

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

function ipcFor(t: Registered) {
  const ssh = { cancelAllPrompts: vi.fn(), closeAll: vi.fn(async () => undefined) };
  // The user approves every native trust dialog here; ipcSecurity.test.ts covers declining.
  const messageBox = vi.fn(async () => ({ response: 1, checkboxChecked: false }));
  const handlers = createHandlers({
    client: t.client,
    ssh,
    serverAddress: { get: () => null, set: async () => undefined },
    notices: new SessionNotices(),
    pages: new PageGate(() => undefined),
    messageBox,
  } as unknown as HandlerDeps);
  const dispatch = createDispatcher(rpcSchemas, handlers);
  const call = async <K extends RpcMethodName>(method: K, arg?: RpcMethods[K]['in']) => {
    const result = await dispatch(method, arg);
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
    return result.value as RpcMethods[K]['out'];
  };
  const failure = async <K extends RpcMethodName>(method: K, arg?: RpcMethods[K]['in']) => {
    const result = await dispatch(method, arg);
    expect(result.ok, `${method} should fail`).toBe(false);
    return result.ok ? undefined! : result.error;
  };
  return { call, failure, ssh };
}

async function team() {
  const a = await registerUser(server, { realtime: false });
  const b = await registerUser(server, { realtime: false });
  const vault = await a.client.createVault('Team');
  const found = await a.client.lookupUser(b.email);
  await a.client.addMember(vault.id, found.id, 'editor', found.publicKey);
  return { a, b, vault, ipc: ipcFor(a) };
}

describe('key pinning over IPC', () => {
  it('returns the key change of a refused rotation, sends nothing, and proceeds after accepting', async () => {
    const { a, b, vault, ipc } = await team();
    const evil = substituteKey(server, idOf(b));

    const error = await ipc.failure('vaults.rotate', { vaultId: vault.id });
    expect(error).toMatchObject({
      code: 'member_key_changed',
      keyChange: {
        userId: idOf(b),
        email: b.email,
        pinnedFingerprint: b.client.account!.user.fingerprint,
        serverFingerprint: fp(evil),
      },
    });
    expect(a.spy.count('POST', '/rotate')).toBe(0);

    // The member list tells the renderer which key to accept.
    const members = await ipc.call('vaults.members', { vaultId: vault.id });
    const changed = members.find((m) => m.userId === idOf(b))!;
    expect(changed).toMatchObject({ keyChanged: true, publicKey: evil, fingerprint: fp(evil) });

    await ipc.call('vaults.acceptMemberKey', { userId: idOf(b), publicKey: evil });
    expect((await ipc.call('vaults.rotate', { vaultId: vault.id })).keyVersion).toBe(2);
    expect(a.spy.count('POST', '/rotate')).toBe(1);
  });

  it('carries the key change in the rotationError of removeMember', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const c = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    for (const who of [b, c]) {
      const found = await a.client.lookupUser(who.email);
      await a.client.addMember(vault.id, found.id, 'editor', found.publicKey);
    }
    const evil = substituteKey(server, idOf(c));
    const ipc = ipcFor(a);

    const result = await ipc.call('vaults.removeMember', { vaultId: vault.id, userId: idOf(b) });
    expect(result.rotated).toBe(false);
    expect(result.rotationError).toMatchObject({
      code: 'member_key_changed',
      keyChange: { userId: idOf(c), email: c.email, serverFingerprint: fp(evil) },
    });
    expect(a.spy.count('POST', '/rotate')).toBe(0);
  });

  it('refuses addMember for a changed key until accepted, then adds', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    const first = await a.client.lookupUser(b.email);
    await a.client.addMember(vault.id, first.id, 'editor', first.publicKey);
    await a.client.removeMember(vault.id, first.id);
    const evil = substituteKey(server, idOf(b));
    const ipc = ipcFor(a);

    const found = await ipc.call('vaults.lookupUser', { email: b.email });
    expect(found).toMatchObject({ keyChanged: true, verified: true, publicKey: evil });
    const add = { vaultId: vault.id, userId: found.id, role: 'viewer' as const };
    const error = await ipc.failure('vaults.addMember', {
      ...add,
      expectedPublicKey: found.publicKey,
    });
    expect(error).toMatchObject({
      code: 'member_key_changed',
      keyChange: { userId: found.id, serverFingerprint: found.fingerprint },
    });

    await ipc.call('vaults.acceptMemberKey', { userId: found.id, publicKey: found.publicKey });
    const added = await ipc.call('vaults.addMember', {
      ...add,
      expectedPublicKey: found.publicKey,
    });
    expect(added).toMatchObject({ keyChanged: false, verified: true, publicKey: evil });
  });

  it('marks a member verified only for the key that was compared', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const c = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    const foundB = await a.client.lookupUser(b.email);
    await a.client.addMember(vault.id, foundB.id, 'owner', foundB.publicKey);
    await b.client.sync();
    const foundC = await b.client.lookupUser(c.email);
    await b.client.addMember(vault.id, foundC.id, 'editor', foundC.publicKey);
    const ipc = ipcFor(a);

    const unverified = (await ipc.call('vaults.members', { vaultId: vault.id })).find(
      (m) => m.userId === idOf(c),
    )!;
    expect(unverified).toMatchObject({ verified: false, keyChanged: false });

    await ipc.call('vaults.markMemberVerified', {
      userId: idOf(c),
      publicKey: unverified.publicKey,
    });
    const marked = (await ipc.call('vaults.members', { vaultId: vault.id })).find(
      (m) => m.userId === idOf(c),
    )!;
    expect(marked).toMatchObject({ verified: true, keyChanged: false });

    // The server swaps the key; the user compares the new fingerprint and tries to mark it,
    // but the pin is still the old key: that is a key change, not a verification.
    const evil = substituteKey(server, idOf(c));
    const error = await ipc.failure('vaults.markMemberVerified', {
      userId: idOf(c),
      publicKey: evil,
    });
    expect(error).toMatchObject({
      code: 'member_key_changed',
      keyChange: { userId: idOf(c), serverFingerprint: fp(evil) },
    });
    const after = (await ipc.call('vaults.members', { vaultId: vault.id })).find(
      (m) => m.userId === idOf(c),
    )!;
    expect(after).toMatchObject({ verified: true, keyChanged: true, publicKey: evil });
  });

  it('reports own_key_mismatch as a stable code', async () => {
    const a = await registerUser(server, { realtime: false });
    substituteKey(server, idOf(a));
    const ipc = ipcFor(a);
    expect(await ipc.failure('account.revalidate')).toMatchObject({ code: 'own_key_mismatch' });
  });
});

describe('IPC lifecycle and errors', () => {
  it('auth.lock returns once the client is locked and prompts are cancelled', async () => {
    const a = await registerUser(server, { realtime: false });
    const ipc = ipcFor(a);
    await ipc.call('auth.lock');
    expect(a.client.state).toBe('locked');
    expect(ipc.ssh.cancelAllPrompts).toHaveBeenCalled();
  });

  it('keeps the location of an unexpected redirect', () => {
    const dto = errorToDto(new UnexpectedRedirectError('https://ternix.example.ts.net/'));
    expect(dto).toMatchObject({
      code: 'unexpected_redirect',
      location: 'https://ternix.example.ts.net/',
    });
    expect(errorToDto(new UnexpectedRedirectError(null))).not.toHaveProperty('location');
  });

  it('flags tailnet addresses on probe without relaxing the https rule', async () => {
    const a = await registerUser(server, { realtime: false });
    const ipc = ipcFor(a);
    await ipc.call('auth.logout'); // probing is for the signed-out setup screen only
    expect(await ipc.call('server.probe', { address: server.url })).toMatchObject({
      serverUrl: server.url,
      tailnet: false,
    });
    expect(
      await ipc.failure('server.probe', { address: 'http://box.tail1234.ts.net' }),
    ).toMatchObject({ code: 'invalid_server_url' });
  });
});
