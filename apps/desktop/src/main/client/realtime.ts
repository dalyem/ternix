import WebSocket from 'ws';
import {
  WS_AUTH_TIMEOUT_MS,
  WS_CLOSE_UNAUTHORIZED,
  WS_PING_INTERVAL_MS,
  type WsClientMessage,
  wsServerMessageSchema,
} from '@ternix/core/protocol';
import type { ConnectionState } from '../../shared/types.js';

/** The slice of a WebSocket the realtime client drives. */
export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Drop the connection without a close handshake (dead peer). */
  terminate(): void;
}

export interface RealtimeSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number): void;
  onError(err: unknown): void;
}

/** Opens a socket and wires its events; injectable so tests and Electron can supply their own. */
export type WebSocketFactory = (url: string, handlers: RealtimeSocketHandlers) => RealtimeSocket;

/** Default factory over the `ws` package. */
export const wsSocketFactory: WebSocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.on('open', () => handlers.onOpen());
  ws.on('message', (data, isBinary) => {
    if (!isBinary) handlers.onMessage(data.toString());
  });
  ws.on('close', (code) => handlers.onClose(code));
  ws.on('error', (err) => handlers.onError(err));
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  };
};

export interface RealtimeOptions {
  /** How often to send `ping` (protocol: 30 s). */
  pingIntervalMs?: number;
  /** A ping with no answer within this long marks the connection dead. */
  pongTimeoutMs?: number;
  /** How long to wait for `ready` after sending `auth`. */
  authTimeoutMs?: number;
  /** First reconnect delay; doubles per failure up to `reconnectMaxMs`, with jitter. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Source of jitter, `Math.random` by default. */
  random?: () => number;
}

export interface RealtimeCallbacks {
  getToken(): string | null;
  onConnection(state: ConnectionState): void;
  /** Authenticated (first connect or reconnect): time for a full catch-up pull. */
  onReady(): void;
  onVaultChanged(vaultId: string): void;
  onVaultsChanged(): void;
  /** `session.revoked`, or the server refused the token (close code 4401). */
  onRevoked(): void;
}

/**
 * Keeps one authenticated WebSocket open: `auth` first, `ready`, ping/pong liveness, and
 * reconnects with jittered exponential backoff. Events are hints; the callbacks pull.
 */
export class Realtime {
  private socket: RealtimeSocket | null = null;
  private stopped = true;
  private failures = 0;
  private state: ConnectionState = 'offline';
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly opts: Required<RealtimeOptions>;

  constructor(
    private readonly url: string,
    private readonly factory: WebSocketFactory,
    private readonly callbacks: RealtimeCallbacks,
    options: RealtimeOptions = {},
  ) {
    this.opts = {
      pingIntervalMs: options.pingIntervalMs ?? WS_PING_INTERVAL_MS,
      pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
      authTimeoutMs: options.authTimeoutMs ?? WS_AUTH_TIMEOUT_MS,
      reconnectBaseMs: options.reconnectBaseMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 60_000,
      random: options.random ?? Math.random,
    };
  }

  get connection(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.failures = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.clearConnectionTimers();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, 'client closing');
    } catch {
      socket?.terminate();
    }
    this.setState('offline');
  }

  /** Drop the current connection and reconnect now (for example after the network returns). */
  reconnectNow(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    this.clearConnectionTimers();
    socket?.terminate();
    this.failures = 0;
    this.connect();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onConnection(state);
  }

  private clearConnectionTimers(): void {
    clearTimeout(this.authTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.authTimer = this.pingTimer = this.pongTimer = undefined;
  }

  private send(socket: RealtimeSocket, message: WsClientMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      socket.terminate();
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const token = this.callbacks.getToken();
    if (!token) return this.stop();
    this.setState('connecting');

    let socket: RealtimeSocket | null = null;
    const current = () => socket !== null && this.socket === socket;
    try {
      socket = this.factory(this.url, {
        onOpen: () => {
          if (!current()) return;
          this.send(socket!, { type: 'auth', token });
          this.authTimer = setTimeout(() => socket!.terminate(), this.opts.authTimeoutMs);
        },
        onMessage: (data) => {
          if (current()) this.handleMessage(socket!, data);
        },
        onClose: (code) => {
          if (!current()) return;
          this.socket = null;
          this.clearConnectionTimers();
          if (this.stopped) return;
          if (code === WS_CLOSE_UNAUTHORIZED) return this.revoked();
          this.scheduleReconnect();
        },
        onError: () => {
          // A close event follows every error.
        },
      });
      this.socket = socket;
    } catch {
      this.scheduleReconnect();
    }
  }

  private handleMessage(socket: RealtimeSocket, data: string): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = wsServerMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case 'ready':
        clearTimeout(this.authTimer);
        this.failures = 0;
        this.startPing(socket);
        this.setState('online');
        this.callbacks.onReady();
        return;
      case 'pong':
        clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        return;
      case 'vault.changed':
        this.callbacks.onVaultChanged(message.vault_id);
        return;
      case 'vaults.changed':
        this.callbacks.onVaultsChanged();
        return;
      case 'session.revoked':
        this.revoked();
        return;
    }
  }

  private startPing(socket: RealtimeSocket): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      // Still waiting for the previous pong: the pong timer handles it.
      if (this.pongTimer !== undefined) return;
      this.send(socket, { type: 'ping' });
      this.pongTimer = setTimeout(() => socket.terminate(), this.opts.pongTimeoutMs);
    }, this.opts.pingIntervalMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setState('offline');
    const ceiling = Math.min(
      this.opts.reconnectMaxMs,
      this.opts.reconnectBaseMs * 2 ** Math.min(this.failures, 30),
    );
    this.failures += 1;
    // "Equal jitter": half fixed, half random, so clients that lost the server together spread out.
    const delay = ceiling / 2 + this.opts.random() * (ceiling / 2);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private revoked(): void {
    this.stop();
    this.callbacks.onRevoked();
  }
}
