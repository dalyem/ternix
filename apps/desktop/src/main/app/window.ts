import { join } from 'node:path';
import { app, BrowserWindow, Menu, type Session, shell, type WebContents } from 'electron';
import { type AppUrls, APP_INDEX_URL, isAppUrl } from './security.js';

export function appUrls(): AppUrls {
  return { devUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'] };
}

/** Where the built renderer lives (served as `ternix://app/`). */
export const RENDERER_ROOT = join(__dirname, '../renderer');

/** Deny every permission request (camera, notifications, clipboard-read, ...). */
export function lockDownSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
}

/**
 * Applied to every WebContents the app ever creates: no navigation away from the app page,
 * no new windows, no webviews. External links are opened by the main process after the
 * user confirms (`shell.openLink`), never by the renderer.
 */
export function lockDownWebContents(contents: WebContents): void {
  const urls = appUrls();
  const block = (event: { preventDefault(): void }, url: string) => {
    if (!isAppUrl(url, urls)) event.preventDefault();
  };
  contents.on('will-navigate', (event) => block(event, event.url));
  contents.on('will-redirect', (event) => block(event, event.url));
  contents.on('will-frame-navigate', (event) => block(event, event.url));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Colours of the 51px tab bar the renderer draws as the title bar (see styles.css). */
const TITLE_BAR_HEIGHT = 51;
const TITLE_BAR_COLOR = '#141729';

/**
 * The renderer's tab bar is the title bar. macOS keeps the traffic lights, inset into it;
 * Windows and Linux get the native window buttons as an overlay on its right edge (the page
 * pads for it with the `titlebar-area-*` env variables).
 */
function titleBarOptions(): Partial<Electron.BrowserWindowConstructorOptions> {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLE_BAR_COLOR,
      symbolColor: '#8d91a5',
      height: TITLE_BAR_HEIGHT - 1,
    },
  };
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Ternix',
    backgroundColor: TITLE_BAR_COLOR,
    autoHideMenuBar: true,
    ...titleBarOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => win.show());

  win.webContents.on('context-menu', (_event, params) => {
    if (
      params.linkURL ||
      !(params.isEditable || params.selectionText || params.editFlags.canPaste)
    ) {
      return;
    }
    Menu.buildFromTemplate([
      ...(params.isEditable ? [{ role: 'cut' as const }] : []),
      { role: 'copy' as const },
      { role: 'paste' as const },
      { type: 'separator' as const },
      { role: 'selectAll' as const },
    ]).popup({ window: win });
  });

  const { devUrl } = appUrls();
  void win.loadURL(devUrl ?? APP_INDEX_URL);
  return win;
}

export async function openExternalLink(url: string): Promise<void> {
  await shell.openExternal(url);
}
