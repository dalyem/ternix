import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  deriveKeys,
  encryptPrivateKey,
  encryptVaultName,
  newVaultKey,
  toB64,
  wrapVaultKey,
} from '@ternix/core';
import {
  WS_CLOSE_UNAUTHORIZED,
  wsServerMessageSchema,
  type WsServerMessage,
} from '@ternix/core/protocol';
import { login, register, startServer, type Client, type TestServer } from './helpers.js';

class Socket {
  readonly messages: WsServerMessage[] = [];
  readonly closed: Promise<{ code: number }>;
  private waiters: (() => void)[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      this.messages.push(wsServerMessageSchema.parse(JSON.parse(data.toString())));
      this.waiters.splice(0).forEach((w) => w());
    });
    this.closed = new Promise((resolve) => this.ws.on('close', (code) => resolve({ code })));
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  async next(match: (m: WsServerMessage) => boolean, timeoutMs = 3000): Promise<WsServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.messages.findIndex(match);
      if (i >= 0) return this.messages.splice(i, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; got ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Assert nothing matching arrives within a short window. */
  async none(match: (m: WsServerMessage) => boolean, windowMs = 250): Promise<void> {
    await new Promise((r) => setTimeout(r, windowMs));
    expect(this.messages.filter(match)).toEqual([]);
  }

  close(): void {
    this.ws.close();
  }
}

const isType = (type: WsServerMessage['type']) => (m: WsServerMessage) => m.type === type;

