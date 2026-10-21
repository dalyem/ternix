import type { Duplex } from 'node:stream';
import ssh2 from 'ssh2';
import type {
  AnyAuthMethod,
  AuthenticationType,
  Client as Ssh2Client,
  ClientChannel,
  ConnectConfig,
  KeyboardInteractiveCallback,
  ParsedKey,
  Prompt,
  ShellOptions as Ssh2ShellOptions,
} from 'ssh2';
import type { HostOs, KnownHostPayload } from '@ternix/core/items';
import { errorMessage, SshError } from './errors.js';
import { ForwardManager } from './forwards.js';
import type { ForwardListener, ForwardStatus } from './forwards.js';
import {
  checkHostKey,
  fingerprintSha256,
  parseKeyType,
  preferredHostKeyAlgorithms,
} from './knownHosts.js';
import type { HostKeyStatus } from './knownHosts.js';
import {
  OS_PROBE_COMMAND,
  OS_PROBE_MAX_BYTES,
  OS_PROBE_TIMEOUT_MS,
  osFromIdent,
  osFromProbe,
} from './os.js';
import type { HopSettings, PortForwardSpec, ResolvedConnection, ResolvedKey } from './resolve.js';

const { Client, utils } = ssh2;

export type SessionState =
  'idle' | 'connecting' | 'verifying-host-key' | 'authenticating' | 'ready' | 'closed';

/** One link of the connection: each jump host in order, then the target. */
export interface HopInfo {
  /** 0-based position in the chain. */
  index: number;
  total: number;
  label: string;
  host: string;
  port: number;
  isTarget: boolean;
}

export type CloseReason =
  | { kind: 'requested' }
  /** The other side or the network ended an established session. */
  | { kind: 'remote' }
  | { kind: 'error'; error: SshError };

export type SessionStatus =
  | { state: 'idle' }
  | { state: 'connecting' | 'verifying-host-key' | 'authenticating'; hop: HopInfo }
  | { state: 'ready' }
  | { state: 'closed'; reason: CloseReason };

export interface StoredHostKey {
  keyType: string;
  key: string;
  fingerprint: string;
}

export interface HostKeyInfo {
  hop: HopInfo;
  host: string;
  port: number;
  keyType: string;
  /** Wire-format key, standard base64: what `knownHostPayload` stores. */
  key: string;
  /** `SHA256:...`, as OpenSSH prints it. */
  fingerprint: string;
  status: HostKeyStatus;
  /** For a `mismatch`: the key that was trusted before. */
  stored?: StoredHostKey;
}

