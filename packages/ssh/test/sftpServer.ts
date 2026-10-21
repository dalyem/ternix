import { constants as fsConstants } from 'node:fs';
import type { Stats as FsStats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  rename,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, posix } from 'node:path';
import ssh2 from 'ssh2';
import type { Attributes, SFTPWrapper } from 'ssh2';

/**
 * The server side of SFTP for the in-process test servers (`TestSshServer` here and the desktop
 * end-to-end fake sshd): remote paths are POSIX paths under `root`, a real directory, so tests
 * can check what landed on disk. Symlinks are real symlinks; `stat` follows them like a real
 * server would, and nothing stops a link from pointing outside `root` (which is what the
 * recursive-delete test needs).
 */

const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;

export type SftpOperation =
  | 'open'
  | 'read'
  | 'write'
  | 'stat'
  | 'opendir'
  | 'readdir'
  | 'mkdir'
  | 'rmdir'
  | 'remove'
  | 'rename'
  | 'realpath';

export interface SftpServerOptions {
  /** The real directory remote `/` maps to. */
  root: string;
  /** What `realpath('.')` answers: the login directory. Default `/`. */
  home?: string;
  /** Answer PERMISSION_DENIED for this operation on this remote path. */
  deny?: (operation: SftpOperation, path: string) => boolean;
  /** Never answer requests for which this returns true (to exercise timeouts). */
  hang?: (operation: SftpOperation, path: string) => boolean;
  /** Milliseconds to wait before answering this request (a slow link). */
  delay?: (operation: SftpOperation, path: string) => number;
  /** Called for every request, after `deny` and `hang` were consulted. */
  onRequest?: (operation: SftpOperation, path: string) => void;
  /** Entries per READDIR answer. Default 3, so listings take several round trips. */
  readdirBatch?: number;
}

/** What the server records, for assertions. */
export interface SftpServerLog {
  operations: { operation: SftpOperation; path: string }[];
}

interface DirHandle {
  kind: 'dir';
  path: string;
  names: string[] | undefined;
  done: boolean;
}

interface FileEntryHandle {
  kind: 'file';
  path: string;
  file: FileHandle;
}

