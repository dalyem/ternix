import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** Opens the outbound side of a SOCKS CONNECT (here: an SSH direct-tcpip channel). */
export type SocksConnector = (host: string, port: number) => Promise<Duplex>;

const VERSION = 5;
const CMD_CONNECT = 1;
const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 3;
const ATYP_IPV6 = 4;
const METHOD_NO_AUTH = 0;
const METHOD_NONE_ACCEPTABLE = 0xff;

const REPLY_SUCCEEDED = 0;
const REPLY_GENERAL_FAILURE = 1;
const REPLY_NETWORK_UNREACHABLE = 3;
const REPLY_HOST_UNREACHABLE = 4;
const REPLY_CONNECTION_REFUSED = 5;
const REPLY_COMMAND_NOT_SUPPORTED = 7;
const REPLY_ADDRESS_TYPE_NOT_SUPPORTED = 8;

/** The handshake is at most 3 + 1 + 255 + 2 bytes after the greeting; anything larger is junk. */
const MAX_HANDSHAKE_BYTES = 1024;
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface SocksRequest {
  host: string;
  port: number;
  /** Bytes the client sent after the request, before it saw a reply. */
  rest: Buffer;
}

export type SocksParse =
  | { state: 'need-more' }
  | { state: 'error'; reply: number }
  | { state: 'ok'; request: SocksRequest };

function formatIPv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  return groups.join(':');
}

/** Parse the CONNECT request that follows the greeting (`buf` starts at the VER byte). */
export function parseSocksRequest(buf: Buffer): SocksParse {
  if (buf.length < 4) return { state: 'need-more' };
  if (buf[0] !== VERSION) return { state: 'error', reply: REPLY_GENERAL_FAILURE };
  if (buf[1] !== CMD_CONNECT) return { state: 'error', reply: REPLY_COMMAND_NOT_SUPPORTED };
  const atyp = buf[3];
  let host: string;
  let offset: number;
  switch (atyp) {
    case ATYP_IPV4:
      if (buf.length < 4 + 4 + 2) return { state: 'need-more' };
      host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      offset = 8;
      break;
    case ATYP_DOMAIN: {
      if (buf.length < 5) return { state: 'need-more' };
      const length = buf[4] ?? 0;
      if (buf.length < 5 + length + 2) return { state: 'need-more' };
      host = buf.subarray(5, 5 + length).toString('utf8');
      offset = 5 + length;
      break;
    }
    case ATYP_IPV6:
      if (buf.length < 4 + 16 + 2) return { state: 'need-more' };
      host = formatIPv6(buf.subarray(4, 20));
      offset = 20;
      break;
    default:
      return { state: 'error', reply: REPLY_ADDRESS_TYPE_NOT_SUPPORTED };
  }
  if (host === '') return { state: 'error', reply: REPLY_GENERAL_FAILURE };
  const port = buf.readUInt16BE(offset);
  return { state: 'ok', request: { host, port, rest: buf.subarray(offset + 2) } };
}

function reply(code: number): Buffer {
  // VER REP RSV ATYP(IPv4) BND.ADDR(0.0.0.0) BND.PORT(0)
  return Buffer.from([VERSION, code, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

function replyForError(err: unknown): number {
  const text = err instanceof Error ? err.message.toLowerCase() : '';
  if (text.includes('refused')) return REPLY_CONNECTION_REFUSED;
  if (text.includes('network is unreachable') || text.includes('enetunreach')) {
    return REPLY_NETWORK_UNREACHABLE;
  }
  if (text.includes('unreachable') || text.includes('timed out') || text.includes('no route')) {
    return REPLY_HOST_UNREACHABLE;
  }
  return REPLY_GENERAL_FAILURE;
}

export function bridge(a: Duplex, b: Duplex): void {
  a.pipe(b);
  b.pipe(a);
  const teardown = () => {
    a.destroy();
    b.destroy();
  };
  for (const stream of [a, b]) {
    stream.on('error', teardown);
    stream.on('close', teardown);
  }
}

/**
 * Serve one SOCKS5 client on an accepted socket: no authentication, CONNECT only, IPv4, IPv6 and
 * domain addresses. `connect` supplies the outbound stream; the bytes are then bridged both ways.
 */
export function serveSocks5(socket: Socket, connect: SocksConnector): void {
  let buf = Buffer.alloc(0);
  let stage: 'greeting' | 'request' | 'connecting' = 'greeting';

  socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
  socket.on('error', () => socket.destroy());

  const fail = (code: number) => {
    socket.end(reply(code));
  };

  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_HANDSHAKE_BYTES) return socket.destroy();

    if (stage === 'greeting') {
      if (buf.length < 2) return;
      const count = buf[1] ?? 0;
      if (buf.length < 2 + count) return;
      if (buf[0] !== VERSION) return socket.destroy();
      const offersNoAuth = buf.subarray(2, 2 + count).includes(METHOD_NO_AUTH);
      if (!offersNoAuth) return void socket.end(Buffer.from([VERSION, METHOD_NONE_ACCEPTABLE]));
      socket.write(Buffer.from([VERSION, METHOD_NO_AUTH]));
      buf = buf.subarray(2 + count);
      stage = 'request';
    }

    if (stage === 'request') {
      const parsed = parseSocksRequest(buf);
      if (parsed.state === 'need-more') return;
      if (parsed.state === 'error') return fail(parsed.reply);
      stage = 'connecting';
      socket.off('data', onData);
      socket.pause();
      socket.setTimeout(0);
      const { host, port, rest } = parsed.request;
      connect(host, port).then(
        (upstream) => {
          if (socket.destroyed) return void upstream.destroy();
          socket.write(reply(REPLY_SUCCEEDED));
          if (rest.length > 0) upstream.write(rest);
          bridge(socket, upstream);
        },
        (err: unknown) => {
          if (!socket.destroyed) fail(replyForError(err));
        },
      );
    }
  };

  socket.on('data', onData);
}
