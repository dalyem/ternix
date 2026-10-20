import { Worker } from 'node:worker_threads';
import type { DerivedKeys } from '@ternix/core/crypto';
import type { KdfParams } from '@ternix/core/protocol';
import workerPath from './deriveWorker?modulePath';

type Reply = ({ ok: true } & DerivedKeys) | { ok: false; name: string; message: string };

/**
 * Argon2id (64 MiB, about a second) in a worker thread so the main process keeps serving
 * the window. One short-lived worker per derivation: its memory, including the password
 * copy, is released when it ends.
 */
export function deriveKeysInWorker(password: string, kdf: KdfParams): Promise<DerivedKeys> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { password, kdf } });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
      void worker.terminate();
    };
    worker.once('message', (reply: Reply) => {
      finish(() => {
        if (reply.ok) resolve({ masterKey: reply.masterKey, authKey: reply.authKey });
        else reject(Object.assign(new Error(reply.message), { name: reply.name }));
      });
    });
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`Key derivation worker exited with code ${code}`))),
    );
  });
}
