import { stat, readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import {
  app,
  type BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  powerMonitor,
  safeStorage,
  session,
} from 'electron';
import { defaultAgentPath } from '@ternix/ssh';
import type { AppEventName, AppEvents, DesktopPlatform } from '../shared/app.js';
import {
  EVENT_CHANNEL,
  PAGE_CHANNEL,
  RPC_CHANNEL,
  TERMINAL_CHANNEL_PREFIX,
  type RpcResult,
} from '../shared/ipc.js';
import { AutoLock } from './app/autoLock.js';
import { deriveKeysInWorker } from './app/derive.js';
import { AppError } from './app/errors.js';
import { installMenu } from './app/menu.js';
import { handleAppScheme, registerAppScheme } from './app/protocol.js';
import { QuitGuard } from './app/quit.js';
import { basicTextRequested, SafeStorageSecretStore } from './app/secretStore.js';
import { isAppUrl } from './app/security.js';
import { ServerAddressStore } from './app/serverAddress.js';
import { SettingsStore } from './app/settings.js';
import { confirmHostKey, confirmNewHosts, type MessageBox } from './app/trust.js';
import {
  appUrls,
  createMainWindow,
  RENDERER_ROOT,
  lockDownSession,
  lockDownWebContents,
  openExternalLink,
} from './app/window.js';
import { JsonFileCacheStore, TernixClient } from './client/index.js';
import { createDispatcher } from './ipc/dispatch.js';
import { createHandlers } from './ipc/handlers.js';
import { PageGate, SessionNotices } from './ipc/pageGate.js';
import { rpcSchemas } from './ipc/schemas.js';
import { snapshotItems } from './ssh/items.js';
import { SshManager } from './ssh/manager.js';

const MAX_KEY_FILE_BYTES = 256 * 1024;
/** How long quitting waits for SSH sessions to close, and then for the cache to be written. */
const QUIT_SSH_GRACE_MS = 2_000;
const QUIT_FLUSH_TIMEOUT_MS = 5_000;

const platform: DesktopPlatform =
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';

app.setName('Ternix');
// Every renderer is sandboxed, whatever its webPreferences say.
app.enableSandbox();
// An explicit --user-data-dir (tests, portable setups) wins over the default location.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'Ternix'));
}

registerAppScheme();

/**
 * `net.fetch` trusts the operating system's certificate store; Node's TLS (used by the `ws`
 * WebSocket) only its bundled roots. Add the system roots so a server behind a private or
 * corporate CA works for both. Needs Node 24.5+; older runtimes keep the defaults.
 */
function trustSystemCertificates(): void {
  const api = tls as unknown as {
    getCACertificates?: (type: 'default' | 'system') => string[];
    setDefaultCACertificates?: (certs: string[]) => void;
  };
  try {
    if (!api.getCACertificates || !api.setDefaultCACertificates) return;
    api.setDefaultCACertificates([
      ...api.getCACertificates('default'),
      ...api.getCACertificates('system'),
    ]);
  } catch {
    // Keep Node's bundled roots.
  }
}

// Linux without a keyring: only in the end-to-end test build (`__TERNIX_E2E__`), on explicit
// request. Release builds do not contain this branch.
if (__TERNIX_E2E__ && process.platform === 'linux' && basicTextRequested(process.env)) {
  safeStorage.setUsePlainTextEncryption(true);
}

let mainWindow: BrowserWindow | null = null;

function activeContents() {
  const win = mainWindow;
  return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : null;
}

function emit<K extends AppEventName>(name: K, payload: AppEvents[K]): void {
  activeContents()?.send(EVENT_CHANNEL, name, payload);
}

