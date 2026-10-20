import { z, type ZodType, type ZodTypeDef } from 'zod';
import {
  groupPayloadSchema,
  hostPayloadSchema,
  identityPayloadSchema,
  knownHostPayloadSchema,
  portForwardPayloadSchema,
  snippetPayloadSchema,
  sshKeyPayloadSchema,
} from '@ternix/core/items';
import { publicKeySchema, uuidSchema, vaultRoleSchema } from '@ternix/core/protocol';
import type { RpcMethodName, RpcMethods } from '../../shared/ipc.js';
import type { ItemDraft, ItemDraftInput } from '../../shared/types.js';
import { settingsPatchSchema } from '../app/settings.js';

/**
 * Every argument the renderer sends is parsed here, in the main process, before any
 * handler runs. Unknown properties are rejected (`strict`) rather than silently dropped,
 * and every string has an upper bound.
 */

const id = uuidSchema;
const text = (max: number) => z.string().max(max);
const name = z.string().trim().min(1).max(200);
const email = z.string().trim().min(3).max(320);
const password = z.string().min(1).max(1024);
const serverAddress = z.string().trim().min(1).max(2048);
const terminalSize = {
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
};

const none = z.undefined();
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** Item drafts: a payload without `updated_at` (the client stamps it at write time). */
export const itemDraftSchema: ZodType<ItemDraft, ZodTypeDef, unknown> = z.discriminatedUnion(
  'type',
  [
    groupPayloadSchema.omit({ updated_at: true }),
    hostPayloadSchema.omit({ updated_at: true }),
    identityPayloadSchema.omit({ updated_at: true }),
    sshKeyPayloadSchema.omit({ updated_at: true }),
    snippetPayloadSchema.omit({ updated_at: true }),
    portForwardPayloadSchema.omit({ updated_at: true }),
    knownHostPayloadSchema.omit({ updated_at: true }),
  ],
);

/**
 * What `items.put` accepts: a draft whose secret fields may also be absent (keep the stored
 * value) or null (clear it); see `ItemDraftInput`. Main merges and then checks the result
 * against `itemDraftSchema`. `known_host` passes here and is refused by the handler.
 */
const secretInput = z.string().nullable().optional();
export const itemDraftInputSchema: ZodType<ItemDraftInput, ZodTypeDef, unknown> =
  z.discriminatedUnion('type', [
    groupPayloadSchema.omit({ updated_at: true }),
    hostPayloadSchema.omit({ updated_at: true }).extend({ password: secretInput }),
    identityPayloadSchema.omit({ updated_at: true }).extend({ password: secretInput }),
    sshKeyPayloadSchema
      .omit({ updated_at: true })
      .extend({ private_key: secretInput, passphrase: secretInput }),
    snippetPayloadSchema.omit({ updated_at: true }),
    portForwardPayloadSchema.omit({ updated_at: true }),
    knownHostPayloadSchema.omit({ updated_at: true }),
  ]);

type Schemas = {
  [K in RpcMethodName]: ZodType<RpcMethods[K]['in'], ZodTypeDef, unknown>;
};

export const rpcSchemas: Schemas = {
  'app.info': none,
  'settings.get': none,
  'settings.set': settingsPatchSchema,
  'clipboard.write': obj({ text: text(1_000_000) }),
  'dialog.importKey': none,
  'shell.openLink': obj({
    url: z
      .string()
      .max(2048)
      .refine((value) => /^https?:\/\/[^\s]+$/i.test(value), 'Only http(s) links can be opened'),
  }),

  'client.snapshot': none,
  'server.probe': obj({ address: serverAddress }),
  'server.remember': obj({ serverUrl: serverAddress.nullable() }),
  'auth.register': obj({
    serverUrl: serverAddress,
    email,
    name,
    password,
    inviteCode: text(512).optional(),
  }),
  'auth.login': obj({ serverUrl: serverAddress, email, password }),
  'auth.unlock': obj({ password }),
  'auth.lock': none,
  'auth.logout': obj({ forgetServer: z.boolean().optional() })
    .optional()
    .transform((value) => value ?? {}),
  'auth.changePassword': obj({ current: password, next: password }),
  'account.revalidate': none,
  'devices.list': none,
  'devices.revoke': obj({ deviceId: id }),

  'admin.invites.list': none,
  'admin.invites.create': obj({
    email: email.optional(),
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .optional(),
  }),
  'admin.invites.delete': obj({ code: z.string().min(1).max(512) }),
  'admin.users.list': none,
  'admin.users.delete': obj({ userId: id }),

  'vaults.list': none,
  'vaults.create': obj({ name }),
  'vaults.rename': obj({ vaultId: id, name }),
  'vaults.delete': obj({ vaultId: id }),
  'vaults.sync': none,
  'vaults.members': obj({ vaultId: id }),
  'vaults.lookupUser': obj({ email }),
  'vaults.addMember': obj({
    vaultId: id,
    userId: id,
    role: vaultRoleSchema,
    expectedPublicKey: text(256),
  }),
  'vaults.markMemberVerified': obj({ userId: id, publicKey: publicKeySchema }),
  'vaults.acceptMemberKey': obj({ userId: id, publicKey: publicKeySchema }),
  'vaults.changeRole': obj({ vaultId: id, userId: id, role: vaultRoleSchema }),
  'vaults.removeMember': obj({ vaultId: id, userId: id }),
  'vaults.leave': obj({ vaultId: id }),
  'vaults.rotate': obj({ vaultId: id }),

  'items.all': none,
  'items.reveal': obj({ vaultId: id, itemId: id }),
  'items.put': obj({ vaultId: id, itemId: id.optional(), draft: itemDraftInputSchema }),
  'items.delete': obj({ vaultId: id, itemId: id }),

  'ssh.list': none,
  'ssh.open': obj({ hostId: id, ...terminalSize }),
  'ssh.quickConnect': obj({
    target: z.string().trim().min(1).max(600),
    password: text(1024).optional(),
    ...terminalSize,
  }),
  'ssh.attach': obj({ id }),
  'ssh.write': obj({ id, data: text(1_000_000) }),
  'ssh.resize': obj({ id, ...terminalSize }),
  'ssh.reconnect': obj({ id, ...terminalSize }),
  'ssh.close': obj({ id }),
  'ssh.answerKeyboard': obj({
    promptId: id,
    answers: z.array(text(4096)).max(32).nullable(),
  }),
  'ssh.forward.start': obj({ id, forwardId: id }),
  'ssh.forward.stop': obj({ id, forwardId: id }),
};
