import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { type SshTarget, startSshTarget } from './support/servers.js';
import { answerDialog, stubDialogs } from './support/dialogs.js';

/**
 * The packaged app against a server it does not own: `E2E_SERVER_URL` is a deployed Ternix
 * server (for example a Kiln preview behind its gateway), reached over the real network path
 * (HTTPS, WebSocket realtime, the system certificate store). The test never touches the
 * server's database and uses fresh accounts named with the run's timestamp, so it can run
 * against a server that already holds data; the accounts stay there. Registration is
 * expected to be `invite`: the first account on an empty server registers without a code.
 *
 * Needs TERNIX_E2E_EXECUTABLE (see apps/desktop/README.md, "End-to-end test"). The SSH
 * target is E2E_SSH_ADDRESS/PORT/USER/PASSWORD (a real sshd) or, when unset, the in-process
 * fake. Skipped when E2E_SERVER_URL is unset, so `pnpm e2e` and Kiln checks are unaffected.
 */

const SERVER_URL = process.env['E2E_SERVER_URL'];
const EXECUTABLE = process.env['TERNIX_E2E_EXECUTABLE'];
const ARTIFACTS = resolve(import.meta.dirname, 'artifacts');
const HOST_LABEL = 'remote-box';
const VAULT_NAME = 'Remote Team';
const SNIPPET_LABEL = 'remote-snippet';

/** Realtime must beat this; a missed push would otherwise only show as a timeout. */
const REALTIME_TIMEOUT = 45_000;

