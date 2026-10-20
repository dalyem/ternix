import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  batchRequestSchema,
  deleteItemQuerySchema,
  listItemsQuerySchema,
  putItemRequestSchema,
  type BatchResult,
} from '@ternix/core/protocol';
import { authenticator } from '../auth.js';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { ItemOutcome } from '../store.js';
import { parse, requireVault, uuidParam } from '../validate.js';

const MIB = 1024 * 1024;

export async function itemRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { store, hub } = ctx;

  const notifyChanged = (vaultId: string, seq: number) =>
    hub.notifyUsers(store.memberUserIds(vaultId), {
      type: 'vault.changed',
      vault_id: vaultId,
      seq,
    });

  await app.register(async (authed) => {
    authed.addHook('onRequest', authenticator(ctx));

    authed.get('/api/v1/vaults/:id/items', async (req) => {
      const { vault } = requireVault(
        store,
        req.auth.user.id,
        (req.params as { id: string }).id,
        'viewer',
      );
      const { since, limit } = parse(listItemsQuerySchema, req.query);
      const { items, hasMore } = store.listItems(vault.id, since, limit);
      return {
        items,
        next_since: items.length > 0 ? items[items.length - 1]!.seq : since,
        has_more: hasMore,
      };
    });

    /** 200 with the item, 409 `{error, current}` on conflict, or the mapped error. */
    function respond(outcome: ItemOutcome, vaultId: string, reply: FastifyReply) {
      if (outcome.status === 'ok') {
        notifyChanged(vaultId, outcome.item.seq);
        return reply.code(200).send({ item: outcome.item });
      }
      if (outcome.status === 'conflict') {
        return reply.code(409).send({
          error: { code: 'conflict', message: 'Item changed on the server; base_seq is stale' },
          current: outcome.current,
        });
      }
      throw new ApiError(outcome.code, outcome.message);
    }

    authed.put('/api/v1/vaults/:id/items/:item_id', async (req, reply) => {
      const params = req.params as { id: string; item_id: string };
      const { vault } = requireVault(store, req.auth.user.id, params.id, 'editor');
      const itemId = uuidParam(params.item_id, 'Item');
      const body = parse(putItemRequestSchema, req.body);
      const outcome = store.transaction(() =>
        store.putItem(
          vault,
          req.auth.user.id,
          itemId,
          body.ciphertext,
          body.key_version,
          body.base_seq,
        ),
      );
      return respond(outcome, vault.id, reply);
    });

    authed.delete('/api/v1/vaults/:id/items/:item_id', async (req, reply) => {
      const params = req.params as { id: string; item_id: string };
      const { vault } = requireVault(store, req.auth.user.id, params.id, 'editor');
      const itemId = uuidParam(params.item_id, 'Item');
      const { base_seq } = parse(deleteItemQuerySchema, req.query);
      const outcome = store.transaction(() =>
        store.deleteItem(vault, req.auth.user.id, itemId, base_seq),
      );
      return respond(outcome, vault.id, reply);
    });

    authed.post('/api/v1/vaults/:id/items/batch', { bodyLimit: 20 * MIB }, async (req) => {
      const userId = req.auth.user.id;
      const { vault } = requireVault(store, userId, (req.params as { id: string }).id, 'editor');
      const { ops } = parse(batchRequestSchema, req.body);
      const results = store.transaction(() =>
        ops.map((op): BatchResult => {
          const outcome =
            op.op === 'put'
              ? store.putItem(vault, userId, op.id, op.ciphertext, op.key_version, op.base_seq)
              : store.deleteItem(vault, userId, op.id, op.base_seq);
          if (outcome.status === 'ok') return { id: op.id, status: 'ok', item: outcome.item };
          if (outcome.status === 'conflict') {
            return { id: op.id, status: 'conflict', current: outcome.current };
          }
          return {
            id: op.id,
            status: 'error',
            error: { code: outcome.code, message: outcome.message },
          };
        }),
      );
      const seqs = results.flatMap((r) => (r.status === 'ok' ? [r.item.seq] : []));
      if (seqs.length > 0) notifyChanged(vault.id, Math.max(...seqs));
      return { results };
    });
  });
}
