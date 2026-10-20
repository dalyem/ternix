import { createConnection, createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSocksRequest, serveSocks5 } from '../src/index.js';
import type { SocksConnector } from '../src/index.js';

const connectRequest = (atyp: number, addr: number[], port: number): Buffer =>
  Buffer.from([5, 1, 0, atyp, ...addr, port >> 8, port & 0xff]);

describe('parseSocksRequest', () => {
  it('parses an IPv4 CONNECT', () => {
    expect(parseSocksRequest(connectRequest(1, [10, 1, 2, 3], 8080))).toMatchObject({
      state: 'ok',
      request: { host: '10.1.2.3', port: 8080 },
    });
  });

  it('parses a domain CONNECT', () => {
    const name = Buffer.from('db.internal');
    const result = parseSocksRequest(connectRequest(3, [name.length, ...name], 5432));
    expect(result).toMatchObject({ state: 'ok', request: { host: 'db.internal', port: 5432 } });
  });

  it('parses an IPv6 CONNECT', () => {
    const addr = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    expect(parseSocksRequest(connectRequest(4, addr, 443))).toMatchObject({
      state: 'ok',
      request: { host: '2001:db8:0:0:0:0:0:1', port: 443 },
    });
  });

  it('keeps bytes that follow the request', () => {
    const buf = Buffer.concat([connectRequest(1, [1, 2, 3, 4], 80), Buffer.from('GET /')]);
    const result = parseSocksRequest(buf);
    expect(result.state === 'ok' && result.request.rest.toString()).toBe('GET /');
  });

  it('waits for the rest of a partial request', () => {
    const full = connectRequest(1, [1, 2, 3, 4], 80);
    for (let n = 0; n < full.length; n += 1) {
      expect(parseSocksRequest(full.subarray(0, n)).state).toBe('need-more');
    }
  });

  it('rejects other commands and address types with the matching reply code', () => {
    expect(parseSocksRequest(Buffer.from([5, 2, 0, 1, 1, 1, 1, 1, 0, 80]))).toEqual({
      state: 'error',
      reply: 7,
    });
    expect(parseSocksRequest(Buffer.from([5, 3, 0, 1, 1, 1, 1, 1, 0, 80]))).toEqual({
      state: 'error',
      reply: 7,
    });
    expect(parseSocksRequest(Buffer.from([5, 1, 0, 9, 1, 1, 1, 1, 0, 80]))).toEqual({
      state: 'error',
      reply: 8,
    });
    expect(parseSocksRequest(Buffer.from([4, 1, 0, 1, 1, 1, 1, 1, 0, 80]))).toEqual({
      state: 'error',
      reply: 1,
    });
  });
});

describe('serveSocks5', () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  /** A SOCKS5 listener whose outbound side is `connector`; returns a client-side socket. */
  async function start(connector: SocksConnector): Promise<Socket> {
    const server = createServer((socket) => serveSocks5(socket, connector));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => server.close());
    const client = createConnection((server.address() as AddressInfo).port, '127.0.0.1');
    closers.push(() => client.destroy());
    await new Promise<void>((resolve) => client.once('connect', resolve));
    return client;
  }

  const next = (socket: Socket, bytes: number): Promise<Buffer> =>
    new Promise((resolve) => {
      let got = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        got = Buffer.concat([got, chunk]);
        if (got.length >= bytes) {
          socket.off('data', onData);
          resolve(got);
        }
      };
      socket.on('data', onData);
    });

  it('negotiates no-auth, connects, and carries bytes both ways', async () => {
    const seen: string[] = [];
    const client = await start(async (host, port) => {
      seen.push(`${host}:${port}`);
      return new PassThrough(); // echoes
    });
    client.write(Buffer.from([5, 2, 2, 0]));
    expect([...(await next(client, 2))]).toEqual([5, 0]);
    const name = Buffer.from('svc.local');
    client.write(connectRequest(3, [name.length, ...name], 9000));
    const reply = await next(client, 10);
    expect([...reply.subarray(0, 2)]).toEqual([5, 0]);
    client.write('ping');
    expect((await next(client, 4)).toString()).toBe('ping');
    expect(seen).toEqual(['svc.local:9000']);
  });

  it('accepts the greeting and request in one packet and forwards early payload bytes', async () => {
    const client = await start(async () => new PassThrough());
    client.write(
      Buffer.concat([
        Buffer.from([5, 1, 0]),
        connectRequest(1, [127, 0, 0, 1], 7),
        Buffer.from('early'),
      ]),
    );
    const all = await next(client, 2 + 10 + 5);
    expect([...all.subarray(0, 2)]).toEqual([5, 0]);
    expect(all.subarray(12).toString()).toBe('early');
  });

  it('refuses a client that offers no acceptable method', async () => {
    const client = await start(async () => new PassThrough());
    client.write(Buffer.from([5, 1, 2]));
    expect([...(await next(client, 2))]).toEqual([5, 0xff]);
  });

  it('answers a failed connect with a failure reply and closes', async () => {
    const client = await start(async () => {
      throw new Error('connection refused');
    });
    client.write(Buffer.from([5, 1, 0]));
    await next(client, 2);
    client.write(connectRequest(1, [127, 0, 0, 1], 1));
    const reply = await next(client, 10);
    expect(reply[0]).toBe(5);
    expect(reply[1]).toBe(5);
    await new Promise((resolve) => client.once('close', resolve));
  });

  it('answers a command it does not support', async () => {
    const client = await start(async () => new PassThrough());
    client.write(Buffer.from([5, 1, 0]));
    await next(client, 2);
    client.write(Buffer.from([5, 2, 0, 1, 1, 2, 3, 4, 0, 80]));
    expect((await next(client, 10))[1]).toBe(7);
  });
});
