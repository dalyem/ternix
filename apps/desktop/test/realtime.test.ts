import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '../src/shared/types.js';
import {
  Realtime,
  type RealtimeSocketHandlers,
  wsSocketFactory,
} from '../src/main/client/realtime.js';
import {
  closeClients,
  loginUser,
  nextEvent,
  registerUser,
  snippet,
  startServer,
  waitFor,
} from './helpers.js';

/** A socket the test drives by hand. */
class FakeSocket {
  sent: unknown[] = [];
  closed: number | undefined;
  terminated = false;
  constructor(readonly handlers: RealtimeSocketHandlers) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code;
  }
  terminate() {
    this.terminated = true;
    this.handlers.onClose(1006);
  }
  serverSays(message: object) {
    this.handlers.onMessage(JSON.stringify(message));
  }
}

function harness(token: string | null = 'tok') {
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const states: ConnectionState[] = [];
  const rt = new Realtime(
    'ws://127.0.0.1/api/v1/ws',
    (_url, handlers) => {
      const s = new FakeSocket(handlers);
      sockets.push(s);
      return s;
    },
    {
      getToken: () => token,
      onConnection: (s) => states.push(s),
      onReady: () => events.push('ready'),
      onVaultChanged: (id) => events.push(`vault:${id}`),
      onVaultsChanged: () => events.push('vaults'),
      onRevoked: () => events.push('revoked'),
    },
    {
      pingIntervalMs: 1000,
      pongTimeoutMs: 300,
      authTimeoutMs: 500,
      reconnectBaseMs: 100,
      reconnectMaxMs: 800,
      random: () => 0,
    },
  );
  return { rt, sockets, events, states };
}

describe('Realtime (fake socket)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('authenticates first, then forwards events', () => {
    const { rt, sockets, events, states } = harness();
    rt.start();
    const s = sockets[0]!;
    s.handlers.onOpen();
    expect(s.sent).toEqual([{ type: 'auth', token: 'tok' }]);
    s.serverSays({ type: 'ready' });
    s.serverSays({
      type: 'vault.changed',
      vault_id: '00000000-0000-4000-8000-000000000001',
      seq: 3,
    });
    s.serverSays({ type: 'vaults.changed' });
    s.serverSays({ type: 'nonsense' });
    s.handlers.onMessage('not json');
    expect(events).toEqual(['ready', 'vault:00000000-0000-4000-8000-000000000001', 'vaults']);
    expect(states).toEqual(['connecting', 'online']);
    rt.stop();
    expect(s.closed).toBe(1000);
    expect(states.at(-1)).toBe('offline');
  });

  it('pings, treats a missing pong as dead, and reconnects with backoff', () => {
    vi.useFakeTimers();
    const { rt, sockets, events } = harness();
    rt.start();
    sockets[0]!.handlers.onOpen();
    sockets[0]!.serverSays({ type: 'ready' });
    vi.advanceTimersByTime(1000);
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'ping' });
    sockets[0]!.serverSays({ type: 'pong' });
    vi.advanceTimersByTime(1000);
    expect(sockets[0]!.terminated).toBe(false);
    // Second ping goes unanswered.
    vi.advanceTimersByTime(300);
    expect(sockets[0]!.terminated).toBe(true);
    expect(sockets).toHaveLength(1);
    // random() = 0: half of base, then half of 2x base, ...
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    sockets[1]!.handlers.onClose(1006);
    vi.advanceTimersByTime(99);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    // A successful ready resets the backoff and triggers a catch-up again.
    sockets[2]!.handlers.onOpen();
    sockets[2]!.serverSays({ type: 'ready' });
    expect(events.filter((e) => e === 'ready')).toHaveLength(2);
    rt.stop();
  });

  it('gives up the auth after a timeout and retries', () => {
    vi.useFakeTimers();
    const { rt, sockets } = harness();
    rt.start();
    sockets[0]!.handlers.onOpen();
    vi.advanceTimersByTime(500);
    expect(sockets[0]!.terminated).toBe(true);
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    rt.stop();
  });

  it('stops on session.revoked and on close code 4401', () => {
    const one = harness();
    one.rt.start();
    one.sockets[0]!.handlers.onOpen();
    one.sockets[0]!.serverSays({ type: 'ready' });
    one.sockets[0]!.serverSays({ type: 'session.revoked' });
    expect(one.events).toEqual(['ready', 'revoked']);
    expect(one.rt.connection).toBe('offline');

    vi.useFakeTimers();
    const two = harness();
    two.rt.start();
    two.sockets[0]!.handlers.onOpen();
    two.sockets[0]!.handlers.onClose(4401);
    expect(two.events).toEqual(['revoked']);
    vi.advanceTimersByTime(10_000);
    expect(two.sockets).toHaveLength(1);
  });

  it('does not connect without a token', () => {
    const { rt, sockets } = harness(null);
    rt.start();
    expect(sockets).toHaveLength(0);
    expect(rt.connection).toBe('offline');
  });
});

describe('Realtime against the server', () => {
  afterEach(() => {
    closeClients();
  });

  it('reconnects after the server drops the socket and catches up on what it missed', async () => {
    const server = await startServer();
    try {
      let connections = 0;
      const a = await registerUser(server, { realtime: false });
      const b = await loginUser(server, a.email, a.password, {
        webSocketFactory: (url, handlers) => {
          connections += 1;
          return wsSocketFactory(url, handlers);
        },
        realtime: { reconnectBaseMs: 600, reconnectMaxMs: 600, random: () => 1 },
      });
      await waitFor(() => b.client.connection === 'online', 'online');
      expect(connections).toBe(1);

      const offline = nextEvent(b.client, 'connection', (s) => s === 'offline');
      server.ctx.hub.closeAll(1012, 'restart');
      await offline;
      // Written while B is disconnected: B gets no vault.changed for it.
      const missed = await a.client.putItem(a.personalVaultId, undefined, snippet('missed'));

      const caughtUp = nextEvent(b.client, 'items-changed');
      await waitFor(() => b.client.connection === 'online', 'back online');
      expect(connections).toBe(2);
      await caughtUp;
      expect(b.client.getItem(a.personalVaultId, missed.item!.id)).not.toBeNull();
    } finally {
      closeClients();
      await server.close();
    }
  });
});
