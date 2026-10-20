import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptPrivateKey,
  deriveKeys,
  fingerprint,
  fromB64,
  publicKeyFromPrivateKey,
} from '@ternix/core/crypto';
import {
  KdfTooWeakError,
  OfflineError,
  TernixError,
  WrongPasswordError,
} from '../src/main/client/index.js';
import {
  closeClients,
  loginUser,
  makeClient,
  nextEvent,
  rawRequest,
  registerUser,
  snippet,
  startServer,
  storedSession,
  type TestServer,
  uniqueEmail,
  waitFor,
} from './helpers.js';

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  closeClients();
  await server.close();
});

describe('server probe', () => {
  it('normalizes the address and validates the server info', async () => {
    const { client } = await makeClient();
    const info = await client.probeServer(`${server.url}/`);
    expect(info).toEqual({
      serverUrl: server.url,
      name: 'Test Ternix',
      version: expect.any(String),
      registration: 'open',
      protocol: 1,
    });
  });

  it('refuses something that is not a Ternix server', async () => {
    const { client } = await makeClient();
    await expect(client.probeServer(`${server.url}/not-ternix`)).rejects.toMatchObject({
      code: 'unsupported_server',
    });
  });

  it('reports an unreachable server as offline', async () => {
    const { client } = await makeClient();
    await expect(client.probeServer('http://127.0.0.1:1')).rejects.toBeInstanceOf(OfflineError);
  });
});

