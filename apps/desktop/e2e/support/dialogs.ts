import { type ElectronApplication, expect } from '@playwright/test';

/**
 * Main asks trust questions (host keys, sharing, member keys) in native message boxes, which
 * Playwright cannot click. The test replaces `dialog.showMessageBox` in the main process of
 * the packaged app with a stub that queues each request until the test answers it. This goes
 * through the Node inspector, which only the e2e package has (its inspector fuse is on); the
 * app itself contains no hook for it.
 */

/** What a dialog showed (the parts a test checks). */
export interface AskedDialog {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  checkboxLabel: string | null;
}

export async function stubDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    interface Entry {
      options: Electron.MessageBoxOptions;
      resolve: (value: Electron.MessageBoxReturnValue) => void;
      done: boolean;
    }
    const queue: Entry[] = [];
    (globalThis as unknown as { __ternixDialogs: Entry[] }).__ternixDialogs = queue;
    const stub = (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as Electron.MessageBoxOptions;
      return new Promise<Electron.MessageBoxReturnValue>((resolve) => {
        const entry: Entry = { options, resolve, done: false };
        queue.push(entry);
        // Main closes a dialog whose question went stale: the answer is the cancel button.
        options.signal?.addEventListener('abort', () => {
          if (entry.done) return;
          entry.done = true;
          resolve({ response: options.cancelId ?? 0, checkboxChecked: false });
        });
      });
    };
    dialog.showMessageBox = stub as typeof dialog.showMessageBox;
  });
}

/** Every dialog main opened so far, answered or not. */
export function askedDialogs(app: ElectronApplication): Promise<AskedDialog[]> {
  return app.evaluate(() =>
    (
      globalThis as unknown as {
        __ternixDialogs: { options: Electron.MessageBoxOptions }[];
      }
    ).__ternixDialogs.map(({ options }) => ({
      title: options.title ?? '',
      message: options.message,
      detail: options.detail ?? '',
      buttons: options.buttons ?? [],
      defaultId: options.defaultId ?? 0,
      cancelId: options.cancelId ?? 0,
      checkboxLabel: options.checkboxLabel ?? null,
    })),
  );
}

/** Waits for the next unanswered dialog, checks its title, and clicks `button` in it. */
export async function answerDialog(
  app: ElectronApplication,
  title: string | RegExp,
  button: string,
  { checkbox = false }: { checkbox?: boolean } = {},
): Promise<AskedDialog> {
  let asked: AskedDialog | null = null;
  await expect
    .poll(
      async () => {
        const open = await app.evaluate(() => {
          const queue = (
            globalThis as unknown as {
              __ternixDialogs: { options: Electron.MessageBoxOptions; done: boolean }[];
            }
          ).__ternixDialogs;
          const index = queue.findIndex((entry) => !entry.done);
          if (index === -1) return null;
          const { options } = queue[index]!;
          return {
            title: options.title ?? '',
            message: options.message,
            detail: options.detail ?? '',
            buttons: options.buttons ?? [],
            defaultId: options.defaultId ?? 0,
            cancelId: options.cancelId ?? 0,
            checkboxLabel: options.checkboxLabel ?? null,
          };
        });
        asked = open;
        return open?.title ?? null;
      },
      { message: `native dialog ${String(title)}` },
    )
    .toMatch(title);
  const shown = asked as AskedDialog | null;
  if (!shown) throw new Error('no dialog');
  const response = shown.buttons.indexOf(button);
  expect(response, `button "${button}" in ${JSON.stringify(shown.buttons)}`).toBeGreaterThan(-1);
  await app.evaluate(
    (_electron, { response: index, checkbox: checked }) => {
      const queue = (
        globalThis as unknown as {
          __ternixDialogs: {
            resolve: (value: Electron.MessageBoxReturnValue) => void;
            done: boolean;
          }[];
        }
      ).__ternixDialogs;
      const entry = queue.find((e) => !e.done);
      if (!entry) throw new Error('the dialog went away before it was answered');
      entry.done = true;
      entry.resolve({ response: index, checkboxChecked: checked });
    },
    { response, checkbox },
  );
  return shown;
}
