import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SshError, SshSession, remoteChild } from '../src/index.js';
import type {
  LocalSink,
  LocalSource,
  SftpClient,
  SftpOptions,
  TransferProgress,
} from '../src/index.js';
import { TestSshServer, connection, waitFor, withTimeout } from './helpers.js';
import type { SftpServerOptions } from './sftpServer.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Setup {
  server: TestSshServer;
  session: SshSession;
  sftp: SftpClient;
  root: string;
}

async function setup(
  sftpOptions: Partial<SftpServerOptions> = {},
  clientOptions: SftpOptions = {},
): Promise<Setup> {
  const root = tempDir('ternix-sftp-root-');
  const server = await TestSshServer.start({
    users: { alice: { password: 'pw' } },
    sftp: { root, ...sftpOptions },
  });
  cleanup.push(() => server.stop());
  const session = new SshSession();
  cleanup.push(() => session.close());
  await session.connect(connection({ port: server.port }), { verifyHostKey: async () => true });
  const sftp = await session.openSftp(clientOptions);
  return { server, session, sftp, root };
}

async function rejection(promise: Promise<unknown>): Promise<SshError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SshError) return err;
    throw err;
  }
  throw new Error('expected the promise to reject');
}

/** A download target in memory: chunks land where their position says. */
function memorySink(): LocalSink & { bytes(): Buffer; writes: number } {
  const chunks: { position: number; data: Buffer }[] = [];
  const sink = {
    writes: 0,
    async write(data: Buffer, position: number) {
      sink.writes++;
      chunks.push({ position, data: Buffer.from(data) });
    },
    bytes() {
      const end = Math.max(0, ...chunks.map((c) => c.position + c.data.length));
      const out = Buffer.alloc(end);
      for (const c of chunks) c.data.copy(out, c.position);
      return out;
    },
  };
  return sink;
}

function bufferSource(data: Buffer): LocalSource & { reads: number } {
  const source = {
    size: data.length,
    reads: 0,
    async read(buffer: Buffer, position: number) {
      source.reads++;
      if (position >= data.length) return 0;
      return data.copy(buffer, 0, position, Math.min(data.length, position + buffer.length));
    },
  };
  return source;
}

const MB = 1024 * 1024;

describe('SFTP browsing', () => {
  it('resolves the login directory', async () => {
    const { sftp, root } = await setup({ home: '/home/alice' });
    await mkdir(join(root, 'home', 'alice'), { recursive: true });
    expect(await sftp.realpath()).toBe('/home/alice');
    expect(await sftp.realpath('/home/alice/../alice/./')).toBe('/home/alice');
  });

  it('lists names, types, sizes, times and modes, and the type behind each symlink', async () => {
    const { sftp, root } = await setup();
    await writeFile(join(root, 'notes.txt'), 'hello world');
    await utimes(join(root, 'notes.txt'), 1_700_000_000, 1_700_000_000);
    await mkdir(join(root, 'docs'));
    await symlink('notes.txt', join(root, 'link-to-file'));
    await symlink('docs', join(root, 'link-to-dir'));
    await symlink('nowhere', join(root, 'dangling'));
    for (let i = 0; i < 7; i++) await writeFile(join(root, `f${i}`), String(i));

    const entries = await sftp.list('/');
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'dangling',
        'docs',
        'f0',
        'f1',
        'f2',
        'f3',
        'f4',
        'f5',
        'f6',
        'link-to-dir',
        'link-to-file',
        'notes.txt',
      ].sort(),
    );
    expect(byName.get('notes.txt')).toMatchObject({
      type: 'file',
      size: 11,
      mtime: 1_700_000_000,
      path: '/notes.txt',
    });
    expect(byName.get('notes.txt')?.targetType).toBeUndefined();
    expect((byName.get('notes.txt')?.mode ?? 0) & 0o777).toBe(
      (await stat(join(root, 'notes.txt'))).mode & 0o777,
    );
    expect(byName.get('docs')).toMatchObject({ type: 'directory', path: '/docs' });
    expect(byName.get('link-to-file')).toMatchObject({ type: 'symlink', targetType: 'file' });
    expect(byName.get('link-to-dir')).toMatchObject({ type: 'symlink', targetType: 'directory' });
    expect(byName.get('dangling')).toMatchObject({ type: 'symlink', targetType: 'missing' });
  });

  it('lstat sees a link, stat what it points to', async () => {
    const { sftp, root } = await setup();
    await mkdir(join(root, 'docs'));
    await symlink('docs', join(root, 'link'));
    expect((await sftp.lstat('/link')).type).toBe('symlink');
    expect((await sftp.stat('/link')).type).toBe('directory');
  });

  it('reports a missing directory and a refused one with their own codes', async () => {
    const { sftp, root } = await setup({
      deny: (op, path) => op === 'opendir' && path === '/secret',
    });
    await mkdir(join(root, 'secret'));
    expect((await rejection(sftp.list('/missing'))).code).toBe('not_found');
    expect((await rejection(sftp.list('/secret'))).code).toBe('permission_denied');
    // The channel still works afterwards.
    expect(await sftp.list('/')).toHaveLength(1);
  });
});

