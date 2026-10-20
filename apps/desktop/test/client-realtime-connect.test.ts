import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '../src/shared/types.js';
import {
  Realtime,
  type RealtimeOptions,
  type RealtimeSocketHandlers,
  type WebSocketFactory,
  wsSocketFactory,
} from '../src/main/client/realtime.js';
import { waitFor } from './helpers.js';

function realtime(factory: WebSocketFactory, url: string, options: RealtimeOptions) {
  const states: ConnectionState[] = [];
  const rt = new Realtime(
    url,
    factory,
    {
      getToken: () => 'tok',
      onConnection: (s) => states.push(s),
      onReady: () => undefined,
      onVaultChanged: () => undefined,
      onVaultsChanged: () => undefined,
      onRevoked: () => undefined,
    },
    { reconnectBaseMs: 100, reconnectMaxMs: 100, random: () => 0, ...options },
  );
  return { rt, states };
}

describe('realtime connect deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a socket that never opens and backs off', () => {
    vi.useFakeTimers();
    const sockets: { handlers: RealtimeSocketHandlers; terminated: boolean }[] = [];
    const { rt, states } = realtime(
      (_url, handlers) => {
        // A socket whose open never comes and whose terminate emits nothing.
        const s = { handlers, terminated: false };
        sockets.push(s);
        return {
          send: () => undefined,
          close: () => undefined,
          terminate: () => (s.terminated = true),
        };
      },
      'ws://127.0.0.1/api/v1/ws',
      { connectTimeoutMs: 1_000 },
    );
    rt.start();
    vi.advanceTimersByTime(999);
    expect(sockets[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sockets[0]!.terminated).toBe(true);
    expect(states).toEqual(['connecting', 'offline']);
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    // A late close from the abandoned socket changes nothing.
    sockets[0]!.handlers.onClose(1006);
    expect(states).toEqual(['connecting', 'offline', 'connecting']);
    rt.stop();
  });

  it('the deadline covers auth too: open but no ready in time', () => {
    vi.useFakeTimers();
    const sockets: { handlers: RealtimeSocketHandlers; terminated: boolean }[] = [];
    const { rt } = realtime(
      (_url, handlers) => {
        const s = { handlers, terminated: false };
        sockets.push(s);
        return {
          send: () => undefined,
          close: () => undefined,
          terminate: () => {
            s.terminated = true;
            handlers.onClose(1006);
          },
        };
      },
      'ws://127.0.0.1/api/v1/ws',
      { connectTimeoutMs: 1_000, authTimeoutMs: 60_000 },
    );
    rt.start();
    vi.advanceTimersByTime(900);
    sockets[0]!.handlers.onOpen();
    vi.advanceTimersByTime(100);
    expect(sockets[0]!.terminated).toBe(true);
    rt.stop();
  });

  it('reconnects when a TCP peer accepts and never answers the upgrade', async () => {
    const accepted: Socket[] = [];
    const tcp = createServer((socket) => {
      accepted.push(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const { port } = tcp.address() as AddressInfo;
    const { rt, states } = realtime(wsSocketFactory, `ws://127.0.0.1:${port}/api/v1/ws`, {
      connectTimeoutMs: 200,
    });
    try {
      rt.start();
      await waitFor(() => accepted.length >= 2, 'a second connection attempt');
      expect(states.slice(0, 3)).toEqual(['connecting', 'offline', 'connecting']);
    } finally {
      rt.stop();
      for (const s of accepted) s.destroy();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    }
  });
});
