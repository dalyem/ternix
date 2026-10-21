export type SshErrorCode =
  | 'invalid_state'
  | 'invalid_key'
  | 'passphrase_required'
  | 'bad_passphrase'
  | 'host_key_rejected'
  | 'auth_failed'
  | 'handshake_failed'
  | 'connect_failed'
  | 'timeout'
  | 'channel_failed'
  | 'forward_failed'
  | 'closed'
  /** SFTP: the path does not exist. */
  | 'not_found'
  /** SFTP: the server refused the operation on this path. */
  | 'permission_denied'
  /** SFTP: something is already there (an upload that may not overwrite, a new folder). */
  | 'already_exists'
  /** SFTP: any other failure the server reported; `message` has its text. */
  | 'sftp_failed'
  /** SFTP: a listing (or a tree walked through listings) is larger than the caller allows. */
  | 'too_many_entries'
  /** A transfer or operation the caller aborted. */
  | 'cancelled';

export interface SshErrorOptions {
  /** Index into the hop list (jump hosts first, target last), when the failure belongs to one hop. */
  hop?: number;
  cause?: unknown;
}

/** Every failure the SSH engine reports to callers. `code` is stable; `message` is for display. */
export class SshError extends Error {
  override readonly name = 'SshError';
  readonly code: SshErrorCode;
  readonly hop: number | undefined;

  constructor(code: SshErrorCode, message: string, options: SshErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.hop = options.hop;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