describe('SFTP changes', () => {
  it('creates a folder, and refuses one that exists', async () => {
    const { sftp, root } = await setup();
    await sftp.mkdir('/new');
    expect((await stat(join(root, 'new'))).isDirectory()).toBe(true);
    expect((await rejection(sftp.mkdir('/new'))).code).toBe('already_exists');
  });

  it('renames, and never replaces an existing target', async () => {
    const { sftp, root } = await setup();
    await writeFile(join(root, 'a.txt'), 'A');
    await writeFile(join(root, 'b.txt'), 'B');
    await sftp.rename('/a.txt', '/c.txt');
    expect(await readFile(join(root, 'c.txt'), 'utf8')).toBe('A');
    expect((await rejection(sftp.rename('/c.txt', '/b.txt'))).code).toBe('already_exists');
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('B');
    expect((await rejection(sftp.rename('/gone', '/x'))).code).toBe('not_found');
  });

  it('removes a file, and a refused removal says so', async () => {
    const { sftp, root } = await setup({ deny: (op, path) => op === 'remove' && path === '/keep' });
    await writeFile(join(root, 'f'), 'x');
    await writeFile(join(root, 'keep'), 'x');
    await sftp.remove('/f');
    await expect(lstat(join(root, 'f'))).rejects.toThrow();
    expect((await rejection(sftp.remove('/keep'))).code).toBe('permission_denied');
    expect(await readFile(join(root, 'keep'), 'utf8')).toBe('x');
  });

  it('deletes a directory tree without following symlinks out of it', async () => {
    const { sftp, root } = await setup();
    const outside = tempDir('ternix-sftp-outside-');
    await writeFile(join(outside, 'precious.txt'), 'keep me');
    await mkdir(join(outside, 'sub'));
    await writeFile(join(outside, 'sub', 'also.txt'), 'keep me too');

    await mkdir(join(root, 'tree', 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'tree', 'top.txt'), '1');
    await writeFile(join(root, 'tree', 'a', 'b', 'deep.txt'), '2');
    // A link to a directory outside, one to a file outside, and one to a directory inside.
    await symlink(outside, join(root, 'tree', 'a', 'to-outside'));
    await symlink(join(outside, 'precious.txt'), join(root, 'tree', 'file-link'));
    await mkdir(join(root, 'kept'));
    await writeFile(join(root, 'kept', 'inside.txt'), '3');
    await symlink(join(root, 'kept'), join(root, 'tree', 'to-kept'));

    await sftp.remove('/tree');

    await expect(lstat(join(root, 'tree'))).rejects.toThrow();
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(await readFile(join(outside, 'sub', 'also.txt'), 'utf8')).toBe('keep me too');
    expect(await readFile(join(root, 'kept', 'inside.txt'), 'utf8')).toBe('3');
  });

  it('deleting a symlink to a directory removes the link only', async () => {
    const { sftp, root } = await setup();
    await mkdir(join(root, 'real'));
    await writeFile(join(root, 'real', 'x'), 'x');
    await symlink('real', join(root, 'link'));
    await sftp.remove('/link');
    await expect(lstat(join(root, 'link'))).rejects.toThrow();
    expect(await readdir(join(root, 'real'))).toEqual(['x']);
  });

  it('stops a recursive delete when its budget runs out', async () => {
    const { sftp, root } = await setup();
    await mkdir(join(root, 'tree'));
    for (let i = 0; i < 5; i++) await writeFile(join(root, 'tree', `f${i}`), '');
    expect((await rejection(sftp.remove('/tree', { maxEntries: 3 }))).code).toBe('sftp_failed');
    expect((await stat(join(root, 'tree'))).isDirectory()).toBe(true);
  });

  it('refuses names that are not one path component', () => {
    expect(remoteChild('/a', 'b')).toBe('/a/b');
    for (const bad of ['', '.', '..', 'x/y', 'a\0b']) {
      expect(() => remoteChild('/a', bad)).toThrow(SshError);
    }
  });
});

