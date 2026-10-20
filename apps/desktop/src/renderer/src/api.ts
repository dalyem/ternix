import type { AppEventName, AppEvents } from '../../shared/app.js';
import type { RpcMethodName, RpcMethods, RpcResult } from '../../shared/ipc.js';
import type { ErrorDto, KeyChangeDto } from '../../shared/types.js';

/**
 * An error from the main process: `code` is the sync client's or the shell's stable code.
 * `keyChange` is set for `member_key_changed`, `location` for `unexpected_redirect`.
 */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly code: string,
    message: string,
    readonly keyChange?: KeyChangeDto,
    readonly location?: string,
  ) {
    super(message);
  }
}

export function apiErrorFrom(dto: ErrorDto): ApiError {
  return new ApiError(dto.code, dto.message, dto.keyChange, dto.location);
}

/** An unlock, login, register or password change that lock, logout or quit superseded. */
export const isCancelled = (err: unknown): boolean =>
  err instanceof ApiError && err.code === 'cancelled';

/** The server reports another account key than this device pinned: nothing may go on. */
export const isOwnKeyMismatch = (err: unknown): boolean =>
  err instanceof ApiError && err.code === 'own_key_mismatch';

/** The pinned-key details of a `member_key_changed` error, if `err` is one. */
export function keyChangeOf(err: unknown): KeyChangeDto | null {
  return err instanceof ApiError && err.code === 'member_key_changed' && err.keyChange
    ? err.keyChange
    : null;
}

const fatalListeners = new Set<() => void>();

/** Called when any request fails with `own_key_mismatch`; the store shows the blocking screen. */
export function onOwnKeyMismatch(listener: () => void): () => void {
  fatalListeners.add(listener);
  return () => void fatalListeners.delete(listener);
}

export function reportOwnKeyMismatch(): void {
  for (const listener of [...fatalListeners]) listener();
}

type Args<K extends RpcMethodName> = RpcMethods[K]['in'] extends void
  ? []
  : [arg: RpcMethods[K]['in']];

/** Call a main-process method. Rejects with `ApiError`. */
export async function call<K extends RpcMethodName>(
  method: K,
  ...args: Args<K>
): Promise<RpcMethods[K]['out']> {
  const result = (await window.ternix.invoke(method, args[0])) as RpcResult<RpcMethods[K]['out']>;
  if (!result.ok) {
    const error = apiErrorFrom(result.error);
    if (isOwnKeyMismatch(error)) reportOwnKeyMismatch();
    throw error;
  }
  return result.value;
}

type Listener<K extends AppEventName> = (payload: AppEvents[K]) => void;
const listeners = new Map<string, Set<(payload: never) => void>>();
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  window.ternix.onEvent((name, payload) => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(payload as never);
  });
}

/** Subscribe to a main-process event; returns the unsubscribe function. */
export function on<K extends AppEventName>(name: K, listener: Listener<K>): () => void {
  ensureSubscribed();
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  set.add(listener as (payload: never) => void);
  return () => void set.delete(listener as (payload: never) => void);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === 'unexpected_redirect') {
    return `The server answered with a redirect${err.location ? ` to ${err.location}` : ''}. Enter the final address instead.`;
  }
  return err instanceof Error ? err.message : String(err);
}
