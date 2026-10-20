import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createInviteRequestSchema } from '@ternix/core/protocol';
import { requireSession } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { toUser } from '../store.js';
import { newInviteCode } from '../tokens.js';
import { parse, uuidParam } from '../validate.js';

export async function adminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config, store, hub } = ctx;

  await app.register(async (admin) => {
    requireSession(admin, ctx);
    const requireAdmin = async (req: FastifyRequest) => {
      if (req.auth.user.role !== 'admin') throw forbidden('Admin role required');
    };
    admin.addHook('onRequest', requireAdmin);
    admin.addHook('preHandler', requireAdmin);

    admin.post('/api/v1/admin/invites', async (req, reply) => {
      const body = parse(createInviteRequestSchema, req.body ?? {});
      const code = newInviteCode();
      const hours = body.expires_in_hours ?? config.inviteDefaultHours;
      const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
      store.insertInvite({
        code,
        email: body.email ?? null,
        createdBy: req.auth.user.id,
        expiresAt,
      });
      return reply.code(201).send({ code, expires_at: expiresAt });
    });

    admin.get('/api/v1/admin/invites', async () => ({ invites: store.listInvites() }));

    admin.delete('/api/v1/admin/invites/:code', async (req, reply) => {
      const code = (req.params as { code: string }).code;
      if (!store.deleteInvite(code)) throw notFound('Invite not found');
      return reply.code(204).send();
    });

    admin.get('/api/v1/admin/users', async () => ({ users: store.listUsers().map(toUser) }));

    admin.delete('/api/v1/admin/users/:id', async (req, reply) => {
      const id = uuidParam((req.params as { id?: string }).id, 'User');
      if (id === req.auth.user.id) throw badRequest('You cannot delete your own account');
      if (!store.getUserById(id)) throw notFound('User not found');
      const stranded = store
        .vaultsOwnedBy(id)
        .some((v) => v.kind === 'shared' && v.owners === 1 && v.members > 1);
      if (stranded) {
        throw conflict(
          'User is the only owner of a shared vault with other members; transfer ownership or delete the vault first',
        );
      }
      const deviceIds = store.deviceIdsOfUser(id);
      const affected = store.transaction(() => store.deleteUser(id));
      hub.revokeDevices(deviceIds);
      hub.notifyUsers(affected, { type: 'vaults.changed' });
      return reply.code(204).send();
    });
  });
}
