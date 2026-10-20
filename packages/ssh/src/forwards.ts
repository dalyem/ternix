import { connect as netConnect, createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Client as Ssh2Client, ClientChannel } from 'ssh2';
import { errorMessage, SshError } from './errors.js';
import type { PortForwardSpec } from './resolve.js';
import { bridge, serveSocks5 } from './socks.js';

export type ForwardState = 'starting' | 'active' | 'stopped' | 'error';

export interface ForwardStatus {
  id: string;
  label: string;
  kind: PortForwardSpec['kind'];
  state: ForwardState;
  /** Where the listener actually is: local for `local`/`dynamic`, on the server for `remote`. */
  boundAddress?: string;
  boundPort?: number;
  /** Connections currently being carried. */
  connections: number;
  /** Start failure, or the most recent per-connection failure of an active forward. */
  error?: string;
}

export type ForwardListener = (status: ForwardStatus) => void;

interface Running {
  spec: PortForwardSpec;
  status: ForwardStatus;
  streams: Set<Duplex>;
  /** Set once the forward is being torn down; anything that completes later cleans up after itself. */
  cancelled: boolean;
  server?: Server;
  remote?: { address: string; port: number };
}

const DEFAULT_BIND_ADDRESS = '127.0.0.1';
const UNFORWARD_TIMEOUT_MS = 2_000;

function bindAddressOf(spec: PortForwardSpec): string {
  return spec.bindAddress.trim() || DEFAULT_BIND_ADDRESS;
}

