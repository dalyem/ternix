import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ready as readyCore } from '@ternix/core/crypto';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  ERROR_CODES,
  ERROR_STATUS,
  type ErrorCode,
} from '@ternix/core/protocol';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { migrate, openDatabase, Sql, type Db } from './db.js';
import { ApiError } from './errors.js';
import { Hub } from './hub.js';
import { FailureLimiter } from './limiter.js';
import { PasswordHasher } from './passwords.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { itemRoutes } from './routes/items.js';
import { vaultRoutes } from './routes/vaults.js';
import { wsRoutes } from './routes/ws.js';
import { Store } from './store.js';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
}

function readVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

function codeForStatus(status: number): ErrorCode {
  for (const code of ERROR_CODES) if (ERROR_STATUS[code] === status) return code;
  return status === 405 || status === 415 ? 'bad_request' : 'internal';
}

/** Build the server. Nothing listens until the caller calls `app.listen`. */
export async function buildApp(config: Config): Promise<BuiltApp> {
  await readyCore();
  const hasher = new PasswordHasher(config.pwhash);
  await hasher.init();

  const db = openDatabase(join(config.dataDir, 'ternix.db'));
  migrate(db);
  const store = new Store(db, new Sql(db));
  const hub = new Hub();
  const ctx: AppContext = {
    config,
    store,
    hub,
    hasher,
    loginLimiter: new FailureLimiter(config.rateLimit.loginFailuresPerEmail, 15 * 60_000),
    version: readVersion(),
  };

  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.authorization'],
            serializers: {
              // Path only: query strings can carry emails.
              req: (req) => ({
                method: req.method,
                url: String(req.url).split('?')[0],
                remoteAddress: req.ip,
              }),
            },
          },
  });

  app.addHook('onClose', async () => {
    hub.closeAll();
    db.close();
  });

  // A POST/DELETE that declares JSON but sends no body is fine (logout, revoke).
  app.addHook('onRequest', async (req) => {
    const length = req.headers['content-length'];
    if ((length === undefined || length === '0') && !req.headers['transfer-encoding']) {
      delete req.headers['content-type'];
    }
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message }, ...err.extra });
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const message =
        status === 413 ? 'Request body too large' : err.message.slice(0, 200) || 'Bad request';
      return reply.code(status).send({ error: { code: codeForStatus(status), message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    // TLS is terminated by the reverse proxy, which owns HSTS.
    hsts: false,
  });

  if (config.rateLimit.enabled) {
    await app.register(rateLimit, {
      global: true,
      max: config.rateLimit.global,
      timeWindow: '1 minute',
      errorResponseBuilder: (_req, context) =>
        new ApiError(
          'rate_limited',
          `Rate limit exceeded; retry in ${Math.ceil(context.ttl / 1000)}s`,
        ),
    });
  }

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  await app.register(async (api) => {
    await authRoutes(api, ctx);
    await adminRoutes(api, ctx);
    await vaultRoutes(api, ctx);
    await itemRoutes(api, ctx);
    await wsRoutes(api, ctx);
  });

  return { app, ctx, db };
}
