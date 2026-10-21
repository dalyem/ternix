import { connect as netConnect, createServer } from 'node:net';
import type { AddressInfo, Server as NetServer, Socket } from 'node:net';
import ssh2 from 'ssh2';
import type { AuthenticationType, Connection, ServerChannel } from 'ssh2';
import { itemPayloadSchema } from '@ternix/core/items';
import type { ItemPayload, ItemPayloadInput } from '@ternix/core/items';
import type { ResolvedConnection } from '../src/index.js';

const { Server, utils } = ssh2;

const NOW = '2026-01-01T00:00:00.000Z';

/** A valid lowercase UUIDv4 that is stable per number. */
export const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Fields<T extends ItemPayloadInput['type']> = Omit<
  Extract<ItemPayloadInput, { type: T }>,
  'type' | 'updated_at' | 'schema'
>;

export const host = (f: Partial<Fields<'host'>> = {}): ItemPayloadInput => ({
  type: 'host',
  updated_at: NOW,
  label: 'host',
  address: 'host.example',
  ...f,
});
export const group = (f: Partial<Fields<'group'>> = {}): ItemPayloadInput => ({
  type: 'group',
  updated_at: NOW,
  label: 'group',
  ...f,
});
export const identity = (f: Partial<Fields<'identity'>> = {}): ItemPayloadInput => ({
  type: 'identity',
  updated_at: NOW,
  label: 'identity',
  username: 'id-user',
  ...f,
});
export const sshKey = (f: Partial<Fields<'ssh_key'>> = {}): ItemPayloadInput => ({
  type: 'ssh_key',
  updated_at: NOW,
  label: 'key',
  private_key: 'PRIVATE',
  ...f,
});
export const snippet = (f: Partial<Fields<'snippet'>> = {}): ItemPayloadInput => ({
  type: 'snippet',
  updated_at: NOW,
  label: 'snippet',
  script: 'true',
  ...f,
});
export const portForward = (f: Fields<'port_forward'>): ItemPayloadInput => ({
  type: 'port_forward',
  updated_at: NOW,
  ...f,
});
export const knownHost = (f: Fields<'known_host'>): ItemPayloadInput => ({
  type: 'known_host',
  updated_at: NOW,
  ...f,
});

/** Parse payloads the way a client does and index them by ID. */
export function itemMap(entries: [string, ItemPayloadInput][]): Map<string, ItemPayload> {
  return new Map(entries.map(([id, payload]) => [id, itemPayloadSchema.parse(payload)]));
}

export interface KeyPair {
  private: string;
  public: string;
}

export function generateKey(passphrase?: string): KeyPair {
  // ssh2 now and then emits an ed25519 key that its own parser rejects; draw again.
  for (;;) {
    const pair = passphrase
      ? utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 4 })
      : utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private, passphrase) instanceof Error)) return pair;
  }
}

/** Wire-format public key of an OpenSSH public key line. */
export function wirePublicKey(publicKey: string): Buffer {
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key) throw new Error('no key');
  return key.getPublicSSH();
}

export interface TestUser {
  password?: string;
  /** OpenSSH public key line that may sign in. */
  publicKey?: string;
  /** Keyboard-interactive: prompts to ask and the answers that sign in. */
  interactive?: { prompts: { prompt: string; echo: boolean }[]; answers: string[] };
}

/** How the test server answers an `exec` request. */
export type ExecReply =
  | 'refuse'
  /** Accept and never answer, to exercise timeouts. */
  | 'hang'
  | { stdout?: string | Buffer; stderr?: string; code?: number };

export interface TestServerOptions {
  users: Record<string, TestUser>;
  hostKey?: KeyPair;
  banner?: string;
  /** Software and comments of the identification line, after `SSH-2.0-`. */
  ident?: string;
  /** Answer `exec` requests; without it they are refused. */
  exec?: (command: string) => ExecReply;
  /** Never answer authentication requests, to exercise the sign-in timeout. */
  stallAuth?: boolean;
  /**
   * Where a direct-tcpip request really goes. The default dials the requested address;
   * return undefined to refuse. Lets a test pretend a host is only reachable through this server.
   */
  route?: (host: string, port: number) => { host: string; port: number } | undefined;
}

