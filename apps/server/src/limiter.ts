/** Fixed-window failure counter keyed by string; used for per-email login throttling. */
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether this key is currently locked out. */
  blocked(key: string): boolean {
    const entry = this.hits.get(key);
    if (!entry) return false;
    if (entry.resetAt <= this.now()) {
      this.hits.delete(key);
      return false;
    }
    return entry.count >= this.max;
  }

  fail(key: string): void {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
    } else {
      entry.count += 1;
    }
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
