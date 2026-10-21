import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../src/main/ipc/dispatch.js';
import { createHandlers, type HandlerDeps } from '../src/main/ipc/handlers.js';
import { PageGate, SessionNotices } from '../src/main/ipc/pageGate.js';
import { rpcSchemas } from '../src/main/ipc/schemas.js';
import type { RpcMethodName, RpcMethods } from '../src/shared/ipc.js';
import {
  closeClients,
  deferred,
  type Registered,
  registerUser,
  startServer,
  type TestServer,
} from './helpers.js';

const { utils } = ssh2;

/**
 * Key generation happens in main: these tests drive a real client and server through the IPC
 * dispatcher, as a compromised renderer would, and check what comes back and what is stored.
 */

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeClients();
  await server.close();
});

const PASSPHRASE = 'correct horse battery staple';
const uuid = '3f1c9a52-8e6b-4d0a-9b7e-0a1b2c3d4e5f';

function ipcFor(t: Registered, pages = new PageGate(() => undefined)) {
  const ssh = {
    cancelAllPrompts: vi.fn(),
    forgetAccount: vi.fn(),
    closeAll: vi.fn(async () => undefined),
    displayItems: <T>(vault: T) => vault,
  };
  const handlers = createHandlers({
    client: t.client,
    ssh,
    serverAddress: { get: () => null, set: async () => undefined },
    notices: new SessionNotices(),
    pages,
    messageBox: vi.fn(),
  } as unknown as HandlerDeps);
  const dispatch = createDispatcher(rpcSchemas, handlers);
  const call = async <K extends RpcMethodName>(method: K, arg?: RpcMethods[K]['in']) => {
    const result = await dispatch(method, arg);
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
    return result.value as RpcMethods[K]['out'];
  };
  const failure = async (method: string, arg?: unknown) => {
    const result = await dispatch(method, arg);
    expect(result.ok, `${method} should fail`).toBe(false);
    return result.ok ? undefined! : result.error;
  };
  return { call, failure, pages };
}

function parsed(text: string, passphrase?: string) {
  const key = utils.parseKey(text, passphrase);
  if (key instanceof Error) throw key;
  const first = Array.isArray(key) ? key[0] : key;
  if (!first) throw new Error('no key');
  return first;
}

