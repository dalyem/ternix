import { connect as netConnect, createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SshError, SshSession } from '../src/index.js';
import type { ForwardStatus, PortForwardSpec } from '../src/index.js';
import {
  EchoServer,
  TestSshServer,
  connection,
  roundTrip,
  waitFor,
  withTimeout,
} from './helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const srv = await TestSshServer.start({ users: { alice: { password: 'pw' } } });
  cleanup.push(() => srv.stop());
  const echo = await EchoServer.start();
  cleanup.push(() => echo.stop());
  const session = new SshSession();
  cleanup.push(() => session.close());
  await session.connect(connection({ port: srv.port }), { verifyHostKey: async () => true });
  return { srv, echo, session };
}

const spec = (
  fields: Partial<PortForwardSpec> & Pick<PortForwardSpec, 'kind'>,
): PortForwardSpec => ({
  id: `fwd-${fields.kind}`,
  label: `${fields.kind} forward`,
  bindAddress: '127.0.0.1',
  bindPort: 0,
  ...fields,
});

async function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(true));
  });
}

/** Minimal SOCKS5 client: greeting, then a CONNECT request. Resolves the socket and the reply. */
async function socksConnect(
  port: number,
  request: Buffer,
): Promise<{ socket: Socket; reply: Buffer }> {
  const socket = netConnect(port, '127.0.0.1');
  cleanup.push(() => void socket.destroy());
  const chunks: Buffer[] = [];
  let waiter: (() => void) | undefined;
  socket.on('data', (d: Buffer) => (chunks.push(d), waiter?.()));
  socket.on('error', () => undefined);
  const take = async (n: number): Promise<Buffer> => {
    while (Buffer.concat(chunks).length < n)
      await new Promise<void>((resolve) => (waiter = resolve));
    const all = Buffer.concat(chunks);
    chunks.length = 0;
    if (all.length > n) chunks.push(all.subarray(n));
    return all.subarray(0, n);
  };
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(Buffer.from([5, 1, 0]));
  expect([...(await take(2))]).toEqual([5, 0]);
  socket.write(request);
  const reply = await take(10);
  return { socket, reply };
}

const ipv4Connect = (port: number): Buffer =>
  Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, port >> 8, port & 0xff]);

