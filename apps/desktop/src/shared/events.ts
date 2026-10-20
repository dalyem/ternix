import type { ClientState, ConnectionState, ErrorDto } from './types.js';

/** Events the sync client emits, with their payloads. */
export interface ClientEvents {
  state: ClientState;
  connection: ConnectionState;
  /** The vault list, a vault name, role or key changed. */
  'vaults-changed': undefined;
  /** Items of one vault changed (pulled or written). */
  'items-changed': { vaultId: string };
  /** The server revoked this device's session, or the token stopped working. */
  'session-revoked': { reason: 'revoked' | 'expired' };
  /** A background task (sync, realtime, automatic rotation) failed. */
  error: ErrorDto;
}

export type ClientEventName = keyof ClientEvents;

export const CLIENT_EVENT_NAMES = [
  'state',
  'connection',
  'vaults-changed',
  'items-changed',
  'session-revoked',
  'error',
] as const satisfies readonly ClientEventName[];
