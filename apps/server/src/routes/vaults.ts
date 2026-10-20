import type { FastifyInstance } from 'fastify';
import {
  addMemberRequestSchema,
  createVaultRequestSchema,
  MAX_ROTATE_BODY_BYTES,
  rotateRequestSchema,
  updateMemberRequestSchema,
  updateVaultRequestSchema,
} from '@ternix/core/protocol';
import { requireSession } from '../auth.js';
import type { AppContext } from '../context.js';
import { ApiError, conflict, forbidden, notFound } from '../errors.js';
import { parse, requireVault, uuidParam } from '../validate.js';

export async function vaultRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { store, hub } = ctx;

  const notifyVaults = (userIds: Iterable<string>) =>
    hub.notifyUsers(userIds, { type: 'vaults.changed' });

  await app.register(async (authed) => {
    requireSession(authed, ctx);

    authed.get('/api/v1/vaults', async (req) => ({
      vaults: store.listVaultsForUser(req.auth.user.id),
    }));

    authed.post('/api/v1/vaults', async (req, reply) => {
      const body = parse(createVaultRequestSchema, req.body);
      const userId = req.auth.user.id;
      if (store.getVault(body.id)) throw conflict('Vault id already exists');
      store.transaction(() => {
        store.insertVault({ id: body.id, kind: 'shared', nameEnc: body.name_enc });
        store.insertMember({
          vaultId: body.id,
          userId,
          role: 'owner',
          wrappedKey: body.wrapped_key,
        });
      });
      notifyVaults([userId]);
      return reply.code(201).send(store.getVaultForUser(body.id, userId));
    });

    authed.patch('/api/v1/vaults/:id', async (req) => {
      const { vault } = requireVault(
        store,
        req.auth.user.id,
        (req.params as { id: string }).id,
        'owner',
      );
      const body = parse(updateVaultRequestSchema, req.body);
      if (!store.renameVault(vault.id, body.name_enc, body.key_version)) {
        throw new ApiError(
          'key_version_mismatch',
          `Vault key_version is ${vault.key_version}; the name must be sealed with it`,
        );
      }
      notifyVaults(store.memberUserIds(vault.id));
      return store.getVaultForUser(vault.id, req.auth.user.id);
    });

    authed.delete('/api/v1/vaults/:id', async (req, reply) => {
      const { vault } = requireVault(
        store,
        req.auth.user.id,
        (req.params as { id: string }).id,
        'owner',
      );
      if (vault.kind === 'personal') throw forbidden('A personal vault cannot be deleted');
      const members = store.memberUserIds(vault.id);
      store.deleteVault(vault.id);
      notifyVaults(members);
      return reply.code(204).send();
    });

    // Members

    authed.get('/api/v1/vaults/:id/members', async (req) => {
      const { vault } = requireVault(
        store,
        req.auth.user.id,
        (req.params as { id: string }).id,
        'viewer',
      );
      return { members: store.listMembers(vault.id) };
    });

    authed.post('/api/v1/vaults/:id/members', async (req, reply) => {
      const { vault } = requireVault(
        store,
        req.auth.user.id,
        (req.params as { id: string }).id,
        'owner',
      );
      const body = parse(addMemberRequestSchema, req.body);
      if (vault.kind === 'personal') throw forbidden('A personal vault cannot be shared');
      if (body.key_version !== vault.key_version) {
        throw new ApiError('key_version_mismatch', `Vault key_version is ${vault.key_version}`);
      }
      if (!store.getUserById(body.user_id)) throw notFound('User not found');
      if (store.membership(vault.id, body.user_id)) throw conflict('User is already a member');
      store.insertMember({
        vaultId: vault.id,
        userId: body.user_id,
        role: body.role,
        wrappedKey: body.wrapped_key,
      });
      notifyVaults(store.memberUserIds(vault.id));
      return reply.code(201).send(store.getMember(vault.id, body.user_id));
    });

    authed.patch('/api/v1/vaults/:id/members/:user_id', async (req) => {
      const params = req.params as { id: string; user_id: string };
      const { vault } = requireVault(store, req.auth.user.id, params.id, 'owner');
      const targetId = uuidParam(params.user_id, 'Member');
      const body = parse(updateMemberRequestSchema, req.body);
      const target = store.membership(vault.id, targetId);
      if (!target) throw notFound('Member not found');
      if (target.role === 'owner' && body.role !== 'owner' && store.ownerCount(vault.id) <= 1) {
        throw conflict('A vault must keep at least one owner');
      }
      store.setMemberRole(vault.id, targetId, body.role);
      notifyVaults(store.memberUserIds(vault.id));
      return store.getMember(vault.id, targetId);
    });

    authed.delete('/api/v1/vaults/:id/members/:user_id', async (req, reply) => {
      const params = req.params as { id: string; user_id: string };
      const callerId = req.auth.user.id;
      const { vault, role } = requireVault(store, callerId, params.id, 'viewer');
      const targetId = uuidParam(params.user_id, 'Member');
      if (targetId !== callerId && role !== 'owner') {
        throw forbidden('Only an owner can remove another member');
      }
      const target = store.membership(vault.id, targetId);
      if (!target) throw notFound('Member not found');
      if (target.role === 'owner' && store.ownerCount(vault.id) <= 1) {
        throw conflict('The last owner cannot leave or be removed');
      }
      store.deleteMember(vault.id, targetId);
      notifyVaults([...store.memberUserIds(vault.id), targetId]);
      return reply.code(204).send();
    });

    // Key rotation

    authed.post('/api/v1/vaults/:id/rotate', { bodyLimit: MAX_ROTATE_BODY_BYTES }, async (req) => {
      const userId = req.auth.user.id;
      const { vault } = requireVault(store, userId, (req.params as { id: string }).id, 'owner');
      const body = parse(rotateRequestSchema, req.body);
      const outcome = store.rotate(vault, userId, body);
      if (!outcome.ok) {
        if (outcome.reason === 'key_version_mismatch') {
          throw new ApiError(
            'key_version_mismatch',
            `Vault key_version is ${vault.key_version}; rotate to ${vault.key_version + 1}`,
          );
        }
        throw conflict(
          'Member or item set does not match the server, or an item changed; refresh and retry',
          { expected: outcome.expected, stale_item_ids: outcome.staleItemIds },
        );
      }
      const members = store.memberUserIds(vault.id);
      notifyVaults(members);
      hub.notifyUsers(members, {
        type: 'vault.changed',
        vault_id: vault.id,
        seq: store.vaultSeq(vault.id),
      });
      return store.getVaultForUser(vault.id, userId);
    });
  });
}
