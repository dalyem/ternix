import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FetchLike, probeServer } from '../src/main/client/index.js';
import { closeClients, makeClient, uniqueEmail } from './helpers.js';

interface Recorded {
  method: string;
  path: string;
  body: string;
}

async function listen(
  handler: (req: IncomingMessage, body: string) => { status: number; headers?: object },
) {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      requests.push({ method: req.method!, path: req.url!, body });
      const out = handler(req, body);
      res.writeHead(out.status, {
        'content-type': 'application/json',
        ...(out.headers as Record<string, string>),
      });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'nothing here' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let target: Awaited<ReturnType<typeof listen>>;
let redirector: Awaited<ReturnType<typeof listen>>;

beforeEach(async () => {
  // Stands in for any destination the user never entered (another host, plain http).
  target = await listen(() => ({ status: 404 }));
  redirector = await listen((req) => ({
    status: 307,
    headers: { location: target.url + req.url },
  }));
});

afterEach(async () => {
  await closeClients();
  await redirector.close();
  await target.close();
});

describe('redirects', () => {
  it('probeServer refuses a redirect and does not follow it', async () => {
    const { client } = await makeClient();
    const err = await client.probeServer(redirector.url).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unexpected_redirect' });
    expect((err as Error).message).toContain(target.url);
    expect(target.requests).toEqual([]);
  });

  it('login stops at the first redirect; nothing is resent elsewhere', async () => {
    const { client } = await makeClient({ realtime: false });
    await expect(
      client.login({ serverUrl: redirector.url, email: uniqueEmail(), password: 'secret' }),
    ).rejects.toMatchObject({ code: 'unexpected_redirect' });
    expect(target.requests).toEqual([]);
    expect(redirector.requests.map((r) => r.path)).toEqual(['/api/v1/auth/prelogin']);
    expect(client.state).toBe('loggedOut');
  });

  it('asks fetch not to follow redirects and treats an opaque redirect as one', async () => {
    const inits: (RequestInit | undefined)[] = [];
    const fetch: FetchLike = async (_input, init) => {
      inits.push(init);
      // What Electron's net.fetch and browsers return for `redirect: 'manual'`.
      return {
        type: 'opaqueredirect',
        status: 0,
        ok: false,
        headers: new Headers(),
        text: async () => '',
      } as unknown as Response;
    };
    await expect(probeServer('https://ternix.example.com', fetch)).rejects.toMatchObject({
      code: 'unexpected_redirect',
    });
    expect(inits[0]?.redirect).toBe('manual');
  });
});
