import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  decryptPrivateKey,
  deriveKeys as coreDeriveKeys,
  type DerivedKeys,
  encryptPrivateKey,
  encryptVaultName,
  fingerprint,
  fromB64,
  generateAccountKeypair,
  isKdfStrongEnough as coreIsKdfStrongEnough,
  type KdfLimits,
  newKdfParams,
  newVaultKey,
  publicKeyFromPrivateKey,
  ready,
  toB64,
  wrapVaultKey,
} from '@ternix/core/crypto';
import {
  createInviteResponseSchema,
  type DeviceInfo,
  type KdfParams,
  listDevicesResponseSchema,
  listInvitesResponseSchema,
  listUsersResponseSchema,
  loginResponseSchema,
  meResponseSchema,
  normalizeEmail,
  preloginResponseSchema,
  registerResponseSchema,
  routes,
  type User,
  type VaultRole,
} from '@ternix/core/protocol';
import type { ClientEvents } from '../../shared/events.js';
import type {
  AccountDto,
  BatchOpInput,
  BatchResultDto,
  ClientState,
  ConnectionState,
  CreatedInviteDto,
  DeviceDto,
  InviteDto,
  ItemDraft,
  ItemDto,
  LogoutResultDto,
  LookupUserDto,
  MemberDto,
  RemoveMemberResultDto,
  ServerInfoDto,
  UserDto,
  VaultDto,
  VaultItemsDto,
  WriteResultDto,
} from '../../shared/types.js';
import { CoalescingCacheStore, type CoalescingOptions } from './coalescing.js';
import { TypedEmitter } from './emitter.js';
import { type PutItemOptions, type SkippedWriteDto, VaultEngine } from './engine.js';
import {
  CancelledError,
  isApiError,
  KdfTooWeakError,
  TernixError,
  toErrorDto,
  WrongPasswordError,
} from './errors.js';
import { type FetchLike, Http } from './http.js';
import { Keyring } from './keyring.js';
import {
  Realtime,
  type RealtimeOptions,
  type WebSocketFactory,
  wsSocketFactory,
} from './realtime.js';
import { PinStore, pinsKey } from './pins.js';
import { normalizeServerUrl, probeServer, wsUrlFor } from './serverUrl.js';
import {
  accountKey,
  isItemsCacheKey,
  SESSION_KEY,
  type StoredSession,
  storedSessionSchema,
} from './session.js';
import type { CacheStore, SecretStore } from './stores.js';

export * from './errors.js';
export { CoalescingCacheStore, type CoalescingOptions, DEFAULT_COALESCING } from './coalescing.js';
export { type KeyPin, PinStore } from './pins.js';
export {
  chunkBatch,
  MAX_ROTATION_ATTEMPTS,
  type PutItemOptions,
  type SkippedWriteDto,
} from './engine.js';
export type { FetchLike } from './http.js';
export type {
  RealtimeOptions,
  RealtimeSocket,
  RealtimeSocketHandlers,
  WebSocketFactory,
} from './realtime.js';
export { wsSocketFactory } from './realtime.js';
export {
  isLoopbackHost,
  isTailnetHost,
  normalizeServerUrl,
  probeServer,
  wsUrlFor,
} from './serverUrl.js';
export {
  type CacheStore,
  JsonFileCacheStore,
  JsonFileSecretStore,
  MemoryCacheStore,
  MemorySecretStore,
  type SecretStore,
} from './stores.js';

export interface TernixClientOptions {
  /** Session and pinned member keys; integrity matters. Electron: `safeStorage`. */
  secretStore: SecretStore;
  cacheStore: CacheStore;
  /**
   * Item-cache writes are coalesced per vault: written once changes pause for `debounceMs`
   * (default 250), or `maxDelayMs` (default 2000) after the first one. `lock`, `logout`,
   * `close` and `flush` write everything at once.
   */
  cacheWrite?: Partial<CoalescingOptions>;
  /** Default `globalThis.fetch`; Electron passes `net.fetch`. */
  fetch?: FetchLike;
  /** Default: the `ws` package. */
  webSocketFactory?: WebSocketFactory;
  /** `false` turns realtime off (sync only on demand). */
  realtime?: RealtimeOptions | false;
  /** Reported to the server at login; default this machine's host name and platform. */
  device?: DeviceInfo;
  /** Password to keys; injectable so the app can run Argon2 off the main thread. */
  deriveKeys?: (password: string, kdf: KdfParams) => Promise<DerivedKeys>;
  /** Login refuses server KDF parameters this rejects. Default: the protocol floor. */
  isKdfStrongEnough?: (kdf: KdfParams) => boolean;
  /** Argon2 limits for new KDF parameters (register, password change). Tests only. */
  kdfLimits?: Partial<KdfLimits>;
  /** Clock for `updated_at` and conflict decisions. */
  now?: () => Date;
  requestTimeoutMs?: number;
}

