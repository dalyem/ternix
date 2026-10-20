import { z, type ZodType, type ZodTypeDef } from 'zod';
import {
  buildPath,
  ERROR_CODES,
  ERROR_STATUS,
  type ErrorCode,
  itemSchema,
  type Route,
  rotateConflictResponseSchema,
} from '@ternix/core/protocol';
import { ApiError, OfflineError, TernixError } from './errors.js';

/** `globalThis.fetch`, or Electron's `net.fetch`, or a test double. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Batch and rotate bodies can be tens of MiB; give them longer. */
export const LONG_TIMEOUT_MS = 5 * 60_000;

export interface HttpOptions {
  /** Canonical base URL from `normalizeServerUrl`. */
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs?: number;
  getToken?: () => string | null;
  /** Called when an authenticated request gets `401`: the session is gone. */
  onUnauthorized?: () => void;
}

export interface RequestOptions<T> {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Validates a 2xx body; omit for `204` routes. */
  schema?: ZodType<T, ZodTypeDef, unknown>;
  /** Send the bearer token (default true). */
  auth?: boolean;
  timeoutMs?: number;
  /**
   * Treat `401` as "session gone" (default true for authenticated requests). Off for
   * routes where `401` means a wrong password.
   */
  expireOn401?: boolean;
}

const looseErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

function codeFor(code: string, status: number): ErrorCode {
  if ((ERROR_CODES as readonly string[]).includes(code)) return code as ErrorCode;
  for (const known of ERROR_CODES) if (ERROR_STATUS[known] === status) return known;
  return 'internal';
}

/** JSON over HTTP with bearer auth, timeouts, and typed errors. */
export class Http {
  readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchFn = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T = undefined>(route: Route, opts: RequestOptions<T> = {}): Promise<T> {
    const auth = opts.auth ?? true;
    const url = this.baseUrl + buildPath(route.path as string, opts.params, opts.query);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (auth) {
      const token = this.options.getToken?.();
      if (!token) throw new TernixError('session_expired', 'Not logged in to the server');
      headers.authorization = `Bearer ${token}`;
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    const signal = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);

    let status: number;
    let text: string;
    try {
      const res = await this.fetchFn(url, { method: route.method, headers, body, signal });
      status = res.status;
      text = await res.text();
    } catch (err) {
      if (signal.aborted) {
        throw new OfflineError('timeout', 'The server did not answer in time', { cause: err });
      }
      throw new OfflineError('network', undefined, { cause: err });
    }

    let json: unknown = undefined;
    let jsonOk = true;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        jsonOk = false;
      }
    }

    if (status >= 200 && status < 300) {
      if (!opts.schema) return undefined as T;
      const parsed = jsonOk ? opts.schema.safeParse(json) : undefined;
      if (!parsed?.success) {
        throw new TernixError(
          'protocol_error',
          `The server sent an unexpected response to ${route.method} ${route.path}`,
          { cause: parsed?.error },
        );
      }
      return parsed.data;
    }

    const envelope = looseErrorSchema.safeParse(json);
    if (!envelope.success) {
      // A reverse proxy (Caddy, tailscale serve) answers 502-504 when Ternix is down.
      if (status === 502 || status === 503 || status === 504) {
        throw new OfflineError('unreachable', `The server is not responding (HTTP ${status})`);
      }
      throw new ApiError(codeFor('', status), status, `Unexpected HTTP ${status} from the server`);
    }
    if (status === 401 && auth && (opts.expireOn401 ?? true)) {
      this.options.onUnauthorized?.();
      throw new TernixError('session_expired', 'The session has expired; log in again');
    }
    const record = json as Record<string, unknown>;
    const current = itemSchema.safeParse(record.current);
    const rotate = rotateConflictResponseSchema.safeParse(json);
    throw new ApiError(
      codeFor(envelope.data.error.code, status),
      status,
      envelope.data.error.message,
      current.success ? current.data : undefined,
      rotate.success ? rotate.data.expected : undefined,
      rotate.success ? rotate.data.stale_item_ids : undefined,
    );
  }
}