describe('local forward', () => {
  it('carries bytes from the local port to the destination through the server', async () => {
    const { srv, echo, session } = await setup();
    const status = await session.startForward(
      spec({ kind: 'local', destHost: '127.0.0.1', destPort: echo.port }),
    );
    expect(status).toMatchObject({ state: 'active', boundAddress: '127.0.0.1' });
    expect(status.boundPort).toBeGreaterThan(0);

    expect((await roundTrip(status.boundPort!, 'ping')).toString()).toBe('ping');
    expect(srv.tcpip).toEqual([{ host: '127.0.0.1', port: echo.port }]);
  });

  it('tracks open connections and reports status changes', async () => {
    const { echo, session } = await setup();
    const seen: ForwardStatus[] = [];
    session.onForwardStatus((s) => seen.push(s));
    const status = await session.startForward(
      spec({ kind: 'local', destHost: '127.0.0.1', destPort: echo.port }),
    );
    const client = netConnect(status.boundPort!, '127.0.0.1');
    cleanup.push(() => void client.destroy());
    client.write('x');
    await waitFor(() => session.forwardStatuses()[0]?.connections === 1, 'one connection');
    client.destroy();
    await waitFor(() => session.forwardStatuses()[0]?.connections === 0, 'zero connections');
    expect(seen.map((s) => s.state)).toContain('starting');
    expect(seen.map((s) => s.state)).toContain('active');
  });

  it('binds to 127.0.0.1 when the bind address is empty', async () => {
    const { echo, session } = await setup();
    const status = await session.startForward(
      spec({ kind: 'local', bindAddress: '', destHost: '127.0.0.1', destPort: echo.port }),
    );
    expect(status.boundAddress).toBe('127.0.0.1');
  });

  it('stops individually and frees the port', async () => {
    const { echo, session } = await setup();
    const a = await session.startForward(
      spec({ id: 'a', kind: 'local', destHost: '127.0.0.1', destPort: echo.port }),
    );
    const b = await session.startForward(
      spec({ id: 'b', kind: 'local', destHost: '127.0.0.1', destPort: echo.port }),
    );
    await session.stopForward('a');
    expect(await refused(a.boundPort!)).toBe(true);
    expect((await roundTrip(b.boundPort!, 'still up')).toString()).toBe('still up');
    expect(session.forwardStatuses().map((s) => [s.id, s.state])).toEqual([['b', 'active']]);
  });

  it('can be restarted after it stopped', async () => {
    const { echo, session } = await setup();
    const forward = spec({ kind: 'local', destHost: '127.0.0.1', destPort: echo.port });
    await session.startForward(forward);
    await session.stopForward(forward.id);
    const again = await session.startForward(forward);
    expect((await roundTrip(again.boundPort!, 'again')).toString()).toBe('again');
  });

  it('starting an active forward again returns it unchanged', async () => {
    const { echo, session } = await setup();
    const forward = spec({ kind: 'local', destHost: '127.0.0.1', destPort: echo.port });
    const first = await session.startForward(forward);
    const second = await session.startForward(forward);
    expect(second.boundPort).toBe(first.boundPort);
    expect(session.forwardStatuses()).toHaveLength(1);
  });

  it('rejects with forward_failed and records the error when the port is taken', async () => {
    const { echo, session } = await setup();
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => void taken.close());
    const port = (taken.address() as AddressInfo).port;
    const err = await session
      .startForward(
        spec({ kind: 'local', bindPort: port, destHost: '127.0.0.1', destPort: echo.port }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SshError);
    expect((err as SshError).code).toBe('forward_failed');
    expect(session.forwardStatuses()[0]).toMatchObject({ state: 'error' });
    expect(session.forwardStatuses()[0]?.error).toContain('EADDRINUSE');
  });

  it('rejects a local forward that has no destination', async () => {
    const { session } = await setup();
    const err = await session.startForward(spec({ kind: 'local' })).catch((e: unknown) => e);
    expect((err as SshError).code).toBe('forward_failed');
  });

  it('drops the local connection when the destination is unreachable', async () => {
    const { session } = await setup();
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const status = await session.startForward(
      spec({ kind: 'local', destHost: '127.0.0.1', destPort: deadPort }),
    );
    const client = netConnect(status.boundPort!, '127.0.0.1');
    client.on('error', () => undefined);
    await new Promise((resolve) => client.once('close', resolve));
    await waitFor(
      () => session.forwardStatuses()[0]?.error !== undefined,
      'the error to be recorded',
    );
    expect(session.forwardStatuses()[0]?.state).toBe('active');
  });
});

describe('dynamic forward (SOCKS5)', () => {
  it('connects to an IPv4 destination and carries bytes', async () => {
    const { srv, echo, session } = await setup();
    const status = await session.startForward(spec({ kind: 'dynamic' }));
    const { socket, reply } = await socksConnect(status.boundPort!, ipv4Connect(echo.port));
    expect([...reply.subarray(0, 2)]).toEqual([5, 0]);
    const echoed = new Promise<Buffer>((resolve) => socket.once('data', resolve));
    socket.write('over socks');
    expect((await echoed).toString()).toBe('over socks');
    expect(srv.tcpip).toEqual([{ host: '127.0.0.1', port: echo.port }]);
  });

  it('resolves a domain destination on the server side', async () => {
    const { srv, echo, session } = await setup();
    const status = await session.startForward(spec({ kind: 'dynamic' }));
    const name = Buffer.from('localhost');
    const request = Buffer.from([
      5,
      1,
      0,
      3,
      name.length,
      ...name,
      echo.port >> 8,
      echo.port & 0xff,
    ]);
    const { socket, reply } = await socksConnect(status.boundPort!, request);
    expect(reply[1]).toBe(0);
    const echoed = new Promise<Buffer>((resolve) => socket.once('data', resolve));
    socket.write('by name');
    expect((await echoed).toString()).toBe('by name');
    expect(srv.tcpip[0]).toEqual({ host: 'localhost', port: echo.port });
  });

  it('sends the IPv6 address through as text', async () => {
    const { srv, session } = await setup();
    const status = await session.startForward(spec({ kind: 'dynamic' }));
    const loopback6 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    const { reply } = await socksConnect(
      status.boundPort!,
      Buffer.from([5, 1, 0, 4, ...loopback6, 0, 1]),
    );
    expect(reply[1]).not.toBe(0); // nothing listens on [::1]:1
    expect(srv.tcpip[0]).toEqual({ host: '0:0:0:0:0:0:0:1', port: 1 });
  });

  it('answers a failed connect with a SOCKS failure reply', async () => {
    const { session } = await setup();
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const status = await session.startForward(spec({ kind: 'dynamic' }));
    const { reply } = await socksConnect(status.boundPort!, ipv4Connect(deadPort));
    expect(reply[0]).toBe(5);
    expect(reply[1]).not.toBe(0);
    expect(session.forwardStatuses()[0]?.state).toBe('active');
  });
});

