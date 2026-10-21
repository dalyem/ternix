import {
  Eye,
  FolderOpen,
  FolderPlus,
  Pencil,
  Play,
  Plus,
  Search,
  Server,
  Folder,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { EntityCard, HostTile, Tile } from '../cards.js';
import { byLabel, canWrite, describeHost, type ItemOf, itemsOfType, vaultTitle } from '../items.js';
import {
  closeEditor,
  type ItemView,
  openEditor,
  openHost,
  quickConnect,
  useStore,
} from '../store.js';
import { Badge, Button, EmptyState, IconButton, useAction } from '../ui.js';

function useVisibleItems(): ItemView[] {
  const items = useStore((s) => s.items);
  const filter = useStore((s) => s.vaultFilter);
  return useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.vaultId === filter)),
    [items, filter],
  );
}

/** The vault a "new" item is created in: the one selected in the sidebar, if writable. */
export function useCreateVault(): string | undefined {
  const filter = useStore((s) => s.vaultFilter);
  const vaultById = useStore((s) => s.vaultById);
  return filter !== 'all' && canWrite(vaultById.get(filter)) ? filter : undefined;
}

function QuickBar({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const action = useAction();
  const target = query.trim();
  return (
    <div className="quick-bar">
      <form
        className="quick-connect"
        onSubmit={(e) => {
          e.preventDefault();
          if (target === '') return;
          void action.run(async () => {
            const ok = await quickConnect(target, needsPassword ? password : undefined);
            if (ok) {
              onQuery('');
              setPassword('');
            }
          });
        }}
      >
        <Search size={14} aria-hidden />
        <input
          id="quick-connect-input"
          aria-label="Quick connect"
          placeholder="Find a host or ssh user@hostname…"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onQuery(e.target.value)}
        />
        {needsPassword ? (
          <input
            aria-label="Quick connect password"
            type="password"
            placeholder="Password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        ) : null}
        <Button variant="quiet" size="sm" onClick={() => setNeedsPassword((v) => !v)}>
          {needsPassword ? 'No password' : 'Password…'}
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          disabled={target === ''}
          busy={action.busy}
        >
          Connect
        </Button>
      </form>
    </div>
  );
}

function matches(host: ItemOf<'host'>, q: string, tag: string | null): boolean {
  const p = host.payload;
  if (tag !== null && !p.tags.includes(tag)) return false;
  if (q === '') return true;
  const hay = [p.label, p.address, p.username ?? '', ...p.tags].join('\n').toLowerCase();
  return hay.includes(q);
}

interface Tree {
  groups: ItemOf<'group'>[];
  hostsByGroup: Map<string | undefined, ItemOf<'host'>[]>;
  childGroups: Map<string | undefined, ItemOf<'group'>[]>;
}

function buildTree(visible: ItemView[], q: string, tag: string | null): Tree {
  const groups = itemsOfType(visible, 'group').sort(byLabel);
  const groupIds = new Set(groups.map((g) => g.id));
  const hosts = itemsOfType(visible, 'host')
    .filter((h) => matches(h, q, tag))
    .sort(byLabel);
  const hostsByGroup = new Map<string | undefined, ItemOf<'host'>[]>();
  for (const host of hosts) {
    const parent = host.payload.group_id;
    const key = parent && groupIds.has(parent) ? parent : undefined;
    hostsByGroup.set(key, [...(hostsByGroup.get(key) ?? []), host]);
  }
  const childGroups = new Map<string | undefined, ItemOf<'group'>[]>();
  for (const group of groups) {
    const parent = group.payload.parent_id;
    const key = parent && groupIds.has(parent) && parent !== group.id ? parent : undefined;
    childGroups.set(key, [...(childGroups.get(key) ?? []), group]);
  }
  return { groups, hostsByGroup, childGroups };
}

export function HostsView() {
  const visible = useVisibleItems();
  const vaultById = useStore((s) => s.vaultById);
  const filter = useStore((s) => s.vaultFilter);
  const editor = useStore((s) => s.editor);
  const createVault = useCreateVault();
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [path, setPath] = useState<string | undefined>(undefined);
  const q = query.trim().toLowerCase();
  const searching = q !== '' || tag !== null;

  const allTags = useMemo(
    () => [...new Set(itemsOfType(visible, 'host').flatMap((h) => h.payload.tags))].sort(),
    [visible],
  );
  const tree = useMemo(() => buildTree(visible, q, tag), [visible, q, tag]);
  const hostCount = itemsOfType(visible, 'host').length;
  const canCreate = createVault !== undefined || filter === 'all';
  const selectedId = editor?.item?.id;

  // A group that is gone (deleted elsewhere, or another vault selected) leads back to the top.
  const current = path && tree.groups.some((g) => g.id === path) ? path : undefined;
  const crumbs = useMemo(() => {
    const chain: ItemOf<'group'>[] = [];
    const seen = new Set<string>();
    let id = current;
    while (id && !seen.has(id) && chain.length < 64) {
      seen.add(id);
      const group = tree.groups.find((g) => g.id === id);
      if (!group) break;
      chain.unshift(group);
      id = group.payload.parent_id;
    }
    return chain;
  }, [current, tree.groups]);

  const groups = searching ? [] : (tree.childGroups.get(current) ?? []);
  const hosts = searching
    ? [...tree.hostsByGroup.values()].flat().sort(byLabel)
    : (tree.hostsByGroup.get(current) ?? []);

  const renderHost = (host: ItemOf<'host'>) => {
    const vault = vaultById.get(host.vaultId);
    const p = host.payload;
    const writable = canWrite(vault);
    return (
      <EntityCard
        key={host.id}
        testId={`host-${p.label}`}
        selected={selectedId === host.id}
        tile={<HostTile label={p.label} color={p.color} os={p.os} />}
        title={<span className="entity-title-text">{p.label}</span>}
        sub={describeHost(p)}
        meta={
          filter === 'all' && vault?.kind === 'shared' ? (
            <Badge tone="accent">{vaultTitle(vault)}</Badge>
          ) : null
        }
        onSelect={() => openEditor({ type: 'host', item: host })}
        onOpen={() => {
          closeEditor();
          void openHost(host.id);
        }}
        actions={
          <>
            <IconButton
              icon={Play}
              label="Connect"
              size="sm"
              className="btn-connect"
              onClick={() => {
                closeEditor();
                void openHost(host.id);
              }}
            />
            <IconButton
              icon={writable ? Pencil : Eye}
              label={writable ? 'Edit' : 'View'}
              size="sm"
              onClick={() => openEditor({ type: 'host', item: host })}
            />
          </>
        }
      />
    );
  };

  const renderGroup = (group: ItemOf<'group'>) => {
    const vault = vaultById.get(group.vaultId);
    const writable = canWrite(vault);
    const hostsHere = tree.hostsByGroup.get(group.id)?.length ?? 0;
    const subgroups = tree.childGroups.get(group.id)?.length ?? 0;
    const label = group.payload.label;
    return (
      <EntityCard
        key={group.id}
        selected={selectedId === group.id}
        tile={<Tile icon={Folder} />}
        title={<span className="entity-title-text group-label">{label}</span>}
        sub={`${hostsHere} host${hostsHere === 1 ? '' : 's'}${
          subgroups > 0 ? `, ${subgroups} subgroup${subgroups === 1 ? '' : 's'}` : ''
        }`}
        meta={
          filter === 'all' && vault?.kind === 'shared' ? (
            <Badge tone="accent">{vaultTitle(vault)}</Badge>
          ) : null
        }
        onSelect={() => openEditor({ type: 'group', item: group })}
        onOpen={() => {
          closeEditor();
          setPath(group.id);
        }}
        actions={
          <>
            <IconButton
              icon={FolderOpen}
              label={`Open ${label}`}
              size="sm"
              onClick={() => {
                closeEditor();
                setPath(group.id);
              }}
            />
            {writable ? (
              <>
                <IconButton
                  icon={Plus}
                  label={`New host in ${label}`}
                  size="sm"
                  onClick={() =>
                    openEditor({
                      type: 'host',
                      vaultId: group.vaultId,
                      preset: { group_id: group.id },
                    })
                  }
                />
                <IconButton
                  icon={FolderPlus}
                  label={`New subgroup in ${label}`}
                  size="sm"
                  onClick={() =>
                    openEditor({
                      type: 'group',
                      vaultId: group.vaultId,
                      preset: { parent_id: group.id },
                    })
                  }
                />
              </>
            ) : null}
            <IconButton
              icon={writable ? Pencil : Eye}
              label={writable ? `Edit ${label}` : `View ${label}`}
              size="sm"
              onClick={() => openEditor({ type: 'group', item: group })}
            />
          </>
        }
      />
    );
  };

  const empty = hostCount === 0 && (tree.groups.length === 0 || searching);
  return (
    <div className="view">
      <QuickBar query={query} onQuery={setQuery} />
      <div className="toolbar">
        {canCreate ? (
          <>
            <Button
              size="md"
              icon={Server}
              data-testid="new-host"
              onClick={() =>
                openEditor({
                  type: 'host',
                  ...(createVault ? { vaultId: createVault } : {}),
                  ...(current ? { preset: { group_id: current } } : {}),
                })
              }
            >
              New host
            </Button>
            <Button
              size="md"
              variant="ghost"
              icon={FolderPlus}
              onClick={() =>
                openEditor({
                  type: 'group',
                  ...(createVault ? { vaultId: createVault } : {}),
                  ...(current ? { preset: { parent_id: current } } : {}),
                })
              }
            >
              New group
            </Button>
          </>
        ) : null}
        <span className="spacer" />
        <div className="toolbar-tags">
          {tag !== null ? (
            <button className="chip chip-active" onClick={() => setTag(null)}>
              {tag} ✕
            </button>
          ) : (
            allTags.slice(0, 8).map((t) => (
              <button key={t} className="chip" onClick={() => setTag(t)}>
                {t}
              </button>
            ))
          )}
        </div>
      </div>
      <div className="view-scroll" data-testid="host-list">
        <div className="page">
          {current ? (
            <nav className="crumbs" aria-label="Group path">
              <button className="crumb" onClick={() => setPath(undefined)}>
                All hosts
              </button>
              {crumbs.map((g, index) => (
                <span key={g.id} style={{ display: 'contents' }}>
                  <span aria-hidden>›</span>
                  <button
                    className="crumb"
                    aria-current={index === crumbs.length - 1 ? 'true' : undefined}
                    onClick={() => setPath(g.id)}
                  >
                    {g.payload.label}
                  </button>
                </span>
              ))}
            </nav>
          ) : null}
          {groups.length > 0 ? (
            <>
              <h3 className="section-title">Groups</h3>
              <div className="grid">{groups.map(renderGroup)}</div>
            </>
          ) : null}
          {hosts.length > 0 ? (
            <>
              <h3 className="section-title">Hosts</h3>
              <div className="grid">{hosts.map(renderHost)}</div>
            </>
          ) : null}
          {empty ? (
            <EmptyState icon={Server} title="No hosts yet">
              {canCreate
                ? 'Create one with “New host”, or connect right away with quick connect.'
                : 'Connect right away with quick connect.'}
            </EmptyState>
          ) : searching && hosts.length === 0 ? (
            <EmptyState icon={Search} title="No saved host matches">
              {q !== ''
                ? `Press Connect to open “${query.trim()}” as an address.`
                : 'No host has this tag.'}
            </EmptyState>
          ) : current && groups.length === 0 && hosts.length === 0 ? (
            <EmptyState icon={Folder} title="This group is empty">
              Add a host or a subgroup with the buttons above.
            </EmptyState>
          ) : null}
        </div>
      </div>
    </div>
  );
}
