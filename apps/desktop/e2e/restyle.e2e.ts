import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { answerDialog, stubDialogs } from './support/dialogs.js';
import {
  type RunningServer,
  type SshTarget,
  startSshTarget,
  startTernixServer,
} from './support/servers.js';
import { restyleShot } from './support/ui.js';

/**
 * Walks the packaged app through its main screens and writes full-window PNGs to
 * `artifacts/restyle-*.png`, so a restyle can be reviewed by eye. (The key change dialog is
 * captured in desktop.e2e.ts, where its state already exists.)
 */

const EXECUTABLE = process.env['TERNIX_E2E_EXECUTABLE'];
const PASSWORD = 'correct-horse-battery-staple';

let server: RunningServer;
let target: SshTarget;
let userData: string;

test.beforeAll(async () => {
  if (!EXECUTABLE) throw new Error('Set TERNIX_E2E_EXECUTABLE to the packaged Ternix binary');
  server = await startTernixServer();
  target = await startSshTarget();
  userData = mkdtempSync(join(tmpdir(), 'ternix-restyle-user-'));
});

test.afterAll(async () => {
  await server?.stop();
  await target?.stop();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

const invoke = (page: Page, method: string, arg?: unknown) =>
  page.evaluate(
    ([m, a]) =>
      (
        window as unknown as {
          ternix: { invoke(m: string, a?: unknown): Promise<{ ok: boolean; value?: unknown }> };
        }
      ).ternix.invoke(m as string, a),
    [method, arg] as const,
  );

const nav = (page: Page, name: RegExp | string) =>
  page.locator('nav.sidebar').getByRole('button', { name });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: EXECUTABLE,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env } as Record<string, string>,
    timeout: 90_000,
  });
  await stubDialogs(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function put(page: Page, vaultId: string, draft: Record<string, unknown>) {
  const result = await invoke(page, 'items.put', { vaultId, draft });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

test('screenshots of the restyled screens', async () => {
  const { app, page } = await launch();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);

  await test.step('welcome and sign-in', async () => {
    await expect(page.getByText('Connect to your server')).toBeVisible();
    await page.getByLabel('Server address').fill(server.url);
    await expect(page.getByTestId('server-info')).toContainText('open');
    await restyleShot(page, '01-server-setup');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.getByLabel('Email').fill('alice@example.com');
    await restyleShot(page, '02-sign-in');
  });

  await test.step('register', async () => {
    await page.getByRole('tab', { name: 'Create account' }).click();
    await page.getByLabel('Email').fill('alice@example.com');
    await page.getByLabel('Your name').fill('Alice');
    await page.getByLabel('Master password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Repeat master password').fill(PASSWORD);
    await restyleShot(page, '03-register');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByTestId('host-list')).toBeVisible({ timeout: 60_000 });
  });

  let vaultId = '';
  await test.step('some data', async () => {
    const vaults = (await invoke(page, 'vaults.list')) as { value: { id: string }[] };
    vaultId = vaults.value[0]!.id;
    await put(page, vaultId, { type: 'group', label: 'Production' });
    const all = (await invoke(page, 'items.all')) as {
      value: { items: { id: string; payload: { type: string; label?: string } }[] }[];
    };
    const group = all.value
      .flatMap((v) => v.items)
      .find((i) => i.payload.type === 'group' && i.payload.label === 'Production')!;
    const hosts: [string, string, string | undefined, string?][] = [
      ['acme-db-prod', 'deploy', '#E95420'],
      ['api-gateway', 'root', '#CE0056'],
      ['build-runner', 'ci', '#1793D1'],
      ['edge-proxy', 'ops', '#3C6EB4'],
      ['staging-web', 'stan', undefined],
      ['backup-nas', 'admin', '#30BA78'],
      ['prod-web-1', 'deploy', '#EFA720', group.id],
    ];
    for (const [label, username, color, group_id] of hosts) {
      await put(page, vaultId, {
        type: 'host',
        label,
        address: `${label}.example.com`,
        port: 22,
        username,
        tags: [],
        agent_forwarding: false,
        ...(color ? { color } : {}),
        ...(group_id ? { group_id } : {}),
      });
    }
    await put(page, vaultId, {
      type: 'host',
      label: 'e2e-box',
      address: target.address,
      port: target.port,
      username: target.username,
      password: target.password,
      tags: ['lab'],
      agent_forwarding: false,
      color: '#21B568',
    });
    if (target.userKey) {
      await put(page, vaultId, {
        type: 'ssh_key',
        label: 'deploy key',
        private_key: target.userKey.privateKey,
      });
      await put(page, vaultId, {
        type: 'ssh_key',
        label: 'backup key',
        private_key: target.userKey.privateKey,
      });
    }
    await put(page, vaultId, { type: 'identity', label: 'Leah', username: 'leah', password: 'x' });
    await put(page, vaultId, {
      type: 'snippet',
      label: 'Disk usage',
      script: 'df -h',
      tags: [],
    });
    await put(page, vaultId, {
      type: 'snippet',
      label: 'Greeting',
      script: 'echo hello',
      tags: [],
    });
    await expect(page.getByTestId('host-e2e-box')).toBeVisible();
  });

  await test.step('hosts grid and host details', async () => {
    await restyleShot(page, '04-hosts-grid');
    await page.getByTestId('host-acme-db-prod').click();
    await expect(page.getByRole('region', { name: /Edit host/ })).toBeVisible();
    await restyleShot(page, '05-host-details');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await test.step('keychain and snippets', async () => {
    await nav(page, /^Keychain/).click();
    await expect(page.locator('.entity-title', { hasText: 'Leah' })).toBeVisible();
    await restyleShot(page, '06-keychain');
    await nav(page, /^Snippets/).click();
    await expect(page.locator('.entity-title', { hasText: 'Greeting' })).toBeVisible();
    await restyleShot(page, '07-snippets');
    await nav(page, /^Hosts/).click();
  });

  await test.step('a terminal tab', async () => {
    await page.getByTestId('host-e2e-box').getByRole('button', { name: 'Connect' }).click();
    await answerDialog(app, 'Connect to a new host?', 'Connect');
    await answerDialog(app, 'Trust this host?', 'Trust and connect');
    await expect(page.getByTestId('terminal-status')).toHaveCount(0, { timeout: 30_000 });
    await page.locator('.terminal-pane[style*="flex"] .xterm-helper-textarea').focus();
    await page.keyboard.type('echo hello from ternix');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
    await page.waitForTimeout(500);
    await restyleShot(page, '08-terminal');
    await page.getByRole('main').getByRole('button', { name: 'Snippets', exact: true }).click();
    await restyleShot(page, '09-terminal-snippets');
    await page.getByRole('main').getByRole('button', { name: 'Snippets', exact: true }).click();
    await page.getByRole('tab', { name: 'Vaults' }).click();
  });

  await test.step('sharing and settings', async () => {
    await nav(page, /^Sharing/).click();
    await page.getByRole('button', { name: 'New shared vault' }).click();
    await page.getByLabel('Name').fill('Team');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('option', { name: /Team/ })).toBeVisible();
    await restyleShot(page, '10-sharing');
    await page.getByRole('button', { name: 'Choose vault' }).click();
    await restyleShot(page, '11-vault-picker');
    await page.keyboard.press('Escape');
    await nav(page, /^Settings/).click();
    await restyleShot(page, '13-settings');
  });

  await test.step('light theme', async () => {
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByLabel('Theme').selectOption('light');
    await nav(page, /^Hosts/).click();
    await page.getByTestId('host-api-gateway').click();
    await expect(page.getByRole('region', { name: /Edit host/ })).toBeVisible();
    await restyleShot(page, '14-hosts-light');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await nav(page, /^Settings/).click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByLabel('Theme').selectOption('dark');
  });

  await test.step('lock screen', async () => {
    await page.getByTestId('lock-now').click();
    await expect(page.getByRole('heading', { name: 'Ternix is locked' })).toBeVisible();
    await restyleShot(page, '15-lock');
  });

  await app.close();
});
