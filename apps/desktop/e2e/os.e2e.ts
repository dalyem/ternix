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
import { answerDialog, stubDialogs } from './support/dialogs.js';
import {
  type RunningServer,
  type SshTarget,
  startSshTarget,
  startTernixServer,
} from './support/servers.js';

/**
 * Host operating systems: tiles show the stored `os`, and connecting a saved host detects it and
 * writes it to the host item. With E2E_SSH_* set the target is a real OpenSSH (the Kiln VM runs
 * Ubuntu 24.04, so `ubuntu` is expected; E2E_SSH_EXPECTED_OS overrides); otherwise the fake sshd
 * answers the probe with an Alpine os-release, so the in-process path is checked too. Also checks
 * the terminal's bottom edge (no black strip under the last row) and writes `artifacts/os-*.png`.
 */

const EXECUTABLE = process.env['TERNIX_E2E_EXECUTABLE'];
const PASSWORD = 'correct-horse-battery-staple';
const ARTIFACTS = resolve(import.meta.dirname, 'artifacts');
const REAL_SSHD = Boolean(process.env['E2E_SSH_ADDRESS']);
const EXPECTED_OS = process.env['E2E_SSH_EXPECTED_OS'] ?? (REAL_SSHD ? 'ubuntu' : 'alpine');
const FAKE_PROBE = 'Linux\nNAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3\n';

let server: RunningServer;
let target: SshTarget;
let userData: string;

test.beforeAll(async () => {
  if (!EXECUTABLE) throw new Error('Set TERNIX_E2E_EXECUTABLE to the packaged Ternix binary');
  mkdirSync(ARTIFACTS, { recursive: true });
  server = await startTernixServer();
  target = await startSshTarget({ probeOutput: FAKE_PROBE });
  userData = mkdtempSync(join(tmpdir(), 'ternix-os-user-'));
});

