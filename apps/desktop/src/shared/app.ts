import type { ClientState, ConnectionState, ErrorDto } from './types.js';

/**
 * Shapes the desktop shell (settings, SSH terminals, prompts) sends to the renderer. Like
 * `types.ts` they are plain and serializable: they cross Electron IPC.
 */

export type DesktopPlatform = 'macos' | 'windows' | 'linux';

export interface AppSettings {
  /** Minutes of system idle time before the vault locks; 0 turns auto-lock off. */
  autoLockMinutes: number;
  terminalFontSize: number;
  /**
   * After a saved host connects, run one read-only command there to learn its operating system
   * (for the host's icon) and store it on the host.
   */
  detectHostOs: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoLockMinutes: 15,
  terminalFontSize: 14,
  detectHostOs: true,
};
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export const MAX_AUTO_LOCK_MINUTES = 24 * 60;

export interface AppInfo {
  version: string;
  platform: DesktopPlatform;
  /** Whether the OS can encrypt the saved session; when false, logging in is refused. */
  secretStorage: { available: boolean; problem: string | null };
}

export interface ImportedFile {
  fileName: string;
  content: string;
}

export type SshState = 'connecting' | 'verifying-host-key' | 'authenticating' | 'ready' | 'closed';

export interface ForwardDto {
  id: string;
  label: string;
  kind: 'local' | 'remote' | 'dynamic';
  bindAddress: string;
  bindPort: number;
  destHost?: string;
  destPort?: number;
  state: 'idle' | 'starting' | 'active' | 'stopped' | 'error';
  boundAddress?: string;
  boundPort?: number;
  connections: number;
  error?: string;
}

export interface TerminalClosedDto {
  kind: 'requested' | 'remote' | 'error';
  /** Present for `error`. */
  message?: string;
  code?: string;
}

export interface TerminalDto {
  /** Session ID; also the tab ID. */
  id: string;
  /** The saved host this tab connects to, or null for a quick connect. */
  hostId: string | null;
  label: string;
  /** `user@address:port` as shown on the tab. */
  target: string;
  state: SshState;
  /** The hop being dialed or authenticated while `state` is not `ready`/`closed`. */
  hop?: { label: string; index: number; total: number };
  closed?: TerminalClosedDto;
  /** Set once the remote shell has ended. */
  exit?: { code?: number; signal?: string };
  forwards: ForwardDto[];
}

/** An SFTP browser tab: its own connection to a saved host, made like a terminal's. */
export interface SftpSessionDto {
  id: string;
  hostId: string;
  label: string;
  /** `user@address:port`. */
  target: string;
  state: SshState;
  hop?: { label: string; index: number; total: number };
  closed?: TerminalClosedDto;
  /** The login directory, once connected. */
  home?: string;
}

export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface SftpEntryDto {
  name: string;
  /** Absolute POSIX path on the server. */
  path: string;
  type: SftpEntryType;
  /** For a symlink: what it points to, or `missing`. */
  targetType?: SftpEntryType | 'missing';
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  /** Mode bits as the server reports them. */
  mode: number;
}

export interface SftpListingDto {
  /** The directory listed, as the server resolved it. */
  path: string;
  entries: SftpEntryDto[];
}

export type TransferState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

/** One file being copied. Local paths are never sent to the renderer, only names. */
export interface TransferDto {
  id: string;
  sessionId: string;
  direction: 'upload' | 'download';
  /** The file's name (a folder transfer lists each file under its own name). */
  name: string;
  remotePath: string;
  state: TransferState;
  transferred: number;
  total: number;
  error?: string;
}

/** What an upload or download request queued. */
export interface TransferBatchDto {
  queued: number;
  /** Items left out (unreadable, unsafe name, symlinked folder, conflict skipped). */
  skipped: number;
}

export interface KeyboardPromptDto {
  kind: 'keyboard';
  promptId: string;
  sessionId: string;
  hopLabel: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

/**
 * Prompts the renderer answers. Host keys are not among them: main asks about those in a
 * native dialog (see `main/app/trust.ts`).
 */
export type PromptDto = KeyboardPromptDto;

/** `trust`: save an unknown key. `replace`: overwrite the stored key after a mismatch. */
export type HostKeyDecision = 'trust' | 'replace' | 'reject';

export interface NoticeDto {
  sessionId?: string;
  level: 'info' | 'warning';
  message: string;
}

/** Events the main process pushes to the renderer. */
export interface AppEvents {
  'client.state': ClientState;
  'client.connection': ConnectionState;
  'client.vaults-changed': undefined;
  'client.items-changed': { vaultId: string };
  'client.session-revoked': { reason: 'revoked' | 'expired' };
  'client.error': ErrorDto;
  'ssh.status': TerminalDto;
  'ssh.prompt': PromptDto;
  /** The prompt's connection attempt ended or it timed out: dismiss its dialog. */
  'ssh.prompt-cancelled': { promptId: string };
  'ssh.notice': NoticeDto;
  'sftp.status': SftpSessionDto;
  /** A transfer changed (throttled while bytes move). */
  'sftp.transfer': TransferDto;
  /** Transfers that are no longer listed (cleared, or their session closed). */
  'sftp.transfers-removed': { ids: string[] };
  'settings.changed': AppSettings;
}

export type AppEventName = keyof AppEvents;
