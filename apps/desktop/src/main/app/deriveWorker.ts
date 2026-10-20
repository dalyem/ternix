import { parentPort, workerData } from 'node:worker_threads';
import { deriveKeys, ready } from '@ternix/core/crypto';
import type { KdfParams } from '@ternix/core/protocol';

/** Runs one Argon2id derivation off the main thread (see `derive.ts`). */
interface Job {
  password: string;
  kdf: KdfParams;
}

async function run(): Promise<void> {
  const { password, kdf } = workerData as Job;
  try {
    await ready();
    const keys = await deriveKeys(password, kdf);
    parentPort?.postMessage({ ok: true, ...keys }, [
      keys.masterKey.buffer as ArrayBuffer,
      keys.authKey.buffer as ArrayBuffer,
    ]);
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

void run();
