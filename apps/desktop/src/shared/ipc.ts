import type {
  AppEvents,
  AppInfo,
  AppSettings,
  ImportedFile,
  SftpListingDto,
  SftpSessionDto,
  TerminalDto,
  TransferBatchDto,
  TransferDto,
} from './app.js';
import type {
  AccountDto,
  ClientState,
  ConnectionState,
  CreatedInviteDto,
  DeviceDto,
  ErrorDto,
  InviteDto,
  ItemDraftInput,
  ItemSecretsDto,
  ListedVaultItemsDto,
  ListedWriteResultDto,
  LogoutResultDto,
  LookupUserDto,
  MemberDto,
  RemoveMemberResultDto,
  ServerInfoDto,
  UserDto,
  VaultDto,
  VaultRole,
} from './types.js';

/**
 * The contract between the renderer and the main process. The renderer is untrusted: it
 * can only call the methods listed here, and main validates every argument (see
 * `main/ipc/schemas.ts`, which must have a schema for each method).
 *
 * Trust decisions are not the renderer's to make. Accepting an SSH host key, adding a vault
 * member, accepting a member's changed key and marking a member verified are confirmed in a
 * native dialog that main opens itself, showing the facts (host, port, key type and
 * fingerprint; or email and fingerprint). The renderer may start these actions, but cannot
 * answer for the user; a dialog the user declines fails with `cancelled`.
 */

/** The one request/response channel; the method name travels as an argument. */
export const RPC_CHANNEL = 'ternix:rpc';
/** Main to renderer events. */
export const EVENT_CHANNEL = 'ternix:event';
/** Terminal output for session `<id>` is sent on `TERMINAL_CHANNEL_PREFIX + id`. */
export const TERMINAL_CHANNEL_PREFIX = 'ternix:term:';
/**
 * Asked once by the preload of every page load (synchronously, before page scripts run): the
 * page generation it then sends with each request. Main refuses requests from a page that was
 * replaced after the user signed out (see `main/ipc/pageGate.ts`).
 */
export const PAGE_CHANNEL = 'ternix:page';
/**
 * Files dropped on the SFTP browser: the preload sends their paths here (from
 * `webUtils.getPathForFile`). Page scripts cannot use this channel; they hand the preload `File`
 * objects, never path strings. Checked like `RPC_CHANNEL`, argument `SftpDropRequest`.
 */
export const SFTP_DROP_CHANNEL = 'ternix:sftp-drop';

export interface SftpDropRequest {
  id: string;
  remoteDir: string;
  paths: string[];
}

/** A probed server, plus whether its address looks like a tailnet one (a UI hint only). */
export interface ProbedServerDto extends ServerInfoDto {
  tailnet: boolean;
}

/**
 * Why the last session ended, for the page that loads after it: the server revoked the device
 * or the session expired, or a logout could not reach the server to revoke this device.
 */
export type SessionNotice = 'revoked' | 'expired' | 'logout_unrevoked';

export interface ClientSnapshot {
  state: ClientState;
  connection: ConnectionState;
  account: AccountDto | null;
  /** The server address to sign in to, remembered by main. */
  serverUrl: string | null;
  notice: SessionNotice | null;
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
  /** Only while signed out (`loggedOut` or `expired`); refused with `forbidden` otherwise. */
  'server.probe': Rpc<{ address: string }, ProbedServerDto>;
  /** Remember (or forget, with null) the server to sign in to. Only while signed out. */
  'server.remember': Rpc<{ serverUrl: string | null }, void>;
  'auth.register': Rpc<
    { serverUrl: string; email: string; name: string; password: string; inviteCode?: string },
    AccountDto
  >;
  'auth.login': Rpc<{ serverUrl: string; email: string; password: string }, AccountDto>;
  'auth.unlock': Rpc<{ password: string }, void>;
  'auth.lock': Rpc<void, void>;
  /**
   * Succeeds when there is no session. Leaving a session reloads the window (see
   * `PAGE_CHANNEL`). `forgetServer` also forgets the remembered server address.
   */
  'auth.logout': Rpc<{ forgetServer?: boolean }, LogoutResultDto>;
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
  /**
   * Main asks the user to confirm the person's email and the fingerprint of
   * `expectedPublicKey`. The user must have been looked up (or listed) first, so main knows
   * the email the server reports for `userId`.
   */
  'vaults.addMember': Rpc<
    { vaultId: string; userId: string; role: VaultRole; expectedPublicKey: string },
    MemberDto
  >;
  /** Main asks the user to confirm the fingerprint of `publicKey`, then marks the pin verified. */
  'vaults.markMemberVerified': Rpc<{ userId: string; publicKey: string }, void>;
  /** Main asks the user to confirm the new fingerprint, then pins `publicKey` as verified. */
  'vaults.acceptMemberKey': Rpc<{ userId: string; publicKey: string }, void>;
  'vaults.changeRole': Rpc<{ vaultId: string; userId: string; role: VaultRole }, MemberDto>;
  'vaults.removeMember': Rpc<{ vaultId: string; userId: string }, RemoveMemberResultDto>;
  'vaults.leave': Rpc<{ vaultId: string }, void>;
  'vaults.rotate': Rpc<{ vaultId: string }, VaultDto>;