function attrsOf(st: FsStats): Attributes {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function statusFor(err: unknown): number {
  switch ((err as { code?: unknown } | null)?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return STATUS_CODE.NO_SUCH_FILE;
    case 'EACCES':
    case 'EPERM':
      return STATUS_CODE.PERMISSION_DENIED;
    default:
      return STATUS_CODE.FAILURE;
  }
}

/** Serve SFTP requests on `sftp` (the server side of a channel) from `options.root`. */
export function serveSftp(sftp: SFTPWrapper, options: SftpServerOptions): SftpServerLog {
  const log: SftpServerLog = { operations: [] };
  const handles = new Map<number, DirHandle | FileEntryHandle>();
  let nextHandle = 1;
  const home = options.home ?? '/';
  const batch = options.readdirBatch ?? 3;

  const toLocal = (remote: string): string => {
    const absolute = posix.resolve(home, remote);
    return join(options.root, ...absolute.split('/').filter(Boolean));
  };
  const handleBuffer = (id: number) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(id);
    return buf;
  };
  const handleOf = (buf: Buffer) =>
    buf.length === 4 ? handles.get(buf.readUInt32BE()) : undefined;

  /** Run one request: logs it, applies deny/hang, answers failures as a status. */
  const serve = (
    reqid: number,
    operation: SftpOperation,
    path: string,
    work: () => Promise<void>,
  ): void => {
    log.operations.push({ operation, path });
    if (options.deny?.(operation, path)) {
      sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied');
      return;
    }
    if (options.hang?.(operation, path)) return;
    options.onRequest?.(operation, path);
    const run = () =>
      work().catch((err: unknown) => {
        try {
          sftp.status(reqid, statusFor(err), (err as Error).message);
        } catch {
          // The channel is gone.
        }
      });
    const delay = options.delay?.(operation, path) ?? 0;
    if (delay > 0) setTimeout(run, delay);
    else void run();
  };

  sftp.on('REALPATH', (reqid, path) =>
    serve(reqid, 'realpath', path, async () => {
      const absolute = posix.resolve(home, path);
      sftp.name(reqid, [{ filename: absolute, longname: absolute, attrs: {} as Attributes }]);
    }),
  );

  const statOp = (follow: boolean) => (reqid: number, path: string) =>
    serve(reqid, 'stat', path, async () => {
      const st = follow ? await stat(toLocal(path)) : await lstat(toLocal(path));
      sftp.attrs(reqid, attrsOf(st));
    });
  sftp.on('STAT', statOp(true));
  sftp.on('LSTAT', statOp(false));

  sftp.on('FSTAT', (reqid, handle) => {
    const h = handleOf(handle);
    serve(reqid, 'stat', h?.path ?? '', async () => {
      if (h?.kind !== 'file') throw Object.assign(new Error('bad handle'), { code: 'EBADF' });
      sftp.attrs(reqid, attrsOf(await h.file.stat()));
    });
  });

  sftp.on('OPENDIR', (reqid, path) =>
    serve(reqid, 'opendir', path, async () => {
      const local = toLocal(path);
      const st = await stat(local);
      if (!st.isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
      const id = nextHandle++;
      handles.set(id, { kind: 'dir', path, names: undefined, done: false });
      sftp.handle(reqid, handleBuffer(id));
    }),
  );

  sftp.on('READDIR', (reqid, handle) => {
    const h = handleOf(handle);
    serve(reqid, 'readdir', h?.path ?? '', async () => {
      if (h?.kind !== 'dir') throw Object.assign(new Error('bad handle'), { code: 'EBADF' });
      if (!h.names) {
        const names = ['.', '..'];
        const dir = await opendir(toLocal(h.path));
        for await (const entry of dir) names.push(entry.name);
        h.names = names;
      }
      if (h.names.length === 0) {
        sftp.status(reqid, STATUS_CODE.EOF);
        return;
      }
      const chunk = h.names.splice(0, batch);
      const entries = [];
      for (const name of chunk) {
        // Like OpenSSH: attributes from lstat, so a link reads as a link.
        const st = await lstat(join(toLocal(h.path), name)).catch(() => undefined);
        if (!st) continue;
        entries.push({ filename: name, longname: name, attrs: attrsOf(st) });
      }
      sftp.name(reqid, entries);
    });
  });

  sftp.on('OPEN', (reqid, filename, flags) =>
    serve(reqid, 'open', filename, async () => {
      let mode = 0;
      const write = (flags & OPEN_MODE.WRITE) !== 0;
      const read = (flags & OPEN_MODE.READ) !== 0;
      if (write && read) mode |= fsConstants.O_RDWR;
      else if (write) mode |= fsConstants.O_WRONLY;
      else mode |= fsConstants.O_RDONLY;
      if (flags & OPEN_MODE.CREAT) mode |= fsConstants.O_CREAT;
      if (flags & OPEN_MODE.TRUNC) mode |= fsConstants.O_TRUNC;
      if (flags & OPEN_MODE.EXCL) mode |= fsConstants.O_EXCL;
      if (flags & OPEN_MODE.APPEND) mode |= fsConstants.O_APPEND;
      const file = await open(toLocal(filename), mode, 0o644);
      const id = nextHandle++;
      handles.set(id, { kind: 'file', path: filename, file });
      sftp.handle(reqid, handleBuffer(id));
    }),
  );

  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = handleOf(handle);
    serve(reqid, 'read', h?.path ?? '', async () => {
      if (h?.kind !== 'file') throw Object.assign(new Error('bad handle'), { code: 'EBADF' });
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await h.file.read(buffer, 0, length, offset);
      if (bytesRead === 0) sftp.status(reqid, STATUS_CODE.EOF);
      else sftp.data(reqid, buffer.subarray(0, bytesRead));
    });
  });

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = handleOf(handle);
    serve(reqid, 'write', h?.path ?? '', async () => {
      if (h?.kind !== 'file') throw Object.assign(new Error('bad handle'), { code: 'EBADF' });
      await h.file.write(data, 0, data.length, offset);
      sftp.status(reqid, STATUS_CODE.OK);
    });
  });

  sftp.on('CLOSE', (reqid, handle) => {
    const key = handle.length === 4 ? handle.readUInt32BE() : -1;
    const h = handles.get(key);
    handles.delete(key);
    void (async () => {
      if (h?.kind === 'file') await h.file.close().catch(() => undefined);
      sftp.status(reqid, h ? STATUS_CODE.OK : STATUS_CODE.FAILURE);
    })();
  });

  sftp.on('MKDIR', (reqid, path) =>
    serve(reqid, 'mkdir', path, async () => {
      await mkdir(toLocal(path));
      sftp.status(reqid, STATUS_CODE.OK);
    }),
  );

  sftp.on('RMDIR', (reqid, path) =>
    serve(reqid, 'rmdir', path, async () => {
      await rmdir(toLocal(path));
      sftp.status(reqid, STATUS_CODE.OK);
    }),
  );

  sftp.on('REMOVE', (reqid, path) =>
    serve(reqid, 'remove', path, async () => {
      // unlink(2): a symlink is removed itself, never its target.
      await unlink(toLocal(path));
      sftp.status(reqid, STATUS_CODE.OK);
    }),
  );

  sftp.on('RENAME', (reqid, from, to) =>
    serve(reqid, 'rename', from, async () => {
      // SFTP v3 rename does not replace an existing target (OpenSSH links, then unlinks).
      const exists = await lstat(toLocal(to)).then(
        () => true,
        () => false,
      );
      if (exists) throw Object.assign(new Error('Failure'), { code: 'EEXIST' });
      await rename(toLocal(from), toLocal(to));
      sftp.status(reqid, STATUS_CODE.OK);
    }),
  );

  sftp.on('READLINK', (reqid, path) =>
    serve(reqid, 'stat', path, async () => {
      const target = await readlink(toLocal(path));
      sftp.name(reqid, [{ filename: target, longname: target, attrs: {} as Attributes }]);
    }),
  );

  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));

  sftp.on('close', () => {
    for (const h of handles.values())
      if (h.kind === 'file') void h.file.close().catch(() => undefined);
    handles.clear();
  });
  return log;
}
