import type { ZodType, ZodTypeDef } from 'zod';
import type { ErrorDto } from '../../shared/types.js';
import type { RpcMethodName, RpcMethods, RpcResult } from '../../shared/ipc.js';
import { errorToDto } from '../app/errors.js';

export type Handlers = {
  [K in RpcMethodName]: (arg: RpcMethods[K]['in']) => Promise<RpcMethods[K]['out']>;
};

export type SchemaTable = {
  [K in RpcMethodName]: ZodType<RpcMethods[K]['in'], ZodTypeDef, unknown>;
};

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

const invalid = (message: string): RpcResult<never> => ({
  ok: false,
  error: { name: 'ValidationError', code: 'invalid_input', message },
});

/**
 * Turns a raw `(method, arg)` pair from the renderer into a handler call: the method must
 * be one we know, the argument must pass that method's schema, and any failure comes back
 * as data (`{ok: false}`), never as a rejected IPC call. Handlers receive parsed values only.
 */
export function createDispatcher(schemas: SchemaTable, handlers: Handlers) {
  return async function dispatch(method: unknown, arg: unknown): Promise<RpcResult<unknown>> {
    if (typeof method !== 'string' || !hasOwn(schemas, method) || !hasOwn(handlers, method)) {
      return invalid('Unknown method');
    }
    const name = method as RpcMethodName;
    const parsed = (schemas[name] as ZodType<unknown, ZodTypeDef, unknown>).safeParse(arg);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
      return invalid(`Invalid request${where}: ${issue?.message ?? 'bad input'}`);
    }
    try {
      const run = handlers[name] as (arg: unknown) => Promise<unknown>;
      return { ok: true, value: await run(parsed.data) };
    } catch (err) {
      const error: ErrorDto = errorToDto(err);
      return { ok: false, error };
    }
  };
}