export interface RegisterInput {
  serverUrl: string;
  email: string;
  name: string;
  password: string;
  inviteCode?: string;
  /** Name of the personal vault created with the account. */
  personalVaultName?: string;
}

export interface LoginInput {
  serverUrl: string;
  email: string;
  password: string;
}

export interface CreateInviteInput {
  email?: string;
  expiresInHours?: number;
}

const sameKdf = (a: KdfParams, b: KdfParams): boolean =>
  a.alg === b.alg && a.salt === b.salt && a.opslimit === b.opslimit && a.memlimit === b.memlimit;

function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    publicKey: user.public_key,
    fingerprint: fingerprint(fromB64(user.public_key)),
    createdAt: user.created_at,
  };
}

/**
 * The Ternix sync client: account, vaults, items, sharing and realtime sync against one
 * server (docs/protocol.md). Framework-free; Electron supplies stores, `fetch` and the
 * WebSocket factory. Every method returns plain DTOs that can cross IPC.
 */
export class TernixClient {
  private readonly emitter = new TypedEmitter<ClientEvents>();
  private readonly fetchFn: FetchLike;
  private readonly deriveKeys: (password: string, kdf: KdfParams) => Promise<DerivedKeys>;
  private readonly isKdfStrongEnough: (kdf: KdfParams) => boolean;
  private readonly now: () => Date;
  /** The caller's cache store behind the write coalescer; everything reads and writes here. */
  private readonly cache: CoalescingCacheStore;
  private pins: { account: string; loading: Promise<PinStore> } | null = null;
  private session: StoredSession | null = null;
  /**
   * Bound to one session: replaced when a session starts, dropped at logout. Its requests
   * carry that session's token and no other, so `this.http === http` also tells whether the
   * session an operation started with is still the current one.
   */
  private http: Http | null = null;
  private engine: VaultEngine | null = null;
  private realtime: Realtime | null = null;
  private currentState: ClientState = 'loggedOut';
  private initialised = false;
  /**
   * Bumped by lock, logout, close, login and register. A pending unlock, login or register
   * that sees it change gives up (`CancelledError`) and wipes what it derived.
   */
  private lifecycle = 0;
  private loggingOut: Promise<unknown> | null = null;

  constructor(private readonly options: TernixClientOptions) {
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.deriveKeys = options.deriveKeys ?? coreDeriveKeys;
    this.isKdfStrongEnough = options.isKdfStrongEnough ?? coreIsKdfStrongEnough;
    this.now = options.now ?? (() => new Date());
    this.cache = new CoalescingCacheStore(
      options.cacheStore,
      isItemsCacheKey,
      (err) => this.emitter.emit('error', toErrorDto(err)),
      options.cacheWrite,
    );
  }

  // Events and state

