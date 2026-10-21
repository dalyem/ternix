import { useSyncExternalStore } from 'react';
import type { ItemType } from '@ternix/core/items';
import type { AppInfo, AppSettings, PromptDto, TerminalDto } from '../../shared/app.js';
import { DEFAULT_SETTINGS } from '../../shared/app.js';
import type { SessionNotice } from '../../shared/ipc.js';
import type {
  AccountDto,
  ClientState,
  ConnectionState,
  ListedPayload,
  VaultDto,
} from '../../shared/types.js';
import { call, errorMessage, isCancelled, on, onOwnKeyMismatch } from './api.js';

export type NavView =
  'hosts' | 'keychain' | 'snippets' | 'forwards' | 'knownHosts' | 'sharing' | 'settings';

/**
 * A decrypted item together with where it lives. Secret fields are not here (see
 * `ListedPayload`); an open editor fetches them with `items.reveal`.
 */
export interface ItemView {
  id: string;
  vaultId: string;
  payload: ListedPayload;
  updatedAt: string;
}

/** What the item editor is open on: an existing item, or a new one of `type`. */
export interface EditorTarget {
  type: ItemType;
  item?: ItemView;
  /** Vault to create in (when the user picked one in the sidebar). */
  vaultId?: string;
  /** Pre-filled references, for example the host of a new port forward. */
  preset?: Record<string, string>;
}

export interface Toast {
  id: number;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface State {
  booted: boolean;
  info: AppInfo | null;
  settings: AppSettings;
  clientState: ClientState;
  connection: ConnectionState;
  account: AccountDto | null;
  vaults: VaultDto[];
  vaultById: Map<string, VaultDto>;
  items: ItemView[];
  itemById: Map<string, ItemView>;
  unreadable: number;
  terminals: TerminalDto[];
  /** The terminal tab in front; null shows the vault views. */
  activeTab: string | null;
  view: NavView;
  editor: EditorTarget | null;
  /** Vault whose items the lists show, or `all`. */
  vaultFilter: string;
  prompts: PromptDto[];
  toasts: Toast[];
  /** Why the user is back at the login screen (revoked session, ...). */
  authNotice: string | null;
  /** The server to sign in to; main remembers it (`server.remember`). */
  serverUrl: string | null;
  /** A login, logout or unlock is running; the buttons for those wait for it. */
  authPending: boolean;
  /** The server reported another account key than the one pinned: only logout is offered. */
  ownKeyMismatch: boolean;
}

/**
 * Where earlier versions kept the server address. Never read: a compromised page could have
 * written an address of its choosing there for the next page to probe. Main keeps it now.
 */
const LEGACY_SERVER_URL_KEY = 'ternix.serverUrl';

let state: State = {
  booted: false,
  info: null,
  settings: DEFAULT_SETTINGS,
  clientState: 'loggedOut',
  connection: 'offline',
  account: null,
  vaults: [],
  vaultById: new Map(),
  items: [],
  itemById: new Map(),
  unreadable: 0,
  terminals: [],
  activeTab: null,
  view: 'hosts',
  editor: null,
  vaultFilter: 'all',
  prompts: [],
  toasts: [],
  authNotice: null,
  serverUrl: null,
  authPending: false,
  ownKeyMismatch: false,
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const listener of [...listeners]) listener();
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => selector(state),
  );
}

// Toasts

let toastId = 0;
export function toast(message: string, level: Toast['level'] = 'info'): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, level, message }].slice(-5) }));
  setTimeout(() => dismissToast(id), level === 'error' ? 10_000 : 5_000);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function reportError(err: unknown): void {
  // A cancelled operation was superseded on purpose (lock, logout, quit): not a failure.
  if (isCancelled(err)) return;
  toast(errorMessage(err), 'error');
}

/**
 * Run a login, register, unlock or logout one at a time: while one is pending another call
 * returns undefined at once, so a double click or a click during sign-out cannot race it.
 */