export interface KeyboardInteractiveRequest {
  hop: HopInfo;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

export interface SessionHooks {
  /**
   * Called for every hop, including jump hosts, after the server presents its key. Resolve true
   * to continue. Called with `status: 'mismatch'` too, so the UI can warn loudly; resolving false,
   * throwing, or having no hook denies anything that is not `trusted`.
   */
  verifyHostKey?(info: HostKeyInfo): Promise<boolean>;
  /** Password, 2FA and other keyboard-interactive prompts. Answers are in prompt order. */
  keyboardInteractive?(request: KeyboardInteractiveRequest): Promise<string[]>;
  onBanner?(message: string, hop: HopInfo): void;
  /** Non-fatal problems, such as agent forwarding requested without an agent. */
  onWarning?(message: string): void;
}

export interface SessionOptions {
  knownHosts?: readonly KnownHostPayload[];
  /** Agent socket/pipe path (or `pageant`) for agent forwarding; see `defaultAgentPath`. */
  agentPath?: string;
  /** TCP connect and key exchange, per hop. Default 15 s. */
  connectTimeoutMs?: number;
  /** Whole hop until authenticated, per hop; paused while waiting for the user. Default 60 s. */
  readyTimeoutMs?: number;
  /** Unanswered keepalives tolerated before the connection is dropped. Default 3. */
  keepaliveCountMax?: number;
}

export interface ShellOptions {
  cols: number;
  rows: number;
  /** Default `xterm-256color`. */
  term?: string;
  /** Send the host's startup snippet after the shell opens. Default true. */
  runStartup?: boolean;
}

export interface ShellExit {
  code: number | undefined;
  signal: string | undefined;
}

export type Unsubscribe = () => void;

export interface DetectOsOptions {
  /** How long the probe command may take. Default 5 s. */
  timeoutMs?: number;
}

export interface ShellStream {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Output of the remote shell. Data that arrives before the first subscriber is buffered. */
  onData(listener: (data: Uint8Array) => void): Unsubscribe;
  /** Fires once, when the remote shell has ended. Subscribing afterwards fires immediately. */
  onExit(listener: (exit: ShellExit) => void): Unsubscribe;
  close(): void;
}

/** Where to find the user's SSH agent, for the platform: pass `process.platform` and `process.env`. */
export function defaultAgentPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | undefined {
  const fromEnv = env['SSH_AUTH_SOCK']?.trim();
  if (fromEnv) return fromEnv;
  // Windows OpenSSH agent. Callers who use Pageant pass the literal string 'pageant' instead.
  return platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;
const CLIENT_CLOSE_GRACE_MS = 1_500;
const PASSWORD_PROMPT = /password/i;
const SECOND_FACTOR_PROMPT = /one.?time|otp|token|verification|code|duo|2fa/i;

/** A timer that can be suspended while the user is answering a prompt. */
class PausableTimer {
  private handle: NodeJS.Timeout | undefined;
  private armed = false;

  constructor(
    private readonly ms: number,
    private readonly onFire: () => void,
  ) {}

  start(): void {
    this.clear();
    this.armed = true;
    this.arm();
  }

  pause(): void {
    this.disarm();
  }

  resume(): void {
    if (this.armed) this.arm();
  }

  clear(): void {
    this.armed = false;
    this.disarm();
  }

  private arm(): void {
    this.disarm();
    if (this.ms > 0) this.handle = setTimeout(this.onFire, this.ms);
  }

  private disarm(): void {
    if (this.handle) clearTimeout(this.handle);
    this.handle = undefined;
  }
}

interface PreparedHop {
  settings: HopSettings;
  info: HopInfo;
  parsedKey?: ParsedKey;
}

function parsePrivateKey(key: ResolvedKey, info: HopInfo): ParsedKey {
  const parsed = utils.parseKey(key.privateKey, key.passphrase);
  const where = `SSH key "${key.label}" for ${info.label}`;
  if (parsed instanceof Error) {
    const text = parsed.message.toLowerCase();
    if (text.includes('no passphrase given')) {
      throw new SshError('passphrase_required', `${where} is encrypted and needs a passphrase`, {
        hop: info.index,
        cause: parsed,
      });
    }
    if (text.includes('passphrase')) {
      throw new SshError('bad_passphrase', `Wrong passphrase for ${where}`, {
        hop: info.index,
        cause: parsed,
      });
    }
    throw new SshError('invalid_key', `${where} cannot be read: ${parsed.message}`, {
      hop: info.index,
      cause: parsed,
    });
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || !first.isPrivateKey()) {
    throw new SshError('invalid_key', `${where} is not a private key`, { hop: info.index });
  }
  return first;
}

function classifyError(err: Error & { level?: string }, hop: HopInfo): SshError {
  if (err instanceof SshError) return err;
  const at = `${hop.host}:${hop.port}`;
  switch (err.level) {
    case 'client-authentication':
      return new SshError('auth_failed', `Authentication failed for ${at}`, {
        hop: hop.index,
        cause: err,
      });
    case 'client-timeout':
      return new SshError('timeout', `Connection to ${at} timed out`, {
        hop: hop.index,
        cause: err,
      });
    case 'handshake':
      return new SshError('handshake_failed', `SSH handshake with ${at} failed: ${err.message}`, {
        hop: hop.index,
        cause: err,
      });
    default:
      return new SshError('connect_failed', `Cannot connect to ${at}: ${err.message}`, {
        hop: hop.index,
        cause: err,
      });
  }
}

function toBuffer(data: string | Uint8Array): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

/**
 * The server's identification line. ssh2 has no public accessor for it: the whole line is kept on
 * its protocol object, the software version alone on the client.
 */
function remoteIdent(client: Ssh2Client): string | undefined {
  const internals = client as unknown as {
    _protocol?: { _remoteIdentRaw?: unknown };
    _remoteVer?: unknown;
  };
  const raw = internals._protocol?._remoteIdentRaw;
  if (Buffer.isBuffer(raw)) return raw.toString('latin1').trim();
  return typeof internals._remoteVer === 'string' ? `SSH-2.0-${internals._remoteVer}` : undefined;
}

/**
 * Run `OS_PROBE_COMMAND` on its own channel: no PTY, stdin closed at once, stderr discarded.
 * Resolves with at most `OS_PROBE_MAX_BYTES` of output (the channel is closed once that much
 * arrived); rejects when the server refuses the channel or the command, or on timeout.
 */
function runOsProbe(client: Ssh2Client, timeoutMs: number): Promise<string> {
  const closeChannel = (channel: ClientChannel) => {
    try {
      channel.close();
    } catch {
      channel.destroy();
    }
  };
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let channel: ClientChannel | undefined;
    let done = false;
    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (channel) closeChannel(channel);
      if (err !== undefined) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => finish(new Error('The OS probe timed out')), timeoutMs);
    try {
      client.exec(OS_PROBE_COMMAND, (err, stream) => {
        if (err) return finish(err);
        stream.on('error', () => undefined);
        // Accepted after the timeout: nobody reads it, so it would stay open on the server.
        if (done) return closeChannel(stream);
        channel = stream;
        stream.stderr.on('data', () => undefined);
        stream.on('data', (chunk: Buffer) => {
          if (done) return;
          const room = OS_PROBE_MAX_BYTES - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          if (size >= OS_PROBE_MAX_BYTES) finish();
        });
        stream.once('close', () => finish());
        stream.end();
      });
    } catch (err) {
      finish(err);
    }
  });
}

