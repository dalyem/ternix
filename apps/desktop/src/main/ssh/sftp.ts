import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { remoteBaseName, remoteChild, type SftpClient, type SftpEntry } from '@ternix/ssh';
import type {
  AppEventName,
  AppEvents,
  SftpEntryDto,
  SftpListingDto,
  SftpSessionDto,
  TransferBatchDto,
  TransferDto,
} from '../../shared/app.js';
import { AppError } from '../app/errors.js';
import type { MessageBox } from '../app/trust.js';
import {
  createLocalFile,
  LocalDestination,
  type LocalFile,
  openLocalReader,
  planUpload,
  printable,
  unsafeLocalName,
} from './localFiles.js';
import type { SshManager } from './manager.js';

export interface SftpManagerDeps {
  ssh: Pick<
    SshManager,
    'openSftp' | 'listSftp' | 'reconnectSftp' | 'close' | 'sftpClient' | 'onSftpEnded'
  >;
  emit<K extends AppEventName>(name: K, payload: AppEvents[K]): void;
  /** File operations need an unlocked vault, like new connections. */
  isUnlocked(): boolean;
  platform: NodeJS.Platform;
  /** Main's native message box (confirmations). */
  messageBox: MessageBox;
  /** Main's native open dialog; empty when cancelled. */
  pickUploads(kind: 'files' | 'folder'): Promise<string[]>;
  /** Main's native save dialog for one file; null when cancelled. */
  pickDownloadFile(defaultName: string): Promise<string | null>;
  /** Main's native folder dialog; null when cancelled. */
  pickDownloadFolder(): Promise<string | null>;
  /** How often a running transfer reports progress. Default 200 ms. */
  progressIntervalMs?: number;
}

/** Files copied at the same time per SFTP session. */
const PARALLEL_TRANSFERS = 2;
const MAX_DOWNLOAD_FILES = 10_000;
const MAX_DOWNLOAD_DEPTH = 64;
/** Finished transfers kept for the panel; the oldest go first. */
const MAX_FINISHED = 200;
const DIALOG_LIST_MAX = 8;

type Conflict = 'replace' | 'skip';

/** One upload or download request: conflicts answered "for all" apply to its other files. */
interface Batch {
  conflict: Conflict | undefined;
}

interface Job {
  dto: TransferDto;
  abort: AbortController;
  run: (job: Job) => Promise<'done' | 'skipped'>;
  lastEmit: number;
  timer: NodeJS.Timeout | undefined;
}

const finished = (state: TransferDto['state']) =>
  state === 'done' || state === 'failed' || state === 'cancelled' || state === 'skipped';

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function entryDto(e: SftpEntry): SftpEntryDto {
  return {
    name: e.name,
    path: e.path,
    type: e.type,
    ...(e.targetType !== undefined ? { targetType: e.targetType } : {}),
    size: e.size,
    mtime: e.mtime,
    mode: e.mode,
  };
}

