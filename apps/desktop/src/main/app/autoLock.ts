export interface AutoLockDeps {
  /** Seconds since the last keyboard or mouse input anywhere in the OS session. */
  idleSeconds(): number;
  /** Minutes of idle time that lock the vault; 0 = never. */
  minutes(): number;
  isUnlocked(): boolean;
  lock(): void;
}

/** Locks the vault when the system has been idle for the configured time. */
export class AutoLock {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: AutoLockDeps,
    private readonly intervalMs = 15_000,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    const minutes = this.deps.minutes();
    if (minutes <= 0 || !this.deps.isUnlocked()) return;
    if (this.deps.idleSeconds() >= minutes * 60) this.deps.lock();
  }
}
