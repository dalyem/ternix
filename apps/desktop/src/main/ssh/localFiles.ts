import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { LocalSink, LocalSource } from '@ternix/ssh';
import { AppError } from '../app/errors.js';
import { visible } from '../app/trust.js';

/**
 * The SFTP browser's only contact with the local filesystem. The renderer never names a local
 * path: uploads read what the user picked in main's open dialog or dropped on the window (the
 * preload turns dropped files into paths), and downloads write only inside the file or folder the
 * user picked in main's save or folder dialog. Names that come from the server are checked here
 * before they become local names: one plain path component, nothing the platform reserves.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
// Windows refuses these characters in names; `/` and `\` are separators.
// eslint-disable-next-line no-control-regex
const WINDOWS_BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const MAX_NAME_BYTES = 255;

/**
 * Why a name from the server cannot be a local file or folder name on `platform`, or null when it
 * can. Refused: empty, `.` and `..`, path separators, NUL, names longer than 255 bytes; on Windows
 * also reserved device names (`CON`, `NUL`, `COM1`, ... with any extension), the characters
 * `<>:"|?*` and control characters, and a trailing dot or space.
 */
export function unsafeLocalName(name: string, platform: NodeJS.Platform): string | null {
  if (name === '' || name === '.' || name === '..') return 'not a file name';
  if (name.includes('\0')) return 'contains a NUL character';
  if (name.includes('/')) return 'contains a path separator';
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return 'name is too long';
  if (platform === 'win32') {
    if (WINDOWS_BAD_CHARS.test(name)) return 'contains a character Windows does not allow';
    if (/[. ]$/.test(name)) return 'ends with a dot or a space';
    const stem = name.split('.')[0]?.trimEnd() ?? '';
    if (WINDOWS_RESERVED.test(stem)) return 'is a name Windows reserves';
  }
  return null;
}

function requireSafeName(name: string, platform: NodeJS.Platform): void {
  const reason = unsafeLocalName(name, platform);
  if (reason) throw new AppError('unsafe_name', `"${printable(name)}" ${reason}`);
}

/** A name for messages and dialogs: control and invisible characters shown as `\u{..}`. */
export const printable = visible;

/** Whether `child` is `root` or below it (both absolute, already resolved). */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Test seams for the local races a second process could cause: each runs at the point it names,
 * so a test can change the disk exactly there. Production code never sets them.
 */
export interface LocalFileHooks {
  /** After the folder was checked, before the file is opened. */
  beforeOpen?: () => Promise<void>;
  /** After the file was opened, before it is checked. */
  afterOpen?: () => Promise<void>;
}

const outsideError = () =>
  new AppError('unsafe_name', 'That would write outside the chosen folder');

/** `dir` must resolve to itself (no link on the way) and be `root` or below it. */
async function requireSameFolder(dir: string, root: string): Promise<void> {
  const real = await realpath(dir).catch(() => undefined);
  if (real !== dir || !isInside(root, real)) throw outsideError();
}

/**
 * A folder the user picked for downloads. Every directory and file made through it is checked to
 * be inside it: names are single components, and an existing entry in the way that is a symlink
 * is refused, never followed.
 */
export class LocalDestination {
  private constructor(
    readonly root: string,
    private readonly platform: NodeJS.Platform,
    private readonly hooks: LocalFileHooks,
  ) {}

  /** `dir` must exist and be a directory; it is resolved once, here. */
  static async open(
    dir: string,
    platform: NodeJS.Platform,
    hooks: LocalFileHooks = {},
  ): Promise<LocalDestination> {
    const root = await realpath(dir);
    if (!(await stat(root)).isDirectory()) {
      throw new AppError('invalid_input', 'The download destination is not a folder');
    }
    return new LocalDestination(root, platform, hooks);
  }

  /**
   * The folder `name` inside `parent` (a folder this destination returned, or its root): made
   * when missing, reused when it is a real folder, refused when a file or a link is in the way.
   */
  async directory(parent: string, name: string): Promise<string> {
    requireSafeName(name, this.platform);
    await this.requireRealDir(parent);
    const target = join(parent, name);
    const existing = await lstat(target).catch(() => undefined);
    if (!existing) {
      await mkdir(target);
      // Made by us just now; check again in case something raced us to it, or swapped a folder
      // above it for a link so that the new folder landed somewhere else.
      if (!(await lstat(target)).isDirectory()) {
        throw new AppError('unsafe_name', `"${printable(name)}" changed while it was created`);
      }
      await this.requireRealDir(target);
      return target;
    }
    if (existing.isSymbolicLink()) {
      throw new AppError('unsafe_name', `"${printable(name)}" is a link here; it is not followed`);
    }
    if (!existing.isDirectory()) {
      throw new AppError('already_exists', `"${printable(name)}" exists here and is not a folder`);
    }
    return target;
  }