/** A list of names for a dialog: the first few, then how many more. */
function listForDialog(names: readonly string[]): string {
  const shown = names.slice(0, DIALOG_LIST_MAX).map((n) => printable(n));
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join('\n')}\n…and ${more} more` : shown.join('\n');
}

/**
 * SFTP for the renderer: browsing and changes on the server, and a transfer queue. Connections
 * belong to `SshManager` (an SFTP session is a tab there, made like a terminal); this class only
 * uses their channels. Every local path comes from main's own dialogs or from files dropped on
 * the window (see `localFiles.ts`).
 */
export class SftpManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queued = new Map<string, Job[]>();
  private readonly running = new Map<string, number>();
  /** Conflict questions, one dialog at a time. */
  private asking: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SftpManagerDeps) {
    deps.ssh.onSftpEnded((id) => this.dropSession(id));
  }

  // Sessions

  open(hostId: string): SftpSessionDto {
    this.requireUnlocked();
    return this.deps.ssh.openSftp(hostId);
  }

  list(): SftpSessionDto[] {
    return this.deps.ssh.listSftp();
  }

  reconnect(id: string): SftpSessionDto {
    this.requireUnlocked();
    return this.deps.ssh.reconnectSftp(id);
  }

  close(id: string): Promise<void> {
    if (!this.deps.ssh.listSftp().some((s) => s.id === id)) return Promise.resolve();
    return this.deps.ssh.close(id);
  }

  // Remote operations

  async readdir(id: string, path: string): Promise<SftpListingDto> {
    const sftp = this.client(id);
    const resolved = await sftp.realpath(path);
    const entries = await sftp.list(resolved);
    return { path: resolved, entries: entries.map(entryDto) };
  }

  async mkdir(id: string, path: string): Promise<void> {
    await this.client(id).mkdir(path);
  }

  async rename(id: string, from: string, to: string): Promise<void> {
    await this.client(id).rename(from, to);
  }

  /** After the user confirms in main's dialog: folders go with everything in them. */
  async remove(id: string, paths: string[]): Promise<void> {
    const sftp = this.client(id);
    const label = this.label(id);
    const answer = await this.deps.messageBox({
      type: 'warning',
      title: 'Delete files',
      message:
        paths.length === 1
          ? `Delete “${printable(remoteBaseName(paths[0]!))}” from ${label}?`
          : `Delete ${paths.length} items from ${label}?`,
      detail: `${listForDialog(paths)}\n\nFolders are deleted with everything in them; links are removed, never what they point to. This cannot be undone.`,
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) throw new AppError('cancelled', 'Not deleted.');
    for (const path of paths) await sftp.remove(path);
  }

  // Transfers

  transfers(): TransferDto[] {
    return [...this.jobs.values()].map((j) => ({ ...j.dto }));
  }

  /** Upload what the user picks in main's open dialog into `remoteDir`. */
  async upload(id: string, remoteDir: string, kind: 'files' | 'folder'): Promise<TransferBatchDto> {
    this.client(id);
    const paths = await this.deps.pickUploads(kind);
    if (paths.length === 0) return { queued: 0, skipped: 0 };
    return this.queueUpload(id, remoteDir, paths);
  }

  /** Upload files dropped on the window; the paths come from the preload, never the page. */
  async uploadDropped(id: string, remoteDir: string, paths: string[]): Promise<TransferBatchDto> {
    this.client(id);
    return this.queueUpload(id, remoteDir, paths);
  }

  /**
   * Download remote paths. One file: to where the user saves it in main's save dialog. Several,
   * or a folder: into a folder the user picks, under the server's names (checked first).
   */
  async download(id: string, paths: string[]): Promise<TransferBatchDto> {
    const sftp = this.client(id);
    const kinds: { path: string; type: 'file' | 'directory' | 'skip' }[] = [];
    for (const path of paths) kinds.push({ path, type: await this.followedType(sftp, path) });
    const batch: Batch = { conflict: undefined };
    const only = kinds.length === 1 ? kinds[0] : undefined;

    if (only?.type === 'file') {
      const remoteName = remoteBaseName(only.path);
      const suggested = unsafeLocalName(remoteName, this.deps.platform) ? 'download' : remoteName;
      const chosen = await this.deps.pickDownloadFile(suggested);
      if (!chosen) return { queued: 0, skipped: 0 };
      // The save dialog asked before replacing an existing file.
      this.enqueue(
        id,
        this.downloadJob(id, sftp, only.path, basename(chosen), batch, {
          open: (replace) => createLocalFile(dirname(chosen), basename(chosen), replace),
          exists: () => this.exists(chosen),
          confirmedReplace: true,
        }),
      );
      return { queued: 1, skipped: 0 };
    }

    const folder = await this.deps.pickDownloadFolder();
    if (!folder) return { queued: 0, skipped: 0 };
    const dest = await LocalDestination.open(folder, this.deps.platform);
    const counts = { queued: 0, skipped: 0 };
    const jobs: Job[] = [];
    const addFile = (remote: string, parent: string) => {
      const name = remoteBaseName(remote);
      if (jobs.length >= MAX_DOWNLOAD_FILES) {
        throw new AppError(
          'invalid_input',
          `More than ${MAX_DOWNLOAD_FILES} files; download fewer at a time`,
        );
      }
      jobs.push(
        this.downloadJob(id, sftp, remote, name, batch, {
          open: (replace) => dest.file(parent, name, replace),
          exists: async () => (await dest.existing(parent, name)) !== undefined,
          confirmedReplace: false,
        }),
      );
    };
    const walk = async (remote: string, parent: string, depth: number): Promise<void> => {
      const local = await this.safely(id, 'download', remote, () =>
        dest.directory(parent, remoteBaseName(remote)),
      );
      if (local === undefined) {
        counts.skipped++;
        return;
      }
      if (depth > MAX_DOWNLOAD_DEPTH) {
        counts.skipped++;
        return;
      }
      const entries = await this.safely(id, 'download', remote, () => sftp.list(remote));
      if (entries === undefined) {
        counts.skipped++;
        return;
      }
      for (const entry of entries) {
        const type = entry.type === 'symlink' ? entry.targetType : entry.type;
        if (entry.type === 'directory') {
          await walk(entry.path, local, depth + 1);
        } else if (type === 'file') {
          if (this.checkedName(id, entry.path, counts)) addFile(entry.path, local);
        } else {
          // Links to folders are not followed inside a folder; sockets and devices are not files.
          counts.skipped++;
        }
      }
    };
    for (const { path, type } of kinds) {
      if (type === 'directory') await walk(path, dest.root, 0);
      else if (type === 'file' && this.checkedName(id, path, counts)) addFile(path, dest.root);
      else if (type !== 'file') counts.skipped++;
    }
    for (const job of jobs) this.enqueue(id, job);
    counts.queued = jobs.length;
    return counts;
  }

  cancel(transferId: string): void {
    const job = this.jobs.get(transferId);
    if (!job || finished(job.dto.state)) return;
    job.abort.abort();
    const queue = this.queued.get(job.dto.sessionId);
    const index = queue?.indexOf(job) ?? -1;
    if (queue && index !== -1) {
      queue.splice(index, 1);
      this.setState(job, 'cancelled');
    }
  }

  /** Forget finished transfers. */
  clearFinished(): void {
    const ids = [...this.jobs.values()].filter((j) => finished(j.dto.state)).map((j) => j.dto.id);
    for (const id of ids) this.jobs.delete(id);
    if (ids.length > 0) this.deps.emit('sftp.transfers-removed', { ids });
  }

  // Internals

  private requireUnlocked(): void {
    if (!this.deps.isUnlocked()) throw new AppError('locked', 'Unlock Ternix first.');
  }

  private client(id: string): SftpClient {
    this.requireUnlocked();
    return this.deps.ssh.sftpClient(id);
  }

  private label(id: string): string {
    return printable(this.deps.ssh.listSftp().find((s) => s.id === id)?.label ?? 'the server');
  }

  /** `file` or `directory` after following a link at the top level (the user picked it). */
  private async followedType(
    sftp: SftpClient,
    path: string,
  ): Promise<'file' | 'directory' | 'skip'> {
    const st = await sftp.lstat(path);
    const type =
      st.type === 'symlink' ? (await sftp.stat(path).catch(() => undefined))?.type : st.type;
    return type === 'file' || type === 'directory' ? type : 'skip';
  }

  private exists(path: string): Promise<boolean> {
    return lstat(path).then(
      () => true,
      () => false,
    );
  }

  /** Whether the server's name for a file can be a local name; if not, a skipped transfer says why. */
  private checkedName(id: string, remote: string, counts: { skipped: number }): boolean {
    const reason = unsafeLocalName(remoteBaseName(remote), this.deps.platform);
    if (!reason) return true;
    counts.skipped++;
    this.record(id, 'download', remote, 'skipped', `Not downloaded: the name ${reason}`);
    return false;
  }

  /** Run a local step; its failure becomes a skipped transfer that says why. */
  private async safely<T>(
    id: string,
    direction: TransferDto['direction'],
    remote: string,
    step: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await step();
    } catch (err) {
      this.record(id, direction, remote, 'skipped', errMessage(err));
      return undefined;
    }
  }

  /** A transfer that never runs, listed so the user sees what was left out and why. */
  private record(
    sessionId: string,
    direction: TransferDto['direction'],
    remotePath: string,
    state: TransferDto['state'],
    error: string,
  ): void {
    const job = this.newJob(
      sessionId,
      direction,
      remoteBaseName(remotePath),
      remotePath,
      0,
      async () => 'skipped',
    );
    job.dto.state = state;
    job.dto.error = error;
    this.jobs.set(job.dto.id, job);
    this.trim();
    this.emitNow(job);
  }

  private async queueUpload(
    id: string,
    remoteDir: string,
    paths: string[],
  ): Promise<TransferBatchDto> {
    const sftp = this.client(id);
    const plan = await planUpload(paths);
    const remotePathOf = (dirs: string[], name?: string) =>
      [...dirs, ...(name === undefined ? [] : [name])].reduce(
        (dir, part) => remoteChild(dir, part),
        remoteDir,
      );
    // Folders first, parents before children; a folder that exists is used as it is.
    for (const dirs of plan.dirs) {
      const path = remotePathOf(dirs);
      try {
        await sftp.mkdir(path);
      } catch (err) {
        const existing = await sftp.lstat(path).catch(() => undefined);
        if (existing?.type !== 'directory') throw err;
      }
    }
    const batch: Batch = { conflict: undefined };
    for (const file of plan.files) {
      const remote = remotePathOf(file.dirs, file.name);
      const job = this.newJob(id, 'upload', file.name, remote, file.size, async (j) => {
        const reader = await openLocalReader(file.local);
        try {
          const options = {
            signal: j.abort.signal,
            onProgress: (p: { transferred: number; total: number }) => this.progress(j, p),
          };
          try {
            await sftp.upload(reader, remote, { ...options, overwrite: false });
          } catch (err) {
            if ((err as { code?: unknown }).code !== 'already_exists') throw err;
            if ((await this.askConflict(id, batch, 'upload', file.name, j)) === 'skip')
              return 'skipped';
            await sftp.upload(reader, remote, { ...options, overwrite: true });
          }
          return 'done';
        } finally {
          await reader.close().catch(() => undefined);
        }
      });
      this.enqueue(id, job);
    }
    return { queued: plan.files.length, skipped: plan.skipped };
  }

  private downloadJob(
    sessionId: string,
    sftp: SftpClient,
    remote: string,
    name: string,
    batch: Batch,
    local: {
      open: (replace: boolean) => Promise<LocalFile>;
      exists: () => Promise<boolean>;
      /** The user already agreed to replace (main's save dialog asked). */
      confirmedReplace: boolean;
    },
  ): Job {
    return this.newJob(sessionId, 'download', name, remote, 0, async (j) => {
      let replace = false;
      if (await local.exists()) {
        if (
          !local.confirmedReplace &&
          (await this.askConflict(sessionId, batch, 'download', name, j)) === 'skip'
        ) {
          return 'skipped';
        }
        replace = true;
      }
      const file = await local.open(replace);
      try {
        await sftp.download(remote, file.sink, {
          signal: j.abort.signal,
          onProgress: (p) => this.progress(j, p),
        });
        await file.finish();
      } catch (err) {
        await file.discard();
        throw err;
      }
      return 'done';
    });
  }

  /** Replace or skip an existing file: the batch's answer, or main's dialog (one at a time). */
  private askConflict(
    sessionId: string,
    batch: Batch,
    direction: TransferDto['direction'],
    name: string,
    job: Job,
  ): Promise<Conflict> {
    const ask = async (): Promise<Conflict> => {
      if (batch.conflict) return batch.conflict;
      if (job.abort.signal.aborted) throw new AppError('cancelled', 'Cancelled');
      const where = direction === 'upload' ? `on ${this.label(sessionId)}` : 'in the chosen folder';
      const answer = await this.deps.messageBox({
        type: 'question',
        title: 'File already exists',
        message: `“${printable(name)}” already exists ${where}.`,
        detail:
          direction === 'upload'
            ? 'Replace the file on the server with the one you are uploading?'
            : 'Replace the file on this computer with the one from the server?',
        buttons: ['Skip', 'Replace'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        checkboxLabel: 'Do the same for the other files of this transfer',
        signal: job.abort.signal,
      });
      if (job.abort.signal.aborted) throw new AppError('cancelled', 'Cancelled');
      const choice: Conflict = answer.response === 1 ? 'replace' : 'skip';
      if (answer.checkboxChecked) batch.conflict = choice;
      return choice;
    };
    const next = this.asking.then(ask, ask);
    this.asking = next.catch(() => undefined);
    return next;
  }

  private newJob(
    sessionId: string,
    direction: TransferDto['direction'],
    name: string,
    remotePath: string,
    total: number,
    run: Job['run'],
  ): Job {
    return {
      dto: {
        id: randomUUID(),
        sessionId,
        direction,
        name,
        remotePath,
        state: 'queued',
        transferred: 0,
        total,
      },
      abort: new AbortController(),
      run,
      lastEmit: 0,
      timer: undefined,
    };
  }

  private enqueue(sessionId: string, job: Job): void {
    this.jobs.set(job.dto.id, job);
    this.trim();
    let queue = this.queued.get(sessionId);
    if (!queue) this.queued.set(sessionId, (queue = []));
    queue.push(job);
    this.emitNow(job);
    this.pump(sessionId);
  }

  private pump(sessionId: string): void {
    const queue = this.queued.get(sessionId);
    while (queue && queue.length > 0 && (this.running.get(sessionId) ?? 0) < PARALLEL_TRANSFERS) {
      const job = queue.shift()!;
      this.running.set(sessionId, (this.running.get(sessionId) ?? 0) + 1);
      void this.execute(job).finally(() => {
        this.running.set(sessionId, Math.max(0, (this.running.get(sessionId) ?? 1) - 1));
        this.pump(sessionId);
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    if (job.abort.signal.aborted) return this.setState(job, 'cancelled');
    this.setState(job, 'running');
    try {
      const outcome = await job.run(job);
      this.setState(job, outcome);
    } catch (err) {
      if (job.abort.signal.aborted || (err as { code?: unknown }).code === 'cancelled') {
        this.setState(job, 'cancelled');
      } else {
        this.setState(job, 'failed', errMessage(err));
      }
    }
  }

  private progress(job: Job, p: { transferred: number; total: number }): void {
    job.dto.transferred = p.transferred;
    job.dto.total = Math.max(p.total, p.transferred);
    const interval = this.deps.progressIntervalMs ?? 200;
    const wait = job.lastEmit + interval - Date.now();
    if (wait <= 0) return this.emitNow(job);
    job.timer ??= setTimeout(() => {
      job.timer = undefined;
      this.emitNow(job);
    }, wait);
  }

  private setState(job: Job, state: TransferDto['state'], error?: string): void {
    job.dto.state = state;
    if (error !== undefined) job.dto.error = error;
    else delete job.dto.error;
    this.emitNow(job);
  }

  private emitNow(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
    if (this.jobs.get(job.dto.id) !== job) return;
    job.lastEmit = Date.now();
    this.deps.emit('sftp.transfer', { ...job.dto });
  }

  /** Keep at most `MAX_FINISHED` finished transfers. */
  private trim(): void {
    const done = [...this.jobs.values()].filter((j) => finished(j.dto.state));
    const extra = done.length - MAX_FINISHED;
    if (extra <= 0) return;
    const ids = done.slice(0, extra).map((j) => j.dto.id);
    for (const id of ids) this.jobs.delete(id);
    this.deps.emit('sftp.transfers-removed', { ids });
  }

  /** The session's tab is gone: stop its transfers and forget them. */
  private dropSession(sessionId: string): void {
    this.queued.delete(sessionId);
    const ids: string[] = [];
    for (const job of [...this.jobs.values()]) {
      if (job.dto.sessionId !== sessionId) continue;
      job.abort.abort();
      if (job.timer) clearTimeout(job.timer);
      this.jobs.delete(job.dto.id);
      ids.push(job.dto.id);
    }
    if (ids.length > 0) this.deps.emit('sftp.transfers-removed', { ids });
  }
}