test.afterAll(async () => {
  await server?.stop();
  await target?.stop();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

type Invoke = { ok: boolean; value?: unknown; error?: unknown };
const invoke = (page: Page, method: string, arg?: unknown) =>
  page.evaluate(
    ([m, a]) =>
      (
        window as unknown as { ternix: { invoke(m: string, a?: unknown): Promise<Invoke> } }
      ).ternix.invoke(m as string, a),
    [method, arg] as const,
  );

interface ListedHost {
  id: string;
  payload: { type: string; label?: string; os?: string; has_password?: boolean };
}

async function hostByLabel(page: Page, label: string): Promise<ListedHost | undefined> {
  const all = (await invoke(page, 'items.all')) as { value: { items: ListedHost[] }[] };
  return all.value.flatMap((v) => v.items).find((i) => i.payload.label === label);
}

async function put(page: Page, vaultId: string, draft: Record<string, unknown>, itemId?: string) {
  const result = await invoke(page, 'items.put', { vaultId, draft, ...(itemId ? { itemId } : {}) });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(ARTIFACTS, `os-${name}.png`), type: 'png' });

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

test('host OS icons, detection on connect, and the terminal edge', async () => {
  test.setTimeout(300_000);
  const { app, page } = await launch();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);

  await test.step('register', async () => {
    await page.getByLabel('Server address').fill(server.url);
    await expect(page.getByTestId('server-info')).toContainText('open');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('tab', { name: 'Create account' }).click();
    await page.getByLabel('Email').fill('olga@example.com');
    await page.getByLabel('Your name').fill('Olga');
    await page.getByLabel('Master password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Repeat master password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByTestId('host-list')).toBeVisible({ timeout: 60_000 });
  });

  const vaults = (await invoke(page, 'vaults.list')) as { value: { id: string }[] };
  const vaultId = vaults.value[0]!.id;

  await test.step('a grid of hosts with different systems', async () => {
    const seeded: [string, string | undefined, string?][] = [
      ['web-ubuntu', 'ubuntu'],
      ['db-debian', 'debian'],
      ['ci-fedora', 'fedora'],
      ['nas-freebsd', 'freebsd'],
      ['arch-desk', 'arch'],
      ['edge-alpine', 'alpine'],
      ['rocky-app', 'rocky'],
      ['nix-build', 'nixos'],
      ['pi-sensor', 'raspbian'],
      ['mac-mini', 'macos'],
      ['win-jump', 'windows'],
      ['plain-linux', 'linux'],
      ['amzn-worker', 'amazon'],
      ['mint-laptop', 'mint'],
      ['branded-db', 'debian', '#AF5FFF'],
      ['mystery-box', undefined],
    ];
    for (const [label, os, color] of seeded) {
      await put(page, vaultId, {
        type: 'host',
        label,
        address: `${label}.example.com`,
        ...(os ? { os } : {}),
        ...(color ? { color } : {}),
      });
    }
    await expect(page.getByTestId('host-mystery-box')).toBeVisible();
    await expect(page.getByTestId('host-web-ubuntu').locator('.tile')).toHaveAttribute(
      'data-os',
      'ubuntu',
    );
    await expect(page.getByTestId('host-win-jump').locator('.tile')).toHaveAttribute(
      'data-os',
      'windows',
    );
    // The user's colour beats the system's; no system keeps the server glyph.
    await expect(page.getByTestId('host-branded-db').locator('.tile')).toHaveCSS(
      'background-color',
      'rgb(175, 95, 255)',
    );
    await expect(page.getByTestId('host-mystery-box').locator('.tile')).toHaveAttribute(
      'data-os',
      '',
    );
    await page.waitForTimeout(300);
    await shot(page, '01-host-grid');
  });

  await test.step('the Vaults tab icon', async () => {
    await page.locator('.vault-tab').screenshot({ path: join(ARTIFACTS, 'os-02-vaults-tab.png') });
    // Lucide's `layers` glyph, not `vault` (which read as an X in a box) nor `lock`.
    await expect(page.locator('.tab-vault svg')).toHaveClass(/lucide-layers/);
  });

  await put(page, vaultId, {
    type: 'host',
    label: 'detect-me',
    address: target.address,
    port: target.port,
    username: target.username,
    password: target.password,
  });
  const before = await hostByLabel(page, 'detect-me');
  expect(before?.payload.os).toBeUndefined();

  await test.step('connecting detects the system and stores it', async () => {
    await page.getByTestId('host-detect-me').getByRole('button', { name: 'Connect' }).click();
    await answerDialog(app, 'Connect to a new host?', 'Connect');
    await answerDialog(app, 'Trust this host?', 'Trust and connect');
    await expect(page.getByTestId('terminal-status')).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => (await hostByLabel(page, 'detect-me'))?.payload.os, {
        message: `the host's os becomes ${EXPECTED_OS}`,
        timeout: 30_000,
      })
      .toBe(EXPECTED_OS);
    const after = await hostByLabel(page, 'detect-me');
    // Written from main's copy: the password survived the write.
    expect(after?.payload.has_password).toBe(true);
  });

  await test.step('the terminal has no line along its bottom edge', async () => {
    await page.locator('.terminal-pane[style*="flex"] .xterm-helper-textarea').focus();
    await page.keyboard.type('echo bottom edge');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const geometry = await page.evaluate(() => {
      const pane = document.querySelector('.terminal-pane[style*="flex"]')!;
      const rect = (selector: string) => {
        const el = pane.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          height: r.height,
          background: getComputedStyle(el).backgroundColor,
        };
      };
      // Whatever is painted at the last pixel row inside the terminal, centre column.
      const xterm = pane.querySelector('.xterm')!.getBoundingClientRect();
      const y = xterm.bottom - 0.5;
      const x = xterm.left + xterm.width / 2;
      const painted = document
        .elementsFromPoint(x, y)
        .map((el) => getComputedStyle(el).backgroundColor)
        .find((bg) => bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent');
      return {
        xterm: rect('.xterm'),
        viewport: rect('.xterm-viewport'),
        scrollArea: rect('.xterm-scrollable-element'),
        screen: rect('.xterm-screen'),
        paintedAtBottom: painted ?? null,
      };
    });
    writeFileSync(join(ARTIFACTS, 'os-terminal-geometry.json'), JSON.stringify(geometry, null, 2));
    expect(geometry.viewport?.background).toBe('rgba(0, 0, 0, 0)');
    // The terminal background (#141729), not the viewport's black.
    expect(geometry.paintedAtBottom).toBe('rgb(20, 23, 41)');
    await shot(page, '04-terminal-bottom');
    const box = await page.locator('.terminal-pane[style*="flex"] .terminal-body').boundingBox();
    if (box) {
      await page.screenshot({
        path: join(ARTIFACTS, 'os-05-terminal-bottom-crop.png'),
        clip: { x: box.x, y: box.y + box.height - 60, width: 360, height: 60 },
      });
    }
  });

  await test.step('the tile and the tab show the detected system', async () => {
    await page.getByRole('tab', { name: 'Vaults' }).click();
    const tile = page.getByTestId('host-detect-me').locator('.tile');
    await expect(tile).toHaveAttribute('data-os', EXPECTED_OS);
    await page.waitForTimeout(300);
    await shot(page, '03-detected-tile');
    await page.getByTestId('host-detect-me').screenshot({
      path: join(ARTIFACTS, 'os-03-detected-tile-crop.png'),
    });
    // The inactive terminal tab shows the system's mark instead of the terminal glyph.
    await expect(page.getByTestId('terminal-tab').locator('svg.tab-icon-glyph')).not.toHaveClass(
      /lucide-square-terminal/,
    );
    await page.locator('.titlebar').screenshot({ path: join(ARTIFACTS, 'os-06-tab-bar.png') });
  });

  await test.step('an edit without os keeps it; with detection off nothing is written', async () => {
    const host = (await hostByLabel(page, 'detect-me'))!;
    await page.getByTestId('host-detect-me').click();
    const label = page.getByRole('region', { name: /Edit host/ }).getByLabel('Label');
    await label.fill('detect-me');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(async () => (await hostByLabel(page, 'detect-me'))?.payload.os)
      .toBe(EXPECTED_OS);

    expect((await invoke(page, 'settings.set', { detectHostOs: false })).ok).toBe(true);
    await put(
      page,
      vaultId,
      {
        type: 'host',
        label: 'detect-me',
        address: target.address,
        port: target.port,
        username: target.username,
        os: 'gentoo',
      },
      host.id,
    );
    await page.getByTestId('terminal-tab').click();
    await page.getByRole('button', { name: /Close detect-me/ }).click();
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByTestId('host-detect-me').getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByTestId('terminal-status')).toHaveCount(0, { timeout: 30_000 });
    await page.waitForTimeout(3_000);
    expect((await hostByLabel(page, 'detect-me'))?.payload.os).toBe('gentoo');
  });

  await app.close();
});
