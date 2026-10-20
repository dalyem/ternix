import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
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
  type RunningServer,
  type SshTarget,
  startEchoServer,
  startSshTarget,
  startTernixServer,
} from './support/servers.js';

const ARTIFACTS = resolve(import.meta.dirname, 'artifacts');
const EXECUTABLE = process.env['TERNIX_E2E_EXECUTABLE'];

const PASSWORD = 'correct-horse-battery-staple';
const HOST_LABEL = 'e2e-box';

let server: RunningServer;
let target: SshTarget;
let echo: { port: number; stop(): Promise<void> };
const dirs: string[] = [];
const consoleErrors: string[] = [];
/** Everything the main processes wrote to stdout and stderr. */
const mainLogs: string[] = [];

test.beforeAll(async () => {
  if (!EXECUTABLE) throw new Error('Set TERNIX_E2E_EXECUTABLE to the packaged Ternix binary');
  mkdirSync(ARTIFACTS, { recursive: true });
  server = await startTernixServer();
  target = await startSshTarget();
  echo = await startEchoServer();
});

test.afterAll(async () => {
  await server?.stop();
  await target?.stop();
  await echo?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function newUserDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ternix-e2e-user-'));
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
  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(ARTIFACTS, `${name}.jpg`), type: 'jpeg', quality: 85 });

async function registerUser(page: Page, email: string, name: string, shotName?: string) {
  await page.getByLabel('Server address').fill(server.url);
  await expect(page.getByTestId('server-info')).toContainText('Registration');
  await expect(page.getByTestId('server-info')).toContainText('open');
  if (shotName) await shot(page, `${shotName}-setup`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Master password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat master password').fill(PASSWORD);
  if (shotName) await shot(page, `${shotName}-register`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('host-list')).toBeVisible({ timeout: 60_000 });
}

/** Text of every row of the visible terminal, from xterm's DOM renderer. */
const terminalRows = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.terminal-pane[style*="flex"] .xterm-rows > div')].map(
      (row) => row.textContent ?? '',
    ),
  );

async function expectTerminalLine(page: Page, line: string | RegExp) {
  await expect
    .poll(
      async () =>
        (await terminalRows(page)).some((row) =>
          typeof line === 'string' ? row.trim() === line : line.test(row),
        ),
      { message: `terminal shows ${String(line)}` },
    )
    .toBe(true);
}

/** Waits for the visible terminal's status banner to go away; a failure shows what it said. */
async function expectConnected(page: Page) {
  await expect
    .poll(
      async () => {
        const banner = page.getByTestId('terminal-status');
        return (await banner.count()) === 0
          ? 'connected'
          : ((await banner.first().textContent()) ?? '');
      },
      { timeout: 30_000, message: 'terminal connected' },
    )
    .toBe('connected');
}

async function typeInTerminal(page: Page, text: string) {
  await page.locator('.terminal-pane[style*="flex"] .xterm-helper-textarea').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

const nav = (page: Page, name: RegExp | string) =>
  page.locator('nav.sidebar').getByRole('button', { name });

function tcpRoundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolveData, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload));
    socket.once('data', (data) => {
      socket.destroy();
      resolveData(data.toString());
    });
    socket.once('error', reject);
    setTimeout(() => reject(new Error('no echo through the forward')), 15_000).unref();
  });
}

