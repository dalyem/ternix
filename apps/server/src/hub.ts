import type { WsServerMessage } from '@ternix/core/protocol';

/** The slice of a WebSocket the hub needs; `ws`'s `WebSocket` satisfies it. */
export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

const WS_OPEN = 1;

interface Entry {
  socket: HubSocket;
  userId: string;
  deviceId: string;
}

/** Tracks authenticated sockets and fans events out to users and devices. */
export class Hub {
  private readonly byUser = new Map<string, Set<Entry>>();
  private readonly byDevice = new Map<string, Set<Entry>>();

  add(socket: HubSocket, userId: string, deviceId: string): () => void {
    const entry: Entry = { socket, userId, deviceId };
    addTo(this.byUser, userId, entry);
    addTo(this.byDevice, deviceId, entry);
    return () => {
      removeFrom(this.byUser, userId, entry);
      removeFrom(this.byDevice, deviceId, entry);
    };
  }

  get size(): number {
    let n = 0;
    for (const set of this.byUser.values()) n += set.size;
    return n;
  }

  /** Send to every connected device of each user. */
  notifyUsers(userIds: Iterable<string>, message: WsServerMessage): void {
    const payload = JSON.stringify(message);
    for (const userId of new Set(userIds)) {
      for (const entry of this.byUser.get(userId) ?? []) safeSend(entry.socket, payload);
    }
  }

  /** Tell these devices their session is gone, then close their sockets. */
  revokeDevices(deviceIds: Iterable<string>): void {
    const payload = JSON.stringify({ type: 'session.revoked' } satisfies WsServerMessage);
    for (const deviceId of new Set(deviceIds)) {
      for (const entry of [...(this.byDevice.get(deviceId) ?? [])]) {
        safeSend(entry.socket, payload);
        safeClose(entry.socket, 1008, 'session revoked');
      }
    }
  }

  revokeUser(userId: string): void {
    const ids = [...(this.byUser.get(userId) ?? [])].map((entry) => entry.deviceId);
    this.revokeDevices(ids);
  }

  closeAll(code = 1001, reason = 'server shutting down'): void {
    for (const set of this.byUser.values()) {
      for (const entry of [...set]) safeClose(entry.socket, code, reason);
    }
  }
}

function addTo(map: Map<string, Set<Entry>>, key: string, entry: Entry): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(entry);
}

function removeFrom(map: Map<string, Set<Entry>>, key: string, entry: Entry): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) map.delete(key);
}

function safeSend(socket: HubSocket, payload: string): void {
  if (socket.readyState !== WS_OPEN) return;
  try {
    socket.send(payload);
  } catch {
    // A socket that cannot be written to is closing; its close handler removes it.
  }
}

function safeClose(socket: HubSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
}
