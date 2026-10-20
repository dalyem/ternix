import { randomBytes } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';

/**
 * Verifier hashing for the client's `auth_key` (docs/protocol.md 2.1). The auth key is
 * already the output of a client-side Argon2id, so the server applies one more
 * `crypto_pwhash_str` round: a database leak does not hand out a usable login credential.
 */
export class PasswordHasher {
  private dummy: string | undefined;

  constructor(private readonly limits: { opslimit: number; memlimit: number }) {}

  async init(): Promise<void> {
    await sodium.ready;
    this.dummy = this.hash(randomBytes(32).toString('base64'));
  }

  hash(authKey: string): string {
    return sodium.crypto_pwhash_str(authKey, this.limits.opslimit, this.limits.memlimit);
  }

  /** Constant-time verification inside libsodium. */
  verify(stored: string, authKey: string): boolean {
    try {
      return sodium.crypto_pwhash_str_verify(stored, authKey);
    } catch {
      return false;
    }
  }

  /**
   * Do the same work as a real verification against a hash nobody can match, so a login for
   * an unknown email takes as long as one with a wrong password.
   */
  verifyDummy(authKey: string): false {
    if (this.dummy === undefined) throw new Error('PasswordHasher.init() was not awaited');
    this.verify(this.dummy, authKey);
    return false;
  }
}
