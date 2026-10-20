import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegistrationMode } from '@ternix/core/protocol';
import { registrationModeSchema } from '@ternix/core/protocol';

export interface RateLimitConfig {
  enabled: boolean;
  /** Requests per minute per IP across the whole API. */
  global: number;
  /** Requests per minute per IP for prelogin, login and register. */
  auth: number;
  /** Failed logins per email per 15 minutes before the server answers 429. */
  loginFailuresPerEmail: number;
  /** User lookups per minute per device. */
  lookup: number;
}

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  serverName: string;
  registration: RegistrationMode;
  /** HMAC key for the stable fake KDF salts that prelogin returns for unknown emails. */
  secret: Uint8Array;
  trustProxy: boolean;
  logLevel: string;
  /** libsodium `crypto_pwhash_str` limits for the stored auth-key verifier. */
  pwhash: { opslimit: number; memlimit: number };
  /** Weakest KDF parameters the server accepts at registration and password change. */
  kdfFloor: { opslimit: number; memlimit: number };
  rateLimit: RateLimitConfig;
  wsAuthTimeoutMs: number;
  /** Interval of the protocol-level ping that detects dead sockets; 0 disables it. */
  wsHeartbeatMs: number;
  /** Minimum time between `last_seen_at` writes for one device. */
  lastSeenThrottleMs: number;
  inviteDefaultHours: number;
}

export const MIB = 1024 * 1024;

export const DEFAULT_PWHASH = { opslimit: 3, memlimit: 64 * MIB } as const;
export const DEFAULT_KDF_FLOOR = { opslimit: 3, memlimit: 64 * MIB } as const;

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  enabled: true,
  global: 1200,
  auth: 20,
  loginFailuresPerEmail: 10,
  lookup: 60,
};

function parseBool(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return 8080;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}

/**
 * The HMAC secret: `TERNIX_SECRET` if set, else 32 random bytes generated once and kept in
 * `$TERNIX_DATA_DIR/server-secret` (mode 0600).
 */
export function loadSecret(dataDir: string, fromEnv: string | undefined): Uint8Array {
  if (fromEnv !== undefined && fromEnv !== '') {
    if (fromEnv.length < 16) throw new Error('TERNIX_SECRET must be at least 16 characters');
    return new TextEncoder().encode(fromEnv);
  }
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'server-secret');
  if (existsSync(file)) {
    const bytes = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
    if (bytes.length < 16) throw new Error(`${file} is corrupt (expected base64url of 32 bytes)`);
    return new Uint8Array(bytes);
  }
  const bytes = randomBytes(32);
  writeFileSync(file, bytes.toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  return new Uint8Array(bytes);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.TERNIX_DATA_DIR || '/data';
  const registration = registrationModeSchema.parse(env.TERNIX_REGISTRATION || 'invite');
  return {
    dataDir,
    host: env.HOST || '0.0.0.0',
    port: parsePort(env.PORT),
    serverName: env.TERNIX_SERVER_NAME || 'Ternix',
    registration,
    secret: loadSecret(dataDir, env.TERNIX_SECRET),
    trustProxy: parseBool(env.TERNIX_TRUST_PROXY),
    logLevel: env.TERNIX_LOG_LEVEL || 'info',
    pwhash: { ...DEFAULT_PWHASH },
    kdfFloor: { ...DEFAULT_KDF_FLOOR },
    rateLimit: { ...DEFAULT_RATE_LIMIT },
    wsAuthTimeoutMs: 10_000,
    wsHeartbeatMs: 30_000,
    lastSeenThrottleMs: 60_000,
    inviteDefaultHours: 168,
  };
}