/** A native message box on the app window; without a window the answer is the deny button. */
const messageBox: MessageBox = async (request) => {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return { response: request.cancelId, checkboxChecked: false };
  const { response, checkboxChecked } = await dialog.showMessageBox(win, request);
  return { response, checkboxChecked };
};

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  const secrets = new SafeStorageSecretStore(userData, safeStorage);
  const settings = new SettingsStore(userData);
  await settings.load();
  const serverAddress = new ServerAddressStore(userData);
  await serverAddress.load();

  const client = new TernixClient({
    secretStore: secrets,
    cacheStore: new JsonFileCacheStore(join(userData, 'cache')),
    // Chromium's network stack: system proxy, system certificate store, OS resolver
    // (so Tailscale MagicDNS names resolve).
    fetch: (input, init) => net.fetch(input, init),
    deriveKeys: deriveKeysInWorker,
    device: { name: hostname() || 'Ternix desktop', platform },
  });
  await client.init();

  const ssh = new SshManager({
    snapshot: () => snapshotItems(client),
    putItem: (vaultId, itemId, draft) => client.putItem(vaultId, itemId, draft),
    emit,
    sendTerminal: (id, data) => {
      const contents = activeContents();
      contents?.send(TERMINAL_CHANNEL_PREFIX + id, data);
      return contents !== null;
    },
    hasWindow: () => activeContents() !== null,
    confirmHostKey: (facts, signal) => confirmHostKey(messageBox, facts, signal),
    confirmNewHosts: (route, signal) => confirmNewHosts(messageBox, route, signal),
    agentPath: defaultAgentPath(process.platform, process.env),
    detectHostOs: () => settings.get().detectHostOs,
    vaultRole: (vaultId) => client.listVaults().find((v) => v.id === vaultId)?.role,
    log: (message) => console.warn(`[ternix] ${message}`),
  });

  /** Keys are gone when this returns; the promise settles once pending cache writes are stored. */
  const lockVault = (): Promise<void> => {
    if (client.state !== 'unlocked') return Promise.resolve();
    ssh.cancelAllPrompts();
    return client.lock();
  };

  // Leaving a session replaces the page, so whatever a compromised renderer kept in its own
  // memory is gone before it could reach `server.probe` or `auth.login`. Terminal output is
  // buffered until the new page attaches.
  const pages = new PageGate(() => {
    ssh.detachAll();
    activeContents()?.reload();
  });
  pages.watch(client);
  const notices = new SessionNotices();
  notices.watch(client);

  client.on('state', (state) => {
    emit('client.state', state);
    if (state !== 'unlocked') ssh.cancelAllPrompts();
    if (state === 'loggedOut') void ssh.closeAll();
  });
  client.on('connection', (state) => emit('client.connection', state));
  client.on('vaults-changed', () => emit('client.vaults-changed', undefined));
  client.on('items-changed', (payload) => emit('client.items-changed', payload));
  client.on('session-revoked', (payload) => emit('client.session-revoked', payload));
  client.on('error', (payload) => emit('client.error', payload));

  const handlers = createHandlers({
    client,
    settings,
    ssh,
    secrets,
    serverAddress,
    notices,
    pages,
    appInfo: () => ({ version: app.getVersion(), platform, secretStorage: secrets.status() }),
    writeClipboard: (text) => clipboard.writeText(text),
    importKeyFile: async () => {
      const options = {
        title: 'Import private key',
        defaultPath: join(homedir(), '.ssh'),
        properties: ['openFile' as const, 'showHiddenFiles' as const],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      const file = result.filePaths[0];
      if (result.canceled || !file) return null;
      if ((await stat(file)).size > MAX_KEY_FILE_BYTES) {
        throw new AppError('file_too_large', 'That file is too large to be a private key.');
      }
      return { fileName: file.split(/[\\/]/).pop() ?? file, content: await readFile(file, 'utf8') };
    },
    openLink: async (url) => {
      const options = {
        type: 'question' as const,
        buttons: ['Open in browser', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Open link',
        message: 'Open this link in your browser?',
        detail: url,
      };
      const answer = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (answer.response === 0) await openExternalLink(url);
    },
    onSettingsChanged: () => emit('settings.changed', settings.get()),
    messageBox,
  });
  const dispatch = pages.guard(createDispatcher(rpcSchemas, handlers));

  // The preload of each page load asks for its generation once, before page scripts run.
  ipcMain.on(PAGE_CHANNEL, (event) => {
    const ours =
      mainWindow !== null &&
      event.sender === mainWindow.webContents &&
      event.senderFrame !== null &&
      event.senderFrame === event.sender.mainFrame;
    event.returnValue = ours ? pages.issue() : 0;
  });

  ipcMain.handle(RPC_CHANNEL, async (event, page: unknown, method: unknown, arg: unknown) => {
    // Only our own window, top frame, showing our own page, may call in.
    const frame = event.senderFrame;
    const trusted =
      mainWindow !== null &&
      event.sender === mainWindow.webContents &&
      frame !== null &&
      frame === event.sender.mainFrame &&
      isAppUrl(frame.url, appUrls());
    if (!trusted) {
      const denied: RpcResult<never> = {
        ok: false,
        error: { name: 'AppError', code: 'forbidden', message: 'Request refused' },
      };
      return denied;
    }
    return dispatch(page, method, arg);
  });

  const openWindow = () => {
    const win = createMainWindow();
    mainWindow = win;
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
      // The UI is gone: nothing may stay waiting on an answer, and the vault locks.
      ssh.cancelAllPrompts();
      ssh.detachAll();
      void lockVault();
    });
  };

  installMenu();
  openWindow();
  app.on('activate', () => {
    if (!mainWindow) openWindow();
  });

  const autoLock = new AutoLock({
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    minutes: () => settings.get().autoLockMinutes,
    isUnlocked: () => client.state === 'unlocked',
    lock: lockVault,
  });
  autoLock.start();
  powerMonitor.on('suspend', () => void lockVault());
  powerMonitor.on('lock-screen', () => void lockVault());

  // Every quit request is held back until the SSH sessions are closed and the client has stored
  // its pending cache writes (each bounded by a timeout); then the app quits for real.
  const quitGuard = new QuitGuard({
    steps: [
      { run: () => ssh.closeAll(), timeoutMs: QUIT_SSH_GRACE_MS },
      { run: () => client.close(), timeoutMs: QUIT_FLUSH_TIMEOUT_MS },
    ],
    onStart: () => autoLock.stop(),
    quit: () => app.quit(),
  });
  app.on('before-quit', quitGuard.onQuitRequest);
  app.on('will-quit', quitGuard.onQuitRequest);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('web-contents-created', (_event, contents) => lockDownWebContents(contents));
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  void app
    .whenReady()
    .then(() => {
      trustSystemCertificates();
      handleAppScheme(RENDERER_ROOT);
      lockDownSession(session.defaultSession);
      return start();
    })
    .catch((err: unknown) => {
      dialog.showErrorBox(
        'Ternix could not start',
        err instanceof Error ? err.message : String(err),
      );
      app.exit(1);
    });
}