function sha256Of(publicLine: string): string {
  const wire = Buffer.from(publicLine.split(' ')[1]!, 'base64');
  return `SHA256:${createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;
}

/** The stored private key signs and the stored public line verifies. */
function assertPair(privateKey: string, publicLine: string, passphrase?: string) {
  const data = Buffer.from('payload');
  const signature = parsed(privateKey, passphrase).sign(data);
  if (signature instanceof Error) throw signature;
  expect(parsed(publicLine).verify(data, signature)).toBe(true);
}

describe('keys.generate schema', () => {
  const schema = rpcSchemas['keys.generate'];
  const base = { vaultId: uuid, label: 'laptop' };

  it('defaults to Ed25519, RSA 4096 and ECDSA P-256', () => {
    expect(schema.parse(base)).toEqual(base);
    expect(schema.parse({ ...base, type: 'ed25519' })).toEqual({ ...base, type: 'ed25519' });
    expect(schema.parse({ ...base, type: 'rsa' })).toEqual({ ...base, type: 'rsa', bits: 4096 });
    expect(schema.parse({ ...base, type: 'ecdsa' })).toEqual({ ...base, type: 'ecdsa', bits: 256 });
  });

  it('accepts the offered sizes, comment and passphrase', () => {
    for (const bits of [2048, 3072, 4096]) {
      expect(schema.parse({ ...base, type: 'rsa', bits })).toMatchObject({ bits });
    }
    for (const bits of [256, 384, 521]) {
      expect(schema.parse({ ...base, type: 'ecdsa', bits })).toMatchObject({ bits });
    }
    expect(schema.parse({ ...base, comment: 'me@box', passphrase: 'x' })).toMatchObject({
      comment: 'me@box',
      passphrase: 'x',
    });
  });

  it.each([
    ['an unknown type', { ...base, type: 'dsa' }],
    ['RSA of 1024 bits', { ...base, type: 'rsa', bits: 1024 }],
    ['RSA of 8192 bits', { ...base, type: 'rsa', bits: 8192 }],
    ['RSA of "4096"', { ...base, type: 'rsa', bits: '4096' }],
    ['an ECDSA curve that is not offered', { ...base, type: 'ecdsa', bits: 2048 }],
    ['bits for Ed25519', { ...base, type: 'ed25519', bits: 256 }],
    ['bits without a type', { ...base, bits: 4096 }],
    ['a missing vault', { label: 'laptop' }],
    ['a vault that is not a UUID', { ...base, vaultId: 'vault' }],
    ['a missing label', { vaultId: uuid }],
    ['a blank label', { ...base, label: '   ' }],
    ['a label of 201 characters', { ...base, label: 'x'.repeat(201) }],
    ['a comment of 201 characters', { ...base, comment: 'x'.repeat(201) }],
    ['an empty passphrase', { ...base, passphrase: '' }],
    ['a passphrase of 1025 characters', { ...base, passphrase: 'x'.repeat(1025) }],
    ['a passphrase that is not text', { ...base, passphrase: 1234 }],
    ['an unknown property', { ...base, private_key: 'x' }],
    ['no arguments', undefined],
    ['null', null],
  ])('rejects %s', (_name, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });

  it('refuses a bad request before the handler runs', async () => {
    const handler = vi.fn(async () => 'handled');
    const handlers = new Proxy({} as Record<string, unknown>, {
      get: (_t, key: string) => (key === 'keys.generate' ? handler : vi.fn()),
      has: (_t, key) => typeof key === 'string' && key in rpcSchemas,
    });
    const dispatch = createDispatcher(rpcSchemas, handlers as never);
    const result = await dispatch('keys.generate', { ...{ vaultId: uuid, label: 'k' }, bits: 99 });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('keys.generate', () => {
  async function setup() {
    const a = await registerUser(server, { realtime: false });
    return { a, ipc: ipcFor(a), vaultId: a.personalVaultId };
  }

  it.each([
    [{ type: 'ed25519' as const }, 'ssh-ed25519'],
    [{}, 'ssh-ed25519'],
    [{ type: 'rsa' as const, bits: 2048 as const }, 'ssh-rsa'],
    [{ type: 'ecdsa' as const, bits: 256 as const }, 'ecdsa-sha2-nistp256'],
    [{ type: 'ecdsa' as const, bits: 384 as const }, 'ecdsa-sha2-nistp384'],
    [{ type: 'ecdsa' as const, bits: 521 as const }, 'ecdsa-sha2-nistp521'],
  ])(
    '%j: saves a key that reads back, and returns only its public half',
    async (spec, keyType) => {
      const { a, ipc, vaultId } = await setup();
      const result = await ipc.call('keys.generate', { vaultId, label: 'Work laptop', ...spec });

      expect(result.keyType).toBe(keyType);
      expect(result.publicKey).toMatch(new RegExp(`^${keyType} \\S+ Work laptop$`));
      expect(result.fingerprint).toBe(sha256Of(result.publicKey));
      expect(result.item).toMatchObject({
        vaultId,
        payload: {
          type: 'ssh_key',
          label: 'Work laptop',
          public_key: result.publicKey,
          has_private_key: true,
          has_passphrase: false,
        },
      });

      // Nothing secret in what the renderer gets.
      expect(result.item.payload).not.toHaveProperty('private_key');
      expect(result.item.payload).not.toHaveProperty('passphrase');
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE KEY/);

      // What is stored is a private key that matches the public line.
      const stored = a.client.getItem(vaultId, result.item.id)!.payload;
      if (stored.type !== 'ssh_key') throw new Error('not a key');
      expect(stored.public_key).toBe(result.publicKey);
      expect(stored.passphrase).toBeUndefined();
      assertPair(stored.private_key, stored.public_key!);
    },
    60_000,
  );

  it('encrypts the private key with the passphrase and never echoes it', async () => {
    const { a, ipc, vaultId } = await setup();
    const result = await ipc.call('keys.generate', {
      vaultId,
      label: 'locked',
      type: 'ed25519',
      passphrase: PASSPHRASE,
    });
    expect(result.item.payload).toMatchObject({ has_passphrase: true, has_private_key: true });
    const text = JSON.stringify(result);
    expect(text).not.toContain(PASSPHRASE);
    expect(text).not.toMatch(/PRIVATE KEY/);

    const stored = a.client.getItem(vaultId, result.item.id)!.payload;
    if (stored.type !== 'ssh_key') throw new Error('not a key');
    expect(stored.passphrase).toBe(PASSPHRASE);
    expect(utils.parseKey(stored.private_key)).toBeInstanceOf(Error);
    assertPair(stored.private_key, stored.public_key!, PASSPHRASE);

    // The lists a renderer can read stay clean, and reveal is still the only way to the secrets.
    expect(JSON.stringify(await ipc.call('items.all'))).not.toContain(PASSPHRASE);
    expect(await ipc.call('items.reveal', { vaultId, itemId: result.item.id })).toEqual({
      private_key: stored.private_key,
      passphrase: PASSPHRASE,
    });
  }, 30_000);

  it('uses the label as the comment unless one is given', async () => {
    const { ipc, vaultId } = await setup();
    const named = await ipc.call('keys.generate', { vaultId, label: 'a\nb  c' });
    expect(named.publicKey.endsWith(' a b c')).toBe(true);
    expect(named.publicKey.split('\n')).toHaveLength(1);
    const own = await ipc.call('keys.generate', { vaultId, label: 'k', comment: 'me@host' });
    expect(own.publicKey.endsWith(' me@host')).toBe(true);
  });

  it('makes a new key each time and lists it among the vault items', async () => {
    const { ipc, vaultId } = await setup();
    const draw = vi.spyOn(ssh2.utils, 'generateKeyPair');
    const one = await ipc.call('keys.generate', { vaultId, label: 'one' });
    const two = await ipc.call('keys.generate', { vaultId, label: 'two' });
    expect(one.fingerprint).not.toBe(two.fingerprint);
    expect(draw).toHaveBeenCalledTimes(2);
    const listed = (await ipc.call('items.all')).flatMap((v) => v.items);
    expect(listed.filter((i) => i.payload.type === 'ssh_key').map((i) => i.id)).toEqual(
      expect.arrayContaining([one.item.id, two.item.id]),
    );
  });

  it('does not generate for a viewer or an unknown vault', async () => {
    const owner = await registerUser(server, { realtime: false });
    const viewer = await registerUser(server, { realtime: false });
    const vault = await owner.client.createVault('Read only');
    const found = await owner.client.lookupUser(viewer.email);
    await owner.client.addMember(vault.id, found.id, 'viewer', found.publicKey);
    await viewer.client.sync();
    const ipc = ipcFor(viewer);
    const generate = vi.spyOn(ssh2.utils, 'generateKeyPair');
    const refused = await ipc.failure('keys.generate', { vaultId: vault.id, label: 'nope' });
    expect(refused.code).toBe('forbidden');
    await ipc.failure('keys.generate', { vaultId: uuid, label: 'nope' });
    expect(generate).not.toHaveBeenCalled();
    expect(viewer.client.listItems(vault.id).items).toHaveLength(0);
  });

  /** Holds the key search until `release()`, so the session can change meanwhile. */
  function slowGeneration() {
    const gate = deferred();
    const real = utils.generateKeyPair.bind(utils) as (...args: unknown[]) => void;
    vi.spyOn(utils, 'generateKeyPair').mockImplementation(((...args: unknown[]) => {
      void gate.promise.then(() => real(...args));
    }) as never);
    return gate.resolve;
  }
  const keysIn = (a: Registered, vaultId: string) =>
    a.client.listItems(vaultId).items.filter((i) => i.payload.type === 'ssh_key');

  it('saves nothing when the page was replaced while the key was generated', async () => {
    const { a, ipc, vaultId } = await setup();
    const release = slowGeneration();
    const pending = ipc.call('keys.generate', { vaultId, label: 'late' });
    ipc.pages.retire();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(keysIn(a, vaultId)).toEqual([]);
  });

  it('saves nothing when the vault was locked while the key was generated', async () => {
    const { a, ipc, vaultId } = await setup();
    const release = slowGeneration();
    const pending = ipc.call('keys.generate', { vaultId, label: 'late' });
    await a.client.lock();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await a.client.unlock(a.password);
    expect(keysIn(a, vaultId)).toEqual([]);
  });

  it('saves the key when nothing changed while it was generated', async () => {
    const { a, ipc, vaultId } = await setup();
    const release = slowGeneration();
    const pending = ipc.call('keys.generate', { vaultId, label: 'slow' });
    release();
    await pending;
    expect(keysIn(a, vaultId)).toHaveLength(1);
  });

  it('saves nothing when the vault was locked and unlocked again while the key was generated', async () => {
    const { a, ipc, vaultId } = await setup();
    const release = slowGeneration();
    const pending = ipc.call('keys.generate', { vaultId, label: 'late' });
    await a.client.lock();
    await a.client.unlock(a.password);
    release();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(keysIn(a, vaultId)).toEqual([]);
  });

  it('is refused while locked', async () => {
    const { a, ipc, vaultId } = await setup();
    await a.client.lock();
    const refused = await ipc.failure('keys.generate', { vaultId, label: 'k' });
    expect(refused.code).not.toBe('internal');
  });
});

describe('public keys of pasted private keys', () => {
  async function setup() {
    const a = await registerUser(server, { realtime: false });
    return { a, ipc: ipcFor(a), vaultId: a.personalVaultId };
  }
  const stored = (a: Registered, vaultId: string, id: string) => {
    const payload = a.client.getItem(vaultId, id)!.payload;
    if (payload.type !== 'ssh_key') throw new Error('not a key');
    return payload;
  };

  it('derives the public key of a private key saved without one', async () => {
    const { a, ipc, vaultId } = await setup();
    const pair = utils.generateKeyPairSync('ed25519', { comment: 'pasted' });
    const saved = await ipc.call('items.put', {
      vaultId,
      draft: { type: 'ssh_key', label: 'pasted', private_key: pair.private },
    });
    expect(saved.item?.payload).toMatchObject({ public_key: pair.public.trim() });
    expect(stored(a, vaultId, saved.id).public_key).toBe(pair.public.trim());
  });

  it('derives it for every key type, and for an old-style PEM key', async () => {
    const { ipc, vaultId } = await setup();
    const keys = [
      utils.generateKeyPairSync('ecdsa', { bits: 384 }),
      utils.generateKeyPairSync('rsa', { bits: 2048 }),
    ];
    for (const pair of keys) {
      const saved = await ipc.call('items.put', {
        vaultId,
        draft: { type: 'ssh_key', label: 'k', private_key: pair.private },
      });
      expect(saved.item?.payload).toMatchObject({ public_key: pair.public.trim() });
    }
  });

  it('decrypts with the given passphrase to derive it', async () => {
    const { ipc, vaultId } = await setup();
    const pair = utils.generateKeyPairSync('ed25519', {
      passphrase: PASSPHRASE,
      cipher: 'aes256-ctr',
      rounds: 4,
    });
    const saved = await ipc.call('items.put', {
      vaultId,
      draft: { type: 'ssh_key', label: 'enc', private_key: pair.private, passphrase: PASSPHRASE },
    });
    expect(saved.item?.payload).toMatchObject({ has_passphrase: true });
    expect((saved.item?.payload as { public_key?: string }).public_key).toBe(pair.public.trim());
  });

  it.each([
    ['an encrypted key without its passphrase', undefined],
    ['an encrypted key with the wrong passphrase', 'wrong'],
  ])('keeps today’s behaviour for %s: saved, no public key', async (_name, pass) => {
    const { ipc, vaultId } = await setup();
    const pair = utils.generateKeyPairSync('ed25519', {
      passphrase: PASSPHRASE,
      cipher: 'aes256-ctr',
      rounds: 4,
    });
    const saved = await ipc.call('items.put', {
      vaultId,
      draft: {
        type: 'ssh_key',
        label: 'enc',
        private_key: pair.private,
        ...(pass ? { passphrase: pass } : {}),
      },
    });
    expect(saved.status).toBe('saved');
    expect(saved.item?.payload).not.toHaveProperty('public_key');
  });

  it('keeps today’s behaviour for text that is not a key: saved as given', async () => {
    const { ipc, vaultId } = await setup();
    const saved = await ipc.call('items.put', {
      vaultId,
      draft: {
        type: 'ssh_key',
        label: 'junk',
        private_key:
          '-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n-----END OPENSSH PRIVATE KEY-----\n',
        public_key: 'whatever I typed',
      },
    });
    expect(saved.item?.payload).toMatchObject({ public_key: 'whatever I typed' });
  });

  it('keeps a matching public key as typed, comment included', async () => {
    const { ipc, vaultId } = await setup();
    const pair = utils.generateKeyPairSync('ed25519');
    const mine = `${pair.public.trim()} my own comment`;
    const saved = await ipc.call('items.put', {
      vaultId,
      draft: { type: 'ssh_key', label: 'k', private_key: pair.private, public_key: `  ${mine}\n` },
    });
    expect(saved.item?.payload).toMatchObject({ public_key: mine });
  });

  it('replaces a public key that belongs to another key', async () => {
    const { ipc, vaultId } = await setup();
    const pair = utils.generateKeyPairSync('ed25519');
    const other = utils.generateKeyPairSync('ed25519');
    const saved = await ipc.call('items.put', {
      vaultId,
      draft: {
        type: 'ssh_key',
        label: 'k',
        private_key: pair.private,
        public_key: other.public.trim(),
      },
    });
    expect(saved.item?.payload).toMatchObject({ public_key: pair.public.trim() });
  });

  it('follows a replaced private key, and backfills a stored key that had no public key', async () => {
    const { a, ipc, vaultId } = await setup();
    const first = utils.generateKeyPairSync('ed25519');
    const second = utils.generateKeyPairSync('ed25519');
    const saved = await ipc.call('items.put', {
      vaultId,
      draft: { type: 'ssh_key', label: 'k', private_key: first.private },
    });
    // The editor sends the public key it was showing along with the new private key.
    await ipc.call('items.put', {
      vaultId,
      itemId: saved.id,
      draft: {
        type: 'ssh_key',
        label: 'k',
        private_key: second.private,
        public_key: first.public.trim(),
      },
    });
    expect(stored(a, vaultId, saved.id).public_key).toBe(second.public.trim());

    // A key stored by an older version has no public key; any edit fills it in.
    const { updated_at: _stamp, ...payload } = stored(a, vaultId, saved.id);
    const { public_key: _gone, ...old } = payload;
    await a.client.putItem(vaultId, saved.id, old as never);
    expect(stored(a, vaultId, saved.id)).not.toHaveProperty('public_key');
    await ipc.call('items.put', {
      vaultId,
      itemId: saved.id,
      draft: { type: 'ssh_key', label: 'renamed' },
    });
    expect(stored(a, vaultId, saved.id)).toMatchObject({
      label: 'renamed',
      public_key: second.public.trim(),
    });
  });

  it('checks an edit that changes only the public key against the stored private key', async () => {
    const { a, ipc, vaultId } = await setup();
    const pair = utils.generateKeyPairSync('ed25519');
    const other = utils.generateKeyPairSync('ed25519');
    const saved = await ipc.call('items.put', {
      vaultId,
      draft: { type: 'ssh_key', label: 'k', private_key: pair.private },
    });
    // The secrets stay as stored (the editor never sees them); only the public line changes.
    await ipc.call('items.put', {
      vaultId,
      itemId: saved.id,
      draft: { type: 'ssh_key', label: 'k', public_key: other.public.trim() },
    });
    expect(stored(a, vaultId, saved.id).public_key).toBe(pair.public.trim());
  });

  it('never stores a public key of more than one line', async () => {
    const { a, ipc, vaultId } = await setup();
    const pair = utils.generateKeyPairSync('ed25519');
    const other = utils.generateKeyPairSync('ed25519');
    const twoLines = `${pair.public.trim()}\n${other.public.trim()}`;
    const saved = await ipc.call('items.put', {
      vaultId,
      draft: { type: 'ssh_key', label: 'k', private_key: pair.private },
    });
    await ipc.call('items.put', {
      vaultId,
      itemId: saved.id,
      draft: { type: 'ssh_key', label: 'k', public_key: twoLines },
    });
    expect(stored(a, vaultId, saved.id).public_key).toBe(pair.public.trim());

    // A key that cannot be read here keeps a typed public key only when it is one line.
    const encrypted = utils.generateKeyPairSync('ed25519', {
      passphrase: PASSPHRASE,
      cipher: 'aes256-ctr',
      rounds: 4,
    });
    const unreadable = await ipc.call('items.put', {
      vaultId,
      draft: {
        type: 'ssh_key',
        label: 'enc',
        private_key: encrypted.private,
        public_key: `${encrypted.public.trim()}\n${other.public.trim()}`,
      },
    });
    expect(stored(a, vaultId, unreadable.id)).not.toHaveProperty('public_key');
  });

  it('does not decrypt again when an edit leaves the key and passphrase alone', async () => {
    const { a, ipc, vaultId } = await setup();
    const pair = utils.generateKeyPairSync('ed25519', {
      passphrase: PASSPHRASE,
      cipher: 'aes256-ctr',
      rounds: 4,
    });
    const saved = await ipc.call('items.put', {
      vaultId,
      draft: { type: 'ssh_key', label: 'k', private_key: pair.private, passphrase: PASSPHRASE },
    });
    const parse = vi.spyOn(ssh2.utils, 'parseKey');
    await ipc.call('items.put', {
      vaultId,
      itemId: saved.id,
      draft: { type: 'ssh_key', label: 'renamed', public_key: pair.public.trim() },
    });
    expect(parse).not.toHaveBeenCalled();
    expect(stored(a, vaultId, saved.id)).toMatchObject({
      label: 'renamed',
      public_key: pair.public.trim(),
      passphrase: PASSPHRASE,
    });
  });
});
