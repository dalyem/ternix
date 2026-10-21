import { posix } from 'node:path';
import type { Attributes, SFTPWrapper, Stats } from 'ssh2';
import { errorMessage, SshError } from './errors.js';
import type { Unsubscribe } from './session.js';

/**
 * Remote file operations over one SFTP channel (`SshSession.openSftp`). Paths are POSIX paths on
 * the server. The local side is never touched here: a download writes into a `LocalSink` and an
 * upload reads from a `LocalSource` the caller opened, so whoever owns the local filesystem
 * decides what may be read or written.
 */

export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface SftpStat {
  type: SftpEntryType;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  /** Mode bits as the server reports them (type and permissions). */
  mode: number;
}

export interface SftpEntry extends SftpStat {
  name: string;
  /** `dir` joined with `name`. */
  path: string;
  /**
   * For a symlink: the type of what it points to (one `stat`, which follows the link), or
   * `missing` when that cannot be read (dangling, a loop, no permission).
   */
  targetType?: SftpEntryType | 'missing';
}

export interface TransferProgress {
  /** Bytes moved so far. */
  transferred: number;
  /** The size reported when the transfer started; a file that grows meanwhile can pass it. */
  total: number;
}

export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
  /** Called when the transfer leaves the queue and starts moving bytes. */
  onStart?: () => void;
}

export interface UploadOptions extends TransferOptions {
  /** Replace an existing remote file; without it, an existing file fails with `already_exists`. */
  overwrite: boolean;
}

/** Where a download writes: positional writes, awaited one by one per request in flight. */
export interface LocalSink {
  write(data: Buffer, position: number): Promise<void>;
}

/** What an upload reads from: positional reads; 0 bytes means the end. */
export interface LocalSource {
  /** Size when the upload starts, for progress. */
  size: number;
  read(buffer: Buffer, position: number): Promise<number>;
}

export interface SftpOptions {
  /** How long one SFTP request may go unanswered before the channel is closed. Default 60 s. */
  requestTimeoutMs?: number;
  /** Transfers that move bytes at the same time; more wait in a queue. Default 2. */
  maxTransfers?: number;
  /** Most entries one listing returns before it gives up. Default 100 000. */
  maxEntries?: number;
}

export interface RemoveOptions {
  signal?: AbortSignal;
  /** Most entries a recursive delete may remove. Default 100 000. */
  maxEntries?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TRANSFERS = 2;
const DEFAULT_MAX_ENTRIES = 100_000;
/** Bytes per read or write request, and requests in flight per transfer. */
const CHUNK_BYTES = 32 * 1024;
const REQUESTS_IN_FLIGHT = 16;
/** Symlink targets looked up at the same time while listing. */
const STAT_CONCURRENCY = 8;
const MAX_TREE_DEPTH = 256;

// SFTP v3 status codes (draft-ietf-secsh-filexfer-02).
const STATUS_NO_SUCH_FILE = 2;
const STATUS_PERMISSION_DENIED = 3;
const STATUS_NO_CONNECTION = 6;
const STATUS_CONNECTION_LOST = 7;
const STATUS_OP_UNSUPPORTED = 8;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function typeOfMode(mode: number): SftpEntryType {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'directory';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'symlink';
    default:
      return 'other';
  }
}

function toStat(attrs: Attributes): SftpStat {
  const mode = typeof attrs.mode === 'number' ? attrs.mode : 0;
  return {
    type: typeOfMode(mode),
    size: typeof attrs.size === 'number' ? attrs.size : 0,
    mtime: typeof attrs.mtime === 'number' ? attrs.mtime : 0,
    mode,
  };
}

/** The last component of a POSIX path (`/` for the root). */
export function remoteBaseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : posix.basename(trimmed);
}

/** `name` inside directory `dir`, for a name that is one component (no `/`, not `.` or `..`). */
export function remoteChild(dir: string, name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new SshError('sftp_failed', `"${name}" is not a valid file name`);
  }
  return posix.join(dir, name);
}

const cancelled = () => new SshError('cancelled', 'Cancelled');

/** A counting semaphore: at most `limit` holders at once, the rest wait in order. */
class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  /** Resolves with a release function once there is room; rejects if `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiting.shift()?.();
        });
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(grant);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(cancelled());
      };
      if (this.active < this.limit) return grant();
      this.waiting.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Run `work` over `items` with at most `limit` at once. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++] as T);
  });
  await Promise.all(runners);
}

/**
 * An open SFTP channel. Each request has a timeout; when one passes, the channel is closed (a
 * server that stopped answering one request has stopped answering all of them) and every
 * request still waiting fails with `timeout`. When the channel or the connection under it goes
 * away, waiting requests fail with `closed`.
 */