/** Output held for a shell nobody is listening to yet; older bytes are dropped past this. */
const MAX_BUFFERED_OUTPUT_BYTES = 4 * 1024 * 1024;

class Shell implements ShellStream {
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(exit: ShellExit) => void>();
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private exit: ShellExit | undefined;
  private lastExit: ShellExit = { code: undefined, signal: undefined };

  constructor(private readonly channel: ClientChannel) {
    // Always read the channel: a stream nobody reads never ends, so 'close' would never come.
    channel.on('data', (chunk: Buffer) => {
      if (this.dataListeners.size > 0) {
        for (const listener of [...this.dataListeners]) listener(chunk);
        return;
      }
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
      while (this.pendingBytes > MAX_BUFFERED_OUTPUT_BYTES && this.pending.length > 1) {
        this.pendingBytes -= this.pending.shift()?.length ?? 0;
      }
    });
    channel.on('exit', (code: number | null, signal?: string | null) => {
      this.lastExit = { code: code ?? undefined, signal: signal ?? undefined };
    });
    channel.on('error', () => {
      // Surfaces as a close; the exit listeners are the API for that.
    });
    channel.once('close', () => {
      this.exit = this.lastExit;
      for (const listener of [...this.exitListeners]) listener(this.exit);
      this.exitListeners.clear();
      this.dataListeners.clear();
    });
  }

  get closed(): boolean {
    return this.exit !== undefined;
  }

  write(data: string | Uint8Array): void {
    if (this.exit || !this.channel.writable) return;
    this.channel.write(toBuffer(data));
  }

  resize(cols: number, rows: number): void {
    if (this.exit) return;
    this.channel.setWindow(rows, cols, 0, 0);
  }

  onData(listener: (data: Uint8Array) => void): Unsubscribe {
    this.dataListeners.add(listener);
    const backlog = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const chunk of backlog) listener(chunk);
    return () => void this.dataListeners.delete(listener);
  }

  onExit(listener: (exit: ShellExit) => void): Unsubscribe {
    if (this.exit) {
      listener(this.exit);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => void this.exitListeners.delete(listener);
  }

  close(): void {
    if (this.exit) return;
    try {
      this.channel.close();
    } catch {
      this.channel.destroy();
    }
  }

  destroy(): void {
    this.channel.destroy();
  }
}