test.describe('packaged app against a remote server', () => {
  test.skip(!SERVER_URL, 'E2E_SERVER_URL is not set');
  test.setTimeout(900_000);

  const stamp = Date.now().toString(36);
  // Generated per run, never printed or written anywhere.
  const password = () => randomBytes(24).toString('base64url');
  const alicePassword = password();
  const bobPassword = password();
  const aliceEmail = `alice-${stamp}@example.com`;
  const bobEmail = `bob-${stamp}@example.com`;
  const dirs: string[] = [];
  const consoleErrors: string[] = [];
  const mainLogs: string[] = [];
  const latency: Record<string, number> = {};
  let target: SshTarget;

  test.beforeAll(async () => {
    if (!EXECUTABLE) throw new Error('Set TERNIX_E2E_EXECUTABLE to the packaged Ternix binary');
    mkdirSync(ARTIFACTS, { recursive: true });
    target = await startSshTarget();
  });

  test.afterAll(async () => {
    await target?.stop();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    writeFileSync(join(ARTIFACTS, 'remote-latency.json'), JSON.stringify(latency, null, 2));
    writeFileSync(join(ARTIFACTS, 'remote-main-process.log'), mainLogs.join(''));
  });

  function newUserDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ternix-remote-user-'));
    dirs.push(dir);
    return dir;
  }

  async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({
      executablePath: EXECUTABLE,
      args: [`--user-data-dir=${userData}`],
      env: { ...process.env } as Record<string, string>,
      timeout: 90_000,
    });
    for (const stream of [app.process().stdout, app.process().stderr]) {
      stream?.on('data', (chunk: Buffer) => mainLogs.push(chunk.toString()));
    }
    await stubDialogs(app);
    const page = await app.firstWindow();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.waitForLoadState('domcontentloaded');
    return { app, page };
  }

  const shot = (page: Page, name: string) =>
    page.screenshot({ path: join(ARTIFACTS, `remote-${name}.jpg`), type: 'jpeg', quality: 85 });

  const nav = (page: Page, name: RegExp | string) =>
    page.locator('nav.sidebar').getByRole('button', { name });

  const terminalRows = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('.terminal-pane[style*="flex"] .xterm-rows > div')].map(
        (row) => row.textContent ?? '',
      ),
    );

  async function expectTerminalLine(page: Page, line: string) {
    await expect
      .poll(async () => (await terminalRows(page)).some((row) => row.trim() === line), {
        message: `terminal shows ${line}`,
        timeout: 45_000,
      })
      .toBe(true);
  }

  async function expectConnected(page: Page) {
    await expect
      .poll(
        async () => {
          const banner = page.getByTestId('terminal-status');
          return (await banner.count()) === 0
            ? 'connected'
            : ((await banner.first().textContent()) ?? '');
        },
        { timeout: 45_000, message: 'terminal connected' },
      )
      .toBe('connected');
  }

  /** Waits until `check` is true and returns how long that took, from `since`. */
  async function elapsedUntil(since: number, message: string, check: () => Promise<unknown>) {
    await check();
    const ms = Date.now() - since;
    latency[message] = ms;
    return ms;
  }

  /** Server address → Continue → Create account, up to (not including) the password fields. */
  async function openRegistration(page: Page, email: string, name: string, invite?: string) {
    await page.getByLabel('Server address').fill(SERVER_URL!);
    await expect(page.getByTestId('server-info')).toBeVisible({ timeout: 45_000 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('tab', { name: 'Create account' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Your name').fill(name);
    if (invite) await page.getByLabel('Invite code').fill(invite);
  }

  async function submitRegistration(page: Page, masterPassword: string) {
    await page.getByLabel('Master password', { exact: true }).fill(masterPassword);
    await page.getByLabel('Repeat master password').fill(masterPassword);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByTestId('host-list')).toBeVisible({ timeout: 90_000 });
  }

  async function unlock(page: Page, masterPassword: string) {
    await page.getByLabel('Master password').fill(masterPassword);
    await page.getByRole('button', { name: 'Unlock' }).click();
  }

  /** The vault's key version, as the Sharing page shows it. */
  async function keyVersion(page: Page): Promise<number> {
    const text = await page
      .locator('.vault-detail')
      .getByText(/key version \d+/)
      .textContent();
    const match = /key version (\d+)/.exec(text ?? '');
    if (!match) throw new Error(`no key version in "${text}"`);
    return Number(match[1]);
  }

  test('register, invite, SSH host, shared vault with realtime, lock, restart, rotation', async () => {
    const userDataA = newUserDataDir();
    let { app: appA, page: a } = await launch(userDataA);
    let invite = '';
    let bob: { app: ElectronApplication; page: Page } | undefined;

    try {
      await test.step('1. A: probe the server, register alice (first account → admin)', async () => {
        await a.getByLabel('Server address').fill(SERVER_URL!);
        const info = a.getByTestId('server-info');
        await expect(info).toBeVisible({ timeout: 45_000 });
        // Server name and version, the normalized address, and the registration mode.
        await expect(info.locator('strong')).not.toBeEmpty();
        const normalized = ((await info.locator('.mono').textContent()) ?? '').trim();
        const typed = new URL(
          /^[a-z][a-z0-9+.-]*:\/\//i.test(SERVER_URL!) ? SERVER_URL! : `https://${SERVER_URL!}`,
        );
        expect(normalized).toBe(
          `${typed.protocol}//${typed.host}${typed.pathname.replace(/\/+$/, '')}`,
        );
        // Anything but this computer must be reached over https.
        if (!['localhost', '127.0.0.1', '[::1]'].includes(typed.hostname)) {
          expect(normalized).toMatch(/^https:\/\//);
        }
        await expect(info).toContainText('Registration');
        await expect(info.locator('.badge').filter({ hasText: /^invite$/ })).toBeVisible();
        await shot(a, '01-setup-probe');

        await a.getByRole('button', { name: 'Continue' }).click();
        await a.getByRole('tab', { name: 'Create account' }).click();
        await a.getByLabel('Email').fill(aliceEmail);
        await a.getByLabel('Your name').fill('Alice Remote');
        await shot(a, '02-register-form');
        await submitRegistration(a, alicePassword);
        await shot(a, '03-alice-registered');
      });

      await test.step('2. A: Settings → Admin → create an invite', async () => {
        await nav(a, /^Settings/).click();
        await a.getByRole('tab', { name: 'Admin' }).click();
        await a.getByRole('button', { name: 'Create invite' }).click();
        const code = a.getByTestId('invite-code');
        await expect(code).toBeVisible();
        invite = ((await code.textContent()) ?? '').trim();
        expect(invite.length).toBeGreaterThan(8);
        await shot(a, '04-admin-invite');
        await nav(a, /^Hosts/).click();
      });

      await test.step('3. B: register bob with the invite', async () => {
        bob = await launch(newUserDataDir());
        await openRegistration(bob.page, bobEmail, 'Bob Remote', invite);
        await submitRegistration(bob.page, bobPassword);
        await shot(bob.page, '05-bob-registered');
      });
      const b = bob!.page;

      await test.step('4. A: SSH host on the VM, approve the dialogs, run echo hello-remote', async () => {
        await a.getByTestId('new-host').click();
        await a.getByLabel('Label', { exact: true }).fill(HOST_LABEL);
        await a.getByLabel('Address', { exact: true }).fill(target.address);
        await a.getByLabel('Port', { exact: true }).fill(String(target.port));
        await a.getByLabel('Username', { exact: true }).fill(target.username);
        await a.getByLabel('Password', { exact: true }).fill(target.password);
        await a.getByRole('button', { name: 'Save' }).click();
        await expect(a.getByTestId(`host-${HOST_LABEL}`)).toBeVisible();

        await a.getByTestId(`host-${HOST_LABEL}`).getByRole('button', { name: 'Connect' }).click();
        const newHost = await answerDialog(appA, 'Connect to a new host?', 'Connect');
        expect(newHost.message).toContain(`${target.address}:${target.port}`);
        const hostKey = await answerDialog(appA, 'Trust this host?', 'Trust and connect');
        expect(hostKey.message).toContain(`${target.address}:${target.port}`);
        await expectConnected(a);
        await expect
          .poll(async () => (await terminalRows(a)).join('').trim().length, { timeout: 45_000 })
          .toBeGreaterThan(0);
        await a.locator('.terminal-pane[style*="flex"] .xterm-helper-textarea').focus();
        await a.keyboard.type('echo hello-remote');
        await a.keyboard.press('Enter');
        // The typed line carries the shell prompt; only the output is a row of its own.
        await expectTerminalLine(a, 'hello-remote');
        await shot(a, '06-ssh-hello-remote');
      });

      await test.step('5. shared vault: bob joins and the vault and snippet reach him by realtime', async () => {
        await a.getByRole('tab', { name: 'Vaults' }).click();
        await nav(a, /^Sharing/).click();
        await a.getByRole('button', { name: 'New shared vault' }).click();
        await a.getByLabel('Name').fill(VAULT_NAME);
        await a.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(a.getByRole('option', { name: new RegExp(VAULT_NAME) })).toBeVisible();

        await a.getByLabel('Email of the person to add').fill(bobEmail);
        await a.getByRole('button', { name: 'Look up' }).click();
        const fingerprint = ((await a.locator('.card .fingerprint').textContent()) ?? '').trim();
        await a.getByRole('button', { name: 'Add to vault' }).click();
        const confirm = await answerDialog(appA, 'Share vault', 'It matches, share');
        expect(confirm.message).toContain(bobEmail);
        expect(confirm.detail).toContain(fingerprint);
        const sharedAt = Date.now();
        await expect(a.getByTestId(`member-${bobEmail}`)).toBeVisible();

        // No refresh on bob's side: the vault arrives over the WebSocket.
        await elapsedUntil(sharedAt, 'vault_appears_for_bob_ms', () =>
          expect(nav(b, new RegExp(VAULT_NAME))).toBeVisible({ timeout: REALTIME_TIMEOUT }),
        );
        await shot(b, '07-bob-sees-vault');

        // Bob looks at the vault's snippets first, so the snippet's latency is not navigation.
        await nav(b, new RegExp(VAULT_NAME)).click();
        await nav(b, /^Snippets/).click();
        await expect(b.locator('.host-label', { hasText: SNIPPET_LABEL })).toHaveCount(0);

        await nav(a, new RegExp(VAULT_NAME)).click();
        await nav(a, /^Snippets/).click();
        await a.getByRole('button', { name: 'New snippet' }).click();
        await a.getByLabel('Label', { exact: true }).fill(SNIPPET_LABEL);
        await a.getByLabel('Script').fill('echo from-the-shared-vault');
        await a.getByRole('button', { name: 'Save' }).click();
        await expect(a.locator('.host-label', { hasText: SNIPPET_LABEL })).toBeVisible();
        const savedAt = Date.now();

        await elapsedUntil(savedAt, 'snippet_appears_for_bob_ms', () =>
          expect(b.locator('.host-label', { hasText: SNIPPET_LABEL })).toBeVisible({
            timeout: REALTIME_TIMEOUT,
          }),
        );
        await shot(b, '08-bob-sees-snippet');
        console.log(`realtime latency: ${JSON.stringify(latency)}`);
      });

      await test.step('6. A: lock and unlock, quit, relaunch, unlock with the password only', async () => {
        await a.getByTestId('lock-now').click();
        await expect(a.getByRole('heading', { name: 'Ternix is locked' })).toBeVisible();
        await shot(a, '09-alice-locked');
        await unlock(a, alicePassword);
        await expect(a.getByTestId('lock-now')).toBeVisible({ timeout: 60_000 });

        await appA.close();
        ({ app: appA, page: a } = await launch(userDataA));
        await expect(a.getByRole('heading', { name: 'Ternix is locked' })).toBeVisible();
        await unlock(a, alicePassword);
        await expect(a.getByTestId(`host-${HOST_LABEL}`)).toBeVisible({ timeout: 90_000 });
        await expect(nav(a, new RegExp(VAULT_NAME))).toBeVisible();
        await shot(a, '10-alice-after-restart');
      });

      await test.step('7. A removes bob: the key rotates and the vault leaves bob by realtime', async () => {
        await nav(a, /^Sharing/).click();
        await a.getByRole('option', { name: new RegExp(VAULT_NAME) }).click();
        await expect(a.getByTestId(`member-${bobEmail}`)).toBeVisible({ timeout: 30_000 });
        const before = await keyVersion(a);

        await a.getByTestId(`member-${bobEmail}`).getByRole('button', { name: 'Remove' }).click();
        await a.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
        const removedAt = Date.now();
        await expect(a.getByText(/Member removed and the vault key rotated/)).toBeVisible({
          timeout: 90_000,
        });
        latency['rotation_after_remove_ms'] = Date.now() - removedAt;
        await expect
          .poll(() => keyVersion(a), { message: 'key version increments' })
          .toBe(before + 1);
        latency['key_version_before'] = before;
        latency['key_version_after'] = before + 1;
        await shot(a, '11-alice-removed-bob');

        await elapsedUntil(removedAt, 'vault_disappears_for_bob_ms', () =>
          expect(nav(b, new RegExp(VAULT_NAME))).toHaveCount(0, { timeout: REALTIME_TIMEOUT }),
        );
        await shot(b, '12-bob-vault-gone');
      });
    } finally {
      await appA.close().catch(() => undefined);
      await bob?.app.close().catch(() => undefined);
    }

    expect.soft(consoleErrors, 'console errors in the renderer').toEqual([]);
    const crashes = mainLogs
      .join('')
      .match(
        /.*(Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError|Cannot find module).*/g,
      );
    expect.soft(crashes, 'errors in the main process').toBeNull();
  });
});
