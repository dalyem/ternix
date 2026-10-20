import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { fakeKdfForEmail } from '@ternix/core/crypto';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  lookupUserQuerySchema,
  PROTOCOL_VERSION,
  preloginRequestSchema,
  registerRequestSchema,
  type KdfParams,
} from '@ternix/core/protocol';
import { authenticator } from '../auth.js';
import type { AppContext } from '../context.js';
import { ApiError, badRequest, notFound, unauthorized } from '../errors.js';
import { kdfOf, toUser, type UserRow } from '../store.js';
import { hashToken, newToken } from '../tokens.js';
import { parse, uuidParam } from '../validate.js';

function isConstraint(err: unknown, column: string): boolean {
  return (
    err instanceof Error &&
    (err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT') === true &&
    err.message.includes(column)
  );
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config, store, hub, hasher, loginLimiter } = ctx;
  const authRateLimit = { rateLimit: { max: config.rateLimit.auth, timeWindow: '1 minute' } };

  function assertKdf(kdf: KdfParams): void {
    if (kdf.opslimit < config.kdfFloor.opslimit || kdf.memlimit < config.kdfFloor.memlimit) {
      throw badRequest(
        `KDF parameters are too weak: need opslimit >= ${config.kdfFloor.opslimit} and memlimit >= ${config.kdfFloor.memlimit}`,
      );
    }
  }

  function createDevice(userId: string, device: { name: string; platform: string }) {
    const token = newToken();
    const deviceId = randomUUID();
    store.insertDevice({ id: deviceId, userId, ...device, tokenHash: hashToken(token) });
    return { token, deviceId };
  }

  // Public

  app.get('/api/v1/server', async () => ({
    name: config.serverName,
    version: ctx.version,
    registration: config.registration,
    protocol: PROTOCOL_VERSION,
  }));

  app.post('/api/v1/auth/prelogin', { config: authRateLimit }, async (req) => {
    const { email } = parse(preloginRequestSchema, req.body);
    const user = store.getUserByEmail(email);
    return { kdf: user ? kdfOf(user) : fakeKdfForEmail(config.secret, email) };
  });

  app.post('/api/v1/auth/register', { config: authRateLimit }, async (req, reply) => {
    const body = parse(registerRequestSchema, req.body);
    assertKdf(body.kdf);

    // Cheap rejections before the expensive hash.
    if (store.userCount() > 0) {
      if (config.registration === 'closed') {
        throw new ApiError('registration_closed', 'Registration is closed on this server');
      }
      if (config.registration === 'invite' && !body.invite_code) {
        throw new ApiError('invalid_invite', 'An invite code is required');
      }
    }
    if (store.getUserByEmail(body.email)) {
      throw new ApiError('email_taken', 'An account with this email already exists');
    }
    if (store.getVault(body.personal_vault.id)) {
      throw new ApiError('conflict', 'Vault id already exists');
    }

    const authHash = hasher.hash(body.auth_key);
    const userId = randomUUID();
    const token = newToken();
    const deviceId = randomUUID();
    let row: UserRow;
    try {
      row = store.transaction(() => {
        // Decided inside the transaction so two first registrations cannot both become admin.
        const first = store.userCount() === 0;
        if (!first && config.registration === 'closed') {
          throw new ApiError('registration_closed', 'Registration is closed on this server');
        }
        const created: UserRow = {
          id: userId,
          email: body.email,
          name: body.name,
          role: first ? 'admin' : 'user',
          auth_hash: authHash,
          kdf: JSON.stringify(body.kdf),
          public_key: body.public_key,
          encrypted_private_key: body.encrypted_private_key,
          created_at: new Date().toISOString(),
        };
        store.insertUser(created);
        if (!first && (config.registration === 'invite' || body.invite_code)) {
          if (!body.invite_code || !store.consumeInvite(body.invite_code, body.email, userId)) {
            throw new ApiError('invalid_invite', 'Invite code is invalid, used, or expired');
          }
        }
        store.insertVault({
          id: body.personal_vault.id,
          kind: 'personal',
          nameEnc: body.personal_vault.name_enc,
        });
        store.insertMember({
          vaultId: body.personal_vault.id,
          userId,
          role: 'owner',
          wrappedKey: body.personal_vault.wrapped_key,
        });
        store.insertDevice({
          id: deviceId,
          userId,
          ...body.device,
          tokenHash: hashToken(token),
        });
        return created;
      });
    } catch (err) {
      if (isConstraint(err, 'users.email')) {
        throw new ApiError('email_taken', 'An account with this email already exists');
      }
      if (isConstraint(err, 'vaults.id')) throw new ApiError('conflict', 'Vault id already exists');
      throw err;
    }
    return reply.code(201).send({ token, user: toUser(row), device_id: deviceId });
  });

  app.post('/api/v1/auth/login', { config: authRateLimit }, async (req) => {
    const body = parse(loginRequestSchema, req.body);
    if (loginLimiter.blocked(body.email)) {
      throw new ApiError('rate_limited', 'Too many failed logins for this account; try later');
    }
    const user = store.getUserByEmail(body.email);
    // An unknown email costs the same as a wrong password.
    const ok = user
      ? hasher.verify(user.auth_hash, body.auth_key)
      : hasher.verifyDummy(body.auth_key);
    if (!user || !ok) {
      loginLimiter.fail(body.email);
      throw unauthorized('Invalid email or password');
    }
    loginLimiter.clear(body.email);
    const { token, deviceId } = createDevice(user.id, body.device);
    return {
      token,
      user: toUser(user),
      device_id: deviceId,
      keys: {
        public_key: user.public_key,
        encrypted_private_key: user.encrypted_private_key,
        kdf: kdfOf(user),
      },
    };
  });

  // Authenticated

  await app.register(async (authed) => {
    authed.addHook('onRequest', authenticator(ctx));

    authed.post('/api/v1/auth/logout', async (req, reply) => {
      store.deleteDevice(req.auth.deviceId, req.auth.user.id);
      hub.revokeDevices([req.auth.deviceId]);
      return reply.code(204).send();
    });

    authed.get('/api/v1/me', async (req) => ({ user: toUser(req.auth.user) }));

    authed.post('/api/v1/me/password', { config: authRateLimit }, async (req, reply) => {
      const body = parse(changePasswordRequestSchema, req.body);
      assertKdf(body.new_kdf);
      const { user, deviceId } = req.auth;
      const limiterKey = `password:${user.id}`;
      if (loginLimiter.blocked(limiterKey)) {
        throw new ApiError('rate_limited', 'Too many failed attempts; try later');
      }
      if (!hasher.verify(user.auth_hash, body.current_auth_key)) {
        loginLimiter.fail(limiterKey);
        throw unauthorized('Current password is incorrect');
      }
      loginLimiter.clear(limiterKey);
      const newHash = hasher.hash(body.new_auth_key);
      const revoked = store.transaction(() => {
        store.updatePassword(user.id, newHash, body.new_kdf, body.new_encrypted_private_key);
        return store.deleteOtherDevices(user.id, deviceId);
      });
      hub.revokeDevices(revoked);
      return reply.code(204).send();
    });

    authed.get('/api/v1/devices', async (req) => ({
      devices: store.listDevices(req.auth.user.id, req.auth.deviceId),
    }));

    authed.delete('/api/v1/devices/:id', async (req, reply) => {
      const id = uuidParam((req.params as { id?: string }).id, 'Device');
      if (!store.deleteDevice(id, req.auth.user.id)) throw notFound('Device not found');
      hub.revokeDevices([id]);
      return reply.code(204).send();
    });

    authed.get(
      '/api/v1/users/lookup',
      { config: { rateLimit: { max: config.rateLimit.lookup, timeWindow: '1 minute' } } },
      async (req) => {
        const { email } = parse(lookupUserQuerySchema, req.query);
        const user = store.getUserByEmail(email);
        if (!user) throw notFound('User not found');
        return { id: user.id, email: user.email, name: user.name, public_key: user.public_key };
      },
    );
  });
}