describe('remote forward', () => {
  it('has the server listen and carries its connections to the local destination', async () => {
    const { srv, echo, session } = await setup();
    const status = await session.startForward(
      spec({ kind: 'remote', bindPort: 0, destHost: '127.0.0.1', destPort: echo.port }),
    );
    expect(status.state).toBe('active');
    expect(status.boundPort).toBeGreaterThan(0);
    expect([...srv.remoteListeners.keys()]).toEqual([status.boundPort]);

    expect((await roundTrip(status.boundPort!, 'from the server side')).toString()).toBe(
      'from the server side',
    );
  });

  it('cancels the server-side listener on stop', async () => {
    const { srv, echo, session } = await setup();
    const status = await session.startForward(
      spec({ kind: 'remote', destHost: '127.0.0.1', destPort: echo.port }),
    );
    await session.stopForward('fwd-remote');
    expect(srv.remoteListeners.size).toBe(0);
    expect(await refused(status.boundPort!)).toBe(true);
  });

  it('requires a destination', async () => {
    const { session } = await setup();
    const err = await session.startForward(spec({ kind: 'remote' })).catch((e: unknown) => e);
    expect((err as SshError).code).toBe('forward_failed');
  });
});

describe('a channel open the server never answers', () => {
  it('lets a local forward stop and the session close', async () => {
    const { srv, echo, session } = await setup();
    const status = await session.startForward(
      spec({ kind: 'local', destHost: '127.0.0.1', destPort: echo.port }),
    );
    srv.holdTcpip = true;
    const client = netConnect(status.boundPort!, '127.0.0.1');
    client.on('error', () => undefined);
    cleanup.push(() => void client.destroy());
    const closed = new Promise((resolve) => client.once('close', resolve));
    await waitFor(() => srv.heldTcpip.length === 1, 'the server to receive the channel open');

    await withTimeout(session.stopForward('fwd-local'), 'the forward to stop');
    await withTimeout(closed, 'the pending local connection to be dropped');
    expect(await refused(status.boundPort!)).toBe(true);
    await withTimeout(session.close(), 'the session to close');
  });

  it('closes the session while a local connection is pending', async () => {
    const { srv, echo, session } = await setup();
    const status = await session.startForward(
      spec({ kind: 'local', destHost: '127.0.0.1', destPort: echo.port }),
    );
    srv.holdTcpip = true;
    const client = netConnect(status.boundPort!, '127.0.0.1');
    client.on('error', () => undefined);
    cleanup.push(() => void client.destroy());
    await waitFor(() => srv.heldTcpip.length === 1, 'the server to receive the channel open');

    await withTimeout(session.close(), 'the session to close');
  });

  it('lets a SOCKS forward stop while a CONNECT is pending', async () => {
    const { srv, echo, session } = await setup();
    const status = await session.startForward(spec({ kind: 'dynamic' }));
    srv.holdTcpip = true;
    const client = netConnect(status.boundPort!, '127.0.0.1');
    client.on('error', () => undefined);
    cleanup.push(() => void client.destroy());
    client.write(Buffer.concat([Buffer.from([5, 1, 0]), ipv4Connect(echo.port)]));
    await waitFor(() => srv.heldTcpip.length === 1, 'the server to receive the channel open');

    await withTimeout(session.stopForward('fwd-dynamic'), 'the forward to stop');
    await withTimeout(session.close(), 'the session to close');
  });

  it('closes a channel that opens after the forward was stopped', async () => {
    const { srv, echo, session } = await setup();
    const status = await session.startForward(
      spec({ kind: 'local', destHost: '127.0.0.1', destPort: echo.port }),
    );
    srv.holdTcpip = true;
    const client = netConnect(status.boundPort!, '127.0.0.1');
    client.on('error', () => undefined);
    cleanup.push(() => void client.destroy());
    await waitFor(() => srv.heldTcpip.length === 1, 'the server to receive the channel open');
    await withTimeout(session.stopForward('fwd-local'), 'the forward to stop');

    const channelClosed = new Promise<void>((resolve) => {
      const [held] = srv.heldTcpip;
      srv.onChannel = (channel) => {
        channel.once('close', () => resolve());
        channel.resume(); // an unread channel never reports its close
      };
      held?.accept();
    });
    await withTimeout(channelClosed, 'the late channel to be closed by the client');
  });
});