function listen(server: Server, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, address, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** Port forwards over one connected `ssh2` client: local, remote and dynamic (SOCKS5). */
export class ForwardManager {
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly client: Ssh2Client,
    private readonly onStatus: ForwardListener,
  ) {
    client.on('tcp connection', (details, accept, reject) => {
      const run = this.remoteTarget(details.destIP, details.destPort);
      if (!run || run.spec.destHost === undefined || run.spec.destPort === undefined) {
        reject();
        return;
      }
      const local = netConnect(run.spec.destPort, run.spec.destHost);
      local.once('error', (err) => {
        this.noteError(
          run,
          `Connection to ${run.spec.destHost}:${run.spec.destPort} failed: ${err.message}`,
        );
        local.destroy();
        reject();
      });
      local.once('connect', () => {
        local.removeAllListeners('error');
        this.carry(run, local, accept());
      });
    });
  }

  statuses(): ForwardStatus[] {
    return [...this.running.values()].map((run) => ({ ...run.status }));
  }

  async start(spec: PortForwardSpec): Promise<ForwardStatus> {
    const existing = this.running.get(spec.id);
    if (existing && (existing.status.state === 'active' || existing.status.state === 'starting')) {
      return { ...existing.status };
    }
    if (existing) await this.stop(spec.id);

    const run: Running = {
      spec,
      streams: new Set(),
      cancelled: false,
      status: {
        id: spec.id,
        label: spec.label,
        kind: spec.kind,
        state: 'starting',
        connections: 0,
      },
    };
    this.running.set(spec.id, run);
    this.emit(run);
    try {
      if (spec.kind === 'local') await this.startLocal(run);
      else if (spec.kind === 'remote') await this.startRemote(run);
      else await this.startDynamic(run);
    } catch (err) {
      const stoppedMeanwhile = run.cancelled;
      await this.teardown(run);
      if (!stoppedMeanwhile) {
        run.status.state = 'error';
        run.status.error = errorMessage(err);
        this.emit(run);
      }
      throw err instanceof SshError
        ? err
        : new SshError(
            'forward_failed',
            `Port forward "${spec.label}" failed: ${errorMessage(err)}`,
            {
              cause: err,
            },
          );
    }
    // Stopped while starting: stop() already reported it, and whatever bound late is released.
    if (run.cancelled) return { ...run.status, state: 'stopped' };
    run.status.state = 'active';
    this.emit(run);
    return { ...run.status };
  }

  async stop(id: string): Promise<void> {
    const run = this.running.get(id);
    if (!run) return;
    this.running.delete(id);
    await this.teardown(run);
    run.status.state = 'stopped';
    run.status.connections = 0;
    this.emit(run);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  private emit(run: Running): void {
    this.onStatus({ ...run.status });
  }

  private noteError(run: Running, message: string): void {
    run.status.error = message;
    this.emit(run);
  }

  private async startLocal(run: Running): Promise<void> {
    const { spec } = run;
    const { destHost, destPort } = this.requireDestination(spec);
    await this.listenLocal(run, (socket) => {
      this.track(run, socket);
      this.openChannel(run, socket, destHost, destPort).then(
        (channel) => this.carry(run, socket, channel),
        (err: unknown) => {
          this.noteError(run, `Forward to ${destHost}:${destPort} failed: ${errorMessage(err)}`);
          socket.destroy();
        },
      );
    });
  }

  private async startDynamic(run: Running): Promise<void> {
    await this.listenLocal(run, (socket) => {
      this.track(run, socket);
      serveSocks5(socket, async (host, port) => {
        try {
          return await this.openChannel(run, socket, host, port);
        } catch (err) {
          this.noteError(run, `SOCKS connect to ${host}:${port} failed: ${errorMessage(err)}`);
          throw err;
        }
      });
    });
  }

  private async listenLocal(run: Running, onConnection: (socket: Socket) => void): Promise<void> {
    const address = bindAddressOf(run.spec);
    const server = createServer(onConnection);
    run.server = server;
    try {
      await listen(server, run.spec.bindPort, address);
    } catch (err) {
      throw new SshError(
        'forward_failed',
        `Cannot listen on ${address}:${run.spec.bindPort}: ${errorMessage(err)}`,
        { cause: err },
      );
    }
    if (run.cancelled) {
      // Stopped while the bind was in flight; teardown could not see the listener yet.
      run.server = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return;
    }
    run.status.boundAddress = address;
    run.status.boundPort = (server.address() as AddressInfo).port;
  }

  /** Track an accepted local socket from the moment it arrives, so teardown can always reach it. */
  private track(run: Running, socket: Socket): void {
    if (run.cancelled) {
      socket.destroy();
      return;
    }
    run.streams.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => run.streams.delete(socket));
  }

  private async startRemote(run: Running): Promise<void> {
    const { spec } = run;
    this.requireDestination(spec);
    const address = bindAddressOf(spec);
    const port = await new Promise<number>((resolve, reject) => {
      try {
        this.client.forwardIn(address, spec.bindPort, (err, assigned) =>
          err ? reject(err) : resolve(assigned || spec.bindPort),
        );
      } catch (err) {
        reject(err);
      }
    }).catch((err: unknown) => {
      throw new SshError(
        'forward_failed',
        `Server refused to listen on ${address}:${spec.bindPort}: ${errorMessage(err)}`,
        { cause: err },
      );
    });
    if (run.cancelled) {
      // Stopped before the server acknowledged: the listener exists on the server now, so remove it.
      await this.unforward({ address, port });
      return;
    }
    run.remote = { address, port };
    run.status.boundAddress = address;
    run.status.boundPort = port;
  }

  private requireDestination(spec: PortForwardSpec): { destHost: string; destPort: number } {
    if (!spec.destHost || spec.destPort === undefined) {
      throw new SshError('forward_failed', `Port forward "${spec.label}" has no destination`);
    }
    return { destHost: spec.destHost, destPort: spec.destPort };
  }

  private remoteTarget(destIP: string, destPort: number): Running | undefined {
    const candidates = [...this.running.values()].filter(
      (run) => run.remote?.port === destPort && run.status.state !== 'stopped',
    );
    return candidates.find((run) => run.remote?.address === destIP) ?? candidates[0];
  }

  private openChannel(
    run: Running,
    from: Socket,
    host: string,
    port: number,
  ): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      try {
        this.client.forwardOut(
          from.remoteAddress ?? DEFAULT_BIND_ADDRESS,
          from.remotePort ?? 0,
          host,
          port,
          (err, channel) => {
            if (err) return reject(err);
            if (from.destroyed || run.cancelled) {
              channel.destroy();
              return reject(new Error('forward closed'));
            }
            resolve(channel);
          },
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Bridge a local socket and an SSH channel and track both until either closes. */
  private carry(run: Running, local: Duplex, channel: Duplex): void {
    run.streams.add(local);
    run.streams.add(channel);
    run.status.connections += 1;
    this.emit(run);
    let counted = true;
    const release = () => {
      run.streams.delete(local);
      run.streams.delete(channel);
      if (counted) {
        counted = false;
        run.status.connections = Math.max(0, run.status.connections - 1);
        if (this.running.get(run.spec.id) === run) this.emit(run);
      }
    };
    local.once('close', release);
    channel.once('close', release);
    bridge(local, channel);
  }

  private async teardown(run: Running): Promise<void> {
    run.cancelled = true;
    for (const stream of run.streams) stream.destroy();
    run.streams.clear();
    const { server, remote } = run;
    run.server = undefined;
    run.remote = undefined;
    const waits: Promise<void>[] = [];
    if (server?.listening) {
      waits.push(new Promise<void>((resolve) => server.close(() => resolve())));
    }
    if (remote) waits.push(this.unforward(remote));
    await Promise.all(waits);
  }

  private unforward(remote: { address: string; port: number }): Promise<void> {
    return new Promise<void>((resolve) => {
      // A dead connection never answers, so do not wait for it forever.
      const timer = setTimeout(resolve, UNFORWARD_TIMEOUT_MS);
      timer.unref();
      try {
        this.client.unforwardIn(remote.address, remote.port, () => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
