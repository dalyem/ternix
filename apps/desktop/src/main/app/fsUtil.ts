import { randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Write `data` to `file` atomically (temp file in the same directory, then rename), mode 0600. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, file);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}

/** Run tasks one after another, whatever happened to the earlier ones. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