describe('SFTP transfers', () => {
  it('uploads and downloads a multi-megabyte file intact, with progress', async () => {
    const { sftp, root } = await setup();
    const data = randomBytes(5 * MB + 12_345);
    const upProgress: TransferProgress[] = [];
    const up = await sftp.upload(bufferSource(data), '/big.bin', {
      overwrite: false,
      onProgress: (p) => upProgress.push(p),
    });
    expect(up.bytes).toBe(data.length);
    expect((await readFile(join(root, 'big.bin'))).equals(data)).toBe(true);

    const sink = memorySink();
    const downProgress: TransferProgress[] = [];
    const down = await sftp.download('/big.bin', sink, { onProgress: (p) => downProgress.push(p) });
    expect(down.bytes).toBe(data.length);
    expect(sink.bytes().equals(data)).toBe(true);

    for (const progress of [upProgress, downProgress]) {
      expect(progress.length).toBeGreaterThan(10);
      expect(progress.at(-1)).toEqual({ transferred: data.length, total: data.length });
      const amounts = progress.map((p) => p.transferred);
      expect([...amounts].sort((a, b) => a - b)).toEqual(amounts);
    }
  });

  it('copies an empty file', async () => {
    const { sftp, root } = await setup();
    await sftp.upload(bufferSource(Buffer.alloc(0)), '/empty', { overwrite: false });
    expect((await stat(join(root, 'empty'))).size).toBe(0);
    const sink = memorySink();
    expect((await sftp.download('/empty', sink)).bytes).toBe(0);
    expect(sink.writes).toBe(0);
  });

  it('does not overwrite unless asked to', async () => {
    const { sftp, root } = await setup();
    await writeFile(join(root, 'existing.txt'), 'original');
    const refused = await rejection(
      sftp.upload(bufferSource(Buffer.from('new')), '/existing.txt', { overwrite: false }),
    );
    expect(refused.code).toBe('already_exists');
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('original');

    await sftp.upload(bufferSource(Buffer.from('new')), '/existing.txt', { overwrite: true });
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('new');
  });

  it('cancels a download midway and keeps the channel usable', async () => {
    const { sftp, root } = await setup();
    await writeFile(join(root, 'big.bin'), randomBytes(8 * MB));
    const abort = new AbortController();
    const sink = memorySink();
    const failure = await rejection(
      sftp.download('/big.bin', sink, {
        signal: abort.signal,
        onProgress: () => abort.abort(),
      }),
    );
    expect(failure.code).toBe('cancelled');
    const writesAtCancel = sink.writes;
    expect(writesAtCancel).toBeLessThan((8 * MB) / (32 * 1024));
    // Nothing is written after the promise settled.
    await new Promise((r) => setTimeout(r, 100));
    expect(sink.writes).toBe(writesAtCancel);
    expect(sftp.closed).toBe(false);
    expect((await sftp.list('/')).map((e) => e.name)).toEqual(['big.bin']);
  });

  it('cancels an upload midway and removes the partial file', async () => {
    const { sftp, root } = await setup();
    const abort = new AbortController();
    const failure = await rejection(
      sftp.upload(bufferSource(randomBytes(8 * MB)), '/partial.bin', {
        overwrite: false,
        signal: abort.signal,
        onProgress: () => abort.abort(),
      }),
    );
    expect(failure.code).toBe('cancelled');
    await expect(lstat(join(root, 'partial.bin'))).rejects.toThrow();
  });

  it('a transfer cancelled while queued never starts', async () => {
    const { sftp, root } = await setup({}, { maxTransfers: 1 });
    await writeFile(join(root, 'a.bin'), randomBytes(2 * MB));
    const started: string[] = [];
    const first = sftp.download('/a.bin', memorySink(), { onStart: () => started.push('a') });
    const abort = new AbortController();
    const second = sftp.download('/a.bin', memorySink(), {
      signal: abort.signal,
      onStart: () => started.push('b'),
    });
    abort.abort();
    expect((await rejection(second)).code).toBe('cancelled');
    await first;
    expect(started).toEqual(['a']);
  });

  it('runs at most maxTransfers at once', async () => {
    const { sftp, root } = await setup({}, { maxTransfers: 2 });
    await writeFile(join(root, 'a.bin'), randomBytes(MB));
    let running = 0;
    let peak = 0;
    // A transfer counts from its start to its last byte (its queue slot frees right after).
    const one = () =>
      sftp.download('/a.bin', memorySink(), {
        onStart: () => {
          running++;
          peak = Math.max(peak, running);
        },
        onProgress: (p) => {
          if (p.transferred === p.total) running--;
        },
      });
    await Promise.all([one(), one(), one(), one(), one()]);
    expect(peak).toBe(2);
  });

  it('fails a transfer when the connection drops midway', async () => {
    const { server, sftp, root } = await setup();
    await writeFile(join(root, 'big.bin'), randomBytes(8 * MB));
    let dropped = false;
    const failure = await rejection(
      withTimeout(
        sftp.download('/big.bin', memorySink(), {
          onProgress: () => {
            if (!dropped) server.dropClients();
            dropped = true;
          },
        }),
        'the download to fail',
        10_000,
      ),
    );
    expect(failure.code).toBe('closed');
    await waitFor(() => sftp.closed, 'the SFTP channel to close');
    expect((await rejection(sftp.list('/'))).code).toBe('closed');
  });

  it('refuses to download a directory, a missing file, or a file it may not read', async () => {
    const { sftp, root } = await setup({ deny: (op, path) => op === 'open' && path === '/locked' });
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'locked'), 'x');
    expect((await rejection(sftp.download('/dir', memorySink()))).code).toBe('sftp_failed');
    expect((await rejection(sftp.download('/nope', memorySink()))).code).toBe('not_found');
    expect((await rejection(sftp.download('/locked', memorySink()))).code).toBe(
      'permission_denied',
    );
    const denied = await rejection(
      sftp.upload(bufferSource(Buffer.from('x')), '/locked', { overwrite: true }),
    );
    expect(denied.code).toBe('permission_denied');
    expect(await readFile(join(root, 'locked'), 'utf8')).toBe('x');
  });
});

