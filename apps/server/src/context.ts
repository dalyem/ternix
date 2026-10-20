import type { Config } from './config.js';
import type { Hub } from './hub.js';
import type { FailureLimiter } from './limiter.js';
import type { PasswordHasher } from './passwords.js';
import type { Store, UserRow } from './store.js';

/** Everything the route modules share. */
export interface AppContext {
  config: Config;
  store: Store;
  hub: Hub;
  hasher: PasswordHasher;
  loginLimiter: FailureLimiter;
  version: string;
}

export interface AuthContext {
  user: UserRow;
  deviceId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook on routes that require a session. */
    auth: AuthContext;
  }
}
