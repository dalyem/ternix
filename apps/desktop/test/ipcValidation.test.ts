import { describe, expect, it, vi } from 'vitest';
import type { RpcMethodName } from '../src/shared/ipc.js';
import { createDispatcher, type Handlers } from '../src/main/ipc/dispatch.js';
import { createHandlers, type HandlerDeps } from '../src/main/ipc/handlers.js';
import { rpcSchemas } from '../src/main/ipc/schemas.js';
import { AppError } from '../src/main/app/errors.js';

const uuid = '3f1c9a52-8e6b-4d0a-9b7e-0a1b2c3d4e5f';
const otherUuid = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const now = new Date().toISOString();

function setup() {
  const handlers = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get(target, key: string) {
      return (target[key] ??= vi.fn(async () => 'handled'));
    },
    has: (_target, key) => typeof key === 'string' && key in rpcSchemas,
    ownKeys: () => Object.keys(rpcSchemas),
    getOwnPropertyDescriptor: (target, key) =>
      typeof key === 'string' && key in rpcSchemas
        ? { enumerable: true, configurable: true, value: target[key] }
        : undefined,
  });
  const dispatch = createDispatcher(rpcSchemas, handlers as unknown as Handlers);
  return { dispatch, handlers };
}

async function rejected(method: unknown, arg: unknown) {
  const { dispatch, handlers } = setup();
  const result = await dispatch(method, arg);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('invalid_input');
  for (const key of Object.keys(rpcSchemas)) {
    expect((handlers[key] as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  }
  return result;
}

describe('rpc dispatch', () => {
  it('has a schema and a handler for every method', () => {
    const handlers = createHandlers({} as HandlerDeps);
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(rpcSchemas).sort());
  });

  it('refuses unknown methods, including inherited property names', async () => {
    for (const method of [
      'nope',
      '',
      '__proto__',
      'constructor',
      'toString',
      42,
      null,
      undefined,
    ]) {
      await rejected(method, undefined);
    }
  });

  it('passes parsed arguments to the handler and returns its value', async () => {
    const { dispatch, handlers } = setup();
    const result = await dispatch('vaults.rename', { vaultId: uuid, name: '  Work  ' });
    expect(result).toEqual({ ok: true, value: 'handled' });
    expect(handlers['vaults.rename']).toHaveBeenCalledWith({ vaultId: uuid, name: 'Work' });
  });

  it('turns handler errors into error results that keep their code', async () => {
    const { dispatch, handlers } = setup();
    handlers['auth.unlock']!.mockRejectedValueOnce(new AppError('wrong_password', 'Nope'));
    const result = await dispatch('auth.unlock', { password: 'x' });
    expect(result).toEqual({
      ok: false,
      error: { name: 'AppError', code: 'wrong_password', message: 'Nope' },
    });
  });

  it('rejects arguments for methods that take none', async () => {
    await rejected('auth.lock', {});
    await rejected('vaults.list', 'x');
  });

  it('rejects non-objects, arrays and unknown properties', async () => {
    await rejected('server.probe', undefined);
    await rejected('server.probe', null);
    await rejected('server.probe', 'https://x');
    await rejected('server.probe', ['https://x']);
    await rejected('server.probe', { address: 'a', extra: true });
    await rejected('server.probe', { address: 'a', __proto__: { x: 1 }, constructor: 1 });
  });

  it('rejects wrong types, empty and oversized strings', async () => {
    await rejected('server.probe', { address: 5 });
    await rejected('server.probe', { address: '' });
    await rejected('server.probe', { address: 'a'.repeat(5000) });
    await rejected('auth.unlock', { password: '' });
    await rejected('auth.unlock', { password: 'p'.repeat(2000) });
    await rejected('clipboard.write', { text: 'x'.repeat(1_000_001) });
    await rejected('ssh.write', { id: uuid, data: 'x'.repeat(1_000_001) });
  });

  it('rejects IDs that are not v4 UUIDs', async () => {
    await rejected('vaults.delete', { vaultId: 'abc' });
    await rejected('vaults.delete', { vaultId: uuid.toUpperCase() });
    await rejected('items.delete', { vaultId: uuid, itemId: '../../etc/passwd' });
    await rejected('ssh.close', { id: uuid + 'x' });
  });

  it('rejects roles outside owner/editor/viewer', async () => {
    await rejected('vaults.changeRole', { vaultId: uuid, userId: otherUuid, role: 'root' });
    await rejected('vaults.addMember', {
      vaultId: uuid,
      userId: otherUuid,
      role: 'admin',
      expectedPublicKey: 'k',
    });
  });

  it('bounds terminal sizes and prompt answers', async () => {
    await rejected('ssh.open', { hostId: uuid, cols: 0, rows: 24 });
    await rejected('ssh.open', { hostId: uuid, cols: 80, rows: 100000 });
    await rejected('ssh.open', { hostId: uuid, cols: 80.5, rows: 24 });
    await rejected('ssh.resize', { id: uuid, cols: -1, rows: 24 });
    await rejected('ssh.answerHostKey', { promptId: uuid, decision: 'maybe' });
    await rejected('ssh.answerKeyboard', { promptId: uuid, answers: 'secret' });
    await rejected('ssh.answerKeyboard', { promptId: uuid, answers: Array(33).fill('a') });
  });

  it('only opens http(s) links', async () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'smb://host/share',
      'https://a b',
    ]) {
      await rejected('shell.openLink', { url });
    }
    const { dispatch } = setup();
    expect((await dispatch('shell.openLink', { url: 'https://example.com/a?b=1' })).ok).toBe(true);
  });

  it('validates settings patches', async () => {
    await rejected('settings.set', { autoLockMinutes: -1 });
    await rejected('settings.set', { autoLockMinutes: 1.5 });
    await rejected('settings.set', { terminalFontSize: 2 });
    await rejected('settings.set', { somethingElse: 1 });
    const { dispatch } = setup();
    expect((await dispatch('settings.set', { terminalFontSize: 16 })).ok).toBe(true);
    expect((await dispatch('settings.set', {})).ok).toBe(true);
  });

  describe('item drafts', () => {
    const host = { type: 'host', label: 'web', address: 'web.example.com' };

    it('accepts a valid host and applies defaults', async () => {
      const { dispatch, handlers } = setup();
      const result = await dispatch('items.put', { vaultId: uuid, draft: host });
      expect(result.ok).toBe(true);
      expect(handlers['items.put']).toHaveBeenCalledWith({
        vaultId: uuid,
        draft: expect.objectContaining({
          type: 'host',
          port: 22,
          tags: [],
          agent_forwarding: false,
          schema: 1,
        }),
      });
    });

    it('rejects unknown types, bad fields and client-supplied timestamps being trusted', async () => {
      await rejected('items.put', { vaultId: uuid, draft: { type: 'script', label: 'x' } });
      await rejected('items.put', { vaultId: uuid, draft: { ...host, port: 70000 } });
      await rejected('items.put', { vaultId: uuid, draft: { ...host, address: '' } });
      await rejected('items.put', { vaultId: uuid, draft: { ...host, group_id: 'nope' } });
      await rejected('items.put', { vaultId: uuid, draft: { ...host, tags: [''] } });
      await rejected('items.put', { vaultId: uuid, draft: 'host' });
      await rejected('items.put', { vaultId: uuid, draft: null });
      await rejected('items.put', {
        vaultId: uuid,
        draft: {
          type: 'known_host',
          host: 'h',
          port: 22,
          key_type: 'ssh-ed25519',
          public_key: '!!',
        },
      });
    });

    it('drops updated_at: the client stamps it at write time', async () => {
      const { dispatch, handlers } = setup();
      await dispatch('items.put', { vaultId: uuid, draft: { ...host, updated_at: now } });
      const call = handlers['items.put']!.mock.calls[0]![0] as { draft: Record<string, unknown> };
      expect(call.draft).not.toHaveProperty('updated_at');
    });
  });

  it('accepts the shapes the UI sends', async () => {
    const { dispatch } = setup();
    const calls: [RpcMethodName, unknown][] = [
      ['auth.login', { serverUrl: 'ternix.example.com', email: 'a@b.co', password: 'pw' }],
      [
        'auth.register',
        { serverUrl: 'x.example', email: 'a@b.co', name: 'A', password: 'pw', inviteCode: 'abc' },
      ],
      ['admin.invites.create', { email: 'a@b.co', expiresInHours: 72 }],
      ['admin.invites.create', {}],
      ['ssh.open', { hostId: uuid, cols: 120, rows: 40 }],
      ['ssh.quickConnect', { target: 'root@10.0.0.1:2222', cols: 80, rows: 24 }],
      ['ssh.answerKeyboard', { promptId: uuid, answers: null }],
      ['ssh.answerHostKey', { promptId: uuid, decision: 'trust' }],
      ['ssh.forward.start', { id: uuid, forwardId: otherUuid }],
    ];
    for (const [method, arg] of calls) {
      const result = await dispatch(method, arg);
      expect(result, method).toEqual({ ok: true, value: 'handled' });
    }
  });
});