export async function runAuthExclusive<T>(task: () => Promise<T>): Promise<T | undefined> {
  if (state.authPending) return undefined;
  setState({ authPending: true });
  try {
    return await task();
  } finally {
    setState({ authPending: false });
  }
}

// Server address

/** Remember the server to sign in to (main stores it; only allowed while signed out). */
export async function rememberServerUrl(serverUrl: string | null): Promise<void> {
  await call('server.remember', { serverUrl });
  setState({ serverUrl });
}

// Session

const hasSession = (s: State) => s.clientState === 'locked' || s.clientState === 'unlocked';

function sessionEndedText(reason: 'revoked' | 'expired'): string {
  return reason === 'revoked'
    ? 'This device was signed out by the server. Sign in again to continue.'
    : 'Your session has expired. Sign in again to continue.';
}

/** Leaving a session reloads the page; main tells the new page why the session ended. */
function showSessionNotice(notice: SessionNotice | null): void {
  if (notice === 'revoked' || notice === 'expired') {
    setState({ authNotice: sessionEndedText(notice) });
  } else if (notice === 'logout_unrevoked') {
    // The local session is gone either way; tell the user the server may still list it.
    toast(
      'Signed out here, but the server could not be reached to revoke this device. Revoke it from another device.',
      'warning',
    );
  }
}

// Data

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/** Reload vaults and items from the main process (coalesces bursts of change events). */
export function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshData(), 40);
}

export async function refreshData(): Promise<void> {
  if (state.clientState !== 'unlocked') return;
  try {
    const [vaults, all] = await Promise.all([call('vaults.list'), call('items.all')]);
    if (state.clientState !== 'unlocked') return;
    const items: ItemView[] = [];
    let unreadable = 0;
    for (const group of all) {
      unreadable += group.unreadable.length;
      for (const item of group.items) {
        items.push({
          id: item.id,
          vaultId: group.vaultId,
          payload: item.payload,
          updatedAt: item.updatedAt,
        });
      }
    }
    setState((s) => ({
      vaults,
      vaultById: new Map(vaults.map((v) => [v.id, v])),
      items,
      itemById: new Map(items.map((i) => [i.id, i])),
      unreadable,
      vaultFilter:
        s.vaultFilter !== 'all' && !vaults.some((v) => v.id === s.vaultFilter)
          ? 'all'
          : s.vaultFilter,
    }));
  } catch (err) {
    reportError(err);
  }
}

/**
 * Leaving `unlocked` (lock, logout, expiry, revocation): drop every decrypted payload and close
 * the editor. The vault views, editors and forms unmount while locked (see `Shell`), which
 * takes revealed secrets and typed passwords with them; only the terminals stay.
 */
function clearData(): void {
  setState({
    vaults: [],
    vaultById: new Map(),
    items: [],
    itemById: new Map(),
    unreadable: 0,
    prompts: [],
    editor: null,
  });
}

function applyClientState(clientState: ClientState): void {
  const previous = state.clientState;
  setState({ clientState });
  if (clientState === 'unlocked') void refreshData();
  else clearData();
  if (clientState === 'loggedOut') {
    setState({
      account: null,
      terminals: [],
      activeTab: null,
      view: 'hosts',
      vaultFilter: 'all',
      ownKeyMismatch: false,
    });
  } else if (previous !== clientState) {
    void call('client.snapshot')
      .then((snap) => setState({ account: snap.account }))
      .catch(() => undefined);
  }
}

// Terminals

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const closedTerminals = new Set<string>();

function upsertTerminal(dto: TerminalDto): void {
  if (closedTerminals.has(dto.id)) return;
  setState((s) => {
    const index = s.terminals.findIndex((t) => t.id === dto.id);
    const terminals =
      index === -1 ? [...s.terminals, dto] : s.terminals.map((t, i) => (i === index ? dto : t));
    return { terminals };
  });
}

function showTerminal(dto: TerminalDto): void {
  upsertTerminal(dto);
  setState({ activeTab: dto.id });
}

export async function openHost(hostId: string): Promise<void> {
  try {
    showTerminal(await call('ssh.open', { hostId, cols: DEFAULT_COLS, rows: DEFAULT_ROWS }));
  } catch (err) {
    reportError(err);
  }
}

