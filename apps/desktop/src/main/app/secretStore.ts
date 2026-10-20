import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretStore } from '../client/index.js';
import { AppError } from './errors.js';
import { Serial, writeFileAtomic } from './fsUtil.js';

/** The part of Electron's `safeStorage` this store uses (a fake in tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: `basic_text` means a hard-coded key, no real protection. */
  getSelectedStorageBackend?(): string;
}

export interface SecretStorageStatus {
  available: boolean;
  problem: string | null;
}

const FILE_NAME = 'session.bin';

/**
 * Escape hatch for Linux machines without a keyring (CI, containers). Not a supported
 * configuration: with `basic_text` the "encryption" is only obfuscation.
 */
export const ALLOW_BASIC_TEXT_ENV = 'TERNIX_ALLOW_BASIC_TEXT_SECRET_STORE';

export function secretStorageStatus(
  safe: SafeStorageLike,
  env: Record<string, string | undefined> = process.env,
): SecretStorageStatus {
  if (!safe.isEncryptionAvailable()) {
    return {
      available: false,
      problem:
        'The operating system cannot encrypt secrets for Ternix (no keychain or credential ' +
        'store is available). Ternix will not save your session unencrypted.',
    };
  }
  const backend = safe.getSelectedStorageBackend?.();
  if (backend === 'basic_text' && env[ALLOW_BASIC_TEXT_ENV] !== '1') {
    return {
      available: false,
      problem:
        'No system keyring was found (the Linux fallback would store your session with a ' +
        'hard-coded key). Install and unlock GNOME Keyring or KWallet, then restart Ternix.',
    };
  }
  return { available: true, problem: null };
}

/**
 * The client's `SecretStore` on top of Electron `safeStorage`: all values live in one JSON
 * object, encrypted with the OS keychain key and kept in a single file under `userData`.
 * Writes refuse (rather than fall back to plain text) when the OS cannot encrypt. A file
 * that cannot be decrypted (another OS account, a reset keychain) reads as empty.
 */
export class SafeStorageSecretStore implements SecretStore {
  private readonly file: string;
  private readonly serial = new Serial();

  constructor(
    dir: string,
    private readonly safe: SafeStorageLike,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.file = join(dir, FILE_NAME);
  }

  status(): SecretStorageStatus {
    return secretStorageStatus(this.safe, this.env);
  }

  /** Throws `AppError('secret_storage_unavailable')` unless the OS can encrypt. */
  assertAvailable(): void {
    const status = this.status();
    if (!status.available) {
      throw new AppError('secret_storage_unavailable', status.problem ?? 'Secure storage is off');
    }
  }

  private async load(): Promise<Record<string, unknown>> {
    if (!this.status().available) return {};
    let raw: Buffer;
    try {
      raw = await readFile(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    try {
      const parsed: unknown = JSON.parse(this.safe.decryptString(raw));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  async get(key: string): Promise<unknown> {
    return this.serial.run(async () => (await this.load())[key]);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.assertAvailable();
    await this.serial.run(async () => {
      const data = await this.load();
      data[key] = value;
      await writeFileAtomic(this.file, this.safe.encryptString(JSON.stringify(data)));
    });
  }

  async delete(key: string): Promise<void> {
    await this.serial.run(async () => {
      const data = await this.load();
      if (!(key in data)) return;
      delete data[key];
      if (!this.status().available) return;
      await writeFileAtomic(this.file, this.safe.encryptString(JSON.stringify(data)));
    });
  }
}
