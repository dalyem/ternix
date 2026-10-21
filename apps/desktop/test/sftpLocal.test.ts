import { mkdtempSync, rmSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalFile,
  isInside,
  LocalDestination,
  planUpload,
  unsafeLocalName,
} from '../src/main/ssh/localFiles.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
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
