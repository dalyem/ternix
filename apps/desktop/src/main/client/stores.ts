import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Persistence the client needs, behind interfaces so Electron can supply its own: the
 * app backs `SecretStore` with `safeStorage`. Values are small JSON-compatible blobs; the
 * client validates whatever it reads back, so a corrupt store reads as empty.
 */

/** Holds the session (token and encrypted account key). Keep it in the OS keychain. */
export interface SecretStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Per-account offline cache, namespaced by `account`. The client writes only ciphertext,
 * wrapped keys and sync cursors here, never plaintext or unwrapped keys.
 */
export interface CacheStore {
  get(account: string, key: string): Promise<unknown>;
  set(account: string, key: string, value: unknown): Promise<void>;
  delete(account: string, key: string): Promise<void>;
  /** Remove everything stored for the account. */
  clear(account: string): Promise<void>;
}

const clone = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export class MemorySecretStore implements SecretStore {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<unknown> {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export class MemoryCacheStore implements CacheStore {
  private readonly data = new Map<string, Map<string, string>>();

  async get(account: string, key: string): Promise<unknown> {
    const raw = this.data.get(account)?.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  async set(account: string, key: string, value: unknown): Promise<void> {
    let entries = this.data.get(account);
    if (!entries) this.data.set(account, (entries = new Map()));
    entries.set(key, JSON.stringify(clone(value)));
  }

  async delete(account: string, key: string): Promise<void> {
    this.data.get(account)?.delete(key);
  }

  async clear(account: string): Promise<void> {
    this.data.delete(account);
  }

  /** Everything stored, serialized; lets tests check that no plaintext reached the cache. */
  dump(): string {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [account, entries] of this.data) {
      out[account] = Object.fromEntries([...entries].map(([k, v]) => [k, JSON.parse(v)]));
    }
    return JSON.stringify(out);
  }
}

/** File name for an arbitrary key: readable prefix plus a hash, so no key escapes the dir. */
function fileNameFor(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `${safe}.${hash}.json`;
}

const pending = new Map<string, Promise<void>>();

/** Run `task` after every earlier task for the same file, so writes land in call order. */
function serialize(file: string, task: () => Promise<void>): Promise<void> {
  const next = (pending.get(file) ?? Promise.resolve()).then(task, task);
  const settled = next.catch(() => undefined);
  pending.set(file, settled);
  void settled.then(() => {
    if (pending.get(file) === settled) pending.delete(file);
  });
  return next;
}

/** Write `data` to `file` atomically: temp file in the same directory, then rename. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, file);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

/**
 * One JSON file per key. Plain files: fine for tests and development, but a real app
 * should keep the session in the OS keychain (Electron `safeStorage`) instead.
 */
export class JsonFileSecretStore implements SecretStore {
  constructor(private readonly dir: string) {}

  async get(key: string): Promise<unknown> {
    return readJson(join(this.dir, fileNameFor(key)));
  }

  async set(key: string, value: unknown): Promise<void> {
    const file = join(this.dir, fileNameFor(key));
    const data = JSON.stringify(value);
    await serialize(file, async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(file, data);
    });
  }

  async delete(key: string): Promise<void> {
    const file = join(this.dir, fileNameFor(key));
    await serialize(file, () => removeFile(file));
  }
}

/** One directory per account (hashed name), one JSON file per key. */
export class JsonFileCacheStore implements CacheStore {
  constructor(private readonly dir: string) {}

  private accountDir(account: string): string {
    return join(this.dir, createHash('sha256').update(account).digest('hex').slice(0, 32));
  }

  async get(account: string, key: string): Promise<unknown> {
    return readJson(join(this.accountDir(account), fileNameFor(key)));
  }

  async set(account: string, key: string, value: unknown): Promise<void> {
    const dir = this.accountDir(account);
    const file = join(dir, fileNameFor(key));
    const data = JSON.stringify(value);
    await serialize(file, async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(file, data);
    });
  }

  async delete(account: string, key: string): Promise<void> {
    const file = join(this.accountDir(account), fileNameFor(key));
    await serialize(file, () => removeFile(file));
  }

  async clear(account: string): Promise<void> {
    await rm(this.accountDir(account), { recursive: true, force: true });
  }

  /** File names currently stored for an account (tests). */
  async files(account: string): Promise<string[]> {
    try {
      return await readdir(this.accountDir(account));
    } catch {
      return [];
    }
  }
}
