import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  answerDialog,
  answerFileDialog,
  askedFileDialogs,
  stubDialogs,
  stubFileDialogs,
} from './support/dialogs.js';
import {
  type RunningServer,
  type SshTarget,
  startSshTarget,
  startTernixServer,
} from './support/servers.js';

/**
 * The SFTP browser against the fake sshd, whose SFTP subsystem serves a temporary directory:
 * open SFTP from a host card (through the same new-host and host-key dialogs as a terminal),
 * browse, upload a file picked in main's open dialog, download it back through main's save
 * dialog and compare the bytes, make a folder, rename, delete after main's confirmation, and
 * check that the page cannot hand main a local path. Writes `artifacts/sftp-browser.png`.
 */

const EXECUTABLE = process.env['TERNIX_E2E_EXECUTABLE'];
const ARTIFACTS = resolve(import.meta.dirname, 'artifacts');
const PASSWORD = 'correct-horse-battery-staple';
const HOST_LABEL = 'files-box';

let server: RunningServer;
let target: SshTarget;
let remoteRoot: string;
let localDir: string;
let userData: string;

test.beforeAll(async () => {
  if (!EXECUTABLE) throw new Error('Set TERNIX_E2E_EXECUTABLE to the packaged Ternix binary');
  mkdirSync(ARTIFACTS, { recursive: true });
  remoteRoot = mkdtempSync(join(tmpdir(), 'ternix-e2e-sftp-remote-'));
  localDir = mkdtempSync(join(tmpdir(), 'ternix-e2e-sftp-local-'));
  userData = mkdtempSync(join(tmpdir(), 'ternix-e2e-sftp-user-'));
  mkdirSync(join(remoteRoot, 'docs'));
  writeFileSync(join(remoteRoot, 'docs', 'inside.txt'), 'inside');
  writeFileSync(join(remoteRoot, 'readme.txt'), 'hello from the server\n');
  server = await startTernixServer();
  target = await startSshTarget({ sftpRoot: remoteRoot });
});

