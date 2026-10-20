/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field in tests */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  decryptItem,
  decryptPrivateKey,
  decryptVaultName,
  deriveKeys,
  encryptItem,
  encryptPrivateKey,
  encryptVaultName,
  fromB64,
  generateAccountKeypair,
  newKdfParams,
  newVaultKey,
  ready,
  toB64,
  unwrapVaultKey,
  wrapVaultKey,
  type AccountKeypair,
} from '@ternix/core';
import type { Item, KdfParams, RegistrationMode, User } from '@ternix/core/protocol';
import { buildApp, type BuiltApp } from '../src/app.js';
import { DEFAULT_RATE_LIMIT, MIB, type Config } from '../src/config.js';

/** Cheap Argon2 limits so tests stay fast. Never use these outside tests. */
export const WEAK = { opslimit: 1, memlimit: 65_536 };

export const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret');

export interface TestServer extends BuiltApp {
  config: Config;
  dir: string;
  /** Throws away the temp dir and closes the app. */
  close(): Promise<void>;
}

export async function startServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  await ready();
  const dir = mkdtempSync(join(tmpdir(), 'ternix-test-'));
  const config: Config = {
    dataDir: dir,
    host: '127.0.0.1',
    port: 0,
    serverName: 'Test Ternix',
    registration: 'invite' satisfies RegistrationMode,
    secret: SECRET,
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
  await built.app.ready();
  return {
    ...built,
    config,
    dir,
    async close() {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
  raw: string;
}

export interface CallOptions {
  token?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
}

/** Thin wrapper over `fastify.inject`. */
export async function call<T = any>(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: CallOptions = {},
): Promise<Res<T>> {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) query[k] = String(v);
  const res = await app.inject({
    method,
    url,
    query,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  let body: unknown = undefined;
  try {
    body = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body: body as T, headers: res.headers, raw: res.body };
}

/** A registered or logged-in client with its key material, as the desktop app would hold it. */
export class Client {
  vaultKeys = new Map<string, Map<number, Uint8Array>>();
  constructor(
    readonly app: FastifyInstance,
    readonly email: string,
    readonly password: string,
    public token: string,
    public user: User,
    readonly deviceId: string,
    readonly keypair: AccountKeypair,
    readonly masterKey: Uint8Array,
    readonly kdf: KdfParams,
    readonly personalVaultId: string,
  ) {}

  get id(): string {
    return this.user.id;
  }

  req<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    o: CallOptions = {},
  ) {
    return call<T>(this.app, method, url, { token: this.token, ...o });
  }

  /** Learn a vault key by unwrapping the caller's `wrapped_key` from the vault list. */
  async syncKeys(): Promise<void> {
    const res = await this.req('GET', '/api/v1/vaults');
    for (const v of res.body.vaults) {
      const key = unwrapVaultKey(v.wrapped_key, this.keypair.publicKey, this.keypair.privateKey);
      let versions = this.vaultKeys.get(v.id);
      if (!versions) this.vaultKeys.set(v.id, (versions = new Map()));
      versions.set(v.key_version, key);
    }
  }

  keyFor(vaultId: string, version = 1): Uint8Array {
    const key = this.vaultKeys.get(vaultId)?.get(version);
    if (!key) throw new Error(`no key for vault ${vaultId} v${version}`);
    return key;
  }

  setKey(vaultId: string, version: number, key: Uint8Array): void {
    let versions = this.vaultKeys.get(vaultId);
    if (!versions) this.vaultKeys.set(vaultId, (versions = new Map()));
    versions.set(version, key);
  }

  encrypt(vaultId: string, itemId: string, label: string, version = 1): string {
    return encryptItem(this.keyFor(vaultId, version), vaultId, itemId, {
      type: 'snippet',
      updated_at: new Date().toISOString(),
      label,
      script: `echo ${label}`,
      tags: [],
    });
  }

  decrypt(item: Item): string {
    if (item.deleted) throw new Error('tombstone');
    const payload = decryptItem(
      this.keyFor(item.vault_id, item.key_version),
      item.vault_id,
      item.id,
      item.ciphertext,
    );
    if (payload.type !== 'snippet') throw new Error('unexpected payload');
    return payload.label;
  }

  decryptName(vault: { id: string; name_enc: string; key_version: number }): string {
    return decryptVaultName(this.keyFor(vault.id, vault.key_version), vault.id, vault.name_enc);
  }

  /** Create a shared vault and learn its key. */
  async createVault(name: string): Promise<string> {
    const id = randomUUID();
    const key = newVaultKey();
    const res = await this.req('POST', '/api/v1/vaults', {
      body: {
        id,
        name_enc: encryptVaultName(key, id, name),
        wrapped_key: wrapVaultKey(key, this.keypair.publicKey),
      },
    });
    if (res.status !== 201) throw new Error(`createVault failed: ${res.raw}`);
    this.setKey(id, 1, key);
    return id;
  }

  /** Invite `other` into a vault the caller owns, wrapping the current key for them. */
  async addMember(
    vaultId: string,
    other: Client,
    role: 'owner' | 'editor' | 'viewer',
    version = 1,
  ) {
    return this.req('POST', `/api/v1/vaults/${vaultId}/members`, {
      body: {
        user_id: other.id,
        role,
        wrapped_key: wrapVaultKey(this.keyFor(vaultId, version), other.keypair.publicKey),
        key_version: version,
      },
    });
  }

  async putItem(
    vaultId: string,
    itemId: string,
    label: string,
    baseSeq: number | null,
    version = 1,
  ) {
    return this.req('PUT', `/api/v1/vaults/${vaultId}/items/${itemId}`, {
      body: {
        ciphertext: this.encrypt(vaultId, itemId, label, version),
        key_version: version,
        base_seq: baseSeq,
      },
    });
  }
}

export interface HeldRequest {
  /** Send the withheld body, wait for the response. */
  finish(): Promise<{ status: number; body: any }>;
}

/**
 * Send a request's headers over a real socket and hold the body back, so the server's
 * `onRequest` hooks have run before the body (and the handler) arrive. Lets a test change
 * server state in the middle of a request.
 */
export async function holdRequest(
  app: FastifyInstance,
  method: 'POST' | 'DELETE',
  url: string,
  token: string,
  body: unknown,
  settleMs = 200,
): Promise<HeldRequest> {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  const socket = connect({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  const chunks: Buffer[] = [];
  const response = new Promise<string>((resolve, reject) => {
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
  socket.write(
    [
      `${method} ${url} HTTP/1.1`,
      'Host: 127.0.0.1',
      `Authorization: Bearer ${token}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(payload)}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n'),
  );
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return {
    async finish() {
      socket.write(payload);
      const raw = await response;
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]);
      const text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      return { status, body: text ? JSON.parse(text) : undefined };
    },
  };
}

let counter = 0;

export interface RegisterOptions {
  email?: string;
  name?: string;
  password?: string;
  invite_code?: string;
  device?: { name: string; platform: string };
}

/** Run the client side of registration (KDF, keypair, personal vault) and POST it. */
export async function registerRaw(app: FastifyInstance, opts: RegisterOptions = {}) {
  counter += 1;
  const email = opts.email ?? `user${counter}@example.com`;
  const password = opts.password ?? `correct horse ${counter}`;
  const kdf = newKdfParams(WEAK);
  const { masterKey, authKey } = await deriveKeys(password, kdf);
  const keypair = generateAccountKeypair();
  const vaultKey = newVaultKey();
  const personalVaultId = randomUUID();
  const body = {
    email,
    name: opts.name ?? `User ${counter}`,
    ...(opts.invite_code ? { invite_code: opts.invite_code } : {}),
    kdf,
    auth_key: toB64(authKey),
    public_key: toB64(keypair.publicKey),
    encrypted_private_key: encryptPrivateKey(masterKey, keypair.privateKey),
    personal_vault: {
      id: personalVaultId,
      name_enc: encryptVaultName(vaultKey, personalVaultId, 'Personal'),
      wrapped_key: wrapVaultKey(vaultKey, keypair.publicKey),
    },
    device: opts.device ?? { name: 'test device', platform: 'linux' },
  };
  const res = await call(app, 'POST', '/api/v1/auth/register', { body });
  return {
    res,
    body,
    email,
    password,
    kdf,
    masterKey,
    authKey,
    keypair,
    vaultKey,
    personalVaultId,
  };
}

export async function register(app: FastifyInstance, opts: RegisterOptions = {}): Promise<Client> {
  const r = await registerRaw(app, opts);
  if (r.res.status !== 201) throw new Error(`register failed: ${r.res.status} ${r.res.raw}`);
  const client = new Client(
    app,
    r.email,
    r.password,
    r.res.body.token,
    r.res.body.user,
    r.res.body.device_id,
    r.keypair,
    r.masterKey,
    r.kdf,
    r.personalVaultId,
  );
  client.setKey(r.personalVaultId, 1, r.vaultKey);
  return client;
}

/** Log in again from scratch: prelogin, derive keys, decrypt the private key. */
export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
  device = { name: 'second device', platform: 'macos' },
): Promise<Client> {
  const pre = await call(app, 'POST', '/api/v1/auth/prelogin', { body: { email } });
  const { masterKey, authKey } = await deriveKeys(password, pre.body.kdf);
  const res = await call(app, 'POST', '/api/v1/auth/login', {
    body: { email, auth_key: toB64(authKey), device },
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.raw}`);
  const privateKey = decryptPrivateKey(masterKey, res.body.keys.encrypted_private_key);
  const keypair = { publicKey: fromB64(res.body.keys.public_key), privateKey };
  const client = new Client(
    app,
    email,
    password,
    res.body.token,
    res.body.user,
    res.body.device_id,
    keypair,
    masterKey,
    res.body.keys.kdf,
    '',
  );
  await client.syncKeys();
  return client;
}

export async function createInvite(admin: Client, body: object = {}): Promise<string> {
  const res = await admin.req('POST', '/api/v1/admin/invites', { body });
  if (res.status !== 201) throw new Error(`createInvite failed: ${res.raw}`);
  return res.body.code;
}

export { MIB };
