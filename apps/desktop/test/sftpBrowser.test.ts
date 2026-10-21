import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { PathLike } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ItemPayload } from '@ternix/core/items';
import type { AppEventName, AppEvents, SftpSessionDto, TransferDto } from '../src/shared/app.js';
import type { MessageBox, MessageBoxRequest } from '../src/main/app/trust.js';
import type { ItemSnapshot } from '../src/main/ssh/items.js';
import { SshManager } from '../src/main/ssh/manager.js';
import { SftpManager, type SftpManagerDeps } from '../src/main/ssh/sftp.js';
import { TestSshServer } from '../../../packages/ssh/test/helpers.js';
import type { SftpServerOptions } from '../../../packages/ssh/test/sftpServer.js';

/**
 * Runs `before` ahead of main's local `realpath`, `lstat`, `mkdir` and `opendir` calls, and of
 * every read through a directory `opendir` returned (`dir.read`, with the folder's path), so a
 * test can act (close a tab, fail the call by throwing) while main waits on one, and see the
 * calls main makes after. Everything else is the real module.
 */
const localFs = vi.hoisted(() => ({
  before: undefined as ((op: string, path: string) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  const gate =
    <A extends unknown[], R>(op: string, fn: (path: PathLike, ...rest: A) => Promise<R>) =>
    async (path: PathLike, ...rest: A): Promise<R> => {
      await localFs.before?.(op, String(path));
      return fn(path, ...rest);
    };
  const opendir = async (...args: Parameters<typeof real.opendir>) => {
    const path = String(args[0]);
    await localFs.before?.('opendir', path);
    const dir = await real.opendir(...args);
    const read = async () => {
      await localFs.before?.('dir.read', path);
      return dir.read();
    };
    return {
      path: dir.path,
      read,
      close: () => dir.close(),
      async *[Symbol.asyncIterator]() {
        try {
          for (let entry = await read(); entry; entry = await read()) yield entry;
        } finally {
          await dir.close().catch(() => undefined);
        }
      },
    };
  };
  const fs = {
    ...real,
    realpath: gate('realpath', real.realpath),
    lstat: gate('lstat', real.lstat),
    mkdir: gate('mkdir', real.mkdir),
    opendir,
  };
  return { ...fs, default: fs };
});

const HOST_ID = '3f1c9a52-8e6b-4d0a-9b7e-0a1b2c3d4e5f';
const PERSONAL = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  localFs.before = undefined;
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function snapshotFor(port: number): ItemSnapshot {
  const host: ItemPayload = {
    type: 'host',
    schema: 1,
    updated_at: new Date().toISOString(),
    label: 'files',
    address: '127.0.0.1',
    port,
    username: 'alice',
    password: 'pw',
    tags: [],
    agent_forwarding: false,
  };
  return {
    lookup: new Map([[HOST_ID, host]]),
    records: new Map([[HOST_ID, { vaultId: PERSONAL, itemId: HOST_ID, seq: 1, payload: host }]]),
    personalVaultId: PERSONAL,
  };
}

interface Options {
  platform?: NodeJS.Platform;
  approveNewHost?: boolean;
  /** Slow down the server's reads (ms per request), so a transfer is still running when cancelled. */
  readDelayMs?: number;
  /** Answers for main's message boxes, in order; each gets the request. */
  answers?: ((request: MessageBoxRequest) => { response: number; checkboxChecked?: boolean })[];
  /** More options for the fake SFTP server. */
  server?: Partial<SftpServerOptions>;
  /** Overrides for the manager's dependencies. */
  deps?: Partial<SftpManagerDeps>;
}

async function setup(options: Options = {}) {
  const remote = tempDir('ternix-sftp-remote-');
  const local = tempDir('ternix-sftp-local-');
  const server = await TestSshServer.start({
    users: { alice: { password: 'pw' } },
    sftp: {
      root: remote,
      home: '/',
      delay: (operation) => (operation === 'read' ? (options.readDelayMs ?? 0) : 0),
      ...options.server,
    },
  });
  cleanup.push(() => server.stop());
  const events: { name: AppEventName; payload: unknown }[] = [];
  const emit = <K extends AppEventName>(name: K, payload: AppEvents[K]) =>
    void events.push({ name, payload });
  const confirmNewHosts = vi.fn(async () => options.approveNewHost ?? true);
  const ssh = new SshManager({
    snapshot: () => snapshotFor(server.port),
    putItem: vi.fn(async () => ({})),
    emit,
    sendTerminal: () => true,
    hasWindow: () => true,
    confirmHostKey: async () => 'trust',
    confirmNewHosts,
    agentPath: undefined,
  });
  cleanup.push(() => ssh.closeAll());
  const asked: MessageBoxRequest[] = [];
  const answers = [...(options.answers ?? [])];
  const messageBox: MessageBox = vi.fn(async (request) => {
    asked.push(request);
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected dialog: ${request.message}`);
    const { response, checkboxChecked = false } = answer(request);
    return { response, checkboxChecked };
  });
  const state = { unlocked: true };
  const pick = {
    uploads: vi.fn<SftpManagerDeps['pickUploads']>(async () => []),
    file: vi.fn<SftpManagerDeps['pickDownloadFile']>(async () => null),
    folder: vi.fn<SftpManagerDeps['pickDownloadFolder']>(async () => local),
  };
  const sftp = new SftpManager({
    ssh,
    emit,
    isUnlocked: () => state.unlocked,
    platform: options.platform ?? process.platform,
    messageBox,
    pickUploads: pick.uploads,
    pickDownloadFile: pick.file,
    pickDownloadFolder: pick.folder,
    progressIntervalMs: 20,
    ...options.deps,
  });
  return { server, remote, local, ssh, sftp, events, asked, pick, state, confirmNewHosts };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function connected(s: Setup): Promise<SftpSessionDto> {
  const opened = s.sftp.open(HOST_ID);
  await vi.waitFor(() => expect(s.sftp.list()[0]?.state).toBe('ready'), { timeout: 10_000 });
  return { ...opened, ...s.sftp.list()[0]! };
}

async function settled(s: Setup, count: number): Promise<TransferDto[]> {
  await vi.waitFor(
    () => {
      const all = s.sftp.transfers();
      expect(all.length).toBeGreaterThanOrEqual(count);
      expect(all.every((t) => t.state !== 'queued' && t.state !== 'running')).toBe(true);
    },
    { timeout: 15_000 },
  );
  return s.sftp.transfers();
}

describe('SFTP sessions', () => {
  it('connect like terminals: a new host is approved in main’s dialog before anything is sent', async () => {
    const s = await setup({ approveNewHost: false });
    const tab = s.sftp.open(HOST_ID);
    await vi.waitFor(() => expect(s.sftp.list()[0]?.state).toBe('closed'));
    expect(s.confirmNewHosts).toHaveBeenCalledWith(
      [{ host: '127.0.0.1', port: s.server.port, isNew: true }],
      expect.any(AbortSignal),
    );
    expect(s.sftp.list()[0]?.closed?.code).toBe('not_approved');
    expect(s.server.connections).toBe(0);
    // Not a terminal tab.
    expect(s.ssh.list()).toEqual([]);
    expect(s.events.some((e) => e.name === 'ssh.status')).toBe(false);
    expect(
      s.events.some((e) => e.name === 'sftp.status' && (e.payload as SftpSessionDto).id === tab.id),
    ).toBe(true);
  });

  it('opens the subsystem and reports the login directory', async () => {
    const s = await setup();
    const session = await connected(s);
    expect(session.home).toBe('/');
    expect(session.target).toBe(`alice@127.0.0.1:${s.server.port}`);
    expect(s.server.sftpSessions).toHaveLength(1);
    expect(s.ssh.list()).toEqual([]);
    // Terminal requests do not reach an SFTP session (no shell, no port forwards).
    expect(() => s.ssh.attach(session.id)).toThrow(/no longer exists/);
    await expect(s.ssh.startForward(session.id, HOST_ID)).rejects.toThrow(/no longer exists/);
  });

  it('refuses file operations while the vault is locked', async () => {
    const s = await setup();
    const session = await connected(s);
    s.state.unlocked = false;
    await expect(s.sftp.readdir(session.id, '/')).rejects.toMatchObject({ code: 'locked' });
    await expect(s.sftp.download(session.id, ['/x'])).rejects.toMatchObject({ code: 'locked' });
    expect(s.pick.folder).not.toHaveBeenCalled();
  });
});

describe('SFTP browsing and changes', () => {
  it('lists, makes folders and renames', async () => {
    const s = await setup();
    const { id } = await connected(s);
    await writeFile(join(s.remote, 'a.txt'), 'A');
    await s.sftp.mkdir(id, '/docs');
    await s.sftp.rename(id, '/a.txt', '/docs/b.txt');
    const listing = await s.sftp.readdir(id, 'docs');
    expect(listing.path).toBe('/docs');
    expect(listing.entries.map((e) => [e.name, e.type, e.size])).toEqual([['b.txt', 'file', 1]]);
  });

  it('deletes only after main’s dialog confirms', async () => {
    const s = await setup({
      answers: [() => ({ response: 0 }), () => ({ response: 1 })],
    });
    const { id } = await connected(s);
    await mkdir(join(s.remote, 'tree', 'sub'), { recursive: true });
    await writeFile(join(s.remote, 'tree', 'sub', 'x'), 'x');
    await expect(s.sftp.remove(id, ['/tree'])).rejects.toMatchObject({ code: 'cancelled' });
    expect(await readdir(join(s.remote, 'tree'))).toEqual(['sub']);
    expect(s.asked[0]).toMatchObject({ defaultId: 0, cancelId: 0, buttons: ['Cancel', 'Delete'] });
    expect(s.asked[0]!.message).toContain('“tree”');

    await s.sftp.remove(id, ['/tree']);
    await expect(lstat(join(s.remote, 'tree'))).rejects.toThrow();
  });
});

describe('SFTP transfers', () => {
  it('uploads picked files and downloads them back intact', async () => {
    const s = await setup();
    const { id } = await connected(s);
    const data = randomBytes(3 * 1024 * 1024 + 7);
    const source = tempDir('ternix-sftp-source-');
    await writeFile(join(source, 'big.bin'), data);
    s.pick.uploads.mockResolvedValueOnce([join(source, 'big.bin')]);

    expect(await s.sftp.upload(id, '/', 'files')).toEqual({ queued: 1, skipped: 0 });
    const [up] = await settled(s, 1);
    expect(up).toMatchObject({
      direction: 'upload',
      state: 'done',
      transferred: data.length,
      total: data.length,
    });
    expect((await readFile(join(s.remote, 'big.bin'))).equals(data)).toBe(true);
    // Progress went out while bytes moved, not only at the end.
    const progress = s.events.filter(
      (e) => e.name === 'sftp.transfer' && (e.payload as TransferDto).id === up!.id,
    );
    expect(progress.length).toBeGreaterThan(2);

    const saveAs = join(s.local, 'copy.bin');
    s.pick.file.mockResolvedValueOnce(saveAs);
    expect(await s.sftp.download(id, ['/big.bin'])).toEqual({ queued: 1, skipped: 0 });
    expect(s.pick.file).toHaveBeenCalledWith('big.bin');
    await settled(s, 2);
    expect((await readFile(saveAs)).equals(data)).toBe(true);
    // The renderer is told names, never local paths.
    for (const e of s.events) expect(JSON.stringify(e.payload)).not.toContain(s.local);
    for (const e of s.events) expect(JSON.stringify(e.payload)).not.toContain(source);
  });

  it('uploads a folder tree and uploads dropped paths', async () => {
    const s = await setup();
    const { id } = await connected(s);
    const source = tempDir('ternix-sftp-source-');
    await mkdir(join(source, 'site', 'css'), { recursive: true });
    await writeFile(join(source, 'site', 'index.html'), '<h1>hi</h1>');
    await writeFile(join(source, 'site', 'css', 'a.css'), 'a{}');
    s.pick.uploads.mockResolvedValueOnce([join(source, 'site')]);
    expect(await s.sftp.upload(id, '/', 'folder')).toEqual({ queued: 2, skipped: 0 });
    await settled(s, 2);
    expect(await readFile(join(s.remote, 'site', 'css', 'a.css'), 'utf8')).toBe('a{}');

    await writeFile(join(source, 'dropped.txt'), 'drop');
    await mkdir(join(s.remote, 'in'));
    expect(await s.sftp.uploadDropped(id, '/in', [join(source, 'dropped.txt')])).toEqual({
      queued: 1,
      skipped: 0,
    });
    await settled(s, 3);
    expect(await readFile(join(s.remote, 'in', 'dropped.txt'), 'utf8')).toBe('drop');
  });

  it('asks before replacing on upload; skip keeps the remote file', async () => {
    const s = await setup({
      answers: [() => ({ response: 0 }), () => ({ response: 1 })],
    });
    const { id } = await connected(s);
    await writeFile(join(s.remote, 'same.txt'), 'remote');
    const source = tempDir('ternix-sftp-source-');
    await writeFile(join(source, 'same.txt'), 'local');

    s.pick.uploads.mockResolvedValueOnce([join(source, 'same.txt')]);
    await s.sftp.upload(id, '/', 'files');
    const [first] = await settled(s, 1);
    expect(first!.state).toBe('skipped');
    expect(await readFile(join(s.remote, 'same.txt'), 'utf8')).toBe('remote');

    s.pick.uploads.mockResolvedValueOnce([join(source, 'same.txt')]);
    await s.sftp.upload(id, '/', 'files');
    await settled(s, 2);
    expect(await readFile(join(s.remote, 'same.txt'), 'utf8')).toBe('local');
    expect(s.asked.map((a) => a.title)).toEqual(['File already exists', 'File already exists']);
  });

  it('downloads a folder into the picked folder, leaving out names the platform refuses', async () => {
    const s = await setup({ platform: 'win32' });
    const { id } = await connected(s);
    await mkdir(join(s.remote, 'stuff', 'deeper'), { recursive: true });
    await writeFile(join(s.remote, 'stuff', 'ok.txt'), 'ok');
    await writeFile(join(s.remote, 'stuff', 'CON.txt'), 'device');
    await writeFile(join(s.remote, 'stuff', 'what?.txt'), 'q');
    await writeFile(join(s.remote, 'stuff', 'deeper', 'z.txt'), 'z');

    const result = await s.sftp.download(id, ['/stuff']);
    expect(result).toEqual({ queued: 2, skipped: 2 });
    const all = await settled(s, 4);
    expect(
      all
        .filter((t) => t.state === 'skipped')
        .map((t) => t.name)
        .sort(),
    ).toEqual(['CON.txt', 'what?.txt']);
    expect(all.find((t) => t.name === 'CON.txt')?.error).toMatch(/Windows reserves/);
    expect((await readdir(join(s.local, 'stuff'))).sort()).toEqual(['deeper', 'ok.txt']);
    expect(await readFile(join(s.local, 'stuff', 'deeper', 'z.txt'), 'utf8')).toBe('z');
  });

  it('never writes through a local symlink out of the picked folder', async () => {
    const s = await setup({ answers: [() => ({ response: 1 })] });
    const { id } = await connected(s);
    const outside = tempDir('ternix-sftp-outside-');
    await writeFile(join(outside, 'victim.txt'), 'precious');
    // A link where the remote folder would go, and one where a remote file would go.
    await symlink(outside, join(s.local, 'stuff'));
    await symlink(join(outside, 'victim.txt'), join(s.local, 'top.txt'));
    await mkdir(join(s.remote, 'stuff'));
    await writeFile(join(s.remote, 'stuff', 'victim.txt'), 'evil');
    await writeFile(join(s.remote, 'top.txt'), 'new top');

    await s.sftp.download(id, ['/stuff', '/top.txt']);
    const all = await settled(s, 2);
    expect(all.find((t) => t.name === 'stuff')).toMatchObject({ state: 'skipped' });
    expect(all.find((t) => t.name === 'stuff')?.error).toMatch(/link/);
    // The file conflict was asked about (and replaced): the link itself was replaced.
    expect(s.asked.map((a) => a.title)).toEqual(['File already exists']);
    expect((await lstat(join(s.local, 'top.txt'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(s.local, 'top.txt'), 'utf8')).toBe('new top');
    expect(await readFile(join(outside, 'victim.txt'), 'utf8')).toBe('precious');
    expect(await readdir(outside)).toEqual(['victim.txt']);
  });

  it('a local conflict answered Skip leaves the file alone', async () => {
    const s = await setup({ answers: [() => ({ response: 0 })] });
    const { id } = await connected(s);
    await writeFile(join(s.remote, 'a.txt'), 'remote');
    await writeFile(join(s.remote, 'b.txt'), 'remote b');
    await writeFile(join(s.local, 'a.txt'), 'mine');
    await s.sftp.download(id, ['/a.txt', '/b.txt']);
    const all = await settled(s, 2);
    expect(all.map((t) => [t.name, t.state]).sort()).toEqual([
      ['a.txt', 'skipped'],
      ['b.txt', 'done'],
    ]);
    expect(await readFile(join(s.local, 'a.txt'), 'utf8')).toBe('mine');
  });

  it('cancelling a download removes the partial file', async () => {
    const s = await setup({ readDelayMs: 50 });
    const { id } = await connected(s);
    await writeFile(join(s.remote, 'huge.bin'), randomBytes(16 * 1024 * 1024));
    s.pick.file.mockResolvedValueOnce(join(s.local, 'huge.bin'));
    await s.sftp.download(id, ['/huge.bin']);
    await vi.waitFor(() => expect(s.sftp.transfers()[0]?.transferred).toBeGreaterThan(0));
    s.sftp.cancel(s.sftp.transfers()[0]!.id);
    const [t] = await settled(s, 1);
    expect(t!.state).toBe('cancelled');
    expect(await readdir(s.local)).toEqual([]);
  });

  it('closing the session stops and forgets its transfers', async () => {
    const s = await setup({ readDelayMs: 50 });
    const { id } = await connected(s);
    await writeFile(join(s.remote, 'huge.bin'), randomBytes(16 * 1024 * 1024));
    s.pick.file.mockResolvedValueOnce(join(s.local, 'huge.bin'));
    await s.sftp.download(id, ['/huge.bin']);
    await vi.waitFor(() => expect(s.sftp.transfers()[0]?.transferred).toBeGreaterThan(0));
    const transferId = s.sftp.transfers()[0]!.id;
    await s.sftp.close(id);
    expect(s.sftp.transfers()).toEqual([]);
    expect(s.sftp.list()).toEqual([]);
    expect(s.events).toContainEqual({
      name: 'sftp.transfers-removed',
      payload: { ids: [transferId] },
    });
    await vi.waitFor(async () => expect(await readdir(s.local)).toEqual([]));
  });

  it('signing out (closeAll) closes SFTP sessions too', async () => {
    const s = await setup();
    await connected(s);
    await s.ssh.closeAll();
    expect(s.sftp.list()).toEqual([]);
    await vi.waitFor(() => expect(s.server.clients.size).toBe(0));
  });
});

describe('SFTP review regressions', () => {
  /** A promise and its resolver, for a dialog that answers when the test says so. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  const transferEvents = (s: Setup, from: number) =>
    s.events.slice(from).filter((e) => e.name === 'sftp.transfer');

  it('a download whose folder dialog is open when the tab closes touches nothing', async () => {
    const s = await setup();
    const { id } = await connected(s);
    await mkdir(join(s.remote, 'tree', 'sub'), { recursive: true });
    await writeFile(join(s.remote, 'tree', 'sub', 'f'), 'x');
    const dialog = deferred<string | null>();
    s.pick.folder.mockImplementationOnce(() => dialog.promise);
    const pending = s.sftp.download(id, ['/tree']);
    await vi.waitFor(() => expect(s.pick.folder).toHaveBeenCalled());
    await s.sftp.close(id);
    const mark = s.events.length;
    dialog.resolve(s.local);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(await readdir(s.local)).toEqual([]);
    expect(s.sftp.transfers()).toEqual([]);
    expect(transferEvents(s, mark)).toEqual([]);
  });

  it('a save dialog answered after the tab closed queues nothing', async () => {
    const s = await setup();
    const { id } = await connected(s);
    await writeFile(join(s.remote, 'one.txt'), 'x');
    const dialog = deferred<string | null>();
    s.pick.file.mockImplementationOnce(() => dialog.promise);
    const pending = s.sftp.download(id, ['/one.txt']);
    await vi.waitFor(() => expect(s.pick.file).toHaveBeenCalled());
    await s.sftp.close(id);
    const mark = s.events.length;
    dialog.resolve(join(s.local, 'one.txt'));
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(s.sftp.transfers()).toEqual([]);
    expect(transferEvents(s, mark)).toEqual([]);
    expect(await readdir(s.local)).toEqual([]);
  });

  it('a recursive download stops creating folders once its tab closes mid-walk', async () => {
    const hooks: { onOpendir?: (path: string) => void } = {};
    const s = await setup({
      server: {
        delay: (op, path) => (op === 'opendir' && path.startsWith('/tree/') ? 200 : 0),
        onRequest: (op, path) => {
          if (op === 'opendir') hooks.onOpendir?.(path);
        },
      },
    });
    const { id } = await connected(s);
    for (const dir of ['a', 'b', 'c']) {
      await mkdir(join(s.remote, 'tree', dir), { recursive: true });
      await writeFile(join(s.remote, 'tree', dir, 'f'), dir);
    }
    let mark = -1;
    hooks.onOpendir = (path) => {
      if (!path.startsWith('/tree/') || mark !== -1) return;
      mark = s.events.length;
      void s.sftp.close(id);
    };
    await expect(s.sftp.download(id, ['/tree'])).rejects.toMatchObject({ code: 'cancelled' });
    // The first subfolder was made before its listing; nothing after the tab closed.
    const made = await readdir(join(s.local, 'tree'));
    expect(made).toHaveLength(1);
    expect(await readdir(join(s.local, 'tree', made[0]!))).toEqual([]);
    expect(s.sftp.transfers()).toEqual([]);
    expect(transferEvents(s, mark)).toEqual([]);
  });

  for (const op of ['realpath', 'lstat'] as const) {
    it(`a tab closed while a download waits on a local ${op} makes no folder`, async () => {
      const s = await setup();
      const { id } = await connected(s);
      await mkdir(join(s.remote, 'tree', 'sub'), { recursive: true });
      await writeFile(join(s.remote, 'tree', 'sub', 'f'), 'x');
      const root = await realpath(s.local);
      // Making `tree` in the picked folder: the folder is resolved again, then `tree` looked up.
      const at = op === 'realpath' ? root : join(root, 'tree');
      let calls = 0;
      localFs.before = async (o, path) => {
        if (o !== op || path !== at) return;
        // The first realpath of the folder is opening the destination, before the walk.
        if (++calls !== (op === 'realpath' ? 2 : 1)) return;
        await s.sftp.close(id);
      };
      await expect(s.sftp.download(id, ['/tree'])).rejects.toMatchObject({ code: 'cancelled' });
      expect(calls).toBeGreaterThanOrEqual(op === 'realpath' ? 2 : 1);
      expect(await readdir(s.local)).toEqual([]);
      expect(s.sftp.transfers()).toEqual([]);
    });
  }

  it('a tab closed while a download makes a local folder looks at nothing after', async () => {
    const s = await setup();
    const { id } = await connected(s);
    await mkdir(join(s.remote, 'tree', 'sub'), { recursive: true });
    await writeFile(join(s.remote, 'tree', 'sub', 'f'), 'x');
    const root = await realpath(s.local);
    let closed = false;
    const after: string[] = [];
    localFs.before = async (op, path) => {
      if (path !== root && !path.startsWith(`${root}/`)) return;
      if (closed) {
        after.push(`${op} ${path}`);
      } else if (op === 'mkdir' && path === join(root, 'tree')) {
        await s.sftp.close(id);
        closed = true;
      }
    };
    await expect(s.sftp.download(id, ['/tree'])).rejects.toMatchObject({ code: 'cancelled' });
    expect(closed).toBe(true);
    // The mkdir already running completes; nothing is looked up or made after it.
    expect(after).toEqual([]);
    expect(await readdir(root)).toEqual(['tree']);
    expect(await readdir(join(root, 'tree'))).toEqual([]);
  });

  /** A local folder `up` with folders `a`, `b` and `c`, each with a file. */
  async function uploadTree(s: Setup): Promise<string> {
    const up = join(await realpath(s.local), 'up');
    for (const dir of ['a', 'b', 'c']) {
      await mkdir(join(up, dir), { recursive: true });
      await writeFile(join(up, dir, 'f'), dir);
    }
    return up;
  }

  it('a tab closed while an upload opens a local folder reads nothing from it', async () => {
    const s = await setup();
    const { id } = await connected(s);
    const up = await uploadTree(s);
    let closed = false;
    const after: string[] = [];
    localFs.before = async (op, path) => {
      if (path !== up && !path.startsWith(`${up}/`)) return;
      if (closed) {
        after.push(`${op} ${path}`);
      } else if (op === 'opendir' && path === up) {
        // The open itself goes ahead and succeeds.
        await s.sftp.close(id);
        closed = true;
      }
    };
    await expect(s.sftp.uploadDropped(id, '/', [up])).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(closed).toBe(true);
    expect(after).toEqual([]);
    expect(await readdir(s.remote)).toEqual([]);
  });

  it('a tab closed while a local folder fails to open stops the upload walk', async () => {
    const s = await setup();
    const { id } = await connected(s);
    const up = await uploadTree(s);
    let closed = false;
    const after: string[] = [];
    localFs.before = async (op, path) => {
      if (path !== up && !path.startsWith(`${up}/`)) return;
      if (closed) {
        after.push(`${op} ${path}`);
      } else if (op === 'opendir' && path === join(up, 'a')) {
        await s.sftp.close(id);
        closed = true;
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
    };
    await expect(s.sftp.uploadDropped(id, '/', [up])).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(closed).toBe(true);
    // Not on to `b`: the failed open is checked like a successful one.
    expect(after).toEqual([]);
    expect(await readdir(s.remote)).toEqual([]);
  });

  it('a tab closed while an upload walks local folders stops the walk', async () => {
    const s = await setup();
    const { id } = await connected(s);
    const up = join(await realpath(s.local), 'up');
    for (const dir of ['a', 'b', 'c']) {
      await mkdir(join(up, dir), { recursive: true });
      await writeFile(join(up, dir, 'f'), dir);
    }
    let closed = false;
    const after: string[] = [];
    localFs.before = async (op, path) => {
      if (path !== up && !path.startsWith(`${up}/`)) return;
      if (closed) {
        after.push(`${op} ${path}`);
      } else if (op === 'opendir' && path === join(up, 'a')) {
        await s.sftp.close(id);
        closed = true;
      }
    };
    await expect(s.sftp.uploadDropped(id, '/', [up])).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(closed).toBe(true);
    // Nothing after the folder being opened when the tab closed.
    expect(after).toEqual([]);
    expect(await readdir(s.remote)).toEqual([]);
  });

  it('a download prepared across a page or account change is dropped', async () => {
    const generation = { value: 1 };
    const s = await setup({ deps: { generation: () => generation.value } });
    const { id } = await connected(s);
    await mkdir(join(s.remote, 'tree'));
    await writeFile(join(s.remote, 'tree', 'f'), 'x');
    const dialog = deferred<string | null>();
    s.pick.folder.mockImplementationOnce(() => dialog.promise);
    const pending = s.sftp.download(id, ['/tree']);
    await vi.waitFor(() => expect(s.pick.folder).toHaveBeenCalled());
    generation.value++;
    const mark = s.events.length;
    dialog.resolve(s.local);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(await readdir(s.local)).toEqual([]);
    expect(transferEvents(s, mark)).toEqual([]);
  });

  it('cancelling right after the last byte, before CLOSE is answered, keeps nothing', async () => {
    const hooks: { onClose?: () => void } = {};
    const s = await setup({
      server: {
        delay: (op) => (op === 'close' ? 300 : 0),
        onRequest: (op) => {
          if (op === 'close') hooks.onClose?.();
        },
      },
    });
    const { id } = await connected(s);
    await writeFile(join(s.remote, 'f.bin'), randomBytes(200 * 1024));
    s.pick.file.mockResolvedValueOnce(join(s.local, 'f.bin'));
    hooks.onClose = () => {
      const t = s.sftp.transfers()[0];
      if (t) s.sftp.cancel(t.id);
    };
    await s.sftp.download(id, ['/f.bin']);
    const [t] = await settled(s, 1);
    expect(t).toMatchObject({ state: 'cancelled', transferred: 200 * 1024 });
    expect(await readdir(s.local)).toEqual([]);
  });

  it('cancelling a replacing download after the last byte keeps the old file', async () => {
    const hooks: { onClose?: () => void } = {};
    const s = await setup({
      answers: [() => ({ response: 1 })],
      server: {
        delay: (op) => (op === 'close' ? 300 : 0),
        onRequest: (op) => {
          if (op === 'close') hooks.onClose?.();
        },
      },
    });
    const { id } = await connected(s);
    await writeFile(join(s.remote, 'a.txt'), 'remote');
    await writeFile(join(s.remote, 'b.txt'), 'remote b');
    await writeFile(join(s.local, 'a.txt'), 'mine');
    hooks.onClose = () => {
      for (const t of s.sftp.transfers()) if (t.name === 'a.txt') s.sftp.cancel(t.id);
    };
    await s.sftp.download(id, ['/a.txt', '/b.txt']);
    const all = await settled(s, 2);
    expect(all.find((t) => t.name === 'a.txt')?.state).toBe('cancelled');
    expect(await readFile(join(s.local, 'a.txt'), 'utf8')).toBe('mine');
    expect((await readdir(s.local)).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('empty folders count against the download budget', async () => {
    const s = await setup({ deps: { maxDownloadEntries: 20 } });
    const { id } = await connected(s);
    for (let i = 0; i < 30; i++) await mkdir(join(s.remote, 'tree', `d${i}`), { recursive: true });
    await expect(s.sftp.download(id, ['/tree'])).rejects.toMatchObject({ code: 'invalid_input' });
    const made = await readdir(join(s.local, 'tree')).catch(() => []);
    expect(made.length).toBeLessThan(20);
    const [row] = s.sftp.transfers();
    expect(row).toMatchObject({ state: 'failed', direction: 'download' });
    expect(row?.error).toMatch(/too many/i);
  });

  it('a listing that never ends counts against the download budget', async () => {
    const s = await setup({
      deps: { maxDownloadEntries: 10 },
      server: { readdirForever: (path) => (path === '/tree' ? ['.', '..'] : undefined) },
    });
    const { id } = await connected(s);
    await mkdir(join(s.remote, 'tree'));
    await expect(s.sftp.download(id, ['/tree'])).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('a download being prepared shows a row that can cancel it', async () => {
    let listingSub = false;
    const s = await setup({
      server: {
        delay: (op, path) => (op === 'opendir' && path === '/tree/sub' ? 1000 : 0),
        onRequest: (op, path) => {
          if (op === 'opendir' && path === '/tree/sub') listingSub = true;
        },
      },
    });
    const { id } = await connected(s);
    await mkdir(join(s.remote, 'tree', 'sub'), { recursive: true });
    await writeFile(join(s.remote, 'tree', 'f'), 'x');
    await writeFile(join(s.remote, 'tree', 'sub', 'g'), 'y');
    const pending = s.sftp.download(id, ['/tree']);
    await vi.waitFor(() => expect(s.sftp.transfers()[0]?.state).toBe('preparing'));
    await vi.waitFor(() => expect(listingSub).toBe(true));
    const row = s.sftp.transfers()[0]!;
    expect(row).toMatchObject({ direction: 'download', name: 'tree', remotePath: '/tree' });
    s.sftp.cancel(row.id);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(s.sftp.transfers()).toEqual([{ ...row, state: 'cancelled' }]);
    // The walk stopped: the file it found first was not queued.
    await new Promise((r) => setTimeout(r, 1200));
    expect(s.sftp.transfers()).toHaveLength(1);
    expect(await readdir(join(s.local, 'tree'))).toEqual(['sub']);
  });

  it('a finished preparation leaves only the file rows', async () => {
    const s = await setup();
    const { id } = await connected(s);
    await mkdir(join(s.remote, 'tree'));
    await writeFile(join(s.remote, 'tree', 'f'), 'x');
    expect(await s.sftp.download(id, ['/tree'])).toEqual({ queued: 1, skipped: 0 });
    const all = await settled(s, 1);
    expect(all.map((t) => [t.name, t.state])).toEqual([['f', 'done']]);
    expect(
      s.events.some(
        (e) => e.name === 'sftp.transfer' && (e.payload as TransferDto).state === 'preparing',
      ),
    ).toBe(true);
  });
});