  /** Every readable vault's decrypted items, without secret fields (see `ListedPayload`). */
  'items.all': Rpc<void, ListedVaultItemsDto[]>;
  /** The secret fields of one item, for an open editor or a copy action. */
  'items.reveal': Rpc<{ vaultId: string; itemId: string }, ItemSecretsDto>;
  /**
   * Create or update an item. Secret fields follow `ItemDraftInput`: absent keeps the stored
   * value, `null` or `''` clears it. `known_host` items cannot be written here (main saves
   * them after the user accepts a host key); deleting them is allowed.
   */
  'items.put': Rpc<
    { vaultId: string; itemId?: string; draft: ItemDraftInput },
    ListedWriteResultDto
  >;
  'items.delete': Rpc<{ vaultId: string; itemId: string }, ListedWriteResultDto>;

  'ssh.list': Rpc<void, TerminalDto[]>;
  'ssh.open': Rpc<{ hostId: string; cols: number; rows: number }, TerminalDto>;
  'ssh.quickConnect': Rpc<
    { target: string; password?: string; cols: number; rows: number },
    TerminalDto
  >;
  /**
   * Start streaming terminal output on the session's channel; output so far is replayed.
   * `displayReset`: an earlier page showed this shell, so this page's terminal starts fresh.
   */
  'ssh.attach': Rpc<{ id: string }, { displayReset: boolean }>;
  'ssh.write': Rpc<{ id: string; data: string }, void>;
  'ssh.resize': Rpc<{ id: string; cols: number; rows: number }, void>;
  'ssh.reconnect': Rpc<{ id: string; cols: number; rows: number }, TerminalDto>;
  'ssh.close': Rpc<{ id: string }, void>;
  'ssh.answerKeyboard': Rpc<{ promptId: string; answers: string[] | null }, void>;
  'ssh.forward.start': Rpc<{ id: string; forwardId: string }, void>;
  'ssh.forward.stop': Rpc<{ id: string; forwardId: string }, void>;

  /** SFTP browser tabs. Each has its own connection to a saved host (`ssh.*` rules apply). */
  'sftp.list': Rpc<void, SftpSessionDto[]>;
  'sftp.open': Rpc<{ hostId: string }, SftpSessionDto>;
  'sftp.reconnect': Rpc<{ id: string }, SftpSessionDto>;
  'sftp.close': Rpc<{ id: string }, void>;
  /** List a remote directory; `path` may be relative to the login directory. */
  'sftp.readdir': Rpc<{ id: string; path: string }, SftpListingDto>;
  'sftp.mkdir': Rpc<{ id: string; path: string }, void>;
  /** Fails with `already_exists` rather than replacing. */
  'sftp.rename': Rpc<{ id: string; from: string; to: string }, void>;
  /** Main asks the user to confirm in a native dialog; declining fails with `cancelled`. */
  'sftp.remove': Rpc<{ id: string; paths: string[] }, void>;
  /** Main shows its open dialog (files, or one folder) and uploads what the user picks. */
  'sftp.upload': Rpc<{ id: string; remoteDir: string; kind: 'files' | 'folder' }, TransferBatchDto>;
  /** Main shows its save (one file) or folder dialog and downloads into what the user picks. */
  'sftp.download': Rpc<{ id: string; paths: string[] }, TransferBatchDto>;
  'sftp.transfers': Rpc<void, TransferDto[]>;
  'sftp.cancelTransfer': Rpc<{ transferId: string }, void>;
  'sftp.clearTransfers': Rpc<void, void>;
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
  /**
   * Upload files dropped on the SFTP browser into `remoteDir`. Takes the dropped `File` objects
   * (the preload looks up their paths); a `File` the page made itself has no path and is ignored.
   */
  uploadDropped(id: string, remoteDir: string, files: File[]): Promise<RpcResult<TransferBatchDto>>;
}

export type { AppEvents };
