import type { ErrorCode, Item, RotateConflictResponse } from '@ternix/core/protocol';
import type { ErrorDto, KeyChangeDto } from '../../shared/types.js';

/** Codes of errors raised by the client itself (server codes are `ErrorCode`). */
export type ClientErrorCode =
  | 'invalid_server_url'
  | 'unsupported_server'
  | 'offline'
  | 'protocol_error'
  | 'kdf_too_weak'
  | 'wrong_password'
  | 'not_logged_in'
  | 'locked'
  | 'session_expired'
  | 'permission_denied'
  | 'limit_exceeded'
  | 'invalid_input'
  | 'vault_unavailable'
  | 'key_changed'
  | 'member_key_changed'
  | 'own_key_mismatch'
  | 'rotation_failed'
  | 'conflict_unresolved';

/** Base class: every error the client throws has a stable `code`. */
export class TernixError extends Error {
  override name = 'TernixError';
  constructor(
    readonly code: ClientErrorCode | ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A non-2xx answer from the server, with the extra fields of the 409 bodies. */
export class ApiError extends TernixError {
  override name = 'ApiError';
  constructor(
    override readonly code: ErrorCode,
    readonly status: number,
    message: string,
    /** `409 conflict` from PUT/DELETE: the server's version of the item. */
    readonly current?: Item,
    /** `409 conflict` from rotate: the IDs the server expects. */
    readonly expected?: RotateConflictResponse['expected'],
    /** `409 conflict` from rotate: requested items whose `seq` is not their `base_seq`. */
    readonly staleItemIds?: string[],
  ) {
    super(code, message);
  }
}

/** The server could not be reached (network error, timeout, or a proxy with no backend). */
export class OfflineError extends TernixError {
  override name = 'OfflineError';
  constructor(
    readonly reason: 'network' | 'timeout' | 'unreachable',
    message = 'The server cannot be reached; changes need a connection',
    options?: { cause?: unknown },
  ) {
    super('offline', message, options);
  }
}

export class InvalidServerUrlError extends TernixError {
  override name = 'InvalidServerUrlError';
  constructor(message: string) {
    super('invalid_server_url', message);
  }
}

export class WrongPasswordError extends TernixError {
  override name = 'WrongPasswordError';
  constructor(message = 'The password is incorrect') {
    super('wrong_password', message);
  }
}

export class KdfTooWeakError extends TernixError {
  override name = 'KdfTooWeakError';
  constructor() {
    super(
      'kdf_too_weak',
      'The server offered password-hashing settings weaker than Ternix allows. ' +
        'Ternix refused to log in, because a malicious or misconfigured server could use ' +
        'weak settings to make your password easier to guess.',
    );
  }
}

/** The automatic or explicit key rotation did not go through after several attempts. */
export class RotationError extends TernixError {
  override name = 'RotationError';
  constructor(message: string, options?: { cause?: unknown }) {
    super('rotation_failed', message, options);
  }
}

/**
 * A member's public key, as the server reports it, is not the one this device pinned. Raised
 * before any vault key is wrapped for it (rotation, sharing); nothing was sent.
 */
export class MemberKeyChangedError extends TernixError {
  override name = 'MemberKeyChangedError';
  constructor(readonly change: KeyChangeDto) {
    super(
      'member_key_changed',
      `The key of ${change.email} changed (pinned ${change.pinnedFingerprint}, server reports ` +
        `${change.serverFingerprint}). Compare the new fingerprint with them, then accept it.`,
    );
  }
}

/** The server reports an account key for this user that differs from the pinned one. */
export class OwnKeyMismatchError extends TernixError {
  override name = 'OwnKeyMismatchError';
  constructor() {
    super(
      'own_key_mismatch',
      'The server reports a different account key than the one this device pinned for you. ' +
        'Ternix stopped, because the server may be trying to impersonate you.',
    );
  }
}

export const isApiError = (err: unknown, code?: ErrorCode): err is ApiError =>
  err instanceof ApiError && (code === undefined || err.code === code);

/** IPC-safe form of any thrown value. */
export function toErrorDto(err: unknown): ErrorDto {
  if (err instanceof ApiError) {
    return { name: err.name, code: err.code, message: err.message, status: err.status };
  }
  if (err instanceof MemberKeyChangedError) {
    return { name: err.name, code: err.code, message: err.message, keyChange: err.change };
  }
  if (err instanceof TernixError) return { name: err.name, code: err.code, message: err.message };
  if (err instanceof Error) return { name: err.name, code: 'internal', message: err.message };
  return { name: 'Error', code: 'internal', message: String(err) };
}
