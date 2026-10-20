import { ERROR_STATUS, type ErrorCode } from '@ternix/core/protocol';

/** An error the API reports as `{"error": {"code", "message"}}`; `extra` is merged into the body. */
export class ApiError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
    statusCode: number = ERROR_STATUS[code],
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

export const badRequest = (message: string) => new ApiError('bad_request', message);
export const unauthorized = (message = 'Authentication required') =>
  new ApiError('unauthorized', message);
export const forbidden = (message: string) => new ApiError('forbidden', message);
export const notFound = (message = 'Not found') => new ApiError('not_found', message);
export const conflict = (message: string, extra?: Record<string, unknown>) =>
  new ApiError('conflict', message, extra);