export async function quickConnect(target: string, password?: string): Promise<boolean> {
  try {
    showTerminal(
      await call('ssh.quickConnect', {
        target,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        ...(password ? { password } : {}),
      }),
    );
    return true;
  } catch (err) {
    reportError(err);
    return false;
  }
}

export async function reconnectTerminal(id: string, cols: number, rows: number): Promise<void> {
  try {
    upsertTerminal(await call('ssh.reconnect', { id, cols, rows }));
  } catch (err) {
    reportError(err);
  }
}

export async function closeTerminal(id: string): Promise<void> {
  closedTerminals.add(id);
  setState((s) => {
    const index = s.terminals.findIndex((t) => t.id === id);
    const terminals = s.terminals.filter((t) => t.id !== id);
    const next = terminals[Math.min(index, terminals.length - 1)];
    return { terminals, activeTab: s.activeTab === id ? (next?.id ?? null) : s.activeTab };
  });
  await call('ssh.close', { id }).catch(() => undefined);
}

// Setup

/** The bundled fonts, loaded before the first screen so terminals measure the right glyphs. */
async function fontsReady(): Promise<void> {
  const loaded = Promise.all([
    document.fonts.load('14px "Source Code Pro"'),
    document.fonts.load('450 14px "Inter Variable"'),
  ]).then(() => undefined);
  await Promise.race([loaded, new Promise<void>((resolve) => setTimeout(resolve, 1500))]).catch(
    () => undefined,
  );
}

let booting: Promise<void> | undefined;

/** Load the initial state and subscribe to main-process events. Call once. */
export function boot(): Promise<void> {
  booting ??= doBoot();
  return booting;
}

async function doBoot(): Promise<void> {
  on('client.state', applyClientState);
  on('client.connection', (connection) => setState({ connection }));
  on('client.vaults-changed', scheduleRefresh);
  on('client.items-changed', scheduleRefresh);
  on('client.session-revoked', ({ reason }) => setState({ authNotice: sessionEndedText(reason) }));
  on('client.error', (err) => {
    if (err.code === 'own_key_mismatch') setState({ ownKeyMismatch: true });
    else if (err.code !== 'cancelled') toast(`Sync problem: ${err.message}`, 'warning');
  });
  // Signed out, the only source is a login or register, which left no session to sign out
  // of: the sign-in form shows it instead of the blocking screen.
  onOwnKeyMismatch(() => {
    if (hasSession(state)) setState({ ownKeyMismatch: true });
  });
  on('settings.changed', (settings) => setState({ settings }));
  on('ssh.status', upsertTerminal);
  on('ssh.prompt', (prompt) => setState((s) => ({ prompts: [...s.prompts, prompt] })));
  on('ssh.prompt-cancelled', ({ promptId }) =>
    setState((s) => ({ prompts: s.prompts.filter((p) => p.promptId !== promptId) })),
  );
  on('ssh.notice', (notice) => toast(notice.message, notice.level));

  try {
    window.localStorage.removeItem(LEGACY_SERVER_URL_KEY);
  } catch {
    // Nothing to clean up.
  }

  const [info, settings, snapshot, terminals] = await Promise.all([
    call('app.info'),
    call('settings.get'),
    call('client.snapshot'),
    call('ssh.list'),
    fontsReady(),
  ]);
  setState({
    info,
    settings,
    clientState: snapshot.state,
    connection: snapshot.connection,
    account: snapshot.account,
    terminals,
    activeTab: terminals[0]?.id ?? null,
    serverUrl: snapshot.serverUrl,
    booted: true,
  });
  showSessionNotice(snapshot.notice);
  if (snapshot.state === 'unlocked') void refreshData();
}

export function openEditor(target: EditorTarget): void {
  setState({ editor: target });
}

export function closeEditor(): void {
  setState({ editor: null });
}

export function answerPrompt(promptId: string): void {
  setState((s) => ({ prompts: s.prompts.filter((p) => p.promptId !== promptId) }));
}
