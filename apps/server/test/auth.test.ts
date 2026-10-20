import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys, encryptPrivateKey, fakeKdfForEmail, toB64 } from '@ternix/core';
import {
  errorEnvelopeSchema,
  listDevicesResponseSchema,
  listInvitesResponseSchema,
  listUsersResponseSchema,
  loginResponseSchema,
  lookupUserResponseSchema,
  meResponseSchema,
  preloginResponseSchema,
  registerResponseSchema,
  serverInfoSchema,
} from '@ternix/core/protocol';
import {
  call,
  createInvite,
  login,
  register,
  registerRaw,
  SECRET,
  startServer,
  type Client,
  type TestServer,
} from './helpers.js';

describe('server info', () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(() => s.close());

  it('GET /api/v1/server is public and matches the schema', async () => {
    const res = await call(s.app, 'GET', '/api/v1/server');
    expect(res.status).toBe(200);
    const info = serverInfoSchema.parse(res.body);
    expect(info).toMatchObject({ name: 'Test Ternix', registration: 'invite', protocol: 1 });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('unknown routes return the error envelope', async () => {
    const res = await call(s.app, 'GET', '/api/v1/nope');
    expect(res.status).toBe(404);
    expect(errorEnvelopeSchema.parse(res.body).error.code).toBe('not_found');
  });

  it('rejects requests without a valid token', async () => {
    for (const path of ['/api/v1/me', '/api/v1/vaults', '/api/v1/devices', '/api/v1/admin/users']) {
      const res = await call(s.app, 'GET', path);
      expect(res.status, path).toBe(401);
      expect(errorEnvelopeSchema.parse(res.body).error.code).toBe('unauthorized');
    }
    const bad = await call(s.app, 'GET', '/api/v1/me', { token: 'not-a-real-token' });
    expect(bad.status).toBe(401);
  });
});

describe('registration', () => {
  it('the first account becomes admin even when registration is closed', async () => {
    const s = await startServer({ registration: 'closed' });
    try {
      const admin = await register(s.app, { email: 'Admin@Example.com ' });
      expect(admin.user.role).toBe('admin');
      expect(admin.user.email).toBe('admin@example.com');
      const second = await registerRaw(s.app);
      expect(second.res.status).toBe(403);
      expect(errorEnvelopeSchema.parse(second.res.body).error.code).toBe('registration_closed');
    } finally {
      await s.close();
    }
  });

  it('enforces invite mode, and single-use, bound, expiring invites', async () => {
    const s = await startServer({ registration: 'invite' });
    try {
      const admin = await register(s.app);

      const noCode = await registerRaw(s.app);
      expect(noCode.res.status).toBe(400);
      expect(noCode.res.body.error.code).toBe('invalid_invite');
      const badCode = await registerRaw(s.app, { invite_code: 'nope' });
      expect(badCode.res.body.error.code).toBe('invalid_invite');

      // Single use.
      const code = await createInvite(admin);
      const first = await registerRaw(s.app, { invite_code: code });
      expect(first.res.status).toBe(201);
      const user = registerResponseSchema.parse(first.res.body).user;
      expect(user.role).toBe('user');
      const reuse = await registerRaw(s.app, { invite_code: code });
      expect(reuse.res.status).toBe(400);
      expect(reuse.res.body.error.code).toBe('invalid_invite');

      // Bound to an email.
      const bound = await createInvite(admin, { email: 'Bound@Example.com' });
      const wrongEmail = await registerRaw(s.app, {
        invite_code: bound,
        email: 'other@example.com',
      });
      expect(wrongEmail.res.body.error.code).toBe('invalid_invite');
      const rightEmail = await registerRaw(s.app, {
        invite_code: bound,
        email: 'bound@example.com',
      });
      expect(rightEmail.res.status).toBe(201);

      // Expired.
      const expiring = await createInvite(admin, { expires_in_hours: 1 });
      s.db
        .prepare('UPDATE invites SET expires_at = ? WHERE code = ?')
        .run('2000-01-01T00:00:00.000Z', expiring);
      const expired = await registerRaw(s.app, { invite_code: expiring });
      expect(expired.res.body.error.code).toBe('invalid_invite');

      // A failed registration does not burn the invite or leave a user behind.
      const spare = await createInvite(admin);
      const dup = await registerRaw(s.app, { invite_code: spare, email: admin.email });
      expect(dup.res.status).toBe(409);
      expect(dup.res.body.error.code).toBe('email_taken');
      const unused = listInvitesResponseSchema
        .parse((await admin.req('GET', '/api/v1/admin/invites')).body)
        .invites.find((i) => i.code === spare);
      expect(unused?.used_at).toBeNull();
    } finally {
      await s.close();
    }
  });

  it('open mode needs no invite, and rejects duplicate emails', async () => {
    const s = await startServer({ registration: 'open' });
    try {
      await register(s.app, { email: 'a@example.com' });
      const b = await registerRaw(s.app, { email: 'b@example.com' });
      expect(b.res.status).toBe(201);
      const dup = await registerRaw(s.app, { email: 'B@example.com' });
      expect(dup.res.status).toBe(409);
      expect(dup.res.body.error.code).toBe('email_taken');
    } finally {
      await s.close();
    }
  });

  it('rejects malformed bodies and a KDF below the floor', async () => {
    const s = await startServer({
      registration: 'open',
      kdfFloor: { opslimit: 2, memlimit: 65_536 },
    });
    try {
      const weak = await registerRaw(s.app);
      expect(weak.res.status).toBe(400);
      expect(weak.res.body.error.message).toMatch(/too weak/);

      const bad = await call(s.app, 'POST', '/api/v1/auth/register', { body: { email: 'x' } });
      expect(bad.status).toBe(400);
      expect(errorEnvelopeSchema.parse(bad.body).error.code).toBe('bad_request');
      const notJson = await call(s.app, 'POST', '/api/v1/auth/register', {
        headers: { 'content-type': 'application/json' },
        body: undefined,
      });
      expect(notJson.status).toBe(400);
    } finally {
      await s.close();
    }
  });
});

describe('login, sessions and prelogin', () => {
  let s: TestServer;
  let admin: Client;
  beforeAll(async () => {
    s = await startServer();
    admin = await register(s.app, { email: 'admin@example.com', password: 'admin pass' });
  });
  afterAll(() => s.close());

  it('prelogin returns the real KDF for a known email and a stable fake for an unknown one', async () => {
    const known = await call(s.app, 'POST', '/api/v1/auth/prelogin', {
      body: { email: ' ADMIN@example.com' },
    });
    expect(preloginResponseSchema.parse(known.body).kdf).toEqual(admin.kdf);

    const a = await call(s.app, 'POST', '/api/v1/auth/prelogin', {
      body: { email: 'ghost@example.com' },
    });
    const b = await call(s.app, 'POST', '/api/v1/auth/prelogin', {
      body: { email: 'ghost@example.com' },
    });
    const c = await call(s.app, 'POST', '/api/v1/auth/prelogin', {
      body: { email: 'ghost2@example.com' },
    });
    expect(a.status).toBe(200);
    expect(preloginResponseSchema.parse(a.body).kdf).toEqual(b.body.kdf);
    expect(a.body.kdf.salt).not.toBe(c.body.kdf.salt);
    expect(a.body.kdf).toEqual(fakeKdfForEmail(SECRET, 'ghost@example.com'));
    expect(a.body.kdf.opslimit).toBe(3);
    expect(a.body.kdf.memlimit).toBe(67_108_864);
  });

  it('logs in, returns the keys, and lists the new device as current', async () => {
    const second = await login(s.app, 'admin@example.com', 'admin pass');
    const res = await call(s.app, 'POST', '/api/v1/auth/login', {
      body: {
        email: 'admin@example.com',
        auth_key: toB64((await deriveKeys('admin pass', admin.kdf)).authKey),
        device: { name: 'cli', platform: 'linux' },
      },
    });
    const parsed = loginResponseSchema.parse(res.body);
    expect(parsed.keys.public_key).toBe(admin.user.public_key);
    expect(parsed.keys.kdf).toEqual(admin.kdf);

    const devices = listDevicesResponseSchema.parse(
      (await second.req('GET', '/api/v1/devices')).body,
    ).devices;
    expect(devices.length).toBeGreaterThanOrEqual(2);
    expect(devices.filter((d) => d.current).map((d) => d.id)).toEqual([second.deviceId]);
    expect(meResponseSchema.parse((await second.req('GET', '/api/v1/me')).body).user.id).toBe(
      admin.id,
    );
  });

  it('answers 401 for a wrong password and for an unknown email alike', async () => {
    const wrong = await deriveKeys('wrong password', admin.kdf);
    const body = (email: string, authKey: Uint8Array) => ({
      email,
      auth_key: toB64(authKey),
      device: { name: 'x', platform: 'y' },
    });
    const badPassword = await call(s.app, 'POST', '/api/v1/auth/login', {
      body: body('admin@example.com', wrong.authKey),
    });
    const noUser = await call(s.app, 'POST', '/api/v1/auth/login', {
      body: body('ghost@example.com', wrong.authKey),
    });
    expect(badPassword.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(badPassword.body).toEqual(noUser.body);
    expect(errorEnvelopeSchema.parse(badPassword.body).error.code).toBe('unauthorized');
  });

  it('logout revokes the token', async () => {
    const c = await login(s.app, 'admin@example.com', 'admin pass');
    expect((await c.req('GET', '/api/v1/me')).status).toBe(200);
    const out = await c.req('POST', '/api/v1/auth/logout', {
      headers: { 'content-type': 'application/json' },
    });
    expect(out.status).toBe(204);
    expect((await c.req('GET', '/api/v1/me')).status).toBe(401);
  });

  it('revokes a single device and refuses someone else’s', async () => {
    const victim = await login(s.app, 'admin@example.com', 'admin pass');
    const code = await createInvite(admin);
    const peer = await register(s.app, { invite_code: code });

    expect((await peer.req('DELETE', `/api/v1/devices/${victim.deviceId}`)).status).toBe(404);
    expect((await victim.req('GET', '/api/v1/me')).status).toBe(200);
    expect((await admin.req('DELETE', `/api/v1/devices/${victim.deviceId}`)).status).toBe(204);
    expect((await victim.req('GET', '/api/v1/me')).status).toBe(401);
    expect((await admin.req('DELETE', `/api/v1/devices/${randomUUID()}`)).status).toBe(404);
  });

  it('looks users up by email, authenticated only', async () => {
    const code = await createInvite(admin);
    const bob = await register(s.app, { email: 'bob@example.com', invite_code: code });
    const res = await admin.req('GET', '/api/v1/users/lookup', {
      query: { email: ' BOB@example.com' },
    });
    expect(lookupUserResponseSchema.parse(res.body)).toEqual({
      id: bob.id,
      email: 'bob@example.com',
      name: bob.user.name,
      public_key: bob.user.public_key,
    });
    expect(
      (await admin.req('GET', '/api/v1/users/lookup', { query: { email: 'none@example.com' } }))
        .status,
    ).toBe(404);
    expect((await admin.req('GET', '/api/v1/users/lookup')).status).toBe(400);
    expect(
      (await call(s.app, 'GET', '/api/v1/users/lookup', { query: { email: 'bob@example.com' } }))
        .status,
    ).toBe(401);
  });
});

describe('password change', () => {
  it('keeps the current device, revokes the others, and changes the login credential', async () => {
    const s = await startServer();
    try {
      const a = await register(s.app, { email: 'p@example.com', password: 'old password' });
      const b = await login(s.app, 'p@example.com', 'old password');
      const c = await login(s.app, 'p@example.com', 'old password');

      const newKdf = { ...a.kdf, salt: toB64(new Uint8Array(16).fill(7)) };
      const next = await deriveKeys('new password', newKdf);
      const current = await deriveKeys('old password', a.kdf);
      const body = {
        current_auth_key: toB64(current.authKey),
        new_auth_key: toB64(next.authKey),
        new_kdf: newKdf,
        new_encrypted_private_key: encryptPrivateKey(next.masterKey, a.keypair.privateKey),
      };

      // Wrong current password is refused and changes nothing.
      const wrong = await b.req('POST', '/api/v1/me/password', {
        body: { ...body, current_auth_key: toB64((await deriveKeys('nope', a.kdf)).authKey) },
      });
      expect(wrong.status).toBe(401);
      expect((await c.req('GET', '/api/v1/me')).status).toBe(200);

      const ok = await b.req('POST', '/api/v1/me/password', { body });
      expect(ok.status).toBe(204);
      expect((await b.req('GET', '/api/v1/me')).status).toBe(200);
      expect((await a.req('GET', '/api/v1/me')).status).toBe(401);
      expect((await c.req('GET', '/api/v1/me')).status).toBe(401);

      await expect(login(s.app, 'p@example.com', 'old password')).rejects.toThrow(
        /login failed: 401/,
      );
      const again = await login(s.app, 'p@example.com', 'new password');
      expect(again.keypair.publicKey).toEqual(a.keypair.publicKey);
      const pre = await call(s.app, 'POST', '/api/v1/auth/prelogin', {
        body: { email: 'p@example.com' },
      });
      expect(pre.body.kdf.salt).toBe(newKdf.salt);
    } finally {
      await s.close();
    }
  });
});

describe('admin', () => {
  it('is admin only, and manages invites and users', async () => {
    const s = await startServer({ registration: 'open' });
    try {
      const admin = await register(s.app);
      const user = await register(s.app);
      for (const [method, url] of [
        ['POST', '/api/v1/admin/invites'],
        ['GET', '/api/v1/admin/invites'],
        ['GET', '/api/v1/admin/users'],
      ] as const) {
        expect(
          (await user.req(method, url, { body: method === 'POST' ? {} : undefined })).status,
        ).toBe(403);
      }

      const code = await createInvite(admin, { email: 'who@example.com', expires_in_hours: 2 });
      const invites = listInvitesResponseSchema.parse(
        (await admin.req('GET', '/api/v1/admin/invites')).body,
      ).invites;
      expect(invites).toHaveLength(1);
      expect(invites[0]).toMatchObject({ code, email: 'who@example.com', used_at: null });
      expect((await admin.req('DELETE', `/api/v1/admin/invites/${code}`)).status).toBe(204);
      expect((await admin.req('DELETE', `/api/v1/admin/invites/${code}`)).status).toBe(404);

      const users = listUsersResponseSchema.parse(
        (await admin.req('GET', '/api/v1/admin/users')).body,
      ).users;
      expect(users.map((u) => u.id).sort()).toEqual([admin.id, user.id].sort());

      expect((await admin.req('DELETE', `/api/v1/admin/users/${admin.id}`)).status).toBe(400);
      expect((await admin.req('DELETE', `/api/v1/admin/users/${randomUUID()}`)).status).toBe(404);
      expect((await admin.req('DELETE', `/api/v1/admin/users/${user.id}`)).status).toBe(204);
      expect((await user.req('GET', '/api/v1/me')).status).toBe(401);
      expect((s.db.prepare('SELECT COUNT(*) AS n FROM vaults').get() as { n: number }).n).toBe(1);
    } finally {
      await s.close();
    }
  });

  it('refuses to strand a shared vault by deleting its only owner', async () => {
    const s = await startServer({ registration: 'open' });
    try {
      const admin = await register(s.app);
      const owner = await register(s.app);
      const member = await register(s.app);
      const vault = await owner.createVault('Team');
      expect((await owner.addMember(vault, member, 'editor')).status).toBe(201);
      const res = await admin.req('DELETE', `/api/v1/admin/users/${owner.id}`);
      expect(res.status).toBe(409);
      // Once they are alone in it, the vault goes with them.
      await owner.req('DELETE', `/api/v1/vaults/${vault}/members/${member.id}`);
      expect((await admin.req('DELETE', `/api/v1/admin/users/${owner.id}`)).status).toBe(204);
      expect(s.db.prepare('SELECT 1 FROM vaults WHERE id = ?').get(vault)).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});

describe('secrets never leave the server', () => {
  it('no response includes auth_hash, token hashes or the server secret', async () => {
    const s = await startServer({ registration: 'open' });
    try {
      const a = await register(s.app);
      const b = await register(s.app);
      const vault = await a.createVault('Shared');
      await a.addMember(vault, b, 'editor');
      const item = randomUUID();
      await a.putItem(vault, item, 'one', null);

      const hashes = (
        s.db
          .prepare('SELECT auth_hash, token_hash FROM users u, devices d WHERE d.user_id = u.id')
          .all() as {
          auth_hash: string;
          token_hash: string;
        }[]
      ).flatMap((r) => [r.auth_hash, r.token_hash]);
      expect(hashes.length).toBeGreaterThan(0);

      const responses: string[] = [];
      const grab = async (r: Promise<{ raw: string }>) => responses.push((await r).raw);
      await grab(a.req('GET', '/api/v1/me'));
      await grab(a.req('GET', '/api/v1/devices'));
      await grab(a.req('GET', '/api/v1/vaults'));
      await grab(a.req('GET', `/api/v1/vaults/${vault}/members`));
      await grab(a.req('GET', `/api/v1/vaults/${vault}/items`, { query: { since: 0 } }));
      await grab(a.req('GET', '/api/v1/users/lookup', { query: { email: b.email } }));
      await grab(a.req('GET', '/api/v1/admin/users'));
      await grab(a.req('GET', '/api/v1/admin/invites'));
      await grab(call(s.app, 'POST', '/api/v1/auth/prelogin', { body: { email: a.email } }));
      await grab(call(s.app, 'GET', '/api/v1/server'));

      for (const raw of responses) {
        expect(raw).not.toMatch(/auth_hash|token_hash/);
        for (const h of hashes) expect(raw).not.toContain(h);
        expect(raw).not.toContain(Buffer.from(SECRET).toString('base64url'));
      }
      // Sanity: the auth key itself is the client's secret and is not echoed either.
      expect(JSON.stringify(a.user)).not.toMatch(/auth_key/);
    } finally {
      await s.close();
    }
  });
});

describe('rate limiting', () => {
  it('limits auth endpoints per IP and failed logins per email, in the error envelope', async () => {
    const s = await startServer({
      rateLimit: { enabled: true, global: 1000, auth: 4, loginFailuresPerEmail: 2, lookup: 60 },
    });
    try {
      const prelogin = () =>
        call(s.app, 'POST', '/api/v1/auth/prelogin', { body: { email: 'a@example.com' } });
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await prelogin()).status);
      expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
      const limited = await prelogin();
      expect(errorEnvelopeSchema.parse(limited.body).error.code).toBe('rate_limited');
      // Other routes are unaffected.
      expect((await call(s.app, 'GET', '/api/v1/server')).status).toBe(200);
    } finally {
      await s.close();
    }

    // Per-email lockout needs more headroom on the per-IP limit.
    const t = await startServer({
      rateLimit: { enabled: true, global: 1000, auth: 100, loginFailuresPerEmail: 2, lookup: 60 },
    });
    try {
      const bad = () =>
        call(t.app, 'POST', '/api/v1/auth/login', {
          body: {
            email: 'ghost@example.com',
            auth_key: toB64(new Uint8Array(32)),
            device: { name: 'x', platform: 'y' },
          },
        });
      expect((await bad()).status).toBe(401);
      expect((await bad()).status).toBe(401);
      const locked = await bad();
      expect(locked.status).toBe(429);
      expect(errorEnvelopeSchema.parse(locked.body).error.code).toBe('rate_limited');
    } finally {
      await t.close();
    }
  });
});
