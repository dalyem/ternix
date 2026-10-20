import { z } from 'zod';
import { fingerprint, fromB64 } from '@ternix/core/crypto';
import { OwnKeyMismatchError } from './errors.js';
import type { SecretStore } from './stores.js';

/**
 * Pinned account public keys, one per user id, for one account on one device. A member's
 * key is what a vault key gets wrapped for, so a server that swaps it during a rotation or a
 * member add would receive the new vault key. Pins make that detectable:
 *
 * - trust on first use: a key seen for the first time is pinned `verified: false`;
 * - verified: the user compared the fingerprint out of band (`addMember`,
 *   `markMemberVerified`, `acceptMemberKey`);
 * - the account's own key is pinned from the keys the client derived itself, and a server
 *   that reports another one for the same user id is a hard error.
 *
 * Pins live in the `SecretStore` (integrity matters; the app backs it with `safeStorage`).
 */

export const keyPinSchema = z.object({
  public_key: z.string().min(1),
  verified: z.boolean(),
  first_seen_at: z.string().min(1),
});
export type KeyPin = z.infer<typeof keyPinSchema>;

const pinsDocSchema = z.object({
  version: z.literal(1),
  pins: z.record(z.string().min(1), keyPinSchema),
});

export const pinsKey = (account: string): string => `pins\n${account}`;

export type PinObservation =
  { status: 'new' | 'match'; pin: KeyPin } | { status: 'mismatch'; pin: KeyPin; serverKey: string };

export const fingerprintOf = (publicKey: string): string => fingerprint(fromB64(publicKey));

export class PinStore {
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  private constructor(
    readonly account: string,
    private readonly store: SecretStore,
    private readonly selfId: string,
    private readonly pins: Map<string, KeyPin>,
    private readonly now: () => Date,
  ) {}

  /** Read the saved pins; a missing or corrupt entry reads as no pins. */
  static async load(
    store: SecretStore,
    account: string,
    selfId: string,
    now: () => Date,
  ): Promise<PinStore> {
    const doc = pinsDocSchema.safeParse(await store.get(pinsKey(account)));
    const pins = new Map(doc.success ? Object.entries(doc.data.pins) : []);
    return new PinStore(account, store, selfId, pins, now);
  }

  get(userId: string): KeyPin | undefined {
    return this.pins.get(userId);
  }

  /** What the pin says about `publicKey`, without changing anything. */
  peek(userId: string, publicKey: string): 'unknown' | 'match' | 'mismatch' {
    const pin = this.pins.get(userId);
    if (!pin) return 'unknown';
    return pin.public_key === publicKey ? 'match' : 'mismatch';
  }

  private persist(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const pins = Object.fromEntries(this.pins);
    const run = this.chain.then(() =>
      this.disposed ? undefined : this.store.set(pinsKey(this.account), { version: 1, pins }),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  private fresh(publicKey: string, verified: boolean): KeyPin {
    return { public_key: publicKey, verified, first_seen_at: this.now().toISOString() };
  }

  /**
   * Compare keys the server reported with the pins and pin the unknown ones (unverified;
   * the account's own key counts as verified). A mismatch of the account's own key throws.
   * Persists before returning, so a later call cannot lose a new pin.
   */
  async observe(entries: { userId: string; publicKey: string }[]): Promise<PinObservation[]> {
    let added = false;
    const out = entries.map(({ userId, publicKey }): PinObservation => {
      const pin = this.pins.get(userId);
      if (!pin) {
        const created = this.fresh(publicKey, userId === this.selfId);
        this.pins.set(userId, created);
        added = true;
        return { status: 'new', pin: created };
      }
      if (pin.public_key === publicKey) return { status: 'match', pin };
      if (userId === this.selfId) throw new OwnKeyMismatchError();
      return { status: 'mismatch', pin, serverKey: publicKey };
    });
    if (added) await this.persist();
    return out;
  }

  /** The account's own key, from a source the client trusts. Throws on a different pin. */
  async pinSelf(publicKey: string): Promise<void> {
    const pin = this.pins.get(this.selfId);
    if (pin) {
      if (pin.public_key !== publicKey) throw new OwnKeyMismatchError();
      return;
    }
    this.pins.set(this.selfId, this.fresh(publicKey, true));
    await this.persist();
  }

  /** The server reported this key for the account itself (`/me`, user lists): must match. */
  checkSelf(userId: string, publicKey: string): void {
    if (userId !== this.selfId) return;
    const pin = this.pins.get(userId);
    if (pin && pin.public_key !== publicKey) throw new OwnKeyMismatchError();
  }

  /** Pin `publicKey` for the user, replacing any earlier pin. Callers decide if that is allowed. */
  async pin(userId: string, publicKey: string, verified: boolean): Promise<void> {
    const old = this.pins.get(userId);
    this.pins.set(userId, {
      public_key: publicKey,
      verified,
      first_seen_at: old?.public_key === publicKey ? old.first_seen_at : this.now().toISOString(),
    });
    await this.persist();
  }

  async markVerified(userId: string): Promise<boolean> {
    const pin = this.pins.get(userId);
    if (!pin) return false;
    if (!pin.verified) {
      this.pins.set(userId, { ...pin, verified: true });
      await this.persist();
    }
    return true;
  }

  /** Forget every pin of the account and delete the saved entry (logout). */
  async clear(): Promise<void> {
    this.pins.clear();
    this.disposed = true;
    await this.chain;
    await this.store.delete(pinsKey(this.account));
  }
}
