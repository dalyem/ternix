import type { FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { unauthorized } from './errors.js';
import { hashToken } from './tokens.js';

export function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match?.[1];
}

/** `onRequest` hook for routes that need a session: resolves the bearer token to a device. */
export function authenticator(ctx: AppContext) {
  return async function authenticate(req: FastifyRequest): Promise<void> {
    const token = bearerToken(req);
    if (!token) throw unauthorized();
    const session = ctx.store.findSession(hashToken(token));
    if (!session) throw unauthorized();
    touchDevice(ctx, session.device_id, session.last_seen_at);
    req.auth = { user: session.user, deviceId: session.device_id };
  };
}

/** Write `last_seen_at` at most once per throttle window. */
export function touchDevice(ctx: AppContext, deviceId: string, lastSeenAt: string | null): void {
  const last = lastSeenAt ? Date.parse(lastSeenAt) : 0;
  if (Date.now() - last >= ctx.config.lastSeenThrottleMs) ctx.store.touchDevice(deviceId);
}
