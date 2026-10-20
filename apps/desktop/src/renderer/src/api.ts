import type { AppEventName, AppEvents } from '../../shared/app.js';
import type { RpcMethodName, RpcMethods, RpcResult } from '../../shared/ipc.js';

/** An error from the main process: `code` is the sync client's or the shell's stable code. */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
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
  if (!result.ok) throw new ApiError(result.error.code, result.error.message);
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
  return err instanceof Error ? err.message : String(err);
}
