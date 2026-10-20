import type {
  AppEvents,
  AppInfo,
  AppSettings,
  HostKeyDecision,
  ImportedFile,
  TerminalDto,
} from './app.js';
import type {
  AccountDto,
  ClientState,
  ConnectionState,
  CreatedInviteDto,
  DeviceDto,
  ErrorDto,
  InviteDto,
  ItemDraft,
  LogoutResultDto,
  LookupUserDto,
  MemberDto,
  RemoveMemberResultDto,
  ServerInfoDto,
  UserDto,
  VaultDto,
  VaultItemsDto,
  VaultRole,
  WriteResultDto,
} from './types.js';

/**
 * The contract between the renderer and the main process. The renderer is untrusted: it
 * can only call the methods listed here, and main validates every argument (see
 * `main/ipc/schemas.ts`, which must have a schema for each method).
 */

/** The one request/response channel; the method name travels as an argument. */
export const RPC_CHANNEL = 'ternix:rpc';
/** Main to renderer events. */
export const EVENT_CHANNEL = 'ternix:event';
/** Terminal output for session `<id>` is sent on `TERMINAL_CHANNEL_PREFIX + id`. */
export const TERMINAL_CHANNEL_PREFIX = 'ternix:term:';

export interface ClientSnapshot {
  state: ClientState;
  connection: ConnectionState;
  account: AccountDto | null;
}

export interface Rpc<In, Out> {
  in: In;
  out: Out;
}

export interface RpcMethods {
  'app.info': Rpc<void, AppInfo>;
  'settings.get': Rpc<void, AppSettings>;
  'settings.set': Rpc<Partial<AppSettings>, AppSettings>;
  'clipboard.write': Rpc<{ text: string }, void>;
  'dialog.importKey': Rpc<void, ImportedFile | null>;
  /** Open an http(s) link in the default browser, after the user confirms. */
  'shell.openLink': Rpc<{ url: string }, void>;

  'client.snapshot': Rpc<void, ClientSnapshot>;
  'server.probe': Rpc<{ address: string }, ServerInfoDto>;
  'auth.register': Rpc<
    { serverUrl: string; email: string; name: string; password: string; inviteCode?: string },
    AccountDto
  >;
  'auth.login': Rpc<{ serverUrl: string; email: string; password: string }, AccountDto>;
  'auth.unlock': Rpc<{ password: string }, void>;
  'auth.lock': Rpc<void, void>;
  'auth.logout': Rpc<void, LogoutResultDto>;
  'auth.changePassword': Rpc<{ current: string; next: string }, void>;
  'account.revalidate': Rpc<void, AccountDto>;
  'devices.list': Rpc<void, DeviceDto[]>;
  'devices.revoke': Rpc<{ deviceId: string }, void>;

  'admin.invites.list': Rpc<void, InviteDto[]>;
  'admin.invites.create': Rpc<{ email?: string; expiresInHours?: number }, CreatedInviteDto>;
  'admin.invites.delete': Rpc<{ code: string }, void>;
  'admin.users.list': Rpc<void, UserDto[]>;
  'admin.users.delete': Rpc<{ userId: string }, void>;

  'vaults.list': Rpc<void, VaultDto[]>;
  'vaults.create': Rpc<{ name: string }, VaultDto>;
  'vaults.rename': Rpc<{ vaultId: string; name: string }, VaultDto>;
  'vaults.delete': Rpc<{ vaultId: string }, void>;
  'vaults.sync': Rpc<void, void>;
  'vaults.members': Rpc<{ vaultId: string }, MemberDto[]>;
  'vaults.lookupUser': Rpc<{ email: string }, LookupUserDto>;
  'vaults.addMember': Rpc<
    { vaultId: string; userId: string; role: VaultRole; expectedPublicKey: string },
    MemberDto
  >;
  'vaults.changeRole': Rpc<{ vaultId: string; userId: string; role: VaultRole }, MemberDto>;
  'vaults.removeMember': Rpc<{ vaultId: string; userId: string }, RemoveMemberResultDto>;
  'vaults.leave': Rpc<{ vaultId: string }, void>;
  'vaults.rotate': Rpc<{ vaultId: string }, VaultDto>;

  /** Every readable vault's decrypted items. */
  'items.all': Rpc<void, VaultItemsDto[]>;
  'items.put': Rpc<{ vaultId: string; itemId?: string; draft: ItemDraft }, WriteResultDto>;
  'items.delete': Rpc<{ vaultId: string; itemId: string }, WriteResultDto>;

  'ssh.list': Rpc<void, TerminalDto[]>;
  'ssh.open': Rpc<{ hostId: string; cols: number; rows: number }, TerminalDto>;
  'ssh.quickConnect': Rpc<
    { target: string; password?: string; cols: number; rows: number },
    TerminalDto
  >;
  /** Start streaming terminal output on the session's channel; output so far is replayed. */
  'ssh.attach': Rpc<{ id: string }, void>;
  'ssh.write': Rpc<{ id: string; data: string }, void>;
  'ssh.resize': Rpc<{ id: string; cols: number; rows: number }, void>;
  'ssh.reconnect': Rpc<{ id: string; cols: number; rows: number }, TerminalDto>;
  'ssh.close': Rpc<{ id: string }, void>;
  'ssh.answerHostKey': Rpc<{ promptId: string; decision: HostKeyDecision }, void>;
  'ssh.answerKeyboard': Rpc<{ promptId: string; answers: string[] | null }, void>;
  'ssh.forward.start': Rpc<{ id: string; forwardId: string }, void>;
  'ssh.forward.stop': Rpc<{ id: string; forwardId: string }, void>;
}

export type RpcMethodName = keyof RpcMethods;

/** Result envelope: errors cross IPC as data, so `code` survives. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: ErrorDto };

/** The one global the preload script exposes. */
export interface TernixBridge {
  invoke(method: string, arg?: unknown): Promise<RpcResult<unknown>>;
  /** Subscribe to main-process events; returns the unsubscribe function. */
  onEvent(listener: (name: string, payload: unknown) => void): () => void;
  /** Terminal output of one session. */
  onTerminalData(id: string, listener: (data: Uint8Array) => void): () => void;
}

export type { AppEvents };