describe('stopping a forward while it starts', () => {
  it('cancels a remote forward whose acknowledgement arrives after the stop', async () => {
    const { srv, echo, session } = await setup();
    const seen: ForwardStatus[] = [];
    session.onForwardStatus((s) => seen.push(s));
    srv.holdForwardAcks = true;
    const starting = session.startForward(
      spec({ kind: 'remote', destHost: '127.0.0.1', destPort: echo.port }),
    );
    await waitFor(() => srv.heldForwards.length === 1, 'the server to receive the request');

    await session.stopForward('fwd-remote');
    srv.releaseForwardAcks();
    const result = await withTimeout(starting, 'the start to settle');

    expect(result.state).toBe('stopped');
    expect(seen.map((s) => s.state)).not.toContain('active');
    expect(srv.cancelledForwards).toHaveLength(1);
    expect(srv.remoteListeners.size).toBe(0);
    expect(session.forwardStatuses()).toEqual([]);
  });

  it('does not leave a local listener behind when stopped during the bind', async () => {
    const { echo, session } = await setup();
    const seen: ForwardStatus[] = [];
    session.onForwardStatus((s) => seen.push(s));
    // A host name makes the bind asynchronous, so the stop lands before the listener exists.
    const starting = session.startForward(
      spec({ kind: 'local', bindAddress: 'localhost', destHost: '127.0.0.1', destPort: echo.port }),
    );
    await session.stopForward('fwd-local');
    const result = await withTimeout(starting, 'the start to settle');

    expect(result.state).toBe('stopped');
    expect(result.boundPort).toBeUndefined();
    expect(seen.map((s) => s.state)).not.toContain('active');
    expect(session.forwardStatuses()).toEqual([]);
  });
});

describe('closing the session', () => {
  it('removes every listener and drops carried connections', async () => {
    const { srv, echo, session } = await setup();
    const local = await session.startForward(
      spec({ id: 'l', kind: 'local', destHost: '127.0.0.1', destPort: echo.port }),
    );
    const dynamic = await session.startForward(spec({ id: 'd', kind: 'dynamic' }));
    const remote = await session.startForward(
      spec({ id: 'r', kind: 'remote', destHost: '127.0.0.1', destPort: echo.port }),
    );

    const open = netConnect(local.boundPort!, '127.0.0.1');
    open.on('error', () => undefined);
    const closed = new Promise((resolve) => open.once('close', resolve));
    open.write('keep open');
    await waitFor(
      () => session.forwardStatuses().find((s) => s.id === 'l')?.connections === 1,
      'a carried connection',
    );

    const seen: ForwardStatus[] = [];
    session.onForwardStatus((s) => seen.push(s));
    await session.close();

    await closed;
    expect(await refused(local.boundPort!)).toBe(true);
    expect(await refused(dynamic.boundPort!)).toBe(true);
    expect(srv.remoteListeners.size).toBe(0);
    expect(await refused(remote.boundPort!)).toBe(true);
    expect(
      seen
        .filter((s) => s.state === 'stopped')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['d', 'l', 'r']);
    expect(session.forwardStatuses()).toEqual([]);
    expect(srv.clients.size).toBe(0);
  });

  it('refuses to start a forward after close', async () => {
    const { echo, session } = await setup();
    await session.close();
    const err = await Promise.resolve()
      .then(() =>
        session.startForward(spec({ kind: 'local', destHost: '127.0.0.1', destPort: echo.port })),
      )
      .catch((e: unknown) => e);
    expect((err as SshError).code).toBe('invalid_state');
  });
});
