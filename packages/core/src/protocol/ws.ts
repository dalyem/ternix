import { z } from 'zod';
import { seqSchema, uuidSchema } from './common.js';

// Realtime (docs/protocol.md section 7)

/** The server closes the socket with this code when auth fails or times out. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
/** The first client message must be `auth` within this many milliseconds. */
export const WS_AUTH_TIMEOUT_MS = 10_000;
/** The client sends `ping` this often. */
export const WS_PING_INTERVAL_MS = 30_000;

// Client to server

export const wsAuthMessageSchema = z.object({ type: z.literal('auth'), token: z.string().min(1) });
export const wsPingMessageSchema = z.object({ type: z.literal('ping') });

export const wsClientMessageSchema = z.discriminatedUnion('type', [
  wsAuthMessageSchema,
  wsPingMessageSchema,
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

// Server to client. Events are hints; the client pulls with `GET .../items?since=`.

export const wsReadyMessageSchema = z.object({ type: z.literal('ready') });
export const wsPongMessageSchema = z.object({ type: z.literal('pong') });
export const wsVaultChangedMessageSchema = z.object({
  type: z.literal('vault.changed'),
  vault_id: uuidSchema,
  seq: seqSchema,
});
export const wsVaultsChangedMessageSchema = z.object({ type: z.literal('vaults.changed') });
/** The server closes the socket right after sending this. */
export const wsSessionRevokedMessageSchema = z.object({ type: z.literal('session.revoked') });

export const wsServerMessageSchema = z.discriminatedUnion('type', [
  wsReadyMessageSchema,
  wsPongMessageSchema,
  wsVaultChangedMessageSchema,
  wsVaultsChangedMessageSchema,
  wsSessionRevokedMessageSchema,
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;