/**
 * One SSH connection to a host, optionally through a chain of jump hosts, with shells and port
 * forwards on top. A session connects once; open a new `SshSession` to reconnect.
 */
export class SshSession {
  private state: SessionState = 'idle';
  private current: SessionStatus = { state: 'idle' };
  private readonly statusListeners = new Set<(status: SessionStatus) => void>();
  private readonly forwardListeners = new Set<ForwardListener>();
  private readonly clients: Ssh2Client[] = [];
  private readonly closedClients = new WeakSet<Ssh2Client>();
  private readonly shells = new Set<Shell>();
  private target: Ssh2Client | undefined;
  private forwards: ForwardManager | undefined;
  private startupScript: string | undefined;
  private runtimeError: SshError | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private targetIdent: string | undefined;
  /** Whether the shell asks for agent forwarding (the host has it on and an agent exists). */
  private forwardAgent = false;

  constructor(private readonly options: SessionOptions = {}) {}

  get status(): SessionStatus {
    return this.current;
  }

  onStatus(listener: (status: SessionStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => void this.statusListeners.delete(listener);
  }

  onForwardStatus(listener: ForwardListener): Unsubscribe {
    this.forwardListeners.add(listener);
    return () => void this.forwardListeners.delete(listener);
  }

  /**
   * Dial the jump hosts in order, then the target, and authenticate on each. Rejects with an
   * `SshError`; the session is closed afterwards.
   */
  async connect(settings: ResolvedConnection, hooks: SessionHooks = {}): Promise<void> {
    if (this.state !== 'idle') {
      throw new SshError('invalid_state', 'This session has already been used; create a new one');
    }
    this.state = 'connecting';
    try {
      const hops = [...settings.jumpChain, settings];
      const prepared = hops.map((hop, index): PreparedHop => {
        const info: HopInfo = {
          index,
          total: hops.length,
          label: hop.label,
          host: hop.address,
          port: hop.port,
          isTarget: index === hops.length - 1,
        };
        const entry: PreparedHop = { settings: hop, info };
        if (hop.key) entry.parsedKey = parsePrivateKey(hop.key, info);
        return entry;
      });

      let previous: Ssh2Client | undefined;
      for (const hop of prepared) {
        if (this.shutdownPromise) throw new SshError('closed', 'Session closed while connecting');
        previous = await this.connectHop(hop, previous, settings, hooks);
      }
      if (this.shutdownPromise || !previous) {
        throw new SshError('closed', 'Session closed while connecting');
      }
      this.target = previous;
      this.startupScript = settings.startupScript;
      this.forwards = new ForwardManager(previous, (status) => {
        for (const listener of [...this.forwardListeners]) listener(status);
      });
      this.state = 'ready';
      this.publish({ state: 'ready' });
    } catch (err) {
      const closedByCaller = this.shutdownPromise !== undefined;
      const error = closedByCaller
        ? new SshError('closed', 'The session was closed while connecting')
        : err instanceof SshError
          ? err
          : new SshError('connect_failed', errorMessage(err), { cause: err });
      await this.shutdown({ kind: 'error', error });
      throw error;
    }
  }

  async openShell(options: ShellOptions): Promise<ShellStream> {
    const client = this.requireReady();
    // ssh2 reads `agentForward` from a channel's options; its type definitions omit it.
    const channelOptions: Ssh2ShellOptions & { agentForward: boolean } = {
      agentForward: this.forwardAgent,
    };
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      try {
        client.shell(
          { term: options.term ?? 'xterm-256color', cols: options.cols, rows: options.rows },
          channelOptions,
          (err, stream) => (err ? reject(err) : resolve(stream)),
        );
      } catch (err) {
        reject(err);
      }
    }).catch((err: unknown) => {
      throw new SshError('channel_failed', `Cannot open a shell: ${errorMessage(err)}`, {
        cause: err,
      });
    });
    const shell = new Shell(channel);
    this.shells.add(shell);
    channel.once('close', () => this.shells.delete(shell));
    if (this.startupScript && options.runStartup !== false) {
      const script = this.startupScript.replace(/\r\n/g, '\n');
      shell.write(script.endsWith('\n') ? script : `${script}\n`);
    }
    return shell;
  }

  async startForward(spec: PortForwardSpec): Promise<ForwardStatus> {
    this.requireReady();
    return this.forwards!.start(spec);
  }

  stopForward(id: string): Promise<void> {
    return this.forwards?.stop(id) ?? Promise.resolve();
  }

  forwardStatuses(): ForwardStatus[] {
    return this.forwards?.statuses() ?? [];
  }

  /** The target's identification line (`SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5`), once connected. */
  get serverIdent(): string | undefined {
    return this.targetIdent;
  }

  /**
   * Best guess at the target's operating system, or undefined. Reads the identification line,
   * then (unless that says Windows) runs `OS_PROBE_COMMAND`, a fixed read-only command, on one
   * exec channel. When the probe is refused, times out or says nothing, the identification line
   * decides. Never rejects.
   */
  async detectOs(options: DetectOsOptions = {}): Promise<HostOs | undefined> {
    const fromIdent = osFromIdent(this.targetIdent);
    if (fromIdent === 'windows') return fromIdent;
    let client: Ssh2Client;
    try {
      client = this.requireReady();
    } catch {
      return fromIdent;
    }
    let fromProbe: HostOs | undefined;
    try {
      fromProbe = osFromProbe(await runOsProbe(client, options.timeoutMs ?? OS_PROBE_TIMEOUT_MS));
    } catch {
      return fromIdent;
    }
    // A distribution named in the identification line beats a bare "Linux".
    if (fromProbe === 'linux' && fromIdent) return fromIdent;
    return fromProbe ?? fromIdent;
  }

  /** Stop forwards and shells, end every connection in the chain. Safe to call repeatedly. */
  close(): Promise<void> {
    return this.shutdown({ kind: 'requested' });
  }

  private requireReady(): Ssh2Client {
    if (this.state !== 'ready' || !this.target || this.shutdownPromise) {
      throw new SshError('invalid_state', 'The session is not connected');
    }
    return this.target;
  }

  private publish(status: SessionStatus): void {
    this.current = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  private shutdown(reason: CloseReason): Promise<void> {
    this.shutdownPromise ??= this.runShutdown(reason);
    return this.shutdownPromise;
  }

  private async runShutdown(reason: CloseReason): Promise<void> {
    for (const shell of this.shells) shell.destroy();
    this.shells.clear();
    await this.forwards?.stopAll();
    await Promise.all([...this.clients].reverse().map((client) => this.endClient(client)));
    this.state = 'closed';
    this.publish({ state: 'closed', reason });
  }

  private endClient(client: Ssh2Client): Promise<void> {
    if (this.closedClients.has(client)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          client.destroy();
        } catch {
          // Already gone.
        }
        resolve();
      }, CLIENT_CLOSE_GRACE_MS);
      client.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        client.end();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private connectHop(
    hop: PreparedHop,
    via: Ssh2Client | undefined,
    settings: ResolvedConnection,
    hooks: SessionHooks,
  ): Promise<Ssh2Client> {
    const { info } = hop;
    const { settings: creds } = hop;
    return new Promise<Ssh2Client>((resolve, reject) => {
      const client = new Client();
      this.clients.push(client);
      let settled = false;

      const connectTimer = new PausableTimer(
        this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        () =>
          fail(
            new SshError('timeout', `Timed out connecting to ${info.host}:${info.port}`, {
              hop: info.index,
            }),
          ),
      );
      const readyTimer = new PausableTimer(
        this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        () =>
          fail(
            new SshError('timeout', `Timed out signing in to ${info.host}:${info.port}`, {
              hop: info.index,
            }),
          ),
      );
      const clearTimers = () => {
        connectTimer.clear();
        readyTimer.clear();
      };
      /** Run a user-facing wait with the hop's timers suspended. */
      const whileUserWaits = async <T>(wait: Promise<T>): Promise<T> => {
        connectTimer.pause();
        readyTimer.pause();
        try {
          return await wait;
        } finally {
          connectTimer.resume();
          readyTimer.resume();
        }
      };
      const fail = (error: SshError) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(error);
        try {
          client.destroy();
        } catch {
          // Not connected yet.
        }
      };

      client.on('error', (err: Error & { level?: string }) => {
        if (!settled) fail(classifyError(err, info));
        else this.runtimeError ??= classifyError(err, info);
      });
      client.on('close', () => {
        this.closedClients.add(client);
        if (!settled) {
          fail(
            new SshError('connect_failed', `Connection to ${info.host}:${info.port} closed`, {
              hop: info.index,
            }),
          );
        } else if (!this.shutdownPromise) {
          void this.shutdown(
            this.runtimeError ? { kind: 'error', error: this.runtimeError } : { kind: 'remote' },
          );
        }
      });
      client.on('banner', (message: string) => hooks.onBanner?.(message, info));
      client.on('handshake', () => {
        // Also fires for every rekey of an established connection, which is not a state change.
        if (settled) return;
        connectTimer.clear();
        this.publish({ state: 'authenticating', hop: info });
      });
      client.on('ready', () => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (info.isTarget) this.targetIdent = remoteIdent(client);
        resolve(client);
      });

      const knownHosts = this.options.knownHosts ?? [];
      /** The key the user (or the known hosts) accepted at connect; later rekeys must match it. */
      let acceptedKey: string | undefined;
      /** Stop a connection that is already up because its host key is not acceptable. */
      const abortEstablished = (error: SshError) => {
        this.runtimeError = error;
      };
      // ssh2 calls this on the first key exchange and again on every rekey, and each call must be
      // answered or the exchange never finishes.
      const hostVerifier = (key: Buffer | string, verify: (accept: boolean) => void) => {
        const keyBuf = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
        const keyType = parseKeyType(keyBuf);
        if (!keyType) {
          const unreadable = new SshError(
            'handshake_failed',
            `${info.host} sent an unreadable host key`,
            { hop: info.index },
          );
          if (settled) abortEstablished(unreadable);
          else fail(unreadable);
          return verify(false);
        }
        const keyB64 = keyBuf.toString('base64');
        if (acceptedKey !== undefined) {
          if (keyB64 === acceptedKey) return verify(true);
          abortEstablished(
            new SshError(
              'host_key_rejected',
              `The host key of ${info.host}:${info.port} has CHANGED during the session`,
              { hop: info.index },
            ),
          );
          return verify(false);
        }
        const check = checkHostKey(knownHosts, creds.address, creds.port, keyType, keyB64);
        const hostKey: HostKeyInfo = {
          hop: info,
          host: creds.address,
          port: creds.port,
          keyType,
          key: keyB64,
          fingerprint: fingerprintSha256(keyBuf),
          status: check.status,
        };
        if (check.status === 'mismatch') {
          hostKey.stored = {
            keyType: check.stored.key_type,
            key: check.stored.public_key,
            fingerprint: fingerprintSha256(check.stored.public_key),
          };
        }
        this.publish({ state: 'verifying-host-key', hop: info });
        const decision = hooks.verifyHostKey
          ? whileUserWaits(hooks.verifyHostKey(hostKey)).catch(() => false)
          : Promise.resolve(check.status === 'trusted');
        void decision.then((accepted) => {
          if (settled) return;
          if (accepted) {
            acceptedKey = keyB64;
            return verify(true);
          }
          const detail =
            check.status === 'mismatch'
              ? `The host key of ${info.host}:${info.port} has CHANGED`
              : `Host key of ${info.host}:${info.port} was not trusted`;
          fail(new SshError('host_key_rejected', detail, { hop: info.index }));
          verify(false);
        });
      };

      const queue: ('publickey' | 'password' | 'keyboard-interactive')[] = [];
      if (hop.parsedKey) queue.push('publickey');
      if (creds.password !== undefined) queue.push('password');
      queue.push('keyboard-interactive');
      let passwordSent = false;
      let passwordAnswered = false;

      const answerPrompts = (
        name: string,
        instructions: string,
        _lang: string,
        prompts: Prompt[],
        finish: KeyboardInteractiveCallback,
      ) => {
        const only = prompts.length === 1 ? prompts[0] : undefined;
        // Servers that sign users in through PAM ask for the password this way. Answer with the
        // stored one, once, unless the password method already tried it.
        if (
          creds.password !== undefined &&
          !passwordSent &&
          !passwordAnswered &&
          only &&
          only.echo !== true &&
          PASSWORD_PROMPT.test(only.prompt) &&
          !SECOND_FACTOR_PROMPT.test(only.prompt)
        ) {
          passwordAnswered = true;
          return finish([creds.password]);
        }
        const ask = hooks.keyboardInteractive;
        if (prompts.length === 0 || !ask) return finish([]);
        const request: KeyboardInteractiveRequest = {
          hop: info,
          name,
          instructions,
          prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo === true })),
        };
        whileUserWaits(ask(request)).then(finish, () => finish([]));
      };

      // Key, then password, then keyboard-interactive, skipping what the server does not offer.
      const authHandler = (left: AuthenticationType[] | null): AnyAuthMethod | false => {
        // Ask what the server offers first, as OpenSSH does.
        if (left === null) return { type: 'none', username: creds.username };
        for (let type = queue.shift(); type; type = queue.shift()) {
          if (left && !left.includes(type)) continue;
          this.publish({ state: 'authenticating', hop: info });
          const username = creds.username;
          if (type === 'publickey' && hop.parsedKey) {
            return { type, username, key: hop.parsedKey };
          }
          if (type === 'password' && creds.password !== undefined) {
            passwordSent = true;
            return { type, username, password: creds.password };
          }
          if (type === 'keyboard-interactive') return { type, username, prompt: answerPrompts };
        }
        return false;
      };

      const config: ConnectConfig = {
        username: creds.username,
        authHandler,
        hostVerifier,
        readyTimeout: 0,
        keepaliveCountMax: this.options.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX,
      };
      if (settings.keepaliveInterval) config.keepaliveInterval = settings.keepaliveInterval * 1000;
      const algorithms = preferredHostKeyAlgorithms(knownHosts, creds.address, creds.port);
      if (algorithms) config.algorithms = { serverHostKey: algorithms };
      if (info.isTarget && settings.agentForwarding) {
        if (this.options.agentPath) {
          // The agent serves the server's requests; forwarding is asked for on the shell's
          // channel only (`openShell`). ssh2's connection-wide `agentForward` would ask on every
          // session channel, the OS probe's included.
          config.agent = this.options.agentPath;
          this.forwardAgent = true;
        } else {
          hooks.onWarning?.(
            'Agent forwarding is on, but no SSH agent was found; continuing without it',
          );
        }
      }

      this.publish({ state: 'connecting', hop: info });
      connectTimer.start();
      readyTimer.start();

      const start = (sock?: Duplex) => {
        try {
          if (sock) config.sock = sock;
          else {
            config.host = creds.address;
            config.port = creds.port;
          }
          client.connect(config);
        } catch (err) {
          fail(new SshError('connect_failed', errorMessage(err), { hop: info.index, cause: err }));
        }
      };

      if (via) {
        via.forwardOut('127.0.0.1', 0, creds.address, creds.port, (err, stream) => {
          if (err) {
            fail(
              new SshError(
                'connect_failed',
                `Jump host cannot reach ${creds.address}:${creds.port}: ${err.message}`,
                { hop: info.index, cause: err },
              ),
            );
          } else if (settled) {
            stream.destroy();
          } else {
            start(stream);
          }
        });
      } else {
        start();
      }
    });
  }
}
