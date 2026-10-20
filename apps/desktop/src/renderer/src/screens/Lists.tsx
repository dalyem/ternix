import { useEffect, useMemo, useState } from 'react';
import { call } from '../api.js';
import {
  byLabel,
  canWrite,
  hostKeyFingerprint,
  type ItemOf,
  itemsOfType,
  labelOf,
  vaultTitle,
} from '../items.js';
import { type ItemView, openEditor, reportError, toast, useStore } from '../store.js';
import { Badge, Button, ConfirmDialog, EmptyState } from '../ui.js';
import { useCreateVault } from './Hosts.js';

function useScoped(): ItemView[] {
  const items = useStore((s) => s.items);
  const filter = useStore((s) => s.vaultFilter);
  return useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.vaultId === filter)),
    [items, filter],
  );
}

function VaultTag({ vaultId }: { vaultId: string }) {
  const vault = useStore((s) => s.vaultById.get(vaultId));
  const filter = useStore((s) => s.vaultFilter);
  if (filter !== 'all' || vault?.kind !== 'shared') return null;
  return <Badge tone="accent">{vaultTitle(vault)}</Badge>;
}

function ListFrame({
  title,
  actions,
  empty,
  isEmpty,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  empty: string;
  isEmpty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="view">
      <div className="view-header">
        <h1>{title}</h1>
        <span className="spacer" />
        {actions}
      </div>
      <div className="list">{isEmpty ? <EmptyState>{empty}</EmptyState> : children}</div>
    </div>
  );
}

function Row({
  item,
  sub,
  onOpen,
  extra,
}: {
  item: ItemView;
  sub?: React.ReactNode;
  onOpen: () => void;
  extra?: React.ReactNode;
}) {
  const vault = useStore((s) => s.vaultById.get(item.vaultId));
  return (
    <div className="host-row" onDoubleClick={onOpen}>
      <div className="host-main">
        <div className="host-label">{labelOf(item.payload)}</div>
        {sub ? <div className="host-sub">{sub}</div> : null}
      </div>
      <div className="host-tags">
        <VaultTag vaultId={item.vaultId} />
      </div>
      <div className="host-actions">
        {extra}
        <Button onClick={onOpen}>{canWrite(vault) ? 'Edit' : 'View'}</Button>
      </div>
    </div>
  );
}

export function KeychainView() {
  const visible = useScoped();
  const createVault = useCreateVault();
  const identities = itemsOfType(visible, 'identity').sort(byLabel);
  const keys = itemsOfType(visible, 'ssh_key').sort(byLabel);
  const vaultArg = createVault ? { vaultId: createVault } : {};
  return (
    <ListFrame
      title="Keychain"
      isEmpty={identities.length + keys.length === 0}
      empty="No identities or SSH keys yet. An identity bundles a username with a password or key, so many hosts can share it."
      actions={
        <>
          <Button onClick={() => openEditor({ type: 'identity', ...vaultArg })}>
            New identity
          </Button>
          <Button variant="primary" onClick={() => openEditor({ type: 'ssh_key', ...vaultArg })}>
            New SSH key
          </Button>
        </>
      }
    >
      {identities.length > 0 ? <h3 className="list-heading">Identities</h3> : null}
      {identities.map((i) => (
        <Row
          key={i.id}
          item={i}
          sub={
            <>
              {i.payload.username}
              {i.payload.has_password ? ' · password' : ''}
              {i.payload.key_id ? ' · key' : ''}
            </>
          }
          onOpen={() => openEditor({ type: 'identity', item: i })}
        />
      ))}
      {keys.length > 0 ? <h3 className="list-heading">SSH keys</h3> : null}
      {keys.map((k) => (
        <Row
          key={k.id}
          item={k}
          sub={k.payload.has_passphrase ? 'passphrase protected' : 'no passphrase'}
          onOpen={() => openEditor({ type: 'ssh_key', item: k })}
        />
      ))}
    </ListFrame>
  );
}