/** An in-process SSH server on 127.0.0.1 that records what clients do. */
export class TestSshServer {
  readonly port: number;
  readonly hostKey: KeyPair;
  readonly authMethods: string[] = [];
  readonly ptys: { term: string; cols: number; rows: number }[] = [];
  readonly windows: { cols: number; rows: number }[] = [];
  readonly tcpip: { host: string; port: number }[] = [];
  readonly keepalives: number[] = [];
  readonly agentForwardRequests: number[] = [];
  readonly remoteListeners = new Map<number, NetServer>();
  readonly clients = new Set<Connection>();
  /** Cancelled remote forwards (`cancel-tcpip-forward`), by bound port. */
  readonly cancelledForwards: number[] = [];
  /** `direct-tcpip` opens (and `tcpip-forward` acks) the server is holding back. */
  readonly heldTcpip: { accept: () => void; reject: () => void }[] = [];
  readonly heldForwards: (() => void)[] = [];
  /** While set, channel opens and remote-forward acks are held until the test releases them. */
  holdTcpip = false;
  holdForwardAcks = false;
  /** Called with each channel the server accepts for a `direct-tcpip` open. */
  onChannel: ((channel: ServerChannel) => void) | undefined;
  connections = 0;
  /** Everything typed into any shell. */
  shellInput = '';
  /** Commands of `exec` requests, with whether a PTY was asked for on that channel. */
  readonly execs: { command: string; pty: boolean }[] = [];
  /** Exec channels whose stdin the client ended, and exec channels the client closed. */
  execStdinEnded = 0;
  execClosed = 0;
  private readonly dialed = new Set<Socket>();

  private constructor(
    private readonly server: InstanceType<typeof Server>,
    port: number,
    hostKey: KeyPair,
  ) {
    this.port = port;
    this.hostKey = hostKey;
  }

  static async start(options: TestServerOptions): Promise<TestSshServer> {
    const hostKey = options.hostKey ?? generateKey();
    // The listener needs the instance, which needs the port: wire it through a holder.
    const holder: { instance?: TestSshServer } = {};
    const server = new Server(
      {
        hostKeys: [hostKey.private],
        ...(options.banner ? { banner: options.banner } : {}),
        ...(options.ident ? { ident: options.ident } : {}),
        // The server never surfaces keepalive pings, only its debug log does.
        debug: (message: string) => {
          if (message.includes('GLOBAL_REQUEST (keepalive@openssh.com)')) {
            holder.instance?.keepalives.push(Date.now());
          }
        },
      },
      (client) => holder.instance?.accept(client, options),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    holder.instance = new TestSshServer(server, (server.address() as AddressInfo).port, hostKey);
    return holder.instance;
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.end();
    for (const socket of this.dialed) socket.destroy();
    for (const listener of this.remoteListeners.values()) listener.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Drop every client connection without a goodbye, as a network failure would. */
  dropClients(): void {
    for (const client of this.clients) client.end();
  }

  /** Let the held `tcpip-forward` requests through. */
  releaseForwardAcks(): void {
    this.holdForwardAcks = false;
    for (const bind of this.heldForwards.splice(0)) bind();
  }

  /**
   * Start a key re-exchange on every client connection, optionally presenting `hostKey` instead of
   * the server's own. Resolves per connection once the exchange completes.
   */
  rekeyAll(hostKey?: KeyPair): Promise<void[]> {
    return Promise.all(
      [...this.clients].map((client) => {
        if (hostKey) {
          const parsed = utils.parseKey(hostKey.private);
          const key = Array.isArray(parsed) ? parsed[0] : parsed;
          if (!key || key instanceof Error) throw new Error('bad host key');
          const protocol = (
            client as unknown as { _protocol: { _hostKeys: Record<string, unknown> } }
          )._protocol;
          protocol._hostKeys[key.type] = key;
        }
        return new Promise<void>((resolve, reject) =>
          client.rekey((err?: Error) => (err ? reject(err) : resolve())),
        );
      }),
    );
  }

  private accept(client: Connection, options: TestServerOptions): void {
    this.connections += 1;
    this.clients.add(client);
    client.on('error', () => undefined);
    client.on('close', () => this.clients.delete(client));

    client.on('authentication', (ctx) => {
      this.authMethods.push(ctx.method);
      if (options.stallAuth) return;
      const user = options.users[ctx.username];
      const offered: AuthenticationType[] = [];
      if (user?.password !== undefined) offered.push('password');
      if (user?.publicKey !== undefined) offered.push('publickey');
      if (user?.interactive) offered.push('keyboard-interactive');
      if (!user) return ctx.reject();
      switch (ctx.method) {
        case 'password':
          return ctx.password === user.password ? ctx.accept() : ctx.reject(offered);
        case 'publickey': {
          const allowed = user.publicKey ? utils.parseKey(user.publicKey) : undefined;
          const key = Array.isArray(allowed) ? allowed[0] : allowed;
          if (!key || key instanceof Error) return ctx.reject(offered);
          if (ctx.key.algo !== key.type || !ctx.key.data.equals(key.getPublicSSH())) {
            return ctx.reject(offered);
          }
          if (!ctx.signature) return ctx.accept();
          const ok = key.verify(ctx.blob ?? Buffer.alloc(0), ctx.signature, ctx.hashAlgo);
          return ok === true ? ctx.accept() : ctx.reject(offered);
        }
        case 'keyboard-interactive': {
          const interactive = user.interactive;
          if (!interactive) return ctx.reject(offered);
          return ctx.prompt(interactive.prompts, (answers) =>
            answers.length === interactive.answers.length &&
            answers.every((a, i) => a === interactive.answers[i])
              ? ctx.accept()
              : ctx.reject(offered),
          );
        }
        default:
          return ctx.reject(offered);
      }
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('auth-agent', (acceptAgent) => {
          this.agentForwardRequests.push(Date.now());
          acceptAgent?.();
        });
        let pty = false;
        session.on('pty', (acceptPty, _reject, info) => {
          pty = true;
          this.ptys.push({ term: info.term, cols: info.cols, rows: info.rows });
          acceptPty?.();
        });
        session.on('exec', (acceptExec, rejectExec, info) => {
          this.execs.push({ command: info.command, pty });
          const reply = options.exec?.(info.command) ?? 'refuse';
          if (reply === 'refuse') return void rejectExec?.();
          const stream = acceptExec();
          stream.on('end', () => (this.execStdinEnded += 1));
          stream.on('close', () => (this.execClosed += 1));
          stream.on('error', () => undefined);
          stream.resume();
          if (reply === 'hang') return;
          if (reply.stderr) stream.stderr.write(reply.stderr);
          if (reply.stdout) stream.write(reply.stdout);
          stream.exit(reply.code ?? 0);
          stream.end();
        });
        session.on('window-change', (acceptWindow, _reject, info) => {
          this.windows.push({ cols: info.cols, rows: info.rows });
          acceptWindow?.();
        });
        session.on('shell', (acceptShell) => this.runShell(acceptShell()));
      });

      client.on('tcpip', (accept, reject, info) => {
        this.tcpip.push({ host: info.destIP, port: info.destPort });
        if (this.holdTcpip) {
          this.heldTcpip.push({
            accept: () => {
              const channel = accept();
              this.onChannel?.(channel);
            },
            reject: () => reject(),
          });
          return;
        }
        const target = (options.route ?? ((h, p) => ({ host: h, port: p })))(
          info.destIP,
          info.destPort,
        );
        if (!target) return reject();
        const socket = netConnect(target.port, target.host);
        this.dialed.add(socket);
        socket.once('error', () => reject());
        socket.once('connect', () => {
          socket.removeAllListeners('error');
          const channel = accept();
          channel.pipe(socket);
          socket.pipe(channel);
          socket.on('error', () => channel.close());
          channel.on('close', () => socket.destroy());
        });
      });

      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward' && 'bindPort' in info) {
          const listener = createServer((conn) => {
            const bound = (listener.address() as AddressInfo).port;
            client.forwardOut(
              info.bindAddr,
              bound,
              conn.remoteAddress ?? '',
              conn.remotePort ?? 0,
              (err, channel) => {
                if (err) return void conn.destroy();
                conn.pipe(channel);
                channel.pipe(conn);
                channel.on('close', () => conn.destroy());
                conn.on('close', () => channel.close());
              },
            );
          });
          const bind = () =>
            listener.listen(info.bindPort, '127.0.0.1', () => {
              const bound = (listener.address() as AddressInfo).port;
              this.remoteListeners.set(bound, listener);
              (accept as (port: number) => void)(bound);
            });
          if (this.holdForwardAcks) return void this.heldForwards.push(bind);
          return void bind();
        }
        if (name === 'cancel-tcpip-forward' && 'bindPort' in info) {
          this.cancelledForwards.push(info.bindPort);
          const listener = this.remoteListeners.get(info.bindPort);
          this.remoteListeners.delete(info.bindPort);
          listener?.close();
          return accept?.();
        }
        return reject?.();
      });
    });
  }

  /** Echo input back; `exit` ends the shell with status 3. */
  private runShell(stream: ServerChannel): void {
    stream.on('data', (data: Buffer) => {
      this.shellInput += data.toString();
      stream.write(data);
      if (data.toString().includes('exit\n')) {
        stream.exit(3);
        stream.end();
      }
    });
  }
}