describe('websocket', () => {
  let s: TestServer;
  let url: string;
  let alice: Client;
  let bob: Client;
  let eve: Client;
  const open: Socket[] = [];

  async function connect(client: Client | string): Promise<Socket> {
    const sock = new Socket(url);
    open.push(sock);
    await sock.opened();
    sock.send({ type: 'auth', token: typeof client === 'string' ? client : client.token });
    await sock.next(isType('ready'));
    return sock;
  }

  beforeAll(async () => {
    s = await startServer({ registration: 'open', wsAuthTimeoutMs: 300 });
    await s.app.listen({ host: '127.0.0.1', port: 0 });
    url = `ws://127.0.0.1:${(s.app.server.address() as AddressInfo).port}/api/v1/ws`;
    alice = await register(s.app, { email: 'alice@example.com' });
    bob = await register(s.app, { email: 'bob@example.com' });
    eve = await register(s.app, { email: 'eve@example.com' });
  });
  afterAll(async () => {
    open.forEach((o) => o.close());
    await s.close();
  });

  it('closes with 4401 when no auth message arrives in time', async () => {
    const sock = new Socket(url);
    open.push(sock);
    await sock.opened();
    expect((await sock.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('closes with 4401 for a bad token or a non-auth first message', async () => {
    const bad = new Socket(url);
    open.push(bad);
    await bad.opened();
    bad.send({ type: 'auth', token: 'wrong' });
    expect((await bad.closed).code).toBe(4401);

    const ping = new Socket(url);
    open.push(ping);
    await ping.opened();
    ping.send({ type: 'ping' });
    expect((await ping.closed).code).toBe(4401);

    const junk = new Socket(url);
    open.push(junk);
    await junk.opened();
    junk.send('not json');
    expect((await junk.closed).code).toBe(4401);
  });

  it('answers ready, then pong for ping', async () => {
    const sock = await connect(alice);
    sock.send({ type: 'ping' });
    await sock.next(isType('pong'));
    // The auth timeout no longer applies once authenticated.
    await new Promise((r) => setTimeout(r, 450));
    sock.send({ type: 'ping' });
    await sock.next(isType('pong'));
  });

  it('delivers vault.changed to every device of every member, and only to members', async () => {
    const vault = await alice.createVault('Realtime');
    expect((await alice.addMember(vault, bob, 'editor')).status).toBe(201);
    await bob.syncKeys();

    const alice2 = await login(s.app, 'alice@example.com', alice.password);
    const sockets = {
      alice: await connect(alice),
      alice2: await connect(alice2),
      bob: await connect(bob),
      eve: await connect(eve),
    };
    // Membership changes produced vaults.changed earlier; drain them.
    await new Promise((r) => setTimeout(r, 100));
    Object.values(sockets).forEach((sock) => (sock.messages.length = 0));

    const itemId = randomUUID();
    const put = await bob.putItem(vault, itemId, 'hello', null);
    const seq = put.body.item.seq as number;

    for (const name of ['alice', 'alice2', 'bob'] as const) {
      const msg = await sockets[name].next(isType('vault.changed'));
      expect(msg).toEqual({ type: 'vault.changed', vault_id: vault, seq });
    }
    await sockets.eve.none(isType('vault.changed'));

    // Deletes and batches notify too; a batch sends one event with the highest seq.
    const del = await bob.req('DELETE', `/api/v1/vaults/${vault}/items/${itemId}`, {
      query: { base_seq: seq },
    });
    const delSeq = del.body.item.seq as number;
    const atSeq = (n: number) => (m: WsServerMessage) => m.type === 'vault.changed' && m.seq === n;
    await sockets.alice.next(atSeq(delSeq));
    await sockets.bob.next(atSeq(delSeq));

    const a = randomUUID();
    const b = randomUUID();
    const batch = await bob.req('POST', `/api/v1/vaults/${vault}/items/batch`, {
      body: {
        ops: [a, b].map((id) => ({
          op: 'put',
          id,
          ciphertext: bob.encrypt(vault, id, id),
          key_version: 1,
          base_seq: null,
        })),
      },
    });
    const top = Math.max(...batch.body.results.map((r: { item: { seq: number } }) => r.item.seq));
    await sockets.bob.next(atSeq(top));
    await sockets.alice.next(atSeq(top));
    await sockets.bob.none(isType('vault.changed')); // one event for the whole batch

    // A failed write (stale base_seq) sends nothing.
    expect((await alice.putItem(vault, a, 'stale', 1)).status).toBe(409);
    await sockets.alice.none(isType('vault.changed'));
  });

  it('sends vaults.changed on membership changes, including to the removed member', async () => {
    const vault = await alice.createVault('Membership');
    const sa = await connect(alice);
    const sb = await connect(bob);
    sa.messages.length = 0;

    expect((await alice.addMember(vault, bob, 'viewer')).status).toBe(201);
    await sb.next(isType('vaults.changed'));
    await sa.next(isType('vaults.changed'));

    sb.messages.length = 0;
    const patch = await alice.req('PATCH', `/api/v1/vaults/${vault}/members/${bob.id}`, {
      body: { role: 'editor' },
    });
    expect(patch.status).toBe(200);
    await sb.next(isType('vaults.changed'));

    sb.messages.length = 0;
    expect((await alice.req('DELETE', `/api/v1/vaults/${vault}/members/${bob.id}`)).status).toBe(
      204,
    );
    await sb.next(isType('vaults.changed'));

    // Rename, rotate and delete reach the remaining members.
    sa.messages.length = 0;
    const key = alice.keyFor(vault);
    await alice.req('PATCH', `/api/v1/vaults/${vault}`, {
      body: { name_enc: encryptVaultName(key, vault, 'again') },
    });
    await sa.next(isType('vaults.changed'));

    sa.messages.length = 0;
    const next = newVaultKey();
    const rotated = await alice.req('POST', `/api/v1/vaults/${vault}/rotate`, {
      body: {
        key_version: 2,
        name_enc: encryptVaultName(next, vault, 'rotated'),
        members: [{ user_id: alice.id, wrapped_key: wrapVaultKey(next, alice.keypair.publicKey) }],
        items: [],
      },
    });
    expect(rotated.status).toBe(200);
    await sa.next(isType('vaults.changed'));

    sa.messages.length = 0;
    await alice.req('DELETE', `/api/v1/vaults/${vault}`);
    await sa.next(isType('vaults.changed'));
  });

  it('sends session.revoked and closes sockets when tokens are revoked', async () => {
    const owner = await register(s.app, { email: 'owner@example.com', password: 'owner pw' });
    const d2 = await login(s.app, 'owner@example.com', 'owner pw');
    const d3 = await login(s.app, 'owner@example.com', 'owner pw');
    const s1 = await connect(owner);
    const s2 = await connect(d2);
    const s3 = await connect(d3);

    // Revoke one device.
    expect((await owner.req('DELETE', `/api/v1/devices/${d3.deviceId}`)).status).toBe(204);
    await s3.next(isType('session.revoked'));
    expect((await s3.closed).code).toBe(1008);
    await s1.none(isType('session.revoked'));

    // Password change closes every other device but the one that changed it.
    const current = await deriveKeys('owner pw', owner.kdf);
    const kdf = { ...owner.kdf, salt: toB64(new Uint8Array(16).fill(3)) };
    const next = await deriveKeys('owner pw 2', kdf);
    const res = await owner.req('POST', '/api/v1/me/password', {
      body: {
        current_auth_key: toB64(current.authKey),
        new_auth_key: toB64(next.authKey),
        new_kdf: kdf,
        new_encrypted_private_key: encryptPrivateKey(next.masterKey, owner.keypair.privateKey),
      },
    });
    expect(res.status).toBe(204);
    await s2.next(isType('session.revoked'));
    expect((await s2.closed).code).toBe(1008);
    await s1.none(isType('session.revoked'));

    // A new socket cannot use a revoked token, and logout closes its own socket.
    const stale = new Socket(url);
    open.push(stale);
    await stale.opened();
    stale.send({ type: 'auth', token: d2.token });
    expect((await stale.closed).code).toBe(4401);

    expect((await owner.req('POST', '/api/v1/auth/logout')).status).toBe(204);
    await s1.next(isType('session.revoked'));
    expect((await s1.closed).code).toBe(1008);
  });

  it('disconnects a user deleted by an admin', async () => {
    const admin = alice; // first registered account on this server
    const victim = await register(s.app, { email: 'victim@example.com' });
    const sock = await connect(victim);
    expect((await admin.req('DELETE', `/api/v1/admin/users/${victim.id}`)).status).toBe(204);
    await sock.next(isType('session.revoked'));
    expect((await sock.closed).code).toBe(1008);
  });
});
