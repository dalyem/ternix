import { z } from 'zod';
import { apiErrorSchema } from './errors.js';
import {
  envelopeSchema,
  keyVersionSchema,
  seqSchema,
  timestampSchema,
  uuidSchema,
} from './common.js';

// Items on the wire (docs/protocol.md section 6)

const itemBase = {
  id: uuidSchema,
  vault_id: uuidSchema,
  seq: seqSchema,
  key_version: keyVersionSchema,
  updated_at: timestampSchema,
  updated_by: uuidSchema,
};

export const liveItemSchema = z.object({
  ...itemBase,
  deleted: z.literal(false),
  ciphertext: envelopeSchema,
});

/** A delete leaves a tombstone that is kept forever. */
export const tombstoneItemSchema = z.object({
  ...itemBase,
  deleted: z.literal(true),
  ciphertext: z.null(),
});

export const itemSchema = z.discriminatedUnion('deleted', [liveItemSchema, tombstoneItemSchema]);
export type Item = z.infer<typeof itemSchema>;
export type LiveItem = z.infer<typeof liveItemSchema>;
export type TombstoneItem = z.infer<typeof tombstoneItemSchema>;

/** Hard limits from the protocol. */
export const MAX_LIST_LIMIT = 1000;
export const DEFAULT_LIST_LIMIT = 500;
export const MAX_BATCH_OPS = 500;

// GET /api/v1/vaults/:id/items?since=&limit=

export const listItemsQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
});
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>;

export const listItemsResponseSchema = z.object({
  items: z.array(itemSchema),
  next_since: seqSchema,
  has_more: z.boolean(),
});
export type ListItemsResponse = z.infer<typeof listItemsResponseSchema>;

// PUT /api/v1/vaults/:id/items/:item_id

/** `null` creates; otherwise the `seq` the client last saw. */
export const baseSeqSchema = seqSchema.nullable();

export const putItemRequestSchema = z.object({
  ciphertext: envelopeSchema,
  key_version: keyVersionSchema,
  base_seq: baseSeqSchema,
});
export type PutItemRequest = z.infer<typeof putItemRequestSchema>;

/** `200` from PUT and DELETE (the tombstone for DELETE). */
export const itemResponseSchema = z.object({ item: itemSchema });
export type ItemResponse = z.infer<typeof itemResponseSchema>;

/** `409 {error, current}` from PUT and DELETE when `base_seq` does not match. */
export const itemConflictResponseSchema = z.object({
  error: apiErrorSchema,
  current: itemSchema,
});
export type ItemConflictResponse = z.infer<typeof itemConflictResponseSchema>;

// DELETE /api/v1/vaults/:id/items/:item_id?base_seq=

export const deleteItemQuerySchema = z.object({ base_seq: z.coerce.number().int().min(0) });
export type DeleteItemQuery = z.infer<typeof deleteItemQuerySchema>;

// POST /api/v1/vaults/:id/items/batch

export const batchPutOpSchema = z.object({
  op: z.literal('put'),
  id: uuidSchema,
  ciphertext: envelopeSchema,
  key_version: keyVersionSchema,
  base_seq: baseSeqSchema,
});
export const batchDeleteOpSchema = z.object({
  op: z.literal('delete'),
  id: uuidSchema,
  base_seq: seqSchema,
});
export const batchOpSchema = z.discriminatedUnion('op', [batchPutOpSchema, batchDeleteOpSchema]);
export type BatchOp = z.infer<typeof batchOpSchema>;

export const batchRequestSchema = z.object({
  ops: z.array(batchOpSchema).min(1).max(MAX_BATCH_OPS),
});
export type BatchRequest = z.infer<typeof batchRequestSchema>;

export const batchResultSchema = z.discriminatedUnion('status', [
  z.object({ id: uuidSchema, status: z.literal('ok'), item: itemSchema }),
  z.object({ id: uuidSchema, status: z.literal('conflict'), current: itemSchema }),
  z.object({ id: uuidSchema, status: z.literal('error'), error: apiErrorSchema }),
]);
export type BatchResult = z.infer<typeof batchResultSchema>;

export const batchResponseSchema = z.object({ results: z.array(batchResultSchema) });
export type BatchResponse = z.infer<typeof batchResponseSchema>;
