import type { CacheStore } from './stores.js';

export interface CoalescingOptions {
  /** Quiet time after the last change before a pending value is written. */
  debounceMs: number;
  /** A value changing without pause is still written this long after its first change. */
  maxDelayMs: number;
}

export const DEFAULT_COALESCING: CoalescingOptions = { debounceMs: 250, maxDelayMs: 2_000 };

interface Entry {
  account: string;
  key: string;
  /** The newest value handed to `set` until it is known to be stored; `get` serves it. */
  latest: { value: unknown } | undefined;
  /** `latest` still has to be written. */
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** When `dirty` last turned true, for the max delay. */
  firstAt: number;
  /** Every store call for this key, in order; never rejects. */
  chain: Promise<void>;
}

type WriteResult = { error: unknown } | null;

const idOf = (account: string, key: string): string => `${account}\u0000${key}`;

/**
 * Wraps a `CacheStore` so frequent writes to some keys (`shouldCoalesce`) become one write
 * per quiet period: the value is held in memory, `get` returns it, and a timer writes only the
 * newest value. A value is stored whole, so what a key's document says about itself (an items
 * document's `since` cursor and its items) is never torn.
 *
 * `flush` writes everything now; the owner calls it on lock, logout, close and app quit. A
 * crash loses at most the pending window. Other keys write through, but only after pending
 * values of the same account, so a document written later never refers to state a pending
 * one lacks (the vault list prunes wrapped keys that cached items no longer need).
 *
 * Values passed to `set` must not be changed afterwards.
 */
export class CoalescingCacheStore implements CacheStore {
  private readonly entries = new Map<string, Entry>();
  private readonly options: CoalescingOptions;

  constructor(
    private readonly inner: CacheStore,
    private readonly shouldCoalesce: (key: string) => boolean,
    /** A write started by a timer failed. The value stays pending for the next `flush`. */
    private readonly onError: (err: unknown) => void,
    options: Partial<CoalescingOptions> = {},
  ) {
    this.options = { ...DEFAULT_COALESCING, ...options };
  }

  /** Values waiting for their timer or a flush. */
  get pending(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.dirty) n += 1;
    return n;
  }

  async get(account: string, key: string): Promise<unknown> {
    if (this.shouldCoalesce(key)) {
      const latest = this.entries.get(idOf(account, key))?.latest;
      if (latest) return structuredClone(latest.value);
    }
    return this.inner.get(account, key);
  }

  async set(account: string, key: string, value: unknown): Promise<void> {
    if (!this.shouldCoalesce(key)) {
      await this.flushAccount(account);
      return this.inner.set(account, key, value);
    }
    const entry = this.entry(account, key);
    entry.latest = { value };
    if (!entry.dirty) {
      entry.dirty = true;
      entry.firstAt = Date.now();
    }
    this.arm(entry);
  }

  async delete(account: string, key: string): Promise<void> {
    const entry = this.shouldCoalesce(key) ? this.entries.get(idOf(account, key)) : undefined;
    if (!entry) return this.inner.delete(account, key);
    this.cancel(entry);
    const op = entry.chain.then(() => this.inner.delete(account, key));
    entry.chain = op.then(noop, noop);
    try {
      await op;
    } finally {
      this.release(entry);
    }
  }

  async clear(account: string): Promise<void> {
    const chains: Promise<void>[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.account !== account) continue;
      this.cancel(entry);
      this.entries.delete(id);
      chains.push(entry.chain);
    }
    await Promise.all(chains);
    await this.inner.clear(account);
  }

  /** Write every pending value and wait for writes in flight. Rejects with the first failure. */
  async flush(): Promise<void> {
    await this.flushEntries([...this.entries.values()], true);
  }

  private async flushAccount(account: string): Promise<void> {
    const mine = [...this.entries.values()].filter((e) => e.account === account);
    await this.flushEntries(mine, false);
  }

  private async flushEntries(entries: Entry[], rethrow: boolean): Promise<void> {
    const results = await Promise.all(entries.map((e) => this.fire(e)));
    const failed = results.find((r) => r !== null);
    // A failed write was reported when it started from a timer; here it is the caller's.
    if (failed && rethrow) throw failed.error;
  }

  private entry(account: string, key: string): Entry {
    const id = idOf(account, key);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        account,
        key,
        latest: undefined,
        dirty: false,
        timer: undefined,
        firstAt: 0,
        chain: Promise.resolve(),
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private arm(entry: Entry): void {
    clearTimeout(entry.timer);
    const { debounceMs, maxDelayMs } = this.options;
    const delay = Math.max(0, Math.min(debounceMs, entry.firstAt + maxDelayMs - Date.now()));
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.fire(entry).then((result) => {
        if (result) this.onError(result.error);
      });
    }, delay);
    entry.timer.unref();
  }

  private cancel(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.dirty = false;
    entry.latest = undefined;
  }

  /** Forget an entry nothing is waiting for. */
  private release(entry: Entry): void {
    if (entry.dirty || entry.timer || entry.latest) return;
    const id = idOf(entry.account, entry.key);
    if (this.entries.get(id) === entry) this.entries.delete(id);
  }

  /** Start the write of the pending value now (or just wait for earlier writes). */
  private fire(entry: Entry): Promise<WriteResult> {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!entry.dirty || !entry.latest) return entry.chain.then(() => null);
    const { value } = entry.latest;
    entry.dirty = false;
    const result = entry.chain
      .then(() => this.inner.set(entry.account, entry.key, value))
      .then(
        (): WriteResult => {
          // Stored; drop the in-memory copy unless a newer value arrived meanwhile.
          if (entry.latest?.value === value && !entry.dirty) entry.latest = undefined;
          this.release(entry);
          return null;
        },
        (error: unknown): WriteResult => {
          // Keep the value pending so the next flush tries again.
          if (entry.latest?.value === value) entry.dirty = true;
          return { error };
        },
      );
    entry.chain = result.then(noop);
    return result;
  }
}

function noop(): void {}
