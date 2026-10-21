import {
  Braces,
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  FingerprintPattern,
  KeyRound,
  Layers,
  Loader,
  Lock,
  Plus,
  Server,
  Settings,
  SquareTerminal,
  Users,
  Waypoints,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HostOs } from '@ternix/core/items';
import { itemsOfType, vaultTitle } from '../items.js';
import { OsGlyph } from '../osIcons.js';
import { closeTerminal, type NavView, reportError, setState, useStore } from '../store.js';
import { Badge, ConfirmDialog, RoleBadge } from '../ui.js';
import { TerminalHost } from '../terminal.js';
import { ItemEditor } from '../editors/index.js';
import { ForwardsView, KeychainView, KnownHostsView, SnippetsView } from './Lists.js';
import { HostsView } from './Hosts.js';
import { SettingsView } from './Settings.js';
import { SharingView } from './Sharing.js';
import { call } from '../api.js';

const NAV: { id: NavView; label: string; icon: typeof Server }[] = [
  { id: 'hosts', label: 'Hosts', icon: Server },
  { id: 'keychain', label: 'Keychain', icon: KeyRound },
  { id: 'snippets', label: 'Snippets', icon: Braces },
  { id: 'forwards', label: 'Port forwards', icon: Waypoints },
  { id: 'knownHosts', label: 'Known hosts', icon: FingerprintPattern },
];

function Sidebar() {
  const view = useStore((s) => s.view);
  const unreadable = useStore((s) => s.unreadable);
  const items = useStore((s) => s.items);

  const go = (next: NavView) => setState({ view: next });
  const item = (id: NavView, label: string, Icon: typeof Server, count?: number) => (
    <button
      key={id}
      className={`side-item ${view === id ? 'active' : ''}`}
      aria-current={view === id ? 'page' : undefined}
      onClick={() => go(id)}
    >
      <Icon aria-hidden />
      <span>{label}</span>
      {count !== undefined ? <span className="side-count">{count}</span> : null}
    </button>
  );

  return (
    <nav className="sidebar" aria-label="Main">
      {NAV.map((n) =>
        item(
          n.id,
          n.label,
          n.icon,
          n.id === 'hosts' ? itemsOfType(items, 'host').length : undefined,
        ),
      )}
      <div className="spacer" />
      {unreadable > 0 ? (
        <div className="side-note" title="Items this app cannot decrypt or understand">
          {unreadable} unreadable item{unreadable === 1 ? '' : 's'}
        </div>
      ) : null}
      {item('sharing', 'Sharing', Users)}
      {item('settings', 'Settings', Settings)}
    </nav>
  );
}

/** The vault filter: a menu under the Vaults tab, with "All vaults" and one row per vault. */
function VaultMenu({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const vaults = useStore((s) => s.vaults);
  const filter = useStore((s) => s.vaultFilter);
  const items = useStore((s) => s.items);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const choose = (next: string) => {
    setState({ vaultFilter: next, activeTab: null });
    onClose();
  };
  const row = (id: string, label: ReactNode, extra: ReactNode, title?: string) => (
    <button
      key={id}
      role="menuitemradio"
      aria-checked={filter === id}
      className="menu-item"
      title={title}
      onClick={() => choose(id)}
    >
      <Layers size={14} aria-hidden />
      <span className="ellipsis" style={{ flex: 1 }}>
        {label}
      </span>
      {extra}
      <span className={`radio-dot ${filter === id ? 'on' : ''}`} aria-hidden>
        {filter === id ? <Check size={12} strokeWidth={3} /> : null}
      </span>
    </button>
  );

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label="Vaults"
      style={{ top: anchor.bottom + 6, left: anchor.left }}
    >
      {row('all', 'All vaults', <span className="side-count">{items.length}</span>)}
      <div className="menu-sep" />
      {vaults.map((v) =>
        row(
          v.id,
          vaultTitle(v),
          v.error ? <Badge tone="bad">locked</Badge> : <RoleBadge role={v.role} />,
          v.error ?? undefined,
        ),
      )}
      <div className="menu-sep" />
      <button
        className="menu-item"
        role="menuitem"
        onClick={() => {
          setState({ view: 'sharing', activeTab: null });
          onClose();
        }}
      >
        <Users size={14} aria-hidden />
        Manage vaults
      </button>
    </div>
  );
}

function TabIcon({ state, os }: { state: string; os: HostOs | undefined }) {
  if (state === 'ready') {
    return os ? (
      <OsGlyph os={os} size={14} className="tab-icon-glyph" />
    ) : (
      <SquareTerminal size={14} className="tab-icon-glyph" aria-hidden />
    );
  }
  if (state === 'closed') return <span className="state-dot closed tab-icon-glyph" aria-hidden />;
  return (
    <Loader
      size={14}
      className="tab-icon-glyph"
      aria-hidden
      style={{ animation: 'spin 1s linear infinite' }}
    />
  );
}

