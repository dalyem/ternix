/** One piece of shutdown work and how long quitting waits for it. */
export interface ShutdownStep {
  run(): Promise<unknown>;
  timeoutMs: number;
}

export interface QuitGuardDeps {
  /** Run in order; each one is abandoned when its timeout passes. Failures are ignored. */
  steps: ShutdownStep[];
  /** Called once, when the first quit request is held back. */
  onStart?(): void;
  /** `app.quit()`: asks again, and this time the request goes through. */
  quit(): void;
}

/**
 * Holds every quit request back until the shutdown work has finished or timed out, then quits
 * for real. "Shutdown in progress" and "exit allowed" are separate: a second request while
 * the work runs (Cmd+Q twice, the last window closing, `will-quit`) is held back too, instead
 * of slipping through.
 */
export class QuitGuard {
  private shutdown: Promise<void> | null = null;
  private exitAllowed = false;

  constructor(private readonly deps: QuitGuardDeps) {}

  /** For `before-quit` and `will-quit`. */
  readonly onQuitRequest = (event: { preventDefault(): void }): void => {
    if (this.exitAllowed) return;
    event.preventDefault();
    if (this.shutdown) return;
    this.deps.onStart?.();
    this.shutdown = this.runSteps().finally(() => {
      this.exitAllowed = true;
      this.deps.quit();
    });
  };

  get exiting(): boolean {
    return this.exitAllowed;
  }

  private async runSteps(): Promise<void> {
    for (const step of this.deps.steps) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.resolve()
          .then(() => step.run())
          .catch(() => undefined),
        new Promise((resolve) => (timer = setTimeout(resolve, step.timeoutMs))),
      ]);
      clearTimeout(timer);
    }
  }
}
