import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeServerUrl } from '../client/serverUrl.js';
import { Serial, writeFileAtomic } from './fsUtil.js';

/**
 * The server address the sign-in screen starts with, in `server.json` under `userData`. Main
 * keeps it rather than the renderer's `localStorage`: a signed-in page could write anything
 * there (say `https://attacker.example/<secret>`), and the fresh page after sign-out would
 * probe it. Main sets it only from a signed-out page's choice or a successful sign-in.
 */
export class ServerAddressStore {
  private readonly file: string;
  private readonly serial = new Serial();
  private current: string | null = null;

  constructor(dir: string) {
    this.file = join(dir, 'server.json');
  }

  async load(): Promise<string | null> {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8')) as { serverUrl?: unknown };
      this.current =
        typeof stored.serverUrl === 'string' ? normalizeServerUrl(stored.serverUrl) : null;
    } catch {
      this.current = null;
    }
    return this.current;
  }

  get(): string | null {
    return this.current;
  }

  /** Remember `serverUrl` (normalized; throws when invalid), or forget with null. */
  async set(serverUrl: string | null): Promise<void> {
    const next = serverUrl === null ? null : normalizeServerUrl(serverUrl);
    if (next === this.current) return;
    this.current = next;
    await this.serial.run(() =>
      writeFileAtomic(this.file, JSON.stringify({ serverUrl: next }, null, 2)),
    );
  }
}
