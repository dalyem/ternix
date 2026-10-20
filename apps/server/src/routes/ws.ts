import type { FastifyInstance } from 'fastify';
import {
  WS_CLOSE_UNAUTHORIZED,
  wsClientMessageSchema,
  type WsServerMessage,
} from '@ternix/core/protocol';
import { touchDevice } from '../auth.js';
import type { AppContext } from '../context.js';
import { hashToken } from '../tokens.js';

export async function wsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config, store, hub } = ctx;

  app.get('/api/v1/ws', { websocket: true }, (socket) => {
    let authed = false;
    let unregister: (() => void) | undefined;
    let alive = true;

    const send = (message: WsServerMessage) => socket.send(JSON.stringify(message));
    const reject = () => socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');

    const authTimer = setTimeout(() => {
      if (!authed) socket.close(WS_CLOSE_UNAUTHORIZED, 'auth timeout');
    }, config.wsAuthTimeoutMs);

    // Protocol-level ping/pong drops half-open connections; clients answer without code.
    const heartbeat =
      config.wsHeartbeatMs > 0
        ? setInterval(() => {
            if (!alive) return socket.terminate();
            alive = false;
            socket.ping();
          }, config.wsHeartbeatMs)
        : undefined;
    socket.on('pong', () => {
      alive = true;
    });

    socket.on('message', (data, isBinary) => {
      let json: unknown;
      try {
        json = isBinary ? undefined : JSON.parse(data.toString());
      } catch {
        json = undefined;
      }
      const message = wsClientMessageSchema.safeParse(json);
      if (!authed) {
        if (!message.success || message.data.type !== 'auth') return reject();
        const session = store.findSession(hashToken(message.data.token));
        if (!session) return reject();
        authed = true;
        clearTimeout(authTimer);
        touchDevice(ctx, session.device_id, session.last_seen_at);
        unregister = hub.add(socket, session.user_id, session.device_id);
        return send({ type: 'ready' });
      }
      if (message.success && message.data.type === 'ping') send({ type: 'pong' });
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (heartbeat) clearInterval(heartbeat);
      unregister?.();
    });
    socket.on('error', () => socket.terminate());
  });
}
