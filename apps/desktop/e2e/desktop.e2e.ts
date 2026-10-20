import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import {
  type RunningServer,
  type SshTarget,
  startEchoServer,
  startKeySwappingProxy,
  startSshTarget,
  startTernixServer,
} from './support/servers.js';
import { answerDialog, askedDialogs, stubDialogs } from './support/dialogs.js';

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
  page.screenshot({ path: join(ARTIFACTS, `${name}.jpg`), type: 'jpeg', quality: 85 });

async function registerUser(
  page: Page,
  email: string,
  name: string,
  shotName?: string,
  serverUrl = server.url,
) {
  await page.getByLabel('Server address').fill(serverUrl);
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

/** A pin badge ("verified", "unverified", "key changed") inside `scope`. */
const pinBadge = (scope: Locator, text: string) =>
  scope.locator('.badge').filter({ hasText: new RegExp(`^${text}$`) });

/** Look a person up on the Sharing page, confirm their fingerprint in main's dialog, add them. */
async function addMemberViaUi(app: ElectronApplication, page: Page, email: string) {
  await page.getByLabel('Email of the person to add').fill(email);
  await page.getByRole('button', { name: 'Look up' }).click();
  const fingerprint = ((await page.locator('.card .fingerprint').textContent()) ?? '').trim();
  await page.getByRole('button', { name: 'Add to vault' }).click();
  const asked = await answerDialog(app, 'Share vault', 'It matches, share');
  expect(asked.message).toContain(email);
  expect(asked.detail).toContain(fingerprint);
  await expect(page.getByTestId(`member-${email}`)).toBeVisible();
}

/** Text of the page and the values of its form fields, as an attacker in the renderer sees it. */
const pageText = (page: Page) =>
  page.evaluate(() =>
    [
      document.body.innerText,
      ...[...document.querySelectorAll('input, textarea')].map(
        (el) => (el as HTMLInputElement | HTMLTextAreaElement).value,
      ),
    ].join('\n'),
  );

/** Call main the way the renderer (or code injected into it) can. */
const invoke = (page: Page, method: string, arg?: unknown) =>
  page.evaluate(
    ([m, a]) =>
      (
        window as unknown as { ternix: { invoke(m: string, a?: unknown): Promise<unknown> } }
      ).ternix.invoke(m as string, a),
    [method, arg] as const,
  );

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

  await test.step('the setup screen explains which addresses are accepted', async () => {
    const hint = page.locator('.hint');
    await expect(hint).toContainText('https://<machine>.<tailnet>.ts.net');
    await expect(hint).toContainText('Tailscale serve provides the certificate');
    await expect(hint).toContainText('Plain http:// works only for localhost.');
    await shot(page, '00-setup-hint');
  });

  await test.step('main rejects malformed requests', async () => {
    expect(await invoke(page, 'vaults.rename', { vaultId: 'not-a-uuid', name: 'x' })).toMatchObject(
      {
        ok: false,
        error: { code: 'invalid_input' },
      },
    );
    expect(await invoke(page, 'no.such.method')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await invoke(page, 'shell.openLink', { url: 'file:///etc/passwd' })).toMatchObject({
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

  await test.step('the renderer gets no secrets and cannot probe other servers', async () => {
    const all = await invoke(page, 'items.all');
    expect(all).toMatchObject({ ok: true });
    expect(JSON.stringify(all)).not.toContain(target.password);
    expect(JSON.stringify(all)).toContain('"has_password":true');
    expect(
      await invoke(page, 'server.probe', { address: 'https://attacker.example/leak' }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(
      await invoke(page, 'ssh.answerHostKey', {
        promptId: '3f1c9a52-8e6b-4d0a-9b7e-0a1b2c3d4e5f',
        decision: 'trust',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  await test.step('a new address is approved before anything is sent; declining sends nothing', async () => {
    await page.getByTestId(`host-${HOST_LABEL}`).getByRole('button', { name: 'Connect' }).click();
    const asked = await answerDialog(app, 'Connect to a new host?', 'Cancel');
    expect(asked.message).toContain(`${target.address}:${target.port}`);
    expect(asked.buttons[asked.defaultId]).toBe('Cancel');
    expect(asked.cancelId).toBe(asked.defaultId);
    const banner = page.getByTestId('terminal-status');
    await expect(banner).toContainText('not approved');
    // Declined before the connection started: no host key was ever seen.
    expect((await askedDialogs(app)).map((d) => d.title)).toEqual(['Connect to a new host?']);
    await banner.getByRole('button', { name: 'Reconnect' }).click();
    await answerDialog(app, 'Connect to a new host?', 'Connect');
  });

  await test.step('connect and verify the unknown host key in the native dialog', async () => {
    await shot(page, '04-host-key');
    const asked = await answerDialog(app, 'Trust this host?', 'Trust and connect');
    expect(asked.message).toContain(`${target.address}:${target.port}`);
    if (target.fingerprint) expect(asked.detail).toContain(target.fingerprint);
    expect(asked.buttons[asked.defaultId]).toBe('Cancel');
    expect(asked.cancelId).toBe(asked.defaultId);
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

    const warning = await answerDialog(app, 'Host key changed', 'Disconnect');
    expect(warning.detail).toContain(oldFingerprint);
    expect(warning.detail).toContain(newFingerprint);
    expect(warning.buttons[warning.defaultId]).toBe('Disconnect');
    expect(warning.checkboxLabel).toMatch(/know why the key changed/);
    await expect(banner).toContainText('CHANGED');

    // Replace without ticking "I know why" is still a no.
    await banner.getByRole('button', { name: 'Reconnect' }).click();
    await answerDialog(app, 'Host key changed', 'Replace stored key and connect');
    await expect(banner).toContainText('CHANGED');

    await banner.getByRole('button', { name: 'Reconnect' }).click();
    await answerDialog(app, 'Host key changed', 'Replace stored key and connect', {
      checkbox: true,
    });
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

  await test.step('locking unmounts editors and drops revealed secrets', async () => {
    const body = 'LOCKTEST-SECRET-KEY-BODY';
    await page.getByRole('tab', { name: 'Vaults' }).click();
    await nav(page, /^Keychain/).click();
    await page.getByRole('button', { name: 'New SSH key' }).click();
    await page.getByLabel('Label', { exact: true }).fill('lock-key');
    await page
      .getByLabel('Private key')
      .fill(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`);
    await page.getByLabel('Passphrase').fill('LOCKTEST-PASSPHRASE');
    await page.getByRole('button', { name: 'Save' }).click();
    const row = page.locator('.host-row', { hasText: 'lock-key' });
    await expect(row).toBeVisible();
    // Lists carry no secrets: the reopened editor starts empty until "Show".
    expect(await pageText(page)).not.toContain(body);
    await row.getByRole('button', { name: 'Edit' }).click();
    const editor = page.getByRole('dialog', { name: /Edit SSH key/ });
    await expect(editor.getByLabel('Private key')).toHaveValue('');
    await editor.getByRole('button', { name: 'Show' }).first().click();
    await expect(editor.getByLabel('Private key')).toHaveValue(new RegExp(body));
    await editor.getByLabel('Passphrase').fill('typed-but-not-saved');

    // The editor covers the sidebar, as it would when auto-lock or a screen lock fires.
    expect(await invoke(page, 'auth.lock')).toMatchObject({ ok: true });
    await expect(page.getByRole('heading', { name: 'Ternix is locked' })).toBeVisible();
    await shot(page, '08b-locked-with-editor');
    const locked = await pageText(page);
    for (const secret of [body, 'LOCKTEST-PASSPHRASE', 'typed-but-not-saved', target.password]) {
      expect(locked).not.toContain(secret);
    }
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(page.locator('.terminal-pane')).not.toHaveCount(0);

    await page.getByLabel('Master password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByTestId('lock-now')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await pageText(page)).not.toContain(body);
  });

  await test.step('a new host starts with the default port of its group', async () => {
    await page.getByRole('tab', { name: 'Vaults' }).click();
    await nav(page, /^Hosts/).click();
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByLabel('Label', { exact: true }).fill('lab');
    await page.getByLabel('Default port').fill('2222');
    await expect(page.getByText('Default port for new hosts in this group.')).toBeVisible();
    await shot(page, '12-group-port');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.group-label', { hasText: 'lab' })).toBeVisible();

    await page.getByTestId('new-host').click();
    const port = page.getByLabel('Port', { exact: true });
    const group = page.getByLabel('Group', { exact: true });
    await expect(port).toHaveValue('22');
    await group.selectOption({ label: 'lab' });
    await expect(port).toHaveValue('2222');
    await group.selectOption({ label: 'None' });
    await expect(port).toHaveValue('22');
    await group.selectOption({ label: 'lab' });
    await expect(port).toHaveValue('2222');
    // A port the user typed is never replaced.
    await port.fill('2200');
    await group.selectOption({ label: 'None' });
    await expect(port).toHaveValue('2200');
    await page.getByRole('button', { name: 'Cancel' }).click();
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
    await expectTerminalLine(page, /Welcome/);
    expect(await askedDialogs(app)).toEqual([]);
    await shot(page, '10-after-restart');
  });

  await test.step('a quick connect to an unknown name asks before the name is looked up', async () => {
    const leak = 'e2e@leak-SECRET.invalid';
    expect(
      await invoke(page, 'ssh.quickConnect', { target: leak, cols: 80, rows: 24 }),
    ).toMatchObject({ ok: true });
    const asked = await answerDialog(app, 'Connect to a new host?', 'Cancel');
    expect(asked.message).toContain('leak-SECRET.invalid:22');
    const list = (await invoke(page, 'ssh.list')) as {
      value: { target: string; state: string; closed?: { code?: string } }[];
    };
    const tab = list.value.find((t) => t.target.includes('leak-SECRET.invalid'));
    // Refused by the dialog, not by a failed DNS lookup.
    expect(tab).toMatchObject({ state: 'closed', closed: { code: 'not_approved' } });
  });

  await test.step('signing out replaces the page; the fresh page can probe', async () => {
    await page.evaluate(() => {
      (window as unknown as { __leftBehind?: string }).__leftBehind = 'revealed secret';
    });
    await page.getByTestId('lock-now').click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __leftBehind?: string }).__leftBehind ?? null),
      )
      .toBeNull();
    expect(await invoke(page, 'server.probe', { address: server.url })).toMatchObject({
      ok: true,
      value: { serverUrl: server.url },
    });
    await shot(page, '13-signed-out');
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

  await test.step('she must confirm the fingerprint in main’s dialog before adding Bob', async () => {
    await a.getByLabel('Email of the person to add').fill('bob@example.com');
    await a.getByRole('button', { name: 'Look up' }).click();
    const found = a.locator('.card .fingerprint');
    await expect(found).toBeVisible();
    expect(((await found.textContent()) ?? '').trim()).toBe(bobFingerprint);
    await shot(a, 'share-1-verify');
    const add = a.getByRole('button', { name: 'Add to vault' });
    await add.click();
    const declined = await answerDialog(alice.app, 'Share vault', 'Cancel');
    expect(declined.message).toContain('bob@example.com');
    expect(declined.detail).toContain(bobFingerprint);
    expect(declined.buttons[declined.defaultId]).toBe('Cancel');
    await expect(a.getByTestId('member-bob@example.com')).toHaveCount(0);

    await add.click();
    await answerDialog(alice.app, 'Share vault', 'It matches, share');
    await expect(a.getByRole('row', { name: /Bob/ })).toContainText('viewer');
    // Alice checked the fingerprint herself, so her device pinned Bob's key as verified.
    const bobRow = a.getByTestId('member-bob@example.com');
    await expect(pinBadge(bobRow, 'verified')).toBeVisible();
    await expect(pinBadge(bobRow, 'unverified')).toHaveCount(0);
    await expect(bobRow.getByRole('button', { name: 'Mark verified' })).toHaveCount(0);
    await shot(a, 'share-1b-bob-verified');
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

  await test.step("Bob has never seen Alice's key: unverified until he compares it", async () => {
    await nav(a, /^Sharing/).click();
    const aliceFingerprint = (
      (await a.locator('.server-card .fingerprint').textContent()) ?? ''
    ).trim();
    expect(aliceFingerprint).toMatch(/^[0-9a-f ]{20,}$/i);

    await nav(b, /^Sharing/).click();
    const aliceRow = b.getByTestId('member-alice2@example.com');
    await expect(aliceRow).toBeVisible();
    await expect(pinBadge(aliceRow, 'unverified')).toBeVisible();
    await expect(pinBadge(b.getByTestId('member-bob@example.com'), 'verified')).toBeVisible();
    await shot(b, 'share-1c-bob-sees-unverified');

    await aliceRow.getByRole('button', { name: 'Mark verified' }).click();
    const asked = await answerDialog(bob.app, 'Mark key as verified', 'Cancel');
    expect(asked.detail).toContain(aliceFingerprint);
    expect(asked.message).toContain('alice2@example.com');
    await expect(pinBadge(aliceRow, 'unverified')).toBeVisible();

    await aliceRow.getByRole('button', { name: 'Mark verified' }).click();
    await answerDialog(bob.app, 'Mark key as verified', 'It matches, mark verified');
    await expect(pinBadge(aliceRow, 'verified')).toBeVisible();
    await expect(pinBadge(aliceRow, 'unverified')).toHaveCount(0);
    await expect(aliceRow.getByRole('button', { name: 'Mark verified' })).toHaveCount(0);
    await nav(b, /^Hosts/).click();
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

test('sharing: a substituted member key is refused until the owner verifies it', async () => {
  const alice = await launch(newUserDataDir());
  const a = alice.page;
  await registerUser(a, 'alice3@example.com', 'Alice Three');
  for (const [email, name] of [
    ['bob3@example.com', 'Bob Three'],
    ['carol3@example.com', 'Carol Three'],
  ] as const) {
    const other = await launch(newUserDataDir());
    await registerUser(other.page, email, name);
    await other.app.close();
  }
  const keyVersions = () => server.db.sharedKeyVersions('alice3@example.com');

  await test.step('Alice shares a vault with Bob and Carol', async () => {
    await nav(a, /^Sharing/).click();
    await a.getByRole('button', { name: 'New shared vault' }).click();
    await a.getByLabel('Name').fill('Ops');
    await a.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(a.getByRole('option', { name: /Ops/ })).toBeVisible();
    await addMemberViaUi(alice.app, a, 'bob3@example.com');
    await addMemberViaUi(alice.app, a, 'carol3@example.com');
    expect(keyVersions()).toEqual([1]);
  });

  let carolFingerprint = '';
  let evilFingerprint = '';
  await test.step("the server swaps Carol's public key", async () => {
    const carolRow = a.getByTestId('member-carol3@example.com');
    carolFingerprint = (
      (await carolRow.locator('.fingerprint').first().textContent()) ?? ''
    ).trim();
    server.db.substituteKey('carol3@example.com');

    // Leave and come back so the member list is fetched again.
    await nav(a, /^Hosts/).click();
    await nav(a, /^Sharing/).click();
    await expect(pinBadge(carolRow, 'key changed')).toBeVisible();
    await expect(carolRow.getByText('Pinned earlier:')).toContainText(carolFingerprint);
    evilFingerprint = ((await carolRow.locator('.fingerprint').first().textContent()) ?? '').trim();
    expect(evilFingerprint).not.toBe(carolFingerprint);
    await expect(pinBadge(a.getByTestId('member-bob3@example.com'), 'verified')).toBeVisible();
    await shot(a, 'share-4-key-changed-row');
  });

  await test.step('removing Bob does not rotate: the key change dialog opens and nothing is sent', async () => {
    await a.getByTestId('member-bob3@example.com').getByRole('button', { name: 'Remove' }).click();
    await a.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    const notice = a.getByRole('alert').filter({ hasText: 'could not be rotated' });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(a.getByTestId('member-bob3@example.com')).toHaveCount(0);

    await notice.getByRole('button', { name: 'Review changed key' }).click();
    const dialog = a.getByRole('dialog', { name: 'Encryption key changed' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(carolFingerprint);
    await expect(dialog).toContainText(evilFingerprint);
    await expect(dialog).toContainText('may be an attack');
    await shot(a, 'share-5-key-changed-dialog');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(keyVersions()).toEqual([1]);
  });

  await test.step('the rotate button is refused the same way', async () => {
    await a.getByRole('button', { name: 'Rotate vault key' }).click();
    const dialog = a.getByRole('dialog', { name: 'Encryption key changed' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(keyVersions()).toEqual([1]);
  });

  await test.step('after Alice verifies the new fingerprint, rotation goes through', async () => {
    await a.getByRole('button', { name: 'Rotate vault key' }).click();
    const dialog = a.getByRole('dialog', { name: 'Encryption key changed' });
    await dialog
      .getByRole('button', { name: 'I verified the new fingerprint with carol3@example.com' })
      .click();
    // The renderer's dialog only explains; main asks again, natively, before pinning the key.
    const asked = await answerDialog(
      alice.app,
      'Encryption key changed',
      'I verified the new fingerprint',
    );
    expect(asked.message).toContain('carol3@example.com');
    expect(asked.detail).toContain(evilFingerprint);
    await expect(dialog).toHaveCount(0);
    await expect.poll(keyVersions, { message: 'vault key rotated on the server' }).toEqual([2]);
    const carolRow = a.getByTestId('member-carol3@example.com');
    await expect(pinBadge(carolRow, 'verified')).toBeVisible();
    await expect(pinBadge(carolRow, 'key changed')).toHaveCount(0);
    await shot(a, 'share-6-key-accepted');
  });

  await alice.app.close();
});

test.afterEach(() => {
  writeFileSync(join(ARTIFACTS, 'main-process.log'), mainLogs.join(''));
  expect(consoleErrors, 'console errors in the renderer').toEqual([]);
  const crashes = mainLogs
    .join('')
    .match(/.*(Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError|Cannot find module).*/g);
  expect(crashes, 'errors in the main process').toBeNull();
});

test('own key mismatch: signed in it signs out to a fresh page; at registration it stays on the form', async () => {
  // A server of its own, so this account is its first (admin) user.
  const own = await startTernixServer();
  const proxy = await startKeySwappingProxy(own.url);
  const { app, page } = await launch(newUserDataDir());
  try {
    await test.step('the server swaps the key of a signed-in account', async () => {
      await registerUser(page, 'dave@example.com', 'Dave', undefined, own.url);
      own.db.substituteKey('dave@example.com');
      await nav(page, /^Settings/).click();
      await page.getByRole('tab', { name: 'Admin' }).click(); // the user list reports the key
      await expect(page.getByTestId('own-key-mismatch')).toBeVisible();
      await shot(page, '20-own-key-mismatch');
      await page.evaluate(() => {
        (window as unknown as { __leftBehind?: string }).__leftBehind = 'yes';
      });
      await page.getByTestId('own-key-mismatch').getByRole('button', { name: 'Sign out' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await expect(page.getByTestId('own-key-mismatch')).toHaveCount(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { __leftBehind?: string }).__leftBehind ?? null,
        ),
      ).toBeNull();
    });

    await test.step('registration through a server that swaps the key', async () => {
      await page.getByRole('button', { name: 'Change server' }).click();
      await page.getByLabel('Server address').fill(proxy.url);
      await expect(page.getByTestId('server-info')).toBeVisible();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('tab', { name: 'Create account' }).click();
      await page.getByLabel('Email').fill('erin@example.com');
      await page.getByLabel('Your name').fill('Erin');
      await page.getByLabel('Master password', { exact: true }).fill(PASSWORD);
      await page.getByLabel('Repeat master password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();
      const mismatch = page.getByTestId('sign-in-key-mismatch');
      await expect(mismatch).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('own-key-mismatch')).toHaveCount(0);
      await shot(page, '21-sign-in-key-mismatch');
      // No session was stored: signing out is a no-op, not an error.
      expect(await invoke(page, 'client.snapshot')).toMatchObject({
        ok: true,
        value: { state: 'loggedOut' },
      });
      expect(await invoke(page, 'auth.logout', {})).toMatchObject({
        ok: true,
        value: { serverRevoked: true },
      });
      await mismatch.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
    });
  } finally {
    await app.close();
    await proxy.stop();
    await own.stop();
  }
});