  on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void) {
    return this.emitter.on(event, listener);
  }

  off<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void) {
    this.emitter.off(event, listener);
  }

  once<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void) {
    return this.emitter.once(event, listener);
  }

  get state(): ClientState {
    return this.currentState;
  }

  get connection(): ConnectionState {
    return this.realtime?.connection ?? 'offline';
  }

  /**
   * Changes on every lock, logout, close, login and register. Work that outlives a call (key
   * generation) compares it before writing, so a lock followed by an unlock still cancels it.
   */
  get epoch(): number {
    return this.lifecycle;
  }

  /** The logged-in account (also while locked or expired), or null. */
  get account(): AccountDto | null {
    const s = this.session;
    if (!s) return null;
    return {
      serverUrl: s.serverUrl,
      email: s.email,
      deviceId: s.deviceId,
      user: toUserDto(s.user),
    };
  }

  private setState(state: ClientState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emitter.emit('state', state);
  }

  /** Load libsodium and any saved session. Call once before anything else. */
  async init(): Promise<ClientState> {
    await ready();
    this.initialised = true;
    const saved = storedSessionSchema.safeParse(await this.options.secretStore.get(SESSION_KEY));
    if (saved.success) {
      this.useSession(saved.data);
      this.setState(saved.data.token ? 'locked' : 'expired');
    } else {
      this.setState('loggedOut');
    }
    return this.currentState;
  }

  private assertInit(): void {
    if (!this.initialised) throw new Error('TernixClient.init() has not been called');
  }

  private useSession(session: StoredSession): void {
    this.session = session;
    const http: Http = new Http({
      baseUrl: session.serverUrl,
      fetch: this.fetchFn,
      timeoutMs: this.options.requestTimeoutMs,
      // Only this session's token, and only while it is current and not expired.
      getToken: () =>
        this.http === http && this.session?.token === session.token ? session.token : null,
      // A late 401 from an earlier session must not end the current one.
      onUnauthorized: () => {
        if (this.http === http) this.expire('expired');
      },
    });
    this.http = http;
  }

  private async saveSession(): Promise<void> {
    if (this.session) await this.options.secretStore.set(SESSION_KEY, this.session);
  }

  private requireSession(): StoredSession {
    this.assertInit();
    if (!this.session) throw new TernixError('not_logged_in', 'Not logged in');
    return this.session;
  }

  private requireOnline(): { session: StoredSession; http: Http } {
    const session = this.requireSession();
    if (!session.token || !this.http) {
      throw new TernixError('session_expired', 'The session has expired; log in again');
    }
    return { session, http: this.http };
  }

  private requireEngine(): VaultEngine {
    this.requireSession();
    if (!this.engine || this.engine.isClosed) throw new TernixError('locked', 'Ternix is locked');
    return this.engine;
  }

  /** The pinned member keys of an account; loaded once and kept across lock and unlock. */
  private pinStoreFor(serverUrl: string, userId: string): Promise<PinStore> {
    const account = accountKey(serverUrl, userId);
    if (this.pins?.account !== account) {
      const loading = PinStore.load(this.options.secretStore, account, userId, this.now);
      this.pins = { account, loading };
      loading.catch(() => {
        if (this.pins?.loading === loading) this.pins = null;
      });
    }
    return this.pins.loading;
  }

  /** Pins of the saved session; its account key is pinned as the account's own. */
  private async sessionPins(session: StoredSession): Promise<PinStore> {
    const pins = await this.pinStoreFor(session.serverUrl, session.user.id);
    await pins.pinSelf(session.keys.public_key);
    return pins;
  }

  private async forgetPins(account: string): Promise<void> {
    const loaded =
      this.pins?.account === account ? await this.pins.loading.catch(() => null) : null;
    this.pins = this.pins?.account === account ? null : this.pins;
    if (loaded) await loaded.clear();
    else await this.options.secretStore.delete(pinsKey(account));
  }

  private get device(): DeviceInfo {
    return (
      this.options.device ?? { name: hostname() || 'Ternix desktop', platform: process.platform }
    );
  }

  // Server

  /** Check an address before register/login: normalizes it and asks the server who it is. */
  async probeServer(input: string): Promise<ServerInfoDto> {
    await ready();
    return probeServer(input, this.fetchFn);
  }

  // Account

  /**
   * Create an account: new KDF parameters, keys derived from the password, an account
   * keypair, and the personal vault. Leaves the client unlocked.
   */
  async register(input: RegisterInput): Promise<AccountDto> {
    this.assertInit();
    await this.settleLogout();
    this.assertCanLogIn();
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const email = normalizeEmail(input.email);
    const http = new Http({
      baseUrl: serverUrl,
      fetch: this.fetchFn,
      timeoutMs: this.options.requestTimeoutMs,
    });
    const live = this.beginLogin();

    const kdf = newKdfParams(this.options.kdfLimits);
    const { masterKey, authKey } = await this.deriveKeys(input.password, kdf);
    const keypair = generateAccountKeypair();
    const vaultKey = newVaultKey();
    const vaultId = randomUUID();
    try {
      live.check();
      const encryptedPrivateKey = encryptPrivateKey(masterKey, keypair.privateKey);
      const publicKey = toB64(keypair.publicKey);
      const res = await http.request(routes.register, {
        auth: false,
        body: {
          email,
          name: input.name.trim(),
          ...(input.inviteCode ? { invite_code: input.inviteCode.trim() } : {}),
          kdf,
          auth_key: toB64(authKey),
          public_key: publicKey,
          encrypted_private_key: encryptedPrivateKey,
          personal_vault: {
            id: vaultId,
            name_enc: encryptVaultName(vaultKey, vaultId, input.personalVaultName ?? 'Personal'),
            wrapped_key: wrapVaultKey(vaultKey, keypair.publicKey),
          },
          device: this.device,
        },
        schema: registerResponseSchema,
      });
      // The account exists now; a cancelled register leaves it for a later login.
      this.revokeIfCancelled(live, serverUrl, res.token);
      const pins = await this.pinStoreFor(serverUrl, res.user.id);
      await pins.pinSelf(publicKey);
      pins.checkSelf(res.user.id, res.user.public_key);
      this.revokeIfCancelled(live, serverUrl, res.token);
      await this.startSession(
        {
          serverUrl,
          email,
          token: res.token,
          deviceId: res.device_id,
          user: res.user,
          keys: { public_key: publicKey, encrypted_private_key: encryptedPrivateKey, kdf },
        },
        live,
      );
      const keyring = new Keyring(keypair.publicKey, keypair.privateKey);
      keyring.set(vaultId, 1, vaultKey);
      await this.openVaults(keyring, live.alive);
      await this.initialSync();
      return this.account!;
    } catch (err) {
      keypair.privateKey.fill(0);
      vaultKey.fill(0);
      throw err;
    } finally {
      masterKey.fill(0);
      authKey.fill(0);
    }
  }

  /**
   * Log in on this device: prelogin, refuse weak KDF parameters, derive keys, log in,
   * decrypt the account key. Leaves the client unlocked.
   */
  async login(input: LoginInput): Promise<AccountDto> {
    this.assertInit();
    await this.settleLogout();
    this.assertCanLogIn();
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const email = normalizeEmail(input.email);
    const http = new Http({
      baseUrl: serverUrl,
      fetch: this.fetchFn,
      timeoutMs: this.options.requestTimeoutMs,
    });
    const live = this.beginLogin();

    const { kdf } = await http.request(routes.prelogin, {
      auth: false,
      body: { email },
      schema: preloginResponseSchema,
    });
    live.check();
    if (!this.isKdfStrongEnough(kdf)) throw new KdfTooWeakError();
    const { masterKey, authKey } = await this.deriveKeys(input.password, kdf);
    try {
      live.check();
      const res = await http
        .request(routes.login, {
          auth: false,
          body: { email, auth_key: toB64(authKey), device: this.device },
          schema: loginResponseSchema,
        })
        .catch((err: unknown) => {
          if (isApiError(err, 'unauthorized')) {
            throw new WrongPasswordError('Wrong email or password');
          }
          throw err;
        });
      this.revokeIfCancelled(live, serverUrl, res.token);
      if (!sameKdf(res.keys.kdf, kdf)) {
        throw new TernixError(
          'protocol_error',
          'The server changed the KDF parameters during login',
        );
      }
      let privateKey: Uint8Array;
      try {
        privateKey = decryptPrivateKey(masterKey, res.keys.encrypted_private_key);
      } catch (err) {
        throw new TernixError(
          'protocol_error',
          'The account key from the server cannot be decrypted',
          {
            cause: err,
          },
        );
      }
      const publicKey = publicKeyFromPrivateKey(privateKey);
      if (toB64(publicKey) !== res.keys.public_key || res.user.public_key !== res.keys.public_key) {
        privateKey.fill(0);
        throw new TernixError('protocol_error', 'The account key from the server does not match');
      }
      try {
        await (await this.pinStoreFor(serverUrl, res.user.id)).pinSelf(res.keys.public_key);
        this.revokeIfCancelled(live, serverUrl, res.token);
        await this.startSession(
          {
            serverUrl,
            email,
            token: res.token,
            deviceId: res.device_id,
            user: res.user,
            keys: res.keys,
          },
          live,
        );
      } catch (err) {
        privateKey.fill(0);
        throw err;
      }
      await this.openVaults(new Keyring(publicKey, privateKey), live.alive);
      await this.initialSync();
      return this.account!;
    } finally {
      masterKey.fill(0);
      authKey.fill(0);
    }
  }

  private assertCanLogIn(): void {
    if (this.currentState === 'locked' || this.currentState === 'unlocked') {
      throw new TernixError('invalid_input', 'Log out before logging in to another account');
    }
  }

  /** A login or register in progress: cancels any other pending one, and is cancelled in turn. */
  private beginLogin(): { alive: () => boolean; check: () => void } {
    const generation = ++this.lifecycle;
    const alive = () => this.lifecycle === generation;
    return {
      alive,
      check: () => {
        if (!alive()) throw new CancelledError();
      },
    };
  }

  /** The server issued a token for a login that was cancelled since: revoke it, then throw. */
  private revokeIfCancelled(live: { alive: () => boolean }, serverUrl: string, token: string) {
    if (live.alive()) return;
    new Http({ baseUrl: serverUrl, fetch: this.fetchFn, getToken: () => token })
      .request(routes.logout, { expireOn401: false })
      .catch(() => undefined);
    throw new CancelledError();
  }

  private async settleLogout(): Promise<void> {
    await this.loggingOut?.catch(() => undefined);
  }

  private async startSession(
    session: StoredSession,
    live: { alive: () => boolean },
  ): Promise<void> {
    // Logging in to another account (after the old one expired) drops the old cache.
    const previous = this.session;
    const oldAccount = previous && accountKey(previous.serverUrl, previous.user.id);
    if (oldAccount && oldAccount !== accountKey(session.serverUrl, session.user.id)) {
      await this.cache.clear(oldAccount);
      await this.forgetPins(oldAccount);
    }
    this.revokeIfCancelled(live, session.serverUrl, session.token!);
    this.useSession(session);
    await this.saveSession();
  }

  /**
   * Unlock with the master password, offline: derive keys from the saved KDF parameters
   * and decrypt the saved account key. Throws `WrongPasswordError`.
   */
  async unlock(password: string): Promise<void> {
    const session = this.requireSession();
    if (!session.token) {
      throw new TernixError('session_expired', 'The session has expired; log in again');
    }
    if (this.currentState === 'unlocked') return;
    // A lock, logout or close during the KDF or the cache load wins over this unlock.
    const generation = this.lifecycle;
    const http = this.http;
    const alive = () => this.lifecycle === generation && this.http === http;
    const { masterKey, authKey } = await this.deriveKeys(password, session.keys.kdf);
    authKey.fill(0);
    if (!alive()) {
      masterKey.fill(0);
      throw new CancelledError();
    }
    let privateKey: Uint8Array;
    try {
      privateKey = decryptPrivateKey(masterKey, session.keys.encrypted_private_key);
    } catch {
      throw new WrongPasswordError();
    } finally {
      masterKey.fill(0);
    }
    const publicKey = publicKeyFromPrivateKey(privateKey);
    if (toB64(publicKey) !== session.keys.public_key) {
      privateKey.fill(0);
      throw new TernixError('protocol_error', 'The saved account key is inconsistent');
    }
    try {
      await (await this.sessionPins(session)).pinSelf(toB64(publicKey));
      if (!alive()) throw new CancelledError();
    } catch (err) {
      privateKey.fill(0);
      throw err;
    }
    // Another unlock finished first.
    if (this.state === 'unlocked') {
      privateKey.fill(0);
      return;
    }
    await this.openVaults(new Keyring(publicKey, privateKey), alive);
  }

  /**
   * Build the engine from the cache, go `unlocked`, start realtime, sync in the background.
   * Takes over `keyring`: wiped if this throws, or if `alive` turns false meanwhile
   * (`CancelledError`).
   */
  private async openVaults(keyring: Keyring, alive: () => boolean): Promise<void> {
    let engine: VaultEngine | null = null;
    try {
      const session = this.session!;
      const pins = await this.pinStoreFor(session.serverUrl, session.user.id);
      if (!alive()) throw new CancelledError();
      this.engine?.close();
      engine = new VaultEngine({
        http: this.http!,
        cache: this.cache,
        account: accountKey(session.serverUrl, session.user.id),
        userId: session.user.id,
        keyring,
        pins,
        now: this.now,
        emit: (event, payload) => this.emitter.emit(event, payload),
      });
      this.engine = engine;
      await engine.loadFromCache().catch((err: unknown) => {
        throw alive() ? err : new CancelledError();
      });
      if (!alive()) throw new CancelledError();
    } catch (err) {
      engine?.close();
      if (engine && this.engine === engine) this.engine = null;
      keyring.wipe();
      throw err;
    }
    this.setState('unlocked');
    this.emitter.emit('vaults-changed', undefined);
    this.startRealtime(engine);
  }

  /** After register or login: fetch the vault list now; a failure is reported, not thrown. */
  private async initialSync(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    try {
      await engine.refreshVaults();
    } catch (err) {
      engine.reportBackground(err);
    }
  }

  private startRealtime(engine: VaultEngine): void {
    this.realtime?.stop();
    this.realtime = null;
    const http = this.http;
    if (this.options.realtime === false || !this.session || !http) return;
    const realtime = new Realtime(
      wsUrlFor(this.session.serverUrl),
      this.options.webSocketFactory ?? wsSocketFactory,
      {
        getToken: () => http.currentToken(),
        onConnection: (state) => this.emitter.emit('connection', state),
        onReady: () => {
          engine.syncAll().catch((err: unknown) => engine.reportBackground(err));
        },
        onVaultChanged: (vaultId) => engine.onVaultChanged(vaultId),
        onVaultsChanged: () => engine.onVaultsChanged(),
        onRevoked: () => this.expire('revoked'),
      },
      this.options.realtime,
    );
    this.realtime = realtime;
    realtime.start();
  }

  /**
   * Forget all key material and stop syncing. The session stays; `unlock` resumes. Keys are
   * gone and the state has changed when this returns; the promise settles once the pending
   * cache writes are stored (it never rejects: failures are emitted as `error` events).
   */
  lock(): Promise<void> {
    this.lifecycle += 1;
    this.realtime?.stop();
    this.realtime = null;
    this.engine?.close();
    this.engine = null;
    if (this.session) this.setState(this.session.token ? 'locked' : 'expired');
    return this.flushQuietly();
  }

  /**
   * Write every pending cache update now. Call it before the app quits; `lock`, `logout` and
   * `close` do it themselves. Rejects if a write failed.
   */
  flush(): Promise<void> {
    return this.cache.flush();
  }

  private async flushQuietly(): Promise<void> {
    try {
      await this.cache.flush();
    } catch (err) {
      this.emitter.emit('error', toErrorDto(err));
    }
  }

  /** The session is gone on the server: drop the token and keys, keep the account. */
  private expire(reason: 'revoked' | 'expired'): void {
    const session = this.session;
    if (!session || session.token === null) return;
    this.session = { ...session, token: null };
    void this.lock();
    this.saveSession().catch(() => undefined);
    this.setState('expired');
    this.emitter.emit('session-revoked', { reason });
  }

  /**
   * Revoke this device's token on the server (best effort), then forget the session and cache.
   * A pending unlock, login or register is cancelled; a new login waits for this to finish.
   */
  async logout(): Promise<LogoutResultDto> {
    const session = this.requireSession();
    this.lifecycle += 1;
    const run = this.doLogout(session);
    this.loggingOut = run;
    try {
      return await run;
    } finally {
      if (this.loggingOut === run) this.loggingOut = null;
    }
  }

  private async doLogout(session: StoredSession): Promise<LogoutResultDto> {
    const http = this.http;
    // Stop realtime first: the server's session.revoked for this logout is not news.
    this.realtime?.stop();
    this.realtime = null;
    let serverRevoked = false;
    if (session.token && http) {
      try {
        await http.request(routes.logout, { expireOn401: false });
        serverRevoked = true;
      } catch {
        serverRevoked = false;
      }
    }
    await this.lock();
    const account = accountKey(session.serverUrl, session.user.id);
    await this.cache.clear(account);
    await this.forgetPins(account);
    if (this.http === http) {
      await this.options.secretStore.delete(SESSION_KEY);
      this.session = null;
      this.http = null;
      this.setState('loggedOut');
    }
    return { serverRevoked };
  }

  /** `GET /me`: refresh the user record. A `401` moves the client to `expired`. */
  async revalidate(): Promise<AccountDto> {
    const { session, http } = this.requireOnline();
    const current = () => {
      if (this.http !== http || !this.session) throw new CancelledError();
      return this.session;
    };
    const { user } = await http.request(routes.me, { schema: meResponseSchema });
    current();
    // The server must keep reporting the account key this device pinned.
    (await this.sessionPins(session)).checkSelf(user.id, user.public_key);
    this.session = { ...current(), user };
    await this.saveSession();
    return this.account!;
  }

  /**
   * Change the master password: the account key is re-encrypted under a new master key
   * with fresh KDF parameters. The server revokes every other device.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const { session, http } = this.requireOnline();
    // Logout or another login during a KDF ends this: nothing is sent for another session.
    const check = () => {
      if (this.http !== http) throw new CancelledError();
    };
    const current = await this.deriveKeys(currentPassword, session.keys.kdf);
    let next: DerivedKeys | null = null;
    let privateKey: Uint8Array | null = null;
    try {
      check();
      try {
        privateKey = decryptPrivateKey(current.masterKey, session.keys.encrypted_private_key);
      } catch {
        throw new WrongPasswordError('The current password is incorrect');
      }
      const newKdf = newKdfParams(this.options.kdfLimits);
      next = await this.deriveKeys(newPassword, newKdf);
      check();
      const newEncrypted = encryptPrivateKey(next.masterKey, privateKey);
      try {
        await http.request(routes.changePassword, {
          body: {
            current_auth_key: toB64(current.authKey),
            new_auth_key: toB64(next.authKey),
            new_kdf: newKdf,
            new_encrypted_private_key: newEncrypted,
          },
          expireOn401: false,
        });
      } catch (err) {
        if (isApiError(err, 'unauthorized')) {
          // Either the current password is wrong or the session is gone; /me tells which.
          await this.revalidate();
          throw new WrongPasswordError('The current password is incorrect');
        }
        throw err;
      }
      // The server has the new password; keep offline unlock in step if the session is ours.
      if (this.http === http && this.session) {
        this.session = {
          ...this.session,
          keys: { ...this.session.keys, encrypted_private_key: newEncrypted, kdf: newKdf },
        };
        await this.saveSession();
      }
    } finally {
      current.masterKey.fill(0);
      current.authKey.fill(0);
      privateKey?.fill(0);
      next?.masterKey.fill(0);
      next?.authKey.fill(0);
    }
  }

  // Devices, users, admin

  async listDevices(): Promise<DeviceDto[]> {
    const { http } = this.requireOnline();
    const { devices } = await http.request(routes.listDevices, {
      schema: listDevicesResponseSchema,
    });
    return devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      current: d.current,
    }));
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const { http } = this.requireOnline();
    await http.request(routes.revokeDevice, { params: { id: deviceId } });
  }

  /** Find a user by email to share with; returns the fingerprint to verify out of band. */
  lookupUser(email: string): Promise<LookupUserDto> {
    return this.requireEngine().lookupUser(email);
  }

  async createInvite(input: CreateInviteInput = {}): Promise<CreatedInviteDto> {
    const { http } = this.requireOnline();
    const res = await http.request(routes.createInvite, {
      body: {
        ...(input.email ? { email: normalizeEmail(input.email) } : {}),
        ...(input.expiresInHours ? { expires_in_hours: input.expiresInHours } : {}),
      },
      schema: createInviteResponseSchema,
    });
    return { code: res.code, expiresAt: res.expires_at };
  }

  async listInvites(): Promise<InviteDto[]> {
    const { http } = this.requireOnline();
    const { invites } = await http.request(routes.listInvites, {
      schema: listInvitesResponseSchema,
    });
    return invites.map((i) => ({
      code: i.code,
      email: i.email,
      expiresAt: i.expires_at,
      createdAt: i.created_at,
      usedAt: i.used_at,
    }));
  }

  async deleteInvite(code: string): Promise<void> {
    const { http } = this.requireOnline();
    await http.request(routes.deleteInvite, { params: { code } });
  }

  async listUsers(): Promise<UserDto[]> {
    const { session, http } = this.requireOnline();
    const { users } = await http.request(routes.listUsers, { schema: listUsersResponseSchema });
    const pins = await this.sessionPins(session);
    for (const u of users) pins.checkSelf(u.id, u.public_key);
    return users.map(toUserDto);
  }

  async deleteUser(userId: string): Promise<void> {
    const { http } = this.requireOnline();
    await http.request(routes.deleteUser, { params: { id: userId } });
  }

  // Vaults

  /** Vaults from memory (works offline after unlock). */
  listVaults(): VaultDto[] {
    return this.requireEngine().listVaults();
  }

  getVault(vaultId: string): VaultDto {
    return this.requireEngine().getVault(vaultId);
  }

  /** Full catch-up with the server: vault list, then every vault's items. */
  sync(): Promise<void> {
    return this.requireEngine().syncAll();
  }

  refreshVaults(): Promise<void> {
    return this.requireEngine().refreshVaults();
  }

  pullVault(vaultId: string): Promise<void> {
    return this.requireEngine().pullVault(vaultId);
  }

  createVault(name: string): Promise<VaultDto> {
    return this.requireEngine().createVault(name);
  }

  renameVault(vaultId: string, name: string): Promise<VaultDto> {
    return this.requireEngine().renameVault(vaultId, name);
  }

  deleteVault(vaultId: string): Promise<void> {
    return this.requireEngine().deleteVault(vaultId);
  }

  listMembers(vaultId: string): Promise<MemberDto[]> {
    return this.requireEngine().listMembers(vaultId);
  }

  /** Second step of sharing; see `VaultEngine.addMember`. */
  addMember(
    vaultId: string,
    userId: string,
    role: VaultRole,
    expectedPublicKey: string,
  ): Promise<MemberDto> {
    return this.requireEngine().addMember(vaultId, userId, role, expectedPublicKey);
  }

  /**
   * After comparing the new fingerprint with the user out of band: trust `publicKey` as the
   * user's key (replacing the pin that made rotation and sharing refuse).
   */
  acceptMemberKey(userId: string, publicKey: string): Promise<void> {
    return this.requireEngine().acceptMemberKey(userId, publicKey);
  }

  /**
   * After comparing the fingerprint of `publicKey` with the user out of band. Refuses with
   * `member_key_changed` if the pinned key is no longer `publicKey`.
   */
  markMemberVerified(userId: string, publicKey: string): Promise<void> {
    return this.requireEngine().markMemberVerified(userId, publicKey);
  }

  changeMemberRole(vaultId: string, userId: string, role: VaultRole): Promise<MemberDto> {
    return this.requireEngine().changeMemberRole(vaultId, userId, role);
  }

  removeMember(vaultId: string, userId: string): Promise<RemoveMemberResultDto> {
    return this.requireEngine().removeMember(vaultId, userId);
  }

  leaveVault(vaultId: string): Promise<void> {
    return this.requireEngine().leaveVault(vaultId);
  }

  rotateVault(vaultId: string): Promise<VaultDto> {
    return this.requireEngine().rotateVault(vaultId);
  }

  // Items

  /** Decrypted items of a vault from memory (works offline after unlock). */
  listItems(vaultId: string): VaultItemsDto {
    return this.requireEngine().listItems(vaultId);
  }

  getItem(vaultId: string, itemId: string): ItemDto | null {
    return this.requireEngine().getItem(vaultId, itemId);
  }

  /** Create (`itemId` undefined) or update an item. Needs the server. */
  putItem(vaultId: string, itemId: string | undefined, draft: ItemDraft): Promise<WriteResultDto>;
  /** A background update of an item; see `PutItemOptions`. */
  putItem(
    vaultId: string,
    itemId: string,
    draft: ItemDraft,
    options: PutItemOptions,
  ): Promise<WriteResultDto | SkippedWriteDto>;
  putItem(
    vaultId: string,
    itemId: string | undefined,
    draft: ItemDraft,
    options?: PutItemOptions,
  ): Promise<WriteResultDto | SkippedWriteDto> {
    const engine = this.requireEngine();
    return options && itemId !== undefined
      ? engine.putItem(vaultId, itemId, draft, options)
      : engine.putItem(vaultId, itemId, draft);
  }

  deleteItem(vaultId: string, itemId: string): Promise<WriteResultDto> {
    return this.requireEngine().deleteItem(vaultId, itemId);
  }

  /** Puts and deletes through the batch endpoint, chunked to the protocol limits. */
  applyBatch(vaultId: string, ops: BatchOpInput[]): Promise<BatchResultDto> {
    return this.requireEngine().applyBatch(vaultId, ops);
  }

  /** Import: create or update many items at once. */
  putMany(vaultId: string, items: { id?: string; payload: ItemDraft }[]): Promise<BatchResultDto> {
    return this.applyBatch(
      vaultId,
      items.map((i) => ({ op: 'put' as const, id: i.id, payload: i.payload })),
    );
  }

  /**
   * Stop realtime and drop keys; the client object can be thrown away afterwards. The promise
   * settles once pending cache writes are stored.
   */
  async close(): Promise<void> {
    // lock() bumps the lifecycle, cancelling a pending unlock, login or register.
    const flushed = this.lock();
    this.emitter.removeAllListeners();
    await flushed;
  }
}