  /** What is at `name` inside `parent` now, without following a link. */
  async existing(parent: string, name: string): Promise<Stats | undefined> {
    requireSafeName(name, this.platform);
    await this.requireRealDir(parent);
    return lstat(join(parent, name)).catch(() => undefined);
  }

  /** A new file `name` inside `parent`; see `createLocalFile`. */
  async file(parent: string, name: string, replace: boolean): Promise<LocalFile> {
    requireSafeName(name, this.platform);
    await this.requireRealDir(parent);
    return createIn(parent, this.root, name, replace, this.hooks);
  }

  /**
   * `dir` must be the root or below it with no link on the way: resolving it changes nothing. A
   * folder swapped for a link after it was made fails here.
   */
  private requireRealDir(dir: string): Promise<void> {
    return requireSameFolder(dir, this.root);
  }
}

/** A file being downloaded: write through `sink`, then `finish` or `discard`. */
export interface LocalFile {
  sink: LocalSink;
  /** Close it and put it in place. */
  finish(): Promise<void>;
  /** Close it and remove what was written (the old file, when replacing, stays). */
  discard(): Promise<void>;
}

// O_NOFOLLOW is POSIX only; with O_CREAT | O_EXCL a link at the path fails anyway.
const CREATE_NEW =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * Create `name` in `dir` for writing. Without `replace`, an existing entry (file, folder or link,
 * even a dangling one) fails with `already_exists`. With `replace`, the data goes to a new
 * temporary file next to it, which replaces the entry on `finish` (a rename replaces a link
 * itself, never its target), so a failed download leaves the old file as it was. A folder is
 * never replaced. `dir` is resolved once, here, and must still resolve to the same folder
 * whenever the file is checked (see `createIn`).
 */
export async function createLocalFile(
  dir: string,
  name: string,
  replace: boolean,
  hooks: LocalFileHooks = {},
): Promise<LocalFile> {
  const real = await realpath(dir);
  return createIn(real, real, name, replace, hooks);
}

/**
 * `createLocalFile` in `dir`, a folder that resolves to itself inside `root`. Node has no
 * `openat`, so every path operation resolves `dir` again, and a local process that can write to
 * the folder could swap it (or the file) for a link in between. The gaps are kept as small as
 * Node allows: right after the open, before the rename into place and before removing a failed
 * download, the folder must still resolve to itself inside `root` and the name must still be the
 * file the handle has open (same device and inode, not a link). When it is not, the name is left
 * alone, what the handle has open is emptied (that file is provably ours), and the download fails.
 *
 * Modes: a new file is created with 0666 less the umask, like any new file. A temporary file is
 * 0600 while it is written; on `finish` it takes the permission bits of the file it replaces
 * (without set-user-ID, set-group-ID or sticky bits), so replacing never widens access. A link
 * that is replaced is treated as a new file.
 */