function TitleBar() {
  const terminals = useStore((s) => s.terminals);
  const activeTab = useStore((s) => s.activeTab);
  const vaults = useStore((s) => s.vaults);
  const filter = useStore((s) => s.vaultFilter);
  const connection = useStore((s) => s.connection);
  const account = useStore((s) => s.account);
  const itemById = useStore((s) => s.itemById);
  const [closing, setClosing] = useState<string | null>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Keep the tab in front visible when many tabs overflow.
  useLayoutEffect(() => {
    scroller.current
      ?.querySelector<HTMLElement>('.tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab, terminals.length]);

  const online = connection === 'online';
  const syncText = online
    ? 'Synced'
    : connection === 'connecting'
      ? 'Connecting…'
      : 'Offline: showing saved data';
  const vaultCount = filter === 'all' ? vaults.length : 1;
  const initial = (account?.user.name ?? '?').trim().charAt(0).toUpperCase();

  return (
    <header className="titlebar" data-terminal={activeTab !== null ? '' : undefined}>
      <div className="tab-scroll" ref={scroller} role="tablist" aria-label="Tabs">
        <div className="vault-tab">
          <button
            role="tab"
            aria-selected={activeTab === null}
            className={`tab tab-vault ${activeTab === null ? 'active' : ''}`}
            onClick={() => setState({ activeTab: null })}
          >
            <Layers size={14} aria-hidden />
            <span>Vaults</span>
            {vaultCount > 0 ? <span className="tab-count">{vaultCount}</span> : null}
          </button>
          <button
            ref={chevron}
            className="tab-vault-chevron"
            aria-label="Choose vault"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={() =>
              setMenu((open) => (open ? null : (chevron.current?.getBoundingClientRect() ?? null)))
            }
          >
            <ChevronDown size={14} aria-hidden />
          </button>
        </div>
        {terminals.map((t) => {
          const host = t.hostId ? itemById.get(t.hostId)?.payload : undefined;
          const os = host?.type === 'host' ? host.os : undefined;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              className={`tab tab-terminal ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setState({ activeTab: t.id })}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  if (t.state === 'ready') setClosing(t.id);
                  else void closeTerminal(t.id);
                }
              }}
              title={`${t.label}: ${t.target}`}
              data-testid="terminal-tab"
            >
              <span className="tab-icon">
                <TabIcon state={t.state} os={os} />
                <button
                  className="tab-close"
                  aria-label={`Close ${t.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (t.state === 'ready') setClosing(t.id);
                    else void closeTerminal(t.id);
                  }}
                >
                  <X size={14} aria-hidden />
                </button>
              </span>
              <span className="tab-title ellipsis">{t.label}</span>
            </div>
          );
        })}
      </div>
      <button
        className="titlebar-icon-btn"
        aria-label="New connection"
        title="New connection"
        onClick={() => {
          setState({ view: 'hosts', activeTab: null });
          setTimeout(() => document.getElementById('quick-connect-input')?.focus(), 0);
        }}
      >
        <Plus size={16} aria-hidden />
      </button>
      <div style={{ flex: 1 }} />
      <div className="titlebar-cluster">
        <span
          className="sync-status"
          role="status"
          title={account?.serverUrl ? `${syncText} · ${account.serverUrl}` : syncText}
          aria-label={syncText}
          style={online ? undefined : { color: 'var(--universal-warning)' }}
        >
          {online ? <Cloud size={14} aria-hidden /> : <CloudOff size={14} aria-hidden />}
        </span>
        <button
          className="titlebar-icon-btn"
          data-testid="lock-now"
          aria-label="Lock"
          title="Lock"
          onClick={() => void call('auth.lock').catch(reportError)}
        >
          <Lock size={14} aria-hidden />
        </button>
        {account ? (
          <button
            className="titlebar-icon-btn"
            aria-label="Account settings"
            title={`${account.user.name} · ${account.email}`}
            onClick={() => setState({ view: 'settings', activeTab: null })}
          >
            <span className="avatar" aria-hidden>
              {initial}
            </span>
          </button>
        ) : null}
      </div>
      {menu ? <VaultMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {closing ? <ConfirmClose id={closing} onClose={() => setClosing(null)} /> : null}
    </header>
  );
}

function ConfirmClose({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useStore((s) => s.terminals.find((x) => x.id === id));
  return (
    <ConfirmDialog
      title="Close this terminal?"
      message={
        <>
          The connection to <strong>{t?.label ?? 'this host'}</strong> is open. Closing the tab
          disconnects it.
        </>
      }
      confirmLabel="Disconnect"
      danger
      onClose={onClose}
      onConfirm={() => closeTerminal(id)}
    />
  );
}

function Views() {
  const view = useStore((s) => s.view);
  const activeTab = useStore((s) => s.activeTab);
  return (
    <div className="views" style={{ display: activeTab ? 'none' : 'flex' }}>
      {view === 'hosts' ? <HostsView /> : null}
      {view === 'keychain' ? <KeychainView /> : null}
      {view === 'snippets' ? <SnippetsView /> : null}
      {view === 'forwards' ? <ForwardsView /> : null}
      {view === 'knownHosts' ? <KnownHostsView /> : null}
      {view === 'sharing' ? <SharingView /> : null}
      {view === 'settings' ? <SettingsView /> : null}
    </div>
  );
}

/**
 * The signed-in app. While `locked` only the terminals stay mounted (hidden), so sessions and
 * their scrollback go on; the vault views, editors and settings forms unmount, so nothing they
 * held (revealed secrets, typed passwords) stays in the page. Every slot keeps its position, so
 * locking never remounts `TerminalHost`.
 */
export function Shell({ locked }: { locked: boolean }) {
  const activeTab = useStore((s) => s.activeTab);
  return (
    <div
      className="shell"
      style={{ visibility: locked ? 'hidden' : 'visible' }}
      aria-hidden={locked}
      // `inert` keeps focus and the accessibility tree out of the hidden UI.
      {...(locked ? { inert: true } : {})}
    >
      {locked ? null : <TitleBar />}
      <div className="shell-body">
        {locked || activeTab !== null ? null : <Sidebar />}
        <main className="main">
          {locked ? null : <Views />}
          <TerminalHost />
        </main>
        {locked ? null : <ItemEditor />}
      </div>
    </div>
  );
}
