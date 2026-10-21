import { mkdtempSync, rmSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalFileHooks } from '../src/main/ssh/localFiles.js';
import {
  createLocalFile,
  isInside,
  LocalDestination,
  planUpload,
  unsafeLocalName,
} from '../src/main/ssh/localFiles.js';

type HandleMethod = 'chmod' | 'close';
type PathMethod = 'link' | 'rename' | 'unlink';

/**
 * File handles from `open` run `next.during` inside their next `next.method` call, before the
 * call itself: another process acting while main waits on its own handle. `link`, `rename` and
 * `unlink` do the same with `pathHooks.next`, standing for a swap inside the system call; its
 * `during` may return the paths the call then uses, for a swap after the kernel looked up the
 * first path and before the second. `pathHooks.linkFails` makes `link` fail with that code, as
 * on a filesystem without hard links. Otherwise the real module.
 */
const handleHooks = vi.hoisted(() => ({
  next: undefined as { method: HandleMethod; during: () => Promise<void> } | undefined,
}));
const pathHooks = vi.hoisted(() => ({
  next: undefined as
    { method: PathMethod; during: (paths: string[]) => Promise<string[] | void> } | undefined,
  linkFails: undefined as string | undefined,
  links: 0,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  const inside =
    (method: PathMethod, call: (...paths: string[]) => Promise<void>) =>
    async (...args: unknown[]) => {
      const paths = args.map(String);
      const next = pathHooks.next;
      if (next?.method !== method) return call(...paths);
      pathHooks.next = undefined;
      return call(...((await next.during(paths)) ?? paths));
    };
  const link = inside('link', async (from, to) => {
    pathHooks.links++;
    if (pathHooks.linkFails) {
      throw Object.assign(new Error(`${pathHooks.linkFails}: link`), {
        code: pathHooks.linkFails,
      });
    }
    return real.link(from!, to!);
  });
  const rename = inside('rename', (from, to) => real.rename(from!, to!));
  const unlink = inside('unlink', (path) => real.unlink(path!));
  const open = async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args);
    for (const method of ['chmod', 'close'] as const) {
      const original = handle[method].bind(handle) as (...a: unknown[]) => Promise<void>;
      Object.defineProperty(handle, method, {
        configurable: true,
        writable: true,
        value: async (...a: unknown[]) => {
          const next = handleHooks.next;
          if (next?.method === method) {
            handleHooks.next = undefined;
            await next.during();
          }
          return original(...a);
        },
      });
    }
    return handle;
  };
  const fs = { ...real, open, link, rename, unlink };
  return { ...fs, default: fs };
});

/** The temporary name every download is written to. */
const TEMP = /^\.ternix-[0-9a-f]{12}\.part$/;

const cleanup: (() => void)[] = [];
afterEach(() => {
  handleHooks.next = undefined;
  pathHooks.next = undefined;
  pathHooks.linkFails = undefined;
  pathHooks.links = 0;
  for (const fn of cleanup.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ternix-local-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('names from the server', () => {
  it('refuses traversal, separators and NUL everywhere', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const bad of ['', '.', '..', '../x', 'a/b', '/etc/passwd', 'a\0b', 'x'.repeat(256)]) {
        expect(
          unsafeLocalName(bad, platform),
          `${JSON.stringify(bad)} on ${platform}`,
        ).not.toBeNull();
      }
      for (const good of ['notes.txt', '.bashrc', 'a b', 'ünïcödé', '...hidden', 'x'.repeat(255)]) {
        expect(unsafeLocalName(good, platform), `${good} on ${platform}`).toBeNull();
      }
    }
  });

  it('refuses names Windows reserves, only on Windows', () => {
    const windowsOnly = [
      'CON',
      'con',
      'NUL.txt',
      'nul.tar.gz',
      'COM1',
      'com9.log',
      'LPT1',
      'lpt¹',
      'AUX ',
      'PRN.',
      'a\\b',
      'C:',
      'c:evil',
      'what?',
      'star*',
      'pipe|',
      'quote"',
      '<tag>',
      'tab\there',
      'ends.',
      'ends ',
    ];
    for (const name of windowsOnly) {
      expect(unsafeLocalName(name, 'win32'), name).not.toBeNull();
      if (!name.includes('/')) expect(unsafeLocalName(name, 'linux'), name).toBeNull();
    }
    for (const name of ['CONSOLE', 'nullable.txt', 'com10', 'COM', 'lpt', 'my CON.txt']) {
      expect(unsafeLocalName(name, 'win32'), name).toBeNull();
    }
  });

  it('isInside compares path components, not string prefixes', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
  });
});