test('packaged app: setup, register, host, host key, terminal, forwards, snippets, lock, restart', async () => {
  const userData = newUserDataDir();
  let { app, page } = await launch(userData);

  await test.step('the window is sandboxed and exposes only the bridge', async () => {
    await expect(page.getByText('Connect to your server')).toBeVisible();
    const exposed = await page.evaluate(() => ({
      bridge: Object.keys((window as unknown as { ternix: object }).ternix).sort(),
      hasRequire: typeof (window as unknown as { require?: unknown }).require,
      hasProcess: typeof (window as unknown as { process?: unknown }).process,
      ipcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
      origin: location.origin,
    }));
    expect(exposed.bridge).toEqual(['invoke', 'onEvent', 'onTerminalData']);
    expect(exposed.hasRequire).toBe('undefined');
    expect(exposed.hasProcess).toBe('undefined');
    expect(exposed.ipcRenderer).toBe('undefined');
    expect(exposed.origin).toBe('ternix://app');
  });

  await test.step('main rejects malformed requests', async () => {
    const invoke = (method: string, arg?: unknown) =>
      page.evaluate(
        ([m, a]) =>
          (
            window as unknown as { ternix: { invoke(m: string, a?: unknown): Promise<unknown> } }
          ).ternix.invoke(m as string, a),
        [method, arg] as const,
      );
    expect(await invoke('vaults.rename', { vaultId: 'not-a-uuid', name: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await invoke('no.such.method')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await invoke('shell.openLink', { url: 'file:///etc/passwd' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });

  await test.step('server setup, register', async () => {
    await registerUser(page, 'alice@example.com', 'Alice', '01');
  });

  await test.step('create a host with a password', async () => {
    await page.getByTestId('new-host').click();
    await page.getByLabel('Label', { exact: true }).fill(HOST_LABEL);
    await page.getByLabel('Address', { exact: true }).fill(target.address);
    await page.getByLabel('Port', { exact: true }).fill(String(target.port));
    await page.getByLabel('Username', { exact: true }).fill(target.username);
    await page.getByLabel('Password', { exact: true }).fill(target.password);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId(`host-${HOST_LABEL}`)).toBeVisible();
    await shot(page, '03-host-list');
  });

  await test.step('create a local port forward and a snippet', async () => {
    await nav(page, /^Port forwards/).click();
    await page.getByRole('button', { name: 'New port forward' }).click();
    await page.getByLabel('Label', { exact: true }).fill('echo');
    await page.getByLabel('Host', { exact: true }).selectOption({ label: HOST_LABEL });
    await page.getByLabel('Listen port').fill('0');
    await page.getByLabel('Destination host').fill('127.0.0.1');
    await page.getByLabel('Destination port').fill(String(echo.port));
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.host-label', { hasText: 'echo' })).toBeVisible();

    await nav(page, /^Snippets/).click();
    await page.getByRole('button', { name: 'New snippet' }).click();
    await page.getByLabel('Label', { exact: true }).fill('greet');
    await page.getByLabel('Script').fill("echo sni''ppet");
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.host-label', { hasText: 'greet' })).toBeVisible();
    await nav(page, /^Hosts/).click();
  });

  await test.step('connect and verify the unknown host key', async () => {
    await page.getByTestId(`host-${HOST_LABEL}`).getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Trust this host?' });
    await expect(dialog).toBeVisible();
    if (target.fingerprint) await expect(dialog).toContainText(target.fingerprint);
    await shot(page, '04-host-key');
    await dialog.getByRole('button', { name: 'Trust and connect' }).click();
  });

  await test.step('run a command and see its output', async () => {
    await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
    await expectConnected(page);
    await expect
      .poll(async () => (await terminalRows(page)).join('').trim().length)
      .toBeGreaterThan(0);
    // The quotes keep the typed line different from the output: only a run command prints `hello`.
    await typeInTerminal(page, "echo hel''lo");
    await expectTerminalLine(page, 'hello');
    await shot(page, '05-terminal');
  });

  await test.step('snippet panel runs a snippet in the terminal', async () => {
    await page.getByRole('main').getByRole('button', { name: 'Snippets', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Snippets' });
    await panel
      .locator('.snippet', { hasText: 'greet' })
      .getByRole('button', { name: 'Run' })
      .click();
    await expectTerminalLine(page, 'snippet');
    await page.getByRole('main').getByRole('button', { name: 'Snippets', exact: true }).click();
  });

  await test.step('port forward: start it and send bytes through the tunnel', async () => {
    await page.getByRole('button', { name: /^Forwards/ }).click();
    const card = page.getByTestId('forward-echo');
    await expect(card).toContainText('idle');
    await card.getByRole('button', { name: 'Start' }).click();
    await expect(card).toContainText('active');
    const text = (await card.textContent()) ?? '';
    const bound = /127\.0\.0\.1:(\d+) →/.exec(text);
    expect(bound, `bound port in "${text}"`).not.toBeNull();
    expect(await tcpRoundTrip(Number(bound![1]), 'ping-through-ssh')).toBe('ping-through-ssh');
    await shot(page, '06-forwards');
    await card.getByRole('button', { name: 'Stop' }).click();
    await expect(card).toContainText('stopped');
    await page.getByRole('button', { name: /^Forwards/ }).click();
  });

  await test.step('the accepted key was saved as a known_host item', async () => {
    await page.getByRole('tab', { name: 'Vaults' }).click();
    await nav(page, /^Known hosts/).click();
    await expect(
      page.locator('.host-label', { hasText: `${target.address}:${target.port}` }),
    ).toBeVisible();
    if (target.fingerprint) {
      await expect(page.locator('.fingerprint', { hasText: target.fingerprint })).toBeVisible();
    }
    await shot(page, '07-known-hosts');
    await page.getByTestId('terminal-tab').click();
  });

  await test.step('lock hides the vault, the session stays, unlock restores', async () => {
    await page.getByTestId('lock-now').click();
    await expect(page.getByRole('heading', { name: 'Ternix is locked' })).toBeVisible();
    await shot(page, '08-locked');
    await page.getByLabel('Master password').fill('wrong password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('alert')).toContainText(/password/i);
    await page.getByLabel('Master password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByTestId('lock-now')).toBeVisible();
    await page.getByTestId('terminal-tab').click();
    await typeInTerminal(page, "echo still''connected");
    await expectTerminalLine(page, 'stillconnected');
  });

  await test.step('the session is stored encrypted, not in plain text', async () => {
    const stored = readFileSync(join(userData, 'session.bin'));
    expect(stored.length).toBeGreaterThan(100);
    const text = stored.toString('latin1');
    for (const needle of ['alice@example.com', 'token', 'encrypted_private_key', server.url]) {
      expect(text).not.toContain(needle);
    }
  });

  await test.step('exit ends the session and reconnect starts it again', async () => {
    await typeInTerminal(page, 'exit');
    const banner = page.getByTestId('terminal-status');
    await expect(banner).toContainText('Session ended');
    await banner.getByRole('button', { name: 'Reconnect' }).click();
    await expectConnected(page);
    await typeInTerminal(page, "echo re''connected");
    await expectTerminalLine(page, 'reconnected');
  });

  await test.step('a changed host key is refused unless replaced explicitly', async () => {
    // Needs the in-process SSH server: a real sshd cannot rotate its host key from here.
    if (!target.fingerprint) return;
    const oldFingerprint = target.fingerprint!;
    await target.rotateHostKey();
    const newFingerprint = target.fingerprint!;
    expect(newFingerprint).not.toBe(oldFingerprint);

    await typeInTerminal(page, 'exit');
    const banner = page.getByTestId('terminal-status');
    await expect(banner).toContainText('Session ended');
    await banner.getByRole('button', { name: 'Reconnect' }).click();

    const warning = page.getByRole('dialog', { name: /host key has changed/i });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(oldFingerprint);
    await expect(warning).toContainText(newFingerprint);
    await expect(warning.getByRole('button', { name: /Replace stored key/ })).toBeDisabled();
    await shot(page, '09-host-key-changed');
    await warning.getByRole('button', { name: 'Disconnect' }).click();
    await expect(banner).toContainText('CHANGED');

    await banner.getByRole('button', { name: 'Reconnect' }).click();
    await expect(warning).toBeVisible();
    await warning.getByRole('checkbox').check();
    await warning.getByRole('button', { name: /Replace stored key/ }).click();
    await expectConnected(page);
    await typeInTerminal(page, "echo new''key");
    await expectTerminalLine(page, 'newkey');

    await page.getByRole('tab', { name: 'Vaults' }).click();
    await nav(page, /^Known hosts/).click();
    await expect(page.locator('.fingerprint', { hasText: newFingerprint })).toBeVisible();
    await expect(page.locator('.fingerprint', { hasText: oldFingerprint })).toHaveCount(0);
    await page.getByTestId('terminal-tab').click();
  });

  await test.step('quick connect to the known host with a typed password', async () => {
    await page.getByRole('tab', { name: 'Vaults' }).click();
    await nav(page, /^Hosts/).click();
    await page
      .getByLabel('Quick connect', { exact: true })
      .fill(`${target.username}@${target.address}:${target.port}`);
    await page.getByRole('button', { name: 'Password…' }).click();
    await page.getByLabel('Quick connect password').fill(target.password);
    await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
    await expect(page.getByTestId('terminal-tab')).toHaveCount(2);
    await expectConnected(page);
    await typeInTerminal(page, "echo quick''connect");
    await expectTerminalLine(page, 'quickconnect');
  });

  await test.step('key authentication with a pasted SSH key', async () => {
    if (!target.userKey) return; // the real sshd has no authorized key for this test
    await page.getByRole('tab', { name: 'Vaults' }).click();
    await nav(page, /^Keychain/).click();
    await page.getByRole('button', { name: 'New SSH key' }).click();
    await page.getByLabel('Label', { exact: true }).fill('e2e-key');
    await page.getByLabel('Private key').fill(target.userKey.privateKey);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.host-label', { hasText: 'e2e-key' })).toBeVisible();

    await nav(page, /^Hosts/).click();
    await page.getByTestId('new-host').click();
    await page.getByLabel('Label', { exact: true }).fill('key-box');
    await page.getByLabel('Address', { exact: true }).fill(target.address);
    await page.getByLabel('Port', { exact: true }).fill(String(target.port));
    await page.getByLabel('Username', { exact: true }).fill(target.username);
    await page.getByLabel('SSH key').selectOption({ label: 'e2e-key' });
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByTestId('host-key-box').getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByTestId('terminal-tab')).toHaveCount(3);
    await expectConnected(page);
    await typeInTerminal(page, "echo key''auth");
    await expectTerminalLine(page, 'keyauth');
  });

  await test.step('admin settings: invites and devices', async () => {
    await nav(page, /^Settings/).click();
    await page.getByRole('tab', { name: 'Devices' }).click();
    await expect(page.getByText('this device')).toBeVisible();
    await page.getByRole('tab', { name: 'Admin' }).click();
    await page.getByRole('button', { name: 'Create invite' }).click();
    const code = page.getByTestId('invite-code');
    await expect(code).toBeVisible();
    const invite = ((await code.textContent()) ?? '').trim();
    await expect(page.getByRole('row', { name: new RegExp(invite) })).toBeVisible();
    await shot(page, '11-admin');
    await page
      .getByRole('row', { name: new RegExp(invite) })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(page.getByRole('row', { name: new RegExp(invite) })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Alice/ })).toBeVisible();
  });

  await test.step('restart: the saved session asks for the password only', async () => {
    await app.close();
    ({ app, page } = await launch(userData));
    await expect(page.getByRole('heading', { name: 'Ternix is locked' })).toBeVisible();
    await page.getByLabel('Master password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByTestId(`host-${HOST_LABEL}`)).toBeVisible({ timeout: 60_000 });
    await page.getByTestId(`host-${HOST_LABEL}`).getByRole('button', { name: 'Connect' }).click();
    // The key was saved, so there is no host-key prompt this time.
    await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
    await expect(
      page.getByRole('dialog', { name: /Trust this host|host key has changed/ }),
    ).toHaveCount(0);
    await expectTerminalLine(page, /Welcome/);
    await shot(page, '10-after-restart');
  });

  await app.close();
});

test('sharing: fingerprint check, roles, realtime, removal', async () => {
  const alice = await launch(newUserDataDir());
  const bob = await launch(newUserDataDir());
  const a = alice.page;
  const b = bob.page;

  await test.step('two people register', async () => {
    await registerUser(a, 'alice2@example.com', 'Alice Two');
    await registerUser(b, 'bob@example.com', 'Bob');
  });

  let bobFingerprint = '';
  await test.step('Bob reads his fingerprint from Settings, as he would read it to Alice', async () => {
    await nav(b, /^Settings/).click();
    const fingerprint = b.locator('.facts .fingerprint').first();
    await expect(fingerprint).toBeVisible();
    bobFingerprint = ((await fingerprint.textContent()) ?? '').trim();
    expect(bobFingerprint).toMatch(/^[0-9a-f ]{20,}$/i);
    await nav(b, /^Hosts/).click();
  });

  await test.step('Alice creates a shared vault', async () => {
    await nav(a, /^Sharing/).click();
    await a.getByRole('button', { name: 'New shared vault' }).click();
    await a.getByLabel('Name').fill('Team');
    await a.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(a.getByRole('option', { name: /Team/ })).toBeVisible();
  });

  await test.step('she must confirm the fingerprint before adding Bob', async () => {
    await a.getByLabel('Email of the person to add').fill('bob@example.com');
    await a.getByRole('button', { name: 'Look up' }).click();
    const found = a.locator('.card .fingerprint');
    await expect(found).toBeVisible();
    expect(((await found.textContent()) ?? '').trim()).toBe(bobFingerprint);
    const add = a.getByRole('button', { name: 'Add to vault' });
    await expect(add).toBeDisabled();
    await a.getByRole('checkbox', { name: /checked this fingerprint/ }).check();
    await shot(a, 'share-1-verify');
    await add.click();
    await expect(a.getByRole('row', { name: /Bob/ })).toContainText('viewer');
  });

  await test.step('a host saved in the shared vault reaches Bob in real time, read-only', async () => {
    await nav(a, /^Team/).click();
    await nav(a, /^Hosts/).click();
    await a.getByTestId('new-host').click();
    await a.getByLabel('Label', { exact: true }).fill('shared-box');
    await a.getByLabel('Address', { exact: true }).fill('shared.example.com');
    await a.getByRole('button', { name: 'Save' }).click();
    await expect(a.getByTestId('host-shared-box')).toBeVisible();

    await expect(nav(b, /Team/)).toBeVisible({ timeout: 30_000 });
    await expect(b.getByTestId('host-shared-box')).toBeVisible({ timeout: 30_000 });
    await shot(b, 'share-2-bob-viewer');
    await b.getByTestId('host-shared-box').getByRole('button', { name: 'View' }).click();
    await expect(b.getByRole('dialog', { name: /read only/ })).toBeVisible();
    await expect(b.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await b.getByRole('button', { name: 'Close' }).click();
  });

  await test.step('promoting Bob to editor lets him edit', async () => {
    await nav(a, /^Sharing/).click();
    await a.getByLabel('Role of Bob').selectOption('editor');
    await expect(
      b.getByTestId('host-shared-box').getByRole('button', { name: 'Edit' }),
    ).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step('removing Bob rotates the key and takes the vault away', async () => {
    await a.getByRole('row', { name: /Bob/ }).getByRole('button', { name: 'Remove' }).click();
    await a.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await expect(a.getByText(/Member removed and the vault key rotated/)).toBeVisible({
      timeout: 60_000,
    });
    await shot(a, 'share-3-removed');
    await expect(nav(b, /Team/)).toHaveCount(0, { timeout: 30_000 });
    await expect(b.getByTestId('host-shared-box')).toHaveCount(0);
  });

  await alice.app.close();
  await bob.app.close();
});

test.afterEach(() => {
  writeFileSync(join(ARTIFACTS, 'main-process.log'), mainLogs.join(''));
  expect(consoleErrors, 'console errors in the renderer').toEqual([]);
  const crashes = mainLogs
    .join('')
    .match(/.*(Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError|Cannot find module).*/g);
  expect(crashes, 'errors in the main process').toBeNull();
});
