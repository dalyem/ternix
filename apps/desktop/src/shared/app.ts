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
}

export const DEFAULT_SETTINGS: AppSettings = { autoLockMinutes: 15, terminalFontSize: 14 };
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

export interface HostKeyPromptDto {
  kind: 'hostkey';
  promptId: string;
  sessionId: string;
  hopLabel: string;
  hopIndex: number;
  hopTotal: number;
  host: string;
  port: number;
  keyType: string;
  /** `SHA256:...` as OpenSSH prints it. */
  fingerprint: string;
  /** `unknown`: first contact. `mismatch`: the host presents another key than the stored one. */
  status: 'unknown' | 'mismatch';
  stored?: { keyType: string; fingerprint: string };
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

export type PromptDto = HostKeyPromptDto | KeyboardPromptDto;

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
  'ssh.prompt-cancelled': { promptId: string };
  'ssh.notice': NoticeDto;
  'settings.changed': AppSettings;
}

export type AppEventName = keyof AppEvents;
