import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAccountKeypair, ready, toB64 } from '@ternix/core/crypto';
import type { KdfParams, RegistrationMode } from '@ternix/core/protocol';
import { buildApp, type BuiltApp } from '../../server/src/app.js';
import { DEFAULT_RATE_LIMIT, type Config } from '../../server/src/config.js';
import type { ClientEvents } from '../src/shared/events.js';
import {
  type FetchLike,
  MemoryCacheStore,
  MemorySecretStore,
  TernixClient,
  type TernixClientOptions,
} from '../src/main/client/index.js';
import type { StoredSession } from '../src/main/client/session.js';

/** Cheap Argon2 limits so tests stay fast. Never use these outside tests. */
export const WEAK = { opslimit: 1, memlimit: 65_536 };
export const weakEnough = (kdf: KdfParams): boolean =>
  kdf.opslimit >= WEAK.opslimit && kdf.memlimit >= WEAK.memlimit;

export interface TestServer extends BuiltApp {
  url: string;
  config: Config;
  close(): Promise<void>;
}

/** The real server, in-process, on a random loopback port (real HTTP and WebSocket). */
export async function startServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  await ready();
  const dir = mkdtempSync(join(tmpdir(), 'ternix-desktop-test-'));
  const config: Config = {
    dataDir: dir,
    host: '127.0.0.1',
    port: 0,
    serverName: 'Test Ternix',
    registration: 'open' satisfies RegistrationMode,
    secret: new TextEncoder().encode('test-secret-test-secret-test-secret'),
    trustProxy: false,
    logLevel: 'silent',
    pwhash: { ...WEAK },
    kdfFloor: { ...WEAK },
    rateLimit: { ...DEFAULT_RATE_LIMIT, enabled: false },
    wsAuthTimeoutMs: 10_000,
    wsHeartbeatMs: 0,
    lastSeenThrottleMs: 0,
    inviteDefaultHours: 168,
    ...overrides,
  };
  const built = await buildApp(config);
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = built.app.server.address() as AddressInfo;
  return {
    ...built,
    config,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Records every request a client makes, and lets a test intercept one. */
export class FetchSpy {
  readonly calls: { method: string; path: string }[] = [];
  /** Runs before a request goes out; may delay it (to change server state mid-flight). */
  before?: (method: string, path: string) => Promise<void> | void;
  /** Sees every response (cloned). */
  after?: (method: string, path: string, res: Response) => Promise<void> | void;
  offline = false;

  readonly fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(input).pathname;
    if (this.offline) throw new TypeError('fetch failed');
    this.calls.push({ method, path });
    await this.before?.(method, path);
    const res = await globalThis.fetch(input, init);
    await this.after?.(method, path, res.clone());
    return res;
  };

  count(method: string, pathPart: string): number {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathPart)).length;
  }
}

export interface TestClient {
  client: TernixClient;
  secretStore: MemorySecretStore;
  cacheStore: MemoryCacheStore;
  spy: FetchSpy;
  /** Shift this client's clock (for the conflict rule). */
  clock: { offsetMs: number };
}

const open: TernixClient[] = [];

export async function makeClient(
  overrides: Partial<TernixClientOptions> = {},
  stores?: { secretStore: MemorySecretStore; cacheStore: MemoryCacheStore },
): Promise<TestClient> {
  const secretStore = stores?.secretStore ?? new MemorySecretStore();
  const cacheStore = stores?.cacheStore ?? new MemoryCacheStore();
  const spy = new FetchSpy();
  const clock = { offsetMs: 0 };
  const client = new TernixClient({
    secretStore,
    cacheStore,
    fetch: spy.fetch,
    kdfLimits: WEAK,
    isKdfStrongEnough: weakEnough,
    device: { name: 'test device', platform: 'linux' },
    now: () => new Date(Date.now() + clock.offsetMs),
    realtime: {
      pingIntervalMs: 1_000,
      pongTimeoutMs: 1_000,
      reconnectBaseMs: 50,
      reconnectMaxMs: 500,
    },
    ...overrides,
  });
  await client.init();
  open.push(client);
  return { client, secretStore, cacheStore, spy, clock };
}

/** Close every client made by `makeClient` (call before stopping the server). */
export async function closeClients(): Promise<void> {
  await Promise.all(open.splice(0).map((client) => client.close()));
}

let counter = 0;

export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}${counter}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export interface Registered extends TestClient {
  email: string;
  password: string;
  personalVaultId: string;
}

export async function registerUser(
  server: TestServer,
  overrides: Partial<TernixClientOptions> = {},
  opts: {
    email?: string;
    password?: string;
    inviteCode?: string;
    stores?: { secretStore: MemorySecretStore; cacheStore: MemoryCacheStore };
  } = {},
): Promise<Registered> {
  const t = await makeClient(overrides, opts.stores);
  const email = opts.email ?? uniqueEmail();
  const password = opts.password ?? `correct horse ${counter}`;
  await t.client.register({
    serverUrl: server.url,
    email,
    name: email.split('@')[0]!,
    password,
    inviteCode: opts.inviteCode,
  });
  const personal = t.client.listVaults().find((v) => v.kind === 'personal');
  if (!personal) throw new Error('no personal vault after register');
  return { ...t, email, password, personalVaultId: personal.id };
}

export async function loginUser(
  server: TestServer,
  email: string,
  password: string,
  overrides: Partial<TernixClientOptions> = {},
): Promise<TestClient> {
  const t = await makeClient(overrides);
  await t.client.login({ serverUrl: server.url, email, password });
  await t.client.sync();
  return t;
}

export async function storedSession(t: TestClient): Promise<StoredSession> {
  return (await t.secretStore.get('session')) as StoredSession;
}

/** Poll until `check` passes (returns truthy without throwing). */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  label = 'condition',
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Resolve on the next matching event. */
export function nextEvent<K extends keyof ClientEvents>(
  client: TernixClient,
  event: K,
  match: (payload: ClientEvents[K]) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<ClientEvents[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${String(event)}`));
    }, timeoutMs);
    const off = client.on(event, (payload) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

/** A request with a raw bearer token, bypassing the client (what a stolen token could do). */
export async function rawRequest(
  server: TestServer,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(server.url + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** A malicious server swapping a user's public key: rewrite it in the server's database. */
export function substituteKey(server: TestServer, userId: string): string {
  const publicKey = toB64(generateAccountKeypair().publicKey);
  const res = server.db
    .prepare('UPDATE users SET public_key = ? WHERE id = ?')
    .run(publicKey, userId);
  if (res.changes !== 1) throw new Error('no such user');
  return publicKey;
}

/** A cache store that counts writes per key. */
export class CountingCacheStore extends MemoryCacheStore {
  readonly sets = new Map<string, number>();

  override async set(account: string, key: string, value: unknown): Promise<void> {
    this.sets.set(key, (this.sets.get(key) ?? 0) + 1);
    return super.set(account, key, value);
  }

  setsOf(keyPart: string): number {
    return [...this.sets].filter(([k]) => k.includes(keyPart)).reduce((n, [, c]) => n + c, 0);
  }
}

export function snippet(label: string, script = `echo ${label}`) {
  return { type: 'snippet' as const, label, script, tags: [] };
}

export const HOUR = 3_600_000;

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
