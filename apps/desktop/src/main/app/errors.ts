import { toErrorDto } from '../client/index.js';
import type { ErrorDto } from '../../shared/types.js';

/** An error of the desktop shell itself (not the sync client), with a stable `code`. */
export class AppError extends Error {
  override name = 'AppError';
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** IPC-safe form of any thrown value; `AppError` and `SshError`-like errors keep their code. */
export function errorToDto(err: unknown): ErrorDto {
  if (err instanceof AppError) return { name: err.name, code: err.code, message: err.message };
  const dto = toErrorDto(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (dto.code === 'internal' && typeof code === 'string' && /^[a-z_]+$/.test(code)) {
    return { ...dto, code };
  }
  return dto;
}
