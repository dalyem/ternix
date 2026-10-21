import {
  Braces,
  Eye,
  FingerprintPattern,
  IdCard,
  KeyRound,
  Pencil,
  Trash2,
  Waypoints,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { call } from '../api.js';
import { EntityCard, Tile } from '../cards.js';
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
import { Badge, Button, ConfirmDialog, EmptyState, IconButton } from '../ui.js';
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
  actions,
  empty,
  emptyIcon,
  emptyTitle,
  isEmpty,
  children,
}: {
  actions?: ReactNode;
  empty: string;
  emptyIcon: typeof KeyRound;
  emptyTitle: string;
  isEmpty: boolean;
  children: ReactNode;
}) {
  return (
    <div className="view">
      {actions ? <div className="toolbar">{actions}</div> : null}
      <div className="view-scroll">
        <div className="page">
          {isEmpty ? (
            <EmptyState icon={emptyIcon} title={emptyTitle}>
              {empty}
            </EmptyState>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h3 className="section-title">{title}</h3>
      <div className="grid grid-wide">{children}</div>
    </>
  );
}

/** A card for an editable item: click selects and opens the editor, Enter or the pencil too. */
function ItemCard({
  item,
  type,
  tile,
  sub,
  mono,
}: {
  item: ItemView;
  type: 'identity' | 'ssh_key' | 'snippet' | 'port_forward';
  tile: ReactNode;
  sub?: ReactNode;
  mono?: boolean;
}) {
  const vault = useStore((s) => s.vaultById.get(item.vaultId));
  const selectedId = useStore((s) => s.editor?.item?.id);
  const writable = canWrite(vault);
  const open = () => openEditor({ type, item });
  return (
    <EntityCard
      selected={selectedId === item.id}
      tile={tile}
      title={<span className="entity-title-text">{labelOf(item.payload)}</span>}
      sub={sub}
      mono={mono}
      meta={<VaultTag vaultId={item.vaultId} />}
      onSelect={open}
      onOpen={open}
      actions={
        <IconButton
          icon={writable ? Pencil : Eye}
          label={writable ? 'Edit' : 'View'}
          size="sm"
          onClick={open}
        />
      }
    />
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
      emptyIcon={KeyRound}
      emptyTitle="Keychain is empty"
      isEmpty={identities.length + keys.length === 0}
      empty="No identities or SSH keys yet. An identity bundles a username with a password or key, so many hosts can share it."
      actions={
        <>
          <Button
            size="md"
            icon={KeyRound}
            onClick={() => openEditor({ type: 'ssh_key', ...vaultArg })}
          >
            New SSH key
          </Button>
          <Button
            size="md"
            variant="ghost"
            icon={IdCard}
            onClick={() => openEditor({ type: 'identity', ...vaultArg })}
          >
            New identity
          </Button>
        </>
      }
    >
      {keys.length > 0 ? (
        <Section title="SSH keys">
          {keys.map((k) => (
            <ItemCard
              key={k.id}
              item={k}
              type="ssh_key"
              tile={<Tile icon={KeyRound} />}
              sub={k.payload.has_passphrase ? 'Passphrase protected' : 'No passphrase'}
            />
          ))}
        </Section>
      ) : null}
      {identities.length > 0 ? (
        <Section title="Identities">
          {identities.map((i) => (
            <ItemCard
              key={i.id}
              item={i}
              type="identity"
              tile={<Tile icon={IdCard} />}
              sub={
                <>
                  {i.payload.username}
                  {i.payload.has_password ? ' · password' : ''}
                  {i.payload.key_id ? ' · key' : ''}
                </>
              }
            />
          ))}
        </Section>
      ) : null}
    </ListFrame>
  );
}

export function SnippetsView() {
  const visible = useScoped();
  const createVault = useCreateVault();
  const snippets = itemsOfType(visible, 'snippet').sort(byLabel);
  return (
    <ListFrame
      emptyIcon={Braces}
      emptyTitle="No snippets yet"
      isEmpty={snippets.length === 0}
      empty="Snippets are scripts you can paste or run in any open terminal, or run when a host connects."
      actions={
        <Button
          size="md"
          icon={Braces}
          onClick={() =>
            openEditor({ type: 'snippet', ...(createVault ? { vaultId: createVault } : {}) })
          }
        >
          New snippet
        </Button>
      }
    >
      <Section title="Snippets">
        {snippets.map((s) => (
          <ItemCard
            key={s.id}
            item={s}
            type="snippet"
            tile={<Tile icon={Braces} />}
            sub={<span className="mono">{s.payload.script.split('\n')[0]?.slice(0, 80)}</span>}
          />
        ))}
      </Section>
    </ListFrame>
  );
}

const FORWARD_LETTER = { local: 'L', remote: 'R', dynamic: 'D' } as const;

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
      emptyIcon={Waypoints}
      emptyTitle="No port forwards yet"
      isEmpty={forwards.length === 0}
      empty="Start and stop them from an open terminal's Forwards panel."
      actions={
        <Button
          size="md"
          icon={Waypoints}
          onClick={() =>
            openEditor({ type: 'port_forward', ...(createVault ? { vaultId: createVault } : {}) })
          }
        >
          New port forward
        </Button>
      }
    >
      <Section title="Port forwards">
        {forwards.map((f) => (
          <ItemCard
            key={f.id}
            item={f}
            type="port_forward"
            tile={<Tile letter={FORWARD_LETTER[f.payload.kind]} />}
            sub={
              <>
                {describe(f)} · via {hostLabel(f.payload.host_id)}
              </>
            }
          />
        ))}
      </Section>
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
      emptyIcon={FingerprintPattern}
      emptyTitle="No trusted host keys yet"
      isEmpty={hosts.length === 0}
      empty="When you connect to a new server, Ternix shows its fingerprint and saves the key you accept here."
    >
      <Section title="Known hosts">
        {hosts.map((h) => {
          const writable = canWrite(vaultById.get(h.vaultId));
          return (
            <EntityCard
              key={h.id}
              mono
              tile={<Tile icon={FingerprintPattern} />}
              title={<span className="entity-title-text">{labelOf(h.payload)}</span>}
              sub={
                <>
                  {h.payload.key_type} · <Fingerprint keyB64={h.payload.public_key} />
                </>
              }
              meta={<VaultTag vaultId={h.vaultId} />}
              actions={
                <IconButton
                  icon={Trash2}
                  label="Forget"
                  size="sm"
                  disabled={!writable}
                  title={writable ? 'Forget' : 'Read only'}
                  onClick={() => setDeleting(h)}
                />
              }
            />
          );
        })}
      </Section>
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