describe('register, logout, login, unlock', () => {
  it('runs the full account lifecycle', async () => {
    const a = await registerUser(server, { realtime: false });
    expect(a.client.state).toBe('unlocked');
    const account = a.client.account!;
    expect(account.user.role).toBe('admin');
    expect(account.user.fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    const personal = a.client.getVault(a.personalVaultId);
    expect(personal).toMatchObject({
      kind: 'personal',
      role: 'owner',
      name: 'Personal',
      keyVersion: 1,
    });
    await a.client.putItem(a.personalVaultId, undefined, snippet('first'));

    // Logout revokes the token on the server and forgets session and cache.
    const token = (await storedSession(a)).token!;
    expect(await a.client.logout()).toEqual({ serverRevoked: true });
    expect(a.client.state).toBe('loggedOut');
    expect(await a.secretStore.get('session')).toBeUndefined();
    expect(a.cacheStore.dump()).toBe('{}');
    expect((await rawRequest(server, 'GET', '/api/v1/me', token)).status).toBe(401);

    // Wrong password at login is a typed error, and nothing is stored.
    await expect(
      a.client.login({ serverUrl: server.url, email: a.email, password: 'wrong password' }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(a.client.state).toBe('loggedOut');

    // Login (email is normalized) decrypts the account key and syncs the vaults.
    await a.client.login({
      serverUrl: server.url,
      email: `  ${a.email.toUpperCase()} `,
      password: a.password,
    });
    expect(a.client.state).toBe('unlocked');
    await a.client.sync();
    expect(a.client.listItems(a.personalVaultId).items.map((i) => i.payload)).toMatchObject([
      { type: 'snippet', label: 'first' },
    ]);

    // Lock drops the keys; unlock with a wrong then the right password.
    a.client.lock();
    expect(a.client.state).toBe('locked');
    expect(() => a.client.listVaults()).toThrow(expect.objectContaining({ code: 'locked' }));
    await expect(a.client.unlock('not it')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(a.client.state).toBe('locked');
    await a.client.unlock(a.password);
    expect(a.client.state).toBe('unlocked');
    expect(a.client.listItems(a.personalVaultId).items).toHaveLength(1);
  });

  it('unlocks offline from the saved session and cache; writes need the server', async () => {
    const a = await registerUser(server, { realtime: false });
    await a.client.putItem(a.personalVaultId, undefined, snippet('cached'));
    a.client.close();

    // A fresh process with the same stores and no network.
    const b = await makeClient({ realtime: false }, a);
    b.spy.offline = true;
    expect(b.client.state).toBe('locked');
    await b.client.unlock(a.password);
    expect(b.client.listVaults().map((v) => v.name)).toEqual(['Personal']);
    expect(b.client.listItems(a.personalVaultId).items.map((i) => i.payload)).toMatchObject([
      { label: 'cached' },
    ]);
    await expect(
      b.client.putItem(a.personalVaultId, undefined, snippet('offline write')),
    ).rejects.toBeInstanceOf(OfflineError);
    await expect(b.client.sync()).rejects.toMatchObject({ code: 'offline' });
  });

  it('caches only ciphertext and wrapped keys, never plaintext', async () => {
    const a = await registerUser(server, { realtime: false });
    const secret = 'plaintext-marker-6c1f9';
    await a.client.putItem(a.personalVaultId, undefined, {
      type: 'host',
      label: secret,
      address: 'db.internal',
      password: `${secret}-password`,
    });
    const vault = await a.client.createVault(`${secret} vault`);
    expect(vault.name).toBe(`${secret} vault`);
    const dump = a.cacheStore.dump();
    expect(dump).toContain('"ciphertext":"v1.');
    expect(dump).toContain('wrapped_key');
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain('Personal');
    const session = JSON.stringify(await storedSession(a));
    expect(session).not.toContain(a.password);
    expect(session).not.toContain(secret);
  });
});

describe('logout with realtime on', () => {
  it('does not report its own logout as a revoked session', async () => {
    const a = await registerUser(server);
    await waitFor(() => a.client.connection === 'online', 'online');
    const events: unknown[] = [];
    a.client.on('session-revoked', (e) => events.push(e));
    expect(await a.client.logout()).toEqual({ serverRevoked: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toEqual([]);
    expect(a.client.state).toBe('loggedOut');
    expect(a.client.connection).toBe('offline');
  });
});

describe('KDF downgrade', () => {
  it('refuses server KDF parameters weaker than the protocol default before sending anything', async () => {
    // The server's floor is weak in tests, so this account really has weak parameters.
    const a = await registerUser(server, { realtime: false });
    // A client with the production check (no isKdfStrongEnough override).
    const b = await makeClient({ realtime: false, isKdfStrongEnough: undefined });
    await expect(
      b.client.login({ serverUrl: server.url, email: a.email, password: a.password }),
    ).rejects.toBeInstanceOf(KdfTooWeakError);
    expect(b.spy.count('POST', '/auth/prelogin')).toBe(1);
    expect(b.spy.count('POST', '/auth/login')).toBe(0);
    expect(b.client.state).toBe('loggedOut');
  });
});

describe('session revalidation and revocation', () => {
  it('moves to expired when /me answers 401', async () => {
    const a = await registerUser(server, { realtime: false });
    const other = await loginUser(server, a.email, a.password, { realtime: false });
    await other.client.revokeDevice(a.client.account!.deviceId);

    const revoked = nextEvent(a.client, 'session-revoked');
    await expect(a.client.revalidate()).rejects.toMatchObject({ code: 'session_expired' });
    expect(await revoked).toEqual({ reason: 'expired' });
    expect(a.client.state).toBe('expired');
    expect((await storedSession(a)).token).toBeNull();
    await expect(a.client.unlock(a.password)).rejects.toMatchObject({ code: 'session_expired' });

    // Logging in again restores the session; the account (and its cache) is the same.
    await a.client.login({ serverUrl: server.url, email: a.email, password: a.password });
    expect(a.client.state).toBe('unlocked');
    expect((await a.client.revalidate()).user.email).toBe(a.email);
  });

  it('expires on session.revoked over the WebSocket', async () => {
    const a = await registerUser(server);
    await waitFor(() => a.client.connection === 'online', 'online');
    const other = await loginUser(server, a.email, a.password, { realtime: false });
    const devices = await other.client.listDevices();
    expect(devices).toHaveLength(2);
    expect(devices.filter((d) => d.current)).toHaveLength(1);

    const revoked = nextEvent(a.client, 'session-revoked');
    await other.client.revokeDevice(a.client.account!.deviceId);
    expect(await revoked).toEqual({ reason: 'revoked' });
    expect(a.client.state).toBe('expired');
    expect(a.client.connection).toBe('offline');
  });
});

describe('password change', () => {
  it('keeps vault access and revokes the other device', async () => {
    const a = await registerUser(server, { realtime: false });
    const shared = await a.client.createVault('Team');
    await a.client.putItem(shared.id, undefined, snippet('kept'));

    const other = await loginUser(server, a.email, a.password);
    await waitFor(() => other.client.connection === 'online', 'other device online');
    const revoked = nextEvent(other.client, 'session-revoked');

    await expect(a.client.changePassword('wrong', 'new password 2')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(a.spy.count('POST', '/me/password')).toBe(0);
    await a.client.changePassword(a.password, 'new password 2');

    expect(await revoked).toEqual({ reason: 'revoked' });
    expect(other.client.state).toBe('expired');

    // This device still works and unlocks only with the new password.
    a.client.lock();
    await expect(a.client.unlock(a.password)).rejects.toBeInstanceOf(WrongPasswordError);
    await a.client.unlock('new password 2');
    await a.client.sync();
    expect(a.client.listItems(shared.id).items.map((i) => i.payload)).toMatchObject([
      { label: 'kept' },
    ]);

    // A fresh login sees the same keypair and every vault.
    await expect(
      loginUser(server, a.email, a.password, { realtime: false }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    const fresh = await loginUser(server, a.email, 'new password 2', { realtime: false });
    expect(fresh.client.account!.user.publicKey).toBe(a.client.account!.user.publicKey);
    expect(fresh.client.listItems(shared.id).items.map((i) => i.payload)).toMatchObject([
      { label: 'kept' },
    ]);

    // The stored account key is under the new password and fresh KDF parameters.
    const session = await storedSession(a);
    const { masterKey } = await deriveKeys('new password 2', session.keys.kdf);
    const privateKey = decryptPrivateKey(masterKey, session.keys.encrypted_private_key);
    expect(fingerprint(publicKeyFromPrivateKey(privateKey))).toBe(
      fingerprint(fromB64(session.keys.public_key)),
    );
  });
});

describe('admin', () => {
  it('manages invites and users', async () => {
    const invServer = await startServer({ registration: 'invite' });
    try {
      const admin = await registerUser(invServer, { realtime: false });
      expect(admin.client.account!.user.role).toBe('admin');
      const email = uniqueEmail('invited');
      const invite = await admin.client.createInvite({ email, expiresInHours: 2 });
      expect(invite.code.length).toBeGreaterThan(0);
      expect((await admin.client.listInvites()).map((i) => i.code)).toContain(invite.code);

      // Without an invite: typed error with the server's code.
      await expect(registerUser(invServer, { realtime: false })).rejects.toMatchObject({
        code: 'invalid_invite',
      });
      const user = await registerUser(
        invServer,
        { realtime: false },
        { email, inviteCode: invite.code },
      );
      expect(user.client.account!.user.role).toBe('user');
      await expect(user.client.listUsers()).rejects.toMatchObject({
        code: 'forbidden',
        status: 403,
      });

      const users = await admin.client.listUsers();
      expect(users.map((u) => u.email).sort()).toEqual([admin.email, email].sort());

      const spare = await admin.client.createInvite();
      await admin.client.deleteInvite(spare.code);
      expect((await admin.client.listInvites()).map((i) => i.code)).not.toContain(spare.code);

      await admin.client.deleteUser(user.client.account!.user.id);
      expect((await admin.client.listUsers()).map((u) => u.email)).toEqual([admin.email]);
      await expect(user.client.revalidate()).rejects.toBeInstanceOf(TernixError);
      expect(user.client.state).toBe('expired');
    } finally {
      closeClients();
      await invServer.close();
    }
  });
});
