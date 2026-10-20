import { useState } from 'react';
import { itemsOfType, vaultTitle } from '../items.js';
import { closeTerminal, type NavView, reportError, setState, useStore } from '../store.js';
import { Badge, ConfirmDialog, RoleBadge } from '../ui.js';
import { TerminalHost } from '../terminal.js';
import { ItemEditor } from '../editors/index.js';
import { ForwardsView, KeychainView, KnownHostsView, SnippetsView } from './Lists.js';
import { HostsView } from './Hosts.js';
import { SettingsView } from './Settings.js';
import { SharingView } from './Sharing.js';
import { call } from '../api.js';

const NAV: { id: NavView; label: string }[] = [
  { id: 'hosts', label: 'Hosts' },
  { id: 'keychain', label: 'Keychain' },
  { id: 'snippets', label: 'Snippets' },
  { id: 'forwards', label: 'Port forwards' },
  { id: 'knownHosts', label: 'Known hosts' },
];

function Sidebar() {
  const vaults = useStore((s) => s.vaults);
  const filter = useStore((s) => s.vaultFilter);
  const view = useStore((s) => s.view);
  const activeTab = useStore((s) => s.activeTab);
  const connection = useStore((s) => s.connection);
  const unreadable = useStore((s) => s.unreadable);
  const account = useStore((s) => s.account);
  const items = useStore((s) => s.items);

  const go = (next: NavView) => setState({ view: next, activeTab: null });
  const online = connection === 'online';

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ▍
          </span>
          Ternix
        </div>
        <div className="muted small" title={account?.serverUrl}>
          <span className={`status-dot ${online ? 'online' : connection}`} aria-hidden />
          {online
            ? 'Synced'
            : connection === 'connecting'
              ? 'Connecting…'
              : 'Offline: showing saved data'}
        </div>
      </div>

      <div className="sidebar-section">Vaults</div>
      <button
        className={`side-item ${filter === 'all' ? 'active' : ''}`}
        onClick={() => setState({ vaultFilter: 'all' })}
      >
        <span>All vaults</span>
        <span className="muted small">{items.length}</span>
      </button>
      {vaults.map((v) => (
        <button
          key={v.id}
          className={`side-item ${filter === v.id ? 'active' : ''}`}
          onClick={() => setState({ vaultFilter: v.id })}
          title={v.error ?? undefined}
        >
          <span className="ellipsis">
            {vaultTitle(v)}
            {v.kind === 'personal' ? ' ' : ''}
          </span>
          {v.error ? <Badge tone="bad">locked</Badge> : <RoleBadge role={v.role} />}
        </button>
      ))}
      {unreadable > 0 ? (
        <div className="muted small side-note" title="Items this app cannot decrypt or understand">
          {unreadable} unreadable item{unreadable === 1 ? '' : 's'}
        </div>
      ) : null}

      <div className="sidebar-section">Library</div>
      {NAV.map((n) => (
        <button
          key={n.id}
          className={`side-item ${view === n.id && activeTab === null ? 'active' : ''}`}
          onClick={() => go(n.id)}
        >
          <span>{n.label}</span>
          {n.id === 'hosts' ? (
            <span className="muted small">{itemsOfType(items, 'host').length}</span>
          ) : null}
        </button>
      ))}

      <div className="spacer" />
      <button
        className={`side-item ${view === 'sharing' && activeTab === null ? 'active' : ''}`}
        onClick={() => go('sharing')}
      >
        Sharing
      </button>
      <button
        className={`side-item ${view === 'settings' && activeTab === null ? 'active' : ''}`}
        onClick={() => go('settings')}
      >
        Settings
      </button>
      <button
        className="side-item"
        data-testid="lock-now"
        onClick={() => void call('auth.lock').catch(reportError)}
      >
        Lock
      </button>
      {account ? (
        <div className="muted small side-note ellipsis" title={account.email}>
          {account.user.name} · {account.email}
        </div>
      ) : null}
    </nav>
  );
}

function TabStrip() {
  const terminals = useStore((s) => s.terminals);
  const activeTab = useStore((s) => s.activeTab);
  const [closing, setClosing] = useState<string | null>(null);
  if (terminals.length === 0) return null;
  return (
    <div className="tabstrip" role="tablist" aria-label="Terminals">
      <button
        role="tab"
        aria-selected={activeTab === null}
        className={`tab ${activeTab === null ? 'active' : ''}`}
        onClick={() => setState({ activeTab: null })}
      >
        Vaults
      </button>
      {terminals.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={activeTab === t.id}
          className={`tab ${activeTab === t.id ? 'active' : ''}`}
          onClick={() => setState({ activeTab: t.id })}
          data-testid="terminal-tab"
        >
          <span
            className={`status-dot ${t.state === 'ready' ? 'online' : t.state === 'closed' ? 'offline' : 'connecting'}`}
          />
          <span className="ellipsis">{t.label}</span>
          <button
            className="tab-close"
            aria-label={`Close ${t.label}`}
            onClick={(e) => {
              e.stopPropagation();
              if (t.state === 'ready') setClosing(t.id);
              else void closeTerminal(t.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      {closing ? <ConfirmClose id={closing} onClose={() => setClosing(null)} /> : null}
    </div>
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
  return (
    <div
      className="shell"
      style={{ visibility: locked ? 'hidden' : 'visible' }}
      aria-hidden={locked}
      // `inert` keeps focus and the accessibility tree out of the hidden UI.
      {...(locked ? { inert: true } : {})}
    >
      {locked ? null : <Sidebar />}
      <main className="main">
        {locked ? null : <TabStrip />}
        {locked ? null : <Views />}
        <TerminalHost />
      </main>
      {locked ? null : <ItemEditor />}
    </div>
  );
}