describe('LocalDestination', () => {
  it('makes folders inside the destination and reuses real ones', async () => {
    const root = tempDir();
    const dest = await LocalDestination.open(root, 'linux');
    const a = await dest.directory(dest.root, 'a');
    const b = await dest.directory(a, 'b');
    expect(b).toBe(join(dest.root, 'a', 'b'));
    expect(await dest.directory(dest.root, 'a')).toBe(a);
    expect((await lstat(b)).isDirectory()).toBe(true);
  });

  it('refuses unsafe names before touching the disk', async () => {
    const root = tempDir();
    const dest = await LocalDestination.open(root, 'win32');
    await expect(dest.directory(dest.root, '..')).rejects.toMatchObject({ code: 'unsafe_name' });
    await expect(dest.directory(dest.root, 'CON')).rejects.toMatchObject({ code: 'unsafe_name' });
    await expect(dest.file(dest.root, 'a\\..\\..\\x', false)).rejects.toMatchObject({
      code: 'unsafe_name',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('never follows a symlink out of the destination', async () => {
    const root = tempDir();
    const outside = tempDir();
    await symlink(outside, join(root, 'escape'));
    const dest = await LocalDestination.open(root, 'linux');
    await expect(dest.directory(dest.root, 'escape')).rejects.toMatchObject({
      code: 'unsafe_name',
    });
    // A parent that is not inside the destination is refused too.
    await expect(dest.file(outside, 'x', false)).rejects.toMatchObject({ code: 'unsafe_name' });
    await expect(dest.directory(join(root, 'escape'), 'x')).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses to use a file as a folder', async () => {
    const root = tempDir();
    await writeFile(join(root, 'f'), 'x');
    const dest = await LocalDestination.open(root, 'linux');
    await expect(dest.directory(dest.root, 'f')).rejects.toMatchObject({ code: 'already_exists' });
  });
});

describe('createLocalFile', () => {
  it('writes a new file and refuses an existing one unless replacing', async () => {
    const dir = tempDir();
    const file = await createLocalFile(dir, 'a.txt', false);
    await file.sink.write(Buffer.from('world'), 6);
    await file.sink.write(Buffer.from('hello '), 0);
    await file.finish();
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello world');
    await expect(createLocalFile(dir, 'a.txt', false)).rejects.toMatchObject({
      code: 'already_exists',
    });
  });

  it('a discarded new file is removed', async () => {
    const dir = tempDir();
    const file = await createLocalFile(dir, 'partial.bin', false);
    await file.sink.write(Buffer.from('half'), 0);
    await file.discard();
    expect(await readdir(dir)).toEqual([]);
  });

  it('replacing keeps the old file until the new one is complete', async () => {
    const dir = tempDir();
    await writeFile(join(dir, 'a.txt'), 'old');
    const failed = await createLocalFile(dir, 'a.txt', true);
    await failed.sink.write(Buffer.from('new!'), 0);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('old');
    await failed.discard();
    expect(await readdir(dir)).toEqual(['a.txt']);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('old');

    const ok = await createLocalFile(dir, 'a.txt', true);
    await ok.sink.write(Buffer.from('new'), 0);
    await ok.finish();
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('a symlink in the way is replaced itself, never written through', async () => {
    const dir = tempDir();
    const outside = tempDir();
    await writeFile(join(outside, 'target.txt'), 'precious');
    await symlink(join(outside, 'target.txt'), join(dir, 'a.txt'));
    await symlink(join(outside, 'missing.txt'), join(dir, 'dangling.txt'));

    await expect(createLocalFile(dir, 'a.txt', false)).rejects.toMatchObject({
      code: 'already_exists',
    });
    await expect(createLocalFile(dir, 'dangling.txt', false)).rejects.toMatchObject({
      code: 'already_exists',
    });
    const file = await createLocalFile(dir, 'a.txt', true);
    await file.sink.write(Buffer.from('downloaded'), 0);
    await file.finish();
    expect((await lstat(join(dir, 'a.txt'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('downloaded');
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('precious');
    expect(await readdir(outside)).toEqual(['target.txt']);
    expect(await readlink(join(dir, 'dangling.txt'))).toBe(join(outside, 'missing.txt'));
  });

  it('never replaces a folder', async () => {
    const dir = tempDir();
    await mkdir(join(dir, 'd'));
    await expect(createLocalFile(dir, 'd', true)).rejects.toMatchObject({ code: 'already_exists' });
  });
});

describe('planUpload', () => {
  it('walks picked folders, uploads linked files and skips linked folders', async () => {
    const base = tempDir();
    const outside = tempDir();
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await mkdir(join(base, 'project', 'src'), { recursive: true });
    await writeFile(join(base, 'project', 'README'), 'readme');
    await writeFile(join(base, 'project', 'src', 'main.c'), 'int main;');
    await mkdir(join(base, 'project', 'empty'));
    await symlink(outside, join(base, 'project', 'linked-dir'));
    await symlink(join(base, 'project', 'README'), join(base, 'project', 'linked-file'));
    await writeFile(join(base, 'single.txt'), 'one');

    const plan = await planUpload([join(base, 'project'), join(base, 'single.txt')]);
    expect(plan.dirs).toEqual([['project'], ['project', 'empty'], ['project', 'src']]);
    expect(plan.files.map((f) => [...f.dirs, f.name].join('/')).sort()).toEqual([
      'project/README',
      'project/linked-file',
      'project/src/main.c',
      'single.txt',
    ]);
    expect(plan.skipped).toBe(1);
    expect(plan.files.find((f) => f.name === 'single.txt')?.size).toBe(3);
  });

  it('follows a picked path that is itself a link, and skips what does not exist', async () => {
    const base = tempDir();
    await mkdir(join(base, 'real'));
    await writeFile(join(base, 'real', 'f'), 'x');
    await symlink(join(base, 'real'), join(base, 'link'));
    const plan = await planUpload([join(base, 'link'), join(base, 'gone')]);
    expect(plan.dirs).toEqual([['link']]);
    expect(plan.files.map((f) => f.name)).toEqual(['f']);
    expect(plan.skipped).toBe(1);
  });
});

describe('a folder swapped while a download writes into it', () => {
  // The race needs a second local process. Swaps before finish and discard are made by the test
  // itself; the gap inside opening a file is reached through the hooks.
  const posixOnly = it.skipIf(process.platform === 'win32');

  /** `root/d` replaced by a link to `outside`; the real folder moves to `root/d-moved`. */
  const swap = (root: string, outside: string) => async () => {
    await rename(join(root, 'd'), join(root, 'd-moved'));
    await symlink(outside, join(root, 'd'));
  };

  async function setupSwap(hooks: (root: string, outside: string) => LocalFileHooks) {
    const root = tempDir();
    const outside = tempDir();
    await mkdir(join(root, 'd'));
    const dest = await LocalDestination.open(root, 'linux', hooks(root, outside));
    return { root, outside, dest, dir: join(dest.root, 'd') };
  }

  posixOnly('a parent swapped for a link just before the open is refused', async () => {
    const { outside, dest, dir } = await setupSwap((root, outside) => ({
      beforeOpen: swap(root, outside),
    }));
    await expect(dest.file(dir, 'x', false)).rejects.toMatchObject({ code: 'unsafe_name' });
    // The open went through the link; what it made is left empty, and nothing else changed.
    const made = await readdir(outside);
    expect(made).toEqual([expect.stringMatching(TEMP)]);
    expect((await stat(join(outside, made[0]!))).size).toBe(0);
  });

  posixOnly('a file swapped right after the open is refused', async () => {
    const root = tempDir();
    const outside = tempDir();
    await writeFile(join(outside, 'victim'), 'precious');
    const dest = await LocalDestination.open(root, 'linux', {
      afterOpen: async () => {
        const [temp] = await readdir(root);
        await unlink(join(root, temp!));
        await symlink(join(outside, 'victim'), join(root, temp!));
      },
    });
    await expect(dest.file(dest.root, 'x', false)).rejects.toMatchObject({
      code: 'unsafe_name',
    });
    expect(await readFile(join(outside, 'victim'), 'utf8')).toBe('precious');
    expect(await readdir(root)).toEqual([expect.stringMatching(TEMP)]);
  });

  posixOnly('a parent swapped before the rename into place is refused', async () => {
    const { root, outside, dest, dir } = await setupSwap(() => ({}));
    await writeFile(join(dir, 'x'), 'old');
    await writeFile(join(outside, 'x'), 'precious');
    const file = await dest.file(dir, 'x', true);
    await file.sink.write(Buffer.from('downloaded'), 0);
    await swap(root, outside)();
    await expect(file.finish()).rejects.toMatchObject({ code: 'unsafe_name' });
    expect(await readdir(outside)).toEqual(['x']);
    expect(await readFile(join(outside, 'x'), 'utf8')).toBe('precious');
    expect(await readFile(join(root, 'd-moved', 'x'), 'utf8')).toBe('old');
    // The temporary file is ours (same inode as the handle): emptied, never renamed.
    const temps = (await readdir(join(root, 'd-moved'))).filter((n) => n !== 'x');
    for (const t of temps) expect((await stat(join(root, 'd-moved', t))).size).toBe(0);
  });

  posixOnly('a parent swapped before a new file is finished is refused', async () => {
    const { root, outside, dest, dir } = await setupSwap(() => ({}));
    const file = await dest.file(dir, 'x', false);
    await file.sink.write(Buffer.from('downloaded'), 0);
    await swap(root, outside)();
    await expect(file.finish()).rejects.toMatchObject({ code: 'unsafe_name' });
    expect(await readdir(outside)).toEqual([]);
    const [temp] = await readdir(join(root, 'd-moved'));
    expect(temp).toMatch(TEMP);
    expect((await stat(join(root, 'd-moved', temp!))).size).toBe(0);
  });

  posixOnly('a parent swapped before a failed download is cleaned up unlinks nothing', async () => {
    const { root, outside, dest, dir } = await setupSwap(() => ({}));
    await writeFile(join(outside, 'x'), 'precious');
    const file = await dest.file(dir, 'x', false);
    await file.sink.write(Buffer.from('half'), 0);
    await swap(root, outside)();
    await file.discard();
    expect(await readFile(join(outside, 'x'), 'utf8')).toBe('precious');
    // What was written is gone from the file that is ours, though its name stays.
    const [temp] = await readdir(join(root, 'd-moved'));
    expect(temp).toMatch(TEMP);
    expect((await stat(join(root, 'd-moved', temp!))).size).toBe(0);
  });

  posixOnly('the save dialog’s folder swapped before the open is refused too', async () => {
    const root = tempDir();
    const outside = tempDir();
    await mkdir(join(root, 'd'));
    const hooks: LocalFileHooks = {
      beforeOpen: async () => {
        await rename(join(root, 'd'), join(root, 'd-moved'));
        await symlink(outside, join(root, 'd'));
      },
    };
    await expect(createLocalFile(join(root, 'd'), 'x', false, hooks)).rejects.toMatchObject({
      code: 'unsafe_name',
    });
    const made = await readdir(outside);
    expect(made).toEqual([expect.stringMatching(TEMP)]);
    expect((await stat(join(outside, made[0]!))).size).toBe(0);
  });
});

describe('a folder swapped while a finished or failed download is put away', () => {
  // The swap happens while main waits on its own handle (setting the mode, closing), after the
  // checks a caller could see. Main must check after that work, right before the rename or unlink.
  const posixOnly = it.skipIf(process.platform === 'win32');

  /** Run `during` inside the next `method` call on a file handle, before the call itself. */
  function duringNext(method: HandleMethod, during: () => Promise<void>): void {
    handleHooks.next = { method, during };
  }

  /** `root/d` moved to `root/d-moved`, a link to `outside` in its place. */
  const swap = async (root: string, outside: string) => {
    await rename(join(root, 'd'), join(root, 'd-moved'));
    await symlink(outside, join(root, 'd'));
  };

  for (const method of ['chmod', 'close'] as const) {
    posixOnly(`a parent swapped during the handle ${method} renames nothing outside`, async () => {
      const root = tempDir();
      const outside = tempDir();
      await mkdir(join(root, 'd'));
      await writeFile(join(root, 'd', 'x'), 'old');
      await chmod(join(root, 'd', 'x'), 0o640);
      await writeFile(join(outside, 'x'), 'precious');
      const dest = await LocalDestination.open(root, 'linux');
      const file = await dest.file(join(dest.root, 'd'), 'x', true);
      await file.sink.write(Buffer.from('downloaded'), 0);
      const [temp] = (await readdir(join(root, 'd'))).filter((n) => n !== 'x');
      // The other process can read the temporary name and plant the same name outside.
      duringNext(method, async () => {
        await swap(root, outside);
        await writeFile(join(outside, temp!), 'planted');
      });
      await expect(file.finish()).rejects.toMatchObject({ code: 'unsafe_name' });
      expect(await readFile(join(outside, 'x'), 'utf8')).toBe('precious');
      expect(await readFile(join(outside, temp!), 'utf8')).toBe('planted');
      expect(await readFile(join(root, 'd-moved', 'x'), 'utf8')).toBe('old');
    });
  }

  posixOnly('a parent swapped while a failed download closes unlinks nothing outside', async () => {
    const root = tempDir();
    const outside = tempDir();
    await mkdir(join(root, 'd'));
    await writeFile(join(outside, 'x'), 'precious');
    const dest = await LocalDestination.open(root, 'linux');
    const file = await dest.file(join(dest.root, 'd'), 'x', false);
    await file.sink.write(Buffer.from('half'), 0);
    duringNext('close', () => swap(root, outside));
    await file.discard();
    expect(await readFile(join(outside, 'x'), 'utf8')).toBe('precious');
    // What was written is gone from the file that is ours, though its name stays.
    const [temp] = await readdir(join(root, 'd-moved'));
    expect(temp).toMatch(TEMP);
    expect((await stat(join(root, 'd-moved', temp!))).size).toBe(0);
  });
});

describe('a finished download is put in place without replacing what it should not', () => {
  const posixOnly = it.skipIf(process.platform === 'win32');

  /** `root/d` moved to `root/d-moved`, a link to `outside` in its place. */
  const swap = async (root: string, outside: string) => {
    await rename(join(root, 'd'), join(root, 'd-moved'));
    await symlink(outside, join(root, 'd'));
  };

  /**
   * The swap between a `link` or `rename`'s two lookups: the first path was found in the real
   * folder (now `d-moved`), the second is looked up through the link.
   */
  const swapBetweenLookups =
    (root: string, outside: string) =>
    async ([from, to]: string[]): Promise<string[]> => {
      await swap(root, outside);
      return [join(dirname(dirname(from!)), 'd-moved', basename(from!)), to!];
    };

  async function downloading(name: string, replace: boolean, data = 'downloaded') {
    const root = tempDir();
    const outside = tempDir();
    await mkdir(join(root, 'd'));
    if (replace) await writeFile(join(root, 'd', name), 'old');
    const dest = await LocalDestination.open(root, 'linux');
    const file = await dest.file(join(dest.root, 'd'), name, replace);
    await file.sink.write(Buffer.from(data), 0);
    return { root, outside, file };
  }

  posixOnly('a swap inside a new file’s link replaces nothing outside', async () => {
    const { root, outside, file } = await downloading('x', false);
    await writeFile(join(outside, 'x'), 'precious');
    pathHooks.next = { method: 'link', during: swapBetweenLookups(root, outside) };
    await expect(file.finish()).rejects.toMatchObject({ code: 'already_exists' });
    // What the transfer queue does after a failed finish.
    await file.discard();
    expect(await readdir(outside)).toEqual(['x']);
    expect(await readFile(join(outside, 'x'), 'utf8')).toBe('precious');
  });

  posixOnly('that swap, with the name free outside, only adds a copy and is reported', async () => {
    const { root, outside, file } = await downloading('x', false);
    pathHooks.next = { method: 'link', during: swapBetweenLookups(root, outside) };
    await expect(file.finish()).rejects.toMatchObject({ code: 'unsafe_name' });
    await file.discard();
    // The documented residual: a second name for the download's own data.
    expect(await readdir(outside)).toEqual(['x']);
    expect(await readFile(join(outside, 'x'), 'utf8')).toBe('downloaded');
  });

  posixOnly('a swap before a failed download is removed removes nothing outside', async () => {
    const { root, outside, file } = await downloading('x', false, 'half');
    await writeFile(join(outside, 'x'), 'precious');
    pathHooks.next = { method: 'unlink', during: () => swap(root, outside) };
    await file.discard();
    expect(await readFile(join(outside, 'x'), 'utf8')).toBe('precious');
  });

  posixOnly('a swap inside a replacing rename is the documented residual, reported', async () => {
    const { root, outside, file } = await downloading('x', true);
    await writeFile(join(outside, 'x'), 'precious');
    pathHooks.next = { method: 'rename', during: swapBetweenLookups(root, outside) };
    await expect(file.finish()).rejects.toMatchObject({ code: 'unsafe_name' });
    await file.discard();
    // What the README says this window allows: the same name outside is replaced.
    expect(await readFile(join(outside, 'x'), 'utf8')).toBe('downloaded');
    expect(await readFile(join(root, 'd-moved', 'x'), 'utf8')).toBe('old');
  });

  it('a name taken while a new file downloads fails as a conflict and is left alone', async () => {
    const dir = tempDir();
    const file = await createLocalFile(dir, 'x', false);
    await file.sink.write(Buffer.from('downloaded'), 0);
    // Another program saves under the same name meanwhile; `wx` fails if the name were held.
    await writeFile(join(dir, 'x'), 'theirs', { flag: 'wx' });
    await expect(file.finish()).rejects.toMatchObject({ code: 'already_exists' });
    await file.discard();
    expect(await readdir(dir)).toEqual(['x']);
    expect(await readFile(join(dir, 'x'), 'utf8')).toBe('theirs');
  });

  it('without hard links a new file is renamed into place', async () => {
    pathHooks.linkFails = 'EPERM';
    const dir = tempDir();
    const file = await createLocalFile(dir, 'x', false);
    await file.sink.write(Buffer.from('downloaded'), 0);
    await file.finish();
    expect(pathHooks.links).toBe(1);
    expect(await readdir(dir)).toEqual(['x']);
    expect(await readFile(join(dir, 'x'), 'utf8')).toBe('downloaded');
  });

  it('without hard links a name taken meanwhile is still a conflict, never replaced', async () => {
    pathHooks.linkFails = 'EPERM';
    const dir = tempDir();
    const file = await createLocalFile(dir, 'x', false);
    await file.sink.write(Buffer.from('downloaded'), 0);
    await writeFile(join(dir, 'x'), 'theirs', { flag: 'wx' });
    await expect(file.finish()).rejects.toMatchObject({ code: 'already_exists' });
    await file.discard();
    expect(pathHooks.links).toBe(1);
    expect(await readdir(dir)).toEqual(['x']);
    expect(await readFile(join(dir, 'x'), 'utf8')).toBe('theirs');
  });

  it('a link failure that is not about hard links fails the download as it is', async () => {
    pathHooks.linkFails = 'EACCES';
    const dir = tempDir();
    const file = await createLocalFile(dir, 'x', false);
    await file.sink.write(Buffer.from('downloaded'), 0);
    await expect(file.finish()).rejects.toMatchObject({ code: 'EACCES' });
    await file.discard();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('modes of downloaded files', () => {
  const posixOnly = it.skipIf(process.platform === 'win32');

  posixOnly('replacing a private file never widens it, even while writing', async () => {
    const dir = tempDir();
    await writeFile(join(dir, 'secret'), 'old');
    await chmod(join(dir, 'secret'), 0o600);
    const file = await createLocalFile(dir, 'secret', true);
    const temps = (await readdir(dir)).filter((n) => n !== 'secret');
    expect(temps).toHaveLength(1);
    expect((await stat(join(dir, temps[0]!))).mode & 0o777).toBe(0o600);
    await file.sink.write(Buffer.from('new'), 0);
    await file.finish();
    expect((await stat(join(dir, 'secret'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, 'secret'), 'utf8')).toBe('new');
  });

  posixOnly('replacing keeps the old file’s permissions, without set-id bits', async () => {
    const dir = tempDir();
    await writeFile(join(dir, 'shared'), 'old');
    await chmod(join(dir, 'shared'), 0o4750);
    const file = await createLocalFile(dir, 'shared', true);
    await file.sink.write(Buffer.from('new'), 0);
    await file.finish();
    expect((await stat(join(dir, 'shared'))).mode & 0o7777).toBe(0o750);
  });

  posixOnly('a new file gets the usual mode (umask applies)', async () => {
    const dir = tempDir();
    await writeFile(join(dir, 'reference'), '');
    const file = await createLocalFile(dir, 'fresh', false);
    await file.finish();
    expect((await stat(join(dir, 'fresh'))).mode & 0o777).toBe(
      (await stat(join(dir, 'reference'))).mode & 0o777,
    );
  });
});