/** A TCP server that echoes bytes back. */
export class EchoServer {
  readonly port: number;
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: NetServer,
    port: number,
  ) {
    this.port = port;
  }

  static async start(): Promise<EchoServer> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const echo = new EchoServer(server, (server.address() as AddressInfo).port);
    for (const s of sockets) echo.sockets.add(s);
    return echo;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export type ConnectionOverrides = Partial<ResolvedConnection> & { port: number };

/** A resolved connection to a TestSshServer: user alice, password "pw". */
export function connection(overrides: ConnectionOverrides): ResolvedConnection {
  return {
    hostId: 'test-host',
    label: 'test host',
    address: '127.0.0.1',
    username: 'alice',
    password: 'pw',
    agentForwarding: false,
    jumpChain: [],
    portForwards: [],
    ...overrides,
  };
}

/** Open a TCP connection, send `payload`, and resolve with the first bytes that come back. */
export function roundTrip(
  port: number,
  payload: Buffer | string,
  address = '127.0.0.1',
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, address);
    socket.once('error', reject);
    socket.once('data', (data: Buffer) => {
      socket.destroy();
      resolve(data);
    });
    socket.once('connect', () => socket.write(payload));
  });
}

export async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Reject if `promise` has not settled within `ms`: a hang becomes a test failure, not a timeout. */
export async function withTimeout<T>(promise: Promise<T>, what: string, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