describe('SFTP channel lifecycle', () => {
  it('closes the channel when a request goes unanswered', async () => {
    const { sftp } = await setup(
      { hang: (op, path) => op === 'stat' && path === '/slow' },
      { requestTimeoutMs: 300 },
    );
    const closes: (SshError | undefined)[] = [];
    sftp.onClose((err) => closes.push(err));
    const failure = await rejection(withTimeout(sftp.stat('/slow'), 'the stat to time out'));
    expect(failure.code).toBe('timeout');
    expect(sftp.closed).toBe(true);
    expect(closes.map((e) => e?.code)).toEqual(['timeout']);
    expect((await rejection(sftp.list('/'))).code).toBe('timeout');
  });

  it('closing the session closes its SFTP channel', async () => {
    const { session, sftp } = await setup();
    const closed = new Promise<void>((resolve) => sftp.onClose(() => resolve()));
    await session.close();
    await withTimeout(closed, 'the SFTP channel to close');
    expect((await rejection(sftp.list('/'))).code).toBe('closed');
  });

  it('fails with channel_failed when the server has no SFTP', async () => {
    const server = await TestSshServer.start({ users: { alice: { password: 'pw' } } });
    cleanup.push(() => server.stop());
    const session = new SshSession();
    cleanup.push(() => session.close());
    await session.connect(connection({ port: server.port }), { verifyHostKey: async () => true });
    expect((await rejection(session.openSftp())).code).toBe('channel_failed');
    // The connection itself is fine.
    expect(session.status.state).toBe('ready');
  });

  it('cannot open SFTP on a session that is not connected', async () => {
    const session = new SshSession();
    expect((await rejection(session.openSftp())).code).toBe('invalid_state');
  });
});