test.afterAll(async () => {
  await server?.stop();
  await target?.stop();
  for (const dir of [remoteRoot, localDir, userData]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

type Invoke = { ok: boolean; value?: unknown; error?: { code?: string } };
const invoke = (page: Page, method: string, arg?: unknown) =>
  page.evaluate(
    ([m, a]) =>
      (
        window as unknown as { ternix: { invoke(m: string, a?: unknown): Promise<Invoke> } }
      ).ternix.invoke(m as string, a),
    [method, arg] as const,
  );

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: EXECUTABLE,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env } as Record<string, string>,
    timeout: 90_000,
  });
  await stubDialogs(app);
  await stubFileDialogs(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

const row = (page: Page, name: string) => page.getByTestId(`sftp-row-${name}`);

test('SFTP: browse, upload, download, rename, delete', async () => {
  test.skip(Boolean(process.env['E2E_SSH_ADDRESS']), 'needs the in-process SFTP server');
  test.setTimeout(300_000);
  const { app, page } = await launch();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);

  await test.step('register and save a host', async () => {
    await page.getByLabel('Server address').fill(server.url);
    await expect(page.getByTestId('server-info')).toContainText('open');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('tab', { name: 'Create account' }).click();
    await page.getByLabel('Email').fill('sftp@example.com');
    await page.getByLabel('Your name').fill('Sam');
    await page.getByLabel('Master password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Repeat master password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByTestId('host-list')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('new-host').click();
    await page.getByLabel('Label', { exact: true }).fill(HOST_LABEL);
    await page.getByLabel('Address', { exact: true }).fill(target.address);
    await page.getByLabel('Port', { exact: true }).fill(String(target.port));
    await page.getByLabel('Username', { exact: true }).fill(target.username);
    await page.getByLabel('Password', { exact: true }).fill(target.password);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId(`host-${HOST_LABEL}`)).toBeVisible();
  });

  await test.step('open SFTP from the host card, through main’s new-host and host-key dialogs', async () => {
    const card = page.getByTestId(`host-${HOST_LABEL}`);
    await card.hover();
    await card.getByRole('button', { name: 'Open SFTP' }).click();
    await answerDialog(app, 'Connect to a new host?', 'Connect');
    await answerDialog(app, 'Trust this host?', 'Trust and connect');
    await expect(page.getByTestId('sftp-view')).toBeVisible();
    await expect(page.getByTestId('sftp-tab')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'readme.txt')).toBeVisible();
    await expect(row(page, 'docs')).toBeVisible();
    // The vault sidebar is hidden while the SFTP tab is in front.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  });

  await test.step('browse into a folder and back', async () => {
    await row(page, 'docs').dblclick();
    await expect(page.getByTestId('sftp-path')).toHaveAttribute('data-path', '/docs');
    await expect(row(page, 'inside.txt')).toBeVisible();
    await page.getByTestId('sftp-path').getByRole('button', { name: '/', exact: true }).click();
    await expect(page.getByTestId('sftp-path')).toHaveAttribute('data-path', '/');
    await expect(row(page, 'readme.txt')).toBeVisible();
  });

  const data = randomBytes(1536 * 1024 + 11);
  const source = join(localDir, 'upload.bin');
  writeFileSync(source, data);

  await test.step('upload a file picked in main’s open dialog', async () => {
    await answerFileDialog(app, [source]);
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByTestId('transfer-upload.bin')).toHaveAttribute('data-state', 'done');
    await expect(row(page, 'upload.bin')).toBeVisible();
    expect(readFileSync(join(remoteRoot, 'upload.bin')).equals(data)).toBe(true);
  });

  await test.step('screenshot of the SFTP screen', async () => {
    await row(page, 'readme.txt').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(ARTIFACTS, 'sftp-browser.png'), type: 'png' });
  });

  const saved = join(localDir, 'downloaded.bin');
  await test.step('download it back through main’s save dialog; the bytes match', async () => {
    await row(page, 'upload.bin').click();
    await answerFileDialog(app, [saved]);
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(page.getByTestId('transfer-downloaded.bin')).toHaveAttribute('data-state', 'done');
    expect(readFileSync(saved).equals(data)).toBe(true);
    const asked = await askedFileDialogs(app);
    expect(asked.map((d) => d.kind)).toEqual(['open', 'save']);
  });

  await test.step('make a folder', async () => {
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.getByLabel('Folder name').fill('made-here');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(row(page, 'made-here')).toBeVisible();
    expect(existsSync(join(remoteRoot, 'made-here'))).toBe(true);
  });

  await test.step('rename from the context menu', async () => {
    await row(page, 'upload.bin').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByLabel('New name').fill('renamed.bin');
    await page.getByRole('button', { name: 'Rename' }).click();
    await expect(row(page, 'renamed.bin')).toBeVisible();
    await expect(row(page, 'upload.bin')).toHaveCount(0);
    expect(readFileSync(join(remoteRoot, 'renamed.bin')).equals(data)).toBe(true);
  });

  await test.step('delete asks in main’s dialog; cancel keeps the file, Delete removes it', async () => {
    await row(page, 'renamed.bin').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const declined = await answerDialog(app, 'Delete files', 'Cancel');
    expect(declined.message).toContain('renamed.bin');
    expect(declined.defaultId).toBe(declined.cancelId);
    await expect(row(page, 'renamed.bin')).toBeVisible();
    expect(existsSync(join(remoteRoot, 'renamed.bin'))).toBe(true);

    await row(page, 'renamed.bin').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await answerDialog(app, 'Delete files', 'Delete');
    await expect(row(page, 'renamed.bin')).toHaveCount(0);
    expect(existsSync(join(remoteRoot, 'renamed.bin'))).toBe(false);
  });

  await test.step('the page cannot hand main a local path', async () => {
    const sessions = (await invoke(page, 'sftp.list')) as { value: { id: string }[] };
    const id = sessions.value[0]!.id;
    // A destination or source path in a request is refused outright.
    expect(
      await invoke(page, 'sftp.download', { id, paths: ['/readme.txt'], destination: localDir }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(
      await invoke(page, 'sftp.upload', { id, remoteDir: '/', kind: 'files', paths: [source] }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    // A File the page makes itself has no path on disk: the preload sends nothing.
    const forged = await page.evaluate(
      async ([sessionId, fakePath]) => {
        const bridge = (
          window as unknown as {
            ternix: {
              uploadDropped(id: string, dir: string, files: unknown[]): Promise<unknown>;
            };
          }
        ).ternix;
        const file = new File(['forged'], fakePath as string);
        return bridge.uploadDropped(sessionId as string, '/', [file, fakePath, { path: fakePath }]);
      },
      [id, source] as const,
    );
    expect(forged).toEqual({ ok: true, value: { queued: 0, skipped: 3 } });
    // Nothing new on the server.
    const listing = (await invoke(page, 'sftp.readdir', { id, path: '/' })) as {
      value: { entries: { name: string }[] };
    };
    expect(listing.value.entries.map((e) => e.name).sort()).toEqual([
      'docs',
      'made-here',
      'readme.txt',
    ]);
  });

  await test.step('locking hides the browser; the session stays for after unlock', async () => {
    await page.getByTestId('lock-now').click();
    await expect(page.getByTestId('sftp-view')).toHaveCount(0);
    await page.getByLabel('Master password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('sftp-tab').click();
    await expect(row(page, 'readme.txt')).toBeVisible();
  });

  await app.close();
});
