import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DerivedKeys, deriveKeys } from '@ternix/core/crypto';
import type { KdfParams } from '@ternix/core/protocol';
import type { FetchLike } from '../src/main/client/index.js';
import type { ClientState } from '../src/shared/types.js';
import {
  closeClients,
  type Deferred,
  deferred,
  makeClient,
  registerUser,
  startServer,
  storedSession,
  type TestServer,
  uniqueEmail,
} from './helpers.js';

/**
 * A `deriveKeys` the test can hold: `arm()` makes the next call wait until released, and
 * remembers the keys it returned so the test can check they were wiped.
 */
function gatedDerive() {
  let armed: { entered: Deferred; release: Deferred; keys?: DerivedKeys } | null = null;
  const gate = {
    arm() {
      const g = { entered: deferred(), release: deferred() } as {
        entered: Deferred;
        release: Deferred;
        keys?: DerivedKeys;
      };
      armed = g;
      return g;
    },
    async derive(password: string, kdf: KdfParams): Promise<DerivedKeys> {
      const g = armed;
      armed = null;
      if (!g) return deriveKeys(password, kdf);
      g.entered.resolve();
      await g.release.promise;
      g.keys = await deriveKeys(password, kdf);
      return g.keys;
    },
  };
  return gate;
}

/** Records the URL and bearer token of every request. */
function loggingFetch() {
  const log: { url: string; auth: string | undefined }[] = [];
  const fetch: FetchLike = (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    log.push({ url: input, auth: headers.authorization });
    return globalThis.fetch(input, init);
  };
  return { log, fetch };
}

const zeroed = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await closeClients();
  await server.close();
});

describe('session lifecycle races', () => {
  it('a password change started on server A never sends server B’s token to A', async () => {
    const other = await startServer();
    try {
      const onB = await registerUser(other, { realtime: false });
      await onB.client.logout();

      const gate = gatedDerive();
      const { log, fetch } = loggingFetch();
      const x = await registerUser(server, { realtime: false, deriveKeys: gate.derive, fetch });
      const held = gate.arm();
      const changing = x.client.changePassword(x.password, 'a new password');
      changing.catch(() => undefined);
      await held.entered.promise;

      await x.client.logout();
      await x.client.login({ serverUrl: other.url, email: onB.email, password: onB.password });
      const tokenB = (await storedSession(x)).token!;
      held.release.resolve();

      await expect(changing).rejects.toMatchObject({ code: 'cancelled' });
      const leaked = log.filter((r) => r.url.startsWith(server.url) && r.auth?.includes(tokenB));
      expect(leaked).toEqual([]);
      expect(log.filter((r) => r.url.endsWith('/me/password'))).toEqual([]);
      expect(held.keys && zeroed(held.keys.masterKey) && zeroed(held.keys.authKey)).toBe(true);
      // The new session is untouched.
      expect(x.client.state).toBe('unlocked');
      expect(x.client.account!.serverUrl).toBe(other.url);
    } finally {
      await closeClients();
      await other.close();
    }
  });

  it('a lock during a pending unlock wins; the derived keys are wiped', async () => {
    const gate = gatedDerive();
    const x = await registerUser(server, { realtime: false, deriveKeys: gate.derive });
    await x.client.lock();
    const states: ClientState[] = [];
    x.client.on('state', (s) => states.push(s));

    const held = gate.arm();
    const unlocking = x.client.unlock(x.password);
    unlocking.catch(() => undefined);
    await held.entered.promise;
    await x.client.lock();
    held.release.resolve();

    await expect(unlocking).rejects.toMatchObject({ code: 'cancelled' });
    expect(x.client.state).toBe('locked');
    expect(states).not.toContain('unlocked');
    expect(() => x.client.listVaults()).toThrow(expect.objectContaining({ code: 'locked' }));
    expect(zeroed(held.keys!.masterKey) && zeroed(held.keys!.authKey)).toBe(true);

    // A later unlock still works.
    await x.client.unlock(x.password);
    expect(x.client.state).toBe('unlocked');
  });

  it('a lock while the cache loads during unlock wins', async () => {
    const x = await registerUser(server, { realtime: false });
    await x.client.lock();
    const loading = deferred();
    const release = deferred();
    const get = x.cacheStore.get.bind(x.cacheStore);
    let hold = true;
    x.cacheStore.get = async (account, key) => {
      if (hold && key === 'vaults') {
        hold = false;
        loading.resolve();
        await release.promise;
      }
      return get(account, key);
    };
    const unlocking = x.client.unlock(x.password);
    unlocking.catch(() => undefined);
    await loading.promise;
    await x.client.lock();
    release.resolve();
    await expect(unlocking).rejects.toMatchObject({ code: 'cancelled' });
    expect(x.client.state).toBe('locked');
  });

  it('close during a pending login leaves the client logged out', async () => {
    const existing = await registerUser(server, { realtime: false });
    await existing.client.logout();
    const gate = gatedDerive();
    const t = await makeClient({ realtime: false, deriveKeys: gate.derive });
    const held = gate.arm();
    const loggingIn = t.client.login({
      serverUrl: server.url,
      email: existing.email,
      password: existing.password,
    });
    loggingIn.catch(() => undefined);
    await held.entered.promise;
    await t.client.close();
    held.release.resolve();

    await expect(loggingIn).rejects.toMatchObject({ code: 'cancelled' });
    expect(t.client.state).toBe('loggedOut');
    expect(t.spy.count('POST', '/auth/login')).toBe(0);
    expect(await t.secretStore.get('session')).toBeUndefined();
    expect(zeroed(held.keys!.masterKey) && zeroed(held.keys!.authKey)).toBe(true);
  });

  it('close during a pending register sends nothing', async () => {
    const gate = gatedDerive();
    const t = await makeClient({ realtime: false, deriveKeys: gate.derive });
    const held = gate.arm();
    const registering = t.client.register({
      serverUrl: server.url,
      email: uniqueEmail(),
      name: 'someone',
      password: 'a password',
    });
    registering.catch(() => undefined);
    await held.entered.promise;
    await t.client.close();
    held.release.resolve();

    await expect(registering).rejects.toMatchObject({ code: 'cancelled' });
    expect(t.client.state).toBe('loggedOut');
    expect(t.spy.count('POST', '/auth/register')).toBe(0);
  });
});
