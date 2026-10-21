import { describe, expect, it, vi } from 'vitest';
import { createDispatcher, type Handlers } from '../src/main/ipc/dispatch.js';
import { rpcSchemas, sftpDropSchema } from '../src/main/ipc/schemas.js';

const uuid = '3f1c9a52-8e6b-4d0a-9b7e-0a1b2c3d4e5f';

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
  return { dispatch: createDispatcher(rpcSchemas, handlers as unknown as Handlers), handlers };
}

async function refused(method: string, arg: unknown) {
  const { dispatch, handlers } = setup();
  const result = await dispatch(method, arg);
  expect(result.ok, `${method} ${JSON.stringify(arg)}`).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('invalid_input');
  expect(handlers[method]!.mock.calls).toHaveLength(0);
}

async function accepted(method: string, arg: unknown) {
  const { dispatch } = setup();
  const result = await dispatch(method, arg);
  expect(result, `${method} ${JSON.stringify(arg)}`).toEqual({ ok: true, value: 'handled' });
}

describe('SFTP requests from the renderer', () => {
  it('accept well-formed remote operations', async () => {
    await accepted('sftp.open', { hostId: uuid });
    await accepted('sftp.readdir', { id: uuid, path: '~/projects' });
    await accepted('sftp.readdir', { id: uuid, path: '/srv/www' });
    await accepted('sftp.mkdir', { id: uuid, path: '/srv/new folder' });
    await accepted('sftp.rename', { id: uuid, from: '/a', to: '/b' });
    await accepted('sftp.remove', { id: uuid, paths: ['/a', '/b/c'] });
    await accepted('sftp.download', { id: uuid, paths: ['/var/log/syslog'] });
    await accepted('sftp.upload', { id: uuid, remoteDir: '/tmp', kind: 'files' });
    await accepted('sftp.upload', { id: uuid, remoteDir: '/tmp', kind: 'folder' });
    await accepted('sftp.cancelTransfer', { transferId: uuid });
    await accepted('sftp.clearTransfers', undefined);
  });

  it('carry no local path: anything that names one is refused', async () => {
    // Uploads pick their sources in main's dialog; downloads their destination.
    await refused('sftp.upload', {
      id: uuid,
      remoteDir: '/tmp',
      kind: 'files',
      paths: ['/etc/passwd'],
    });
    await refused('sftp.upload', { id: uuid, remoteDir: '/tmp', kind: '/etc/passwd' });
    await refused('sftp.download', { id: uuid, paths: ['/x'], destination: '/home/me/.bashrc' });
    await refused('sftp.download', { id: uuid, paths: ['/x'], localPath: '/tmp' });
    await refused('sftp.open', { hostId: uuid, root: '/' });
  });

  it('refuse relative, empty, NUL and oversized remote paths', async () => {
    await refused('sftp.mkdir', { id: uuid, path: 'relative' });
    await refused('sftp.mkdir', { id: uuid, path: '' });
    await refused('sftp.rename', { id: uuid, from: '/a', to: 'b' });
    await refused('sftp.remove', { id: uuid, paths: [] });
    await refused('sftp.remove', { id: uuid, paths: ['relative'] });
    await refused('sftp.remove', { id: uuid, paths: ['/a\0b'] });
    await refused('sftp.readdir', { id: uuid, path: '/a\0' });
    await refused('sftp.readdir', { id: uuid, path: `/${'x'.repeat(5000)}` });
    await refused('sftp.download', {
      id: uuid,
      paths: Array.from({ length: 10_001 }, (_, i) => `/f${i}`),
    });
    await refused('sftp.upload', { id: uuid, remoteDir: 'tmp', kind: 'files' });
  });

  it('refuse bad session IDs and wrong types', async () => {
    await refused('sftp.readdir', { id: 'not-a-uuid', path: '/' });
    await refused('sftp.readdir', { id: uuid, path: 42 });
    await refused('sftp.remove', { id: uuid, paths: '/a' });
    await refused('sftp.cancelTransfer', { transferId: '../x' });
    await refused('sftp.list', {});
    await refused('sftp.transfers', 'x');
  });
});

describe('dropped files (preload channel)', () => {
  it('accepts absolute local paths only', () => {
    const ok = sftpDropSchema.safeParse({ id: uuid, remoteDir: '/tmp', paths: ['/home/me/a.txt'] });
    expect(ok.success).toBe(true);
    for (const paths of [[], ['relative.txt'], ['/a\0b'], ['../../etc/passwd'], [''], [42]]) {
      expect(
        sftpDropSchema.safeParse({ id: uuid, remoteDir: '/tmp', paths }).success,
        JSON.stringify(paths),
      ).toBe(false);
    }
    expect(
      sftpDropSchema.safeParse({ id: uuid, remoteDir: '/tmp', paths: ['/a'], extra: true }).success,
    ).toBe(false);
    expect(sftpDropSchema.safeParse({ id: uuid, remoteDir: 'tmp', paths: ['/a'] }).success).toBe(
      false,
    );
  });
});