async function createIn(
  dir: string,
  root: string,
  name: string,
  replace: boolean,
  hooks: LocalFileHooks,
): Promise<LocalFile> {
  const target = join(dir, name);
  const existing = await lstat(target).catch(() => undefined);
  if (existing && !replace) {
    throw new AppError('already_exists', `"${printable(name)}" already exists`);
  }
  if (existing?.isDirectory()) {
    throw new AppError('already_exists', `"${printable(name)}" is a folder; it is not replaced`);
  }
  const path = existing ? join(dir, `.ternix-${randomBytes(6).toString('hex')}.part`) : target;
  // The permission bits a replaced file had; undefined for a new file or a replaced link.
  const keepMode = existing?.isFile() ? existing.mode & 0o777 : undefined;
  await hooks.beforeOpen?.();
  let handle: FileHandle;
  try {
    handle = await open(path, CREATE_NEW, keepMode === undefined ? 0o666 : 0o600);
  } catch (err) {
    if (
      (err as { code?: unknown }).code === 'EEXIST' ||
      (err as { code?: unknown }).code === 'ELOOP'
    ) {
      throw new AppError('already_exists', `"${printable(name)}" already exists`);
    }
    throw err;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  /** Whether `path` is still the file `handle` has open, in the folder that was checked. */
  let own: Stats;
  const isOurs = async (): Promise<boolean> => {
    try {
      await requireSameFolder(dir, root);
    } catch {
      return false;
    }
    const now = await lstat(path).catch(() => undefined);
    return now !== undefined && now.isFile() && now.dev === own.dev && now.ino === own.ino;
  };
  /** Empty what the handle has open and fail; the name, maybe someone else's now, is left. */
  const refuse = async (): Promise<never> => {
    if (!closed) await handle.truncate(0).catch(() => undefined);
    await close().catch(() => undefined);
    throw new AppError(
      'unsafe_name',
      `The chosen folder changed while "${printable(name)}" was written; it was not saved`,
    );
  };
  try {
    own = await handle.stat();
    await hooks.afterOpen?.();
  } catch (err) {
    await close().catch(() => undefined);
    throw err;
  }
  if (!(await isOurs())) await refuse();
  return {
    sink: {
      write: async (data, position) => {
        let offset = 0;
        while (offset < data.length) {
          const { bytesWritten } = await handle.write(
            data,
            offset,
            data.length - offset,
            position + offset,
          );
          offset += bytesWritten;
        }
      },
    },
    finish: async () => {
      if (!(await isOurs())) await refuse();
      if (keepMode !== undefined) await handle.chmod(keepMode);
      await close();
      if (path !== target) await rename(path, target);
    },
    discard: async () => {
      if (!(await isOurs())) {
        await refuse().catch(() => undefined);
        return;
      }
      await close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
    },
  };
}

/** A local file to upload, opened for reading. */
export interface LocalReader extends LocalSource {
  close(): Promise<void>;
}

export async function openLocalReader(path: string): Promise<LocalReader> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new AppError('invalid_input', `${basename(path)} is not a file`);
    return {
      size: st.size,
      read: async (buffer, position) =>
        (await handle.read(buffer, 0, buffer.length, position)).bytesRead,
      close: () => handle.close(),
    };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

/** One file to upload: where it is, and where it goes relative to the remote folder. */
export interface UploadPlanFile {
  local: string;
  /** Folder names between the remote destination and the file (empty for a picked file). */
  dirs: string[];
  name: string;
  size: number;
}

export interface UploadPlan {
  /** Folders to create remotely, parents first, each as its path of names. */
  dirs: string[][];
  files: UploadPlanFile[];
  /** Entries left out: symlinked folders inside a picked folder, unreadable entries. */
  skipped: number;
}

export const MAX_UPLOAD_FILES = 10_000;
const MAX_UPLOAD_DEPTH = 64;

/**
 * What uploading `paths` (picked or dropped by the user) means: each file as it is, each folder
 * with everything in it. Inside a folder, symlinks to files are uploaded as files and symlinks to
 * folders are skipped (they could loop or reach anywhere). A picked path that is itself a link is
 * followed: the user chose it.
 */
export async function planUpload(paths: readonly string[]): Promise<UploadPlan> {
  const plan: UploadPlan = { dirs: [], files: [], skipped: 0 };
  const addFile = (local: string, dirs: string[], st: Stats) => {
    if (plan.files.length >= MAX_UPLOAD_FILES) {
      throw new AppError(
        'invalid_input',
        `More than ${MAX_UPLOAD_FILES} files; upload fewer at a time`,
      );
    }
    plan.files.push({ local, dirs, name: basename(local), size: st.size });
  };
  const walk = async (dir: string, dirs: string[]): Promise<void> => {
    if (dirs.length > MAX_UPLOAD_DEPTH) {
      plan.skipped++;
      return;
    }
    plan.dirs.push(dirs);
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      plan.skipped++;
      return;
    }
    const names: string[] = [];
    for await (const entry of handle) names.push(entry.name);
    names.sort();
    for (const name of names) {
      const local = join(dir, name);
      const entry = await lstat(local).catch(() => undefined);
      if (!entry) {
        plan.skipped++;
      } else if (entry.isDirectory()) {
        await walk(local, [...dirs, name]);
      } else if (entry.isFile()) {
        addFile(local, dirs, entry);
      } else if (entry.isSymbolicLink()) {
        const target = await stat(local).catch(() => undefined);
        if (target?.isFile()) addFile(local, dirs, target);
        else plan.skipped++;
      } else {
        plan.skipped++;
      }
    }
  };
  for (const path of paths) {
    const st = await stat(path).catch(() => undefined);
    if (st?.isFile()) addFile(path, [], st);
    else if (st?.isDirectory()) await walk(path, [basename(path)]);
    else plan.skipped++;
  }
  return plan;
}
