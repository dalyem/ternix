import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuitGuard } from '../src/main/app/quit.js';

const request = () => ({ preventDefault: vi.fn() });

afterEach(() => {
  vi.useRealTimers();
});

describe('QuitGuard', () => {
  it('holds a second quit request while slow cleanup runs, then quits once', async () => {
    vi.useFakeTimers();
    const sshClosed = vi.fn();
    const flushed = vi.fn();
    const quit = vi.fn();
    const guard = new QuitGuard({
      steps: [
        // Never finishes: abandoned after its timeout.
        { run: () => new Promise(() => sshClosed()), timeoutMs: 2_000 },
        { run: () => new Promise((r) => setTimeout(() => r(flushed()), 1_000)), timeoutMs: 5_000 },
      ],
      quit,
    });

    const first = request();
    guard.onQuitRequest(first);
    expect(first.preventDefault).toHaveBeenCalled();

    // Cmd+Q again, the window closing, will-quit: all still held back.
    await vi.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 3; i++) {
      const again = request();
      guard.onQuitRequest(again);
      expect(again.preventDefault).toHaveBeenCalled();
    }
    expect(quit).not.toHaveBeenCalled();
    expect(sshClosed).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_600); // the SSH step times out at 2 s
    expect(flushed).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000); // the flush finishes
    expect(flushed).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(guard.exiting).toBe(true);

    // The request that `app.quit()` makes now goes through.
    const final = request();
    guard.onQuitRequest(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('quits after a failing step', async () => {
    const quit = vi.fn();
    const guard = new QuitGuard({
      steps: [
        {
          run: async () => {
            throw new Error('boom');
          },
          timeoutMs: 1_000,
        },
      ],
      quit,
    });
    guard.onQuitRequest(request());
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  });
});