export function SnippetsView() {
  const visible = useScoped();
  const createVault = useCreateVault();
  const snippets = itemsOfType(visible, 'snippet').sort(byLabel);
  return (
    <ListFrame
      title="Snippets"
      isEmpty={snippets.length === 0}
      empty="No snippets yet. Snippets are scripts you can paste or run in any open terminal, or run when a host connects."
      actions={
        <Button
          variant="primary"
          onClick={() =>
            openEditor({ type: 'snippet', ...(createVault ? { vaultId: createVault } : {}) })
          }
        >
          New snippet
        </Button>
      }
    >
      {snippets.map((s) => (
        <Row
          key={s.id}
          item={s}
          sub={<span className="mono">{s.payload.script.split('\n')[0]?.slice(0, 80)}</span>}
          onOpen={() => openEditor({ type: 'snippet', item: s })}
        />
      ))}
    </ListFrame>
  );
}

export function ForwardsView() {
  const visible = useScoped();
  const items = useStore((s) => s.items);
  const createVault = useCreateVault();
  const forwards = itemsOfType(visible, 'port_forward').sort(byLabel);
  const hostLabel = (id: string) => {
    const host = items.find((i) => i.id === id);
    return host ? labelOf(host.payload) : 'missing host';
  };
  const describe = (f: ItemOf<'port_forward'>) => {
    const p = f.payload;
    const listen = `${p.bind_address}:${p.bind_port}`;
    if (p.kind === 'dynamic') return `SOCKS5 on ${listen}`;
    const dest = `${p.dest_host}:${p.dest_port}`;
    return p.kind === 'local' ? `${listen} → ${dest}` : `host ${listen} → ${dest} here`;
  };
  return (
    <ListFrame
      title="Port forwards"
      isEmpty={forwards.length === 0}
      empty="No port forwards yet. Start and stop them from an open terminal's Forwards panel."
      actions={
        <Button
          variant="primary"
          onClick={() =>
            openEditor({ type: 'port_forward', ...(createVault ? { vaultId: createVault } : {}) })
          }
        >
          New port forward
        </Button>
      }
    >
      {forwards.map((f) => (
        <Row
          key={f.id}
          item={f}
          sub={
            <>
              <Badge>{f.payload.kind}</Badge> {describe(f)} · via {hostLabel(f.payload.host_id)}
            </>
          }
          onOpen={() => openEditor({ type: 'port_forward', item: f })}
        />
      ))}
    </ListFrame>
  );
}

function Fingerprint({ keyB64 }: { keyB64: string }) {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    hostKeyFingerprint(keyB64).then(
      (fp) => alive && setValue(fp),
      () => alive && setValue(null),
    );
    return () => void (alive = false);
  }, [keyB64]);
  return <code className="fingerprint">{value ?? '…'}</code>;
}

export function KnownHostsView() {
  const visible = useScoped();
  const vaultById = useStore((s) => s.vaultById);
  const hosts = itemsOfType(visible, 'known_host').sort(byLabel);
  const [deleting, setDeleting] = useState<ItemOf<'known_host'> | null>(null);
  return (
    <ListFrame
      title="Known hosts"
      isEmpty={hosts.length === 0}
      empty="No trusted host keys yet. When you connect to a new server, Ternix shows its fingerprint and saves the key you accept here."
    >
      {hosts.map((h) => {
        const writable = canWrite(vaultById.get(h.vaultId));
        return (
          <div key={h.id} className="host-row">
            <div className="host-main">
              <div className="host-label mono">{labelOf(h.payload)}</div>
              <div className="host-sub">
                {h.payload.key_type} · <Fingerprint keyB64={h.payload.public_key} />
              </div>
            </div>
            <div className="host-tags">
              <VaultTag vaultId={h.vaultId} />
            </div>
            <div className="host-actions">
              <Button
                variant="danger"
                disabled={!writable}
                title={writable ? undefined : 'Read only'}
                onClick={() => setDeleting(h)}
              >
                Forget
              </Button>
            </div>
          </div>
        );
      })}
      {deleting ? (
        <ConfirmDialog
          title="Forget this host key?"
          message={
            <>
              The next connection to <strong>{labelOf(deleting.payload)}</strong> will ask you to
              verify its fingerprint again.
            </>
          }
          confirmLabel="Forget"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const result = await call('items.delete', {
              vaultId: deleting.vaultId,
              itemId: deleting.id,
            }).catch((err: unknown) => (reportError(err), null));
            if (result?.status === 'dropped') toast('That entry was changed elsewhere.', 'warning');
          }}
        />
      ) : null}
    </ListFrame>
  );
}