export class SftpClient {
  private readonly closeListeners = new Set<(error: SshError | undefined) => void>();
  private readonly transfers: Limiter;
  private closedWith: SshError | undefined;
  private isClosed = false;

  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly options: SftpOptions = {},
  ) {
    this.transfers = new Limiter(Math.max(1, options.maxTransfers ?? DEFAULT_MAX_TRANSFERS));
    sftp.on('error', (err: unknown) => {
      this.closedWith ??= new SshError('closed', `SFTP failed: ${errorMessage(err)}`, {
        cause: err,
      });
    });
    sftp.once('close', () => this.markClosed());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Fires once when the channel has closed: with the error that closed it, if one did. */
  onClose(listener: (error: SshError | undefined) => void): Unsubscribe {
    if (this.isClosed) {
      listener(this.closedWith);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => void this.closeListeners.delete(listener);
  }

  /** Close the channel; requests still waiting fail with `closed`. */
  close(): void {
    if (this.isClosed) return;
    try {
      this.sftp.end();
    } catch {
      // Already gone.
    }
  }

  /** Drop the channel without waiting for the server (session teardown). */
  destroy(): void {
    this.close();
    this.markClosed();
  }

  /** The absolute form of `path`; `.` is the login directory. */
  realpath(path = '.'): Promise<string> {
    return this.request(path, (cb) => this.sftp.realpath(path, cb));
  }

  /** Follows symlinks. */
  async stat(path: string): Promise<SftpStat> {
    return toStat(await this.request<Stats>(path, (cb) => this.sftp.stat(path, cb)));
  }

  /** Does not follow symlinks: a link reads as `symlink`. */
  async lstat(path: string): Promise<SftpStat> {
    return toStat(await this.request<Stats>(path, (cb) => this.sftp.lstat(path, cb)));
  }

  /**
   * The entries of a directory, without `.` and `..`. Each symlink's target is looked up with
   * `stat` so the caller can tell a link to a directory from a link to a file.
   */
  async list(path: string): Promise<SftpEntry[]> {
    const handle = await this.request<Buffer>(path, (cb) => this.sftp.opendir(path, cb));
    const entries: SftpEntry[] = [];
    const max = this.options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    try {
      for (;;) {
        const batch = await this.request<{ filename: string; attrs: Attributes }[] | false>(
          path,
          (cb) =>
            this.sftp.readdir(handle, (err, list) => {
              // The end of the listing is a status EOF, not an error.
              if (err && (err as { code?: unknown }).code === 1) return cb(undefined, false);
              cb(err, list);
            }),
        );
        if (batch === false) break;
        for (const item of batch) {
          const name = item.filename;
          if (name === '.' || name === '..' || name === '' || name.includes('/')) continue;
          entries.push({ name, path: posix.join(path, name), ...toStat(item.attrs) });
        }
        if (entries.length > max) {
          throw new SshError('sftp_failed', `${path} has more than ${max} entries`);
        }
      }
    } finally {
      await this.closeHandle(handle);
    }
    const links = entries.filter((e) => e.type === 'symlink');
    await eachLimited(links, STAT_CONCURRENCY, async (entry) => {
      try {
        entry.targetType = (await this.stat(entry.path)).type;
      } catch (err) {
        if (this.isClosed) throw err;
        entry.targetType = 'missing';
      }
    });
    return entries;
  }

  async mkdir(path: string): Promise<void> {
    try {
      await this.request<void>(path, (cb) => this.sftp.mkdir(path, cb));
    } catch (err) {
      throw await this.explainExisting(err, path);
    }
  }

  /** Rename or move. Fails when `to` exists (SFTP v3 rename never replaces). */
  async rename(from: string, to: string): Promise<void> {
    try {
      await this.request<void>(from, (cb) => this.sftp.rename(from, to, cb));
    } catch (err) {
      throw await this.explainExisting(err, to);
    }
  }

  /** Remove a file or a symlink (never what the link points to). */
  removeFile(path: string): Promise<void> {
    return this.request<void>(path, (cb) => this.sftp.unlink(path, cb));
  }

  /**
   * Remove whatever is at `path`. A directory is removed with everything in it. Symlinks are
   * never followed: each entry is `lstat`ed first and a link is unlinked like a file, so a link
   * to a directory elsewhere removes the link and leaves the directory alone.
   */
  async remove(path: string, options: RemoveOptions = {}): Promise<void> {
    const budget = { left: options.maxEntries ?? DEFAULT_MAX_ENTRIES };
    await this.removeTree(path, 0, budget, options.signal);
  }

  /**
   * Copy a remote file into `sink`. Up to 16 read requests are in flight; each chunk is written
   * (and the write awaited) before its slot asks for more, so memory stays bounded however slow
   * the sink is. Waits in the transfer queue first. Rejects with `cancelled` once `signal` aborts;
   * the caller removes what was written.
   */
  async download(remotePath: string, sink: LocalSink, options: TransferOptions = {}) {
    const { signal } = options;
    const release = await this.transfers.acquire(signal);
    try {
      options.onStart?.();
      const handle = await this.request<Buffer>(remotePath, (cb) =>
        this.sftp.open(remotePath, 'r', cb),
      );
      try {
        const st = toStat(
          await this.request<Stats>(remotePath, (cb) => this.sftp.fstat(handle, cb)),
        );
        if (st.type === 'directory') {
          throw new SshError('sftp_failed', `${remotePath} is a directory`);
        }
        const progress = { transferred: 0, total: st.size };
        let next = 0;
        let ended = false;
        await this.inParallel(signal, async (guard, stopped) => {
          const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
          while (!ended && !stopped()) {
            const position = next;
            next += CHUNK_BYTES;
            let got = 0;
            while (got < CHUNK_BYTES) {
              const n = await guard(
                this.request<number>(remotePath, (cb) =>
                  this.sftp.read(
                    handle,
                    buffer,
                    got,
                    CHUNK_BYTES - got,
                    position + got,
                    (err, nb) => cb(err, nb),
                  ),
                ),
              );
              if (!n) break;
              got += n;
            }
            if (stopped()) return;
            // Not raced: once the transfer settles, no local write is still running.
            if (got > 0) {
              await sink.write(buffer.subarray(0, got), position);
              progress.transferred += got;
              options.onProgress?.({ ...progress });
            }
            if (got < CHUNK_BYTES) ended = true;
          }
        });
        return { bytes: progress.transferred };
      } finally {
        await this.closeHandle(handle);
      }
    } finally {
      release();
    }
  }

  /**
   * Copy `source` to a remote file. Without `overwrite`, an existing file fails with
   * `already_exists` (the file is opened with `O_EXCL`). A failed or cancelled upload removes
   * the partial file when the channel still works. Waits in the transfer queue first.
   */
  async upload(source: LocalSource, remotePath: string, options: UploadOptions) {
    const { signal } = options;
    const release = await this.transfers.acquire(signal);
    try {
      options.onStart?.();
      let handle: Buffer;
      try {
        handle = await this.request<Buffer>(remotePath, (cb) =>
          this.sftp.open(remotePath, options.overwrite ? 'w' : 'wx', cb),
        );
      } catch (err) {
        throw options.overwrite ? err : await this.explainExisting(err, remotePath);
      }
      const progress = { transferred: 0, total: source.size };
      let next = 0;
      let ended = false;
      let failure: unknown;
      try {
        await this.inParallel(signal, async (guard, stopped) => {
          const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
          while (!ended && !stopped()) {
            const position = next;
            next += CHUNK_BYTES;
            // Not raced: once the transfer settles, no local read is still running.
            const n = await source.read(buffer, position);
            if (n <= 0) {
              ended = true;
              break;
            }
            await guard(
              this.request<void>(remotePath, (cb) =>
                this.sftp.write(handle, buffer, 0, n, position, (err) => cb(err)),
              ),
            );
            progress.transferred += n;
            options.onProgress?.({ ...progress });
          }
        });
      } catch (err) {
        failure = err;
      }
      await this.closeHandle(handle);
      if (failure !== undefined) {
        if (!this.isClosed) await this.removeFile(remotePath).catch(() => undefined);
        throw failure;
      }
      return { bytes: progress.transferred };
    } finally {
      release();
    }
  }

  /**
   * Run `REQUESTS_IN_FLIGHT` copies of `worker` until all return. The first failure (or the
   * abort) stops the others: `guard` rejects every remote wait that is still pending (a late
   * answer from the server is ignored), and `stopped` tells a worker to quit before its next
   * local read or write.
   */
  private async inParallel(
    signal: AbortSignal | undefined,
    worker: (guard: <T>(wait: Promise<T>) => Promise<T>, stopped: () => boolean) => Promise<void>,
  ): Promise<void> {
    let stopped: unknown;
    let stop: (err: unknown) => void = () => undefined;
    const stopping = new Promise<never>((_, reject) => {
      stop = (err) => {
        stopped ??= err;
        reject(stopped);
      };
    });
    stopping.catch(() => undefined);
    const onAbort = () => stop(cancelled());
    if (signal?.aborted) throw cancelled();
    signal?.addEventListener('abort', onAbort, { once: true });
    const guard = <T>(wait: Promise<T>): Promise<T> => {
      if (stopped !== undefined) return Promise.reject(stopped);
      return Promise.race([wait, stopping]);
    };
    try {
      await Promise.all(
        Array.from({ length: REQUESTS_IN_FLIGHT }, () =>
          worker(guard, () => stopped !== undefined).catch((err: unknown) => stop(err)),
        ),
      );
      if (stopped !== undefined) throw stopped;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async removeTree(
    path: string,
    depth: number,
    budget: { left: number },
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal?.aborted) throw cancelled();
    if (--budget.left < 0) {
      throw new SshError('sftp_failed', 'Too many entries to delete; nothing more was removed');
    }
    const st = await this.lstat(path);
    if (st.type !== 'directory') return this.removeFile(path);
    if (depth >= MAX_TREE_DEPTH) {
      throw new SshError('sftp_failed', `${path} is nested too deeply to delete`);
    }
    for (const entry of await this.list(path)) {
      await this.removeTree(entry.path, depth + 1, budget, signal);
    }
    await this.request<void>(path, (cb) => this.sftp.rmdir(path, cb));
  }

  private closeHandle(handle: Buffer): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    return this.request<void>('', (cb) => this.sftp.close(handle, cb)).catch(() => undefined);
  }

  /** A server's generic failure for an existing target, made explicit. */
  private async explainExisting(err: unknown, path: string): Promise<unknown> {
    if (!(err instanceof SshError) || err.code !== 'sftp_failed' || this.isClosed) return err;
    try {
      await this.lstat(path);
    } catch {
      return err;
    }
    return new SshError('already_exists', `${path} already exists`, { cause: err });
  }

  /** One SFTP request: settles once, with a timeout, mapped to `SshError`. */
  private request<T>(
    path: string,
    send: (cb: (err: Error | null | undefined, value?: T) => void) => void,
  ): Promise<T> {
    if (this.isClosed) return Promise.reject(this.closedError());
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (err: unknown, value?: T) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        if (err) reject(this.mapError(err, path));
        else resolve(value as T);
      };
      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.closedWith ??= new SshError('timeout', 'The SFTP server stopped answering');
        finish(this.closedWith);
        this.destroy();
      }, timeoutMs);
      const unsubscribe = this.onClose(() => finish(this.closedError()));
      try {
        send((err, value) => finish(err, value));
      } catch (err) {
        finish(err);
      }
    });
  }

  private closedError(): SshError {
    return this.closedWith ?? new SshError('closed', 'The SFTP connection is closed');
  }

  private mapError(err: unknown, path: string): SshError {
    if (err instanceof SshError) return err;
    if (this.isClosed) return this.closedError();
    const code = (err as { code?: unknown } | null)?.code;
    const text = errorMessage(err);
    const where = path ? `${path}: ` : '';
    switch (code) {
      case STATUS_NO_SUCH_FILE:
        return new SshError('not_found', `${where}No such file or directory`, { cause: err });
      case STATUS_PERMISSION_DENIED:
        return new SshError('permission_denied', `${where}Permission denied`, { cause: err });
      case STATUS_NO_CONNECTION:
      case STATUS_CONNECTION_LOST:
        return new SshError('closed', 'The SFTP connection was lost', { cause: err });
      case STATUS_OP_UNSUPPORTED:
        return new SshError('sftp_failed', `${where}The server does not support this`, {
          cause: err,
        });
      default:
        // ssh2 fails requests that were waiting when the channel ended with this, and no code.
        if (code === undefined && /no response from server/i.test(text)) {
          return new SshError('closed', 'The SFTP connection was lost', { cause: err });
        }
        return new SshError('sftp_failed', `${where}${text}`, { cause: err });
    }
  }

  private markClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const error = this.closedWith;
    for (const listener of [...this.closeListeners]) listener(error);
    this.closeListeners.clear();
  }
}
