import { useMemo, useState } from 'react';
import { byLabel, canWrite, describeHost, type ItemOf, itemsOfType, vaultTitle } from '../items.js';
import { type ItemView, openEditor, openHost, quickConnect, useStore } from '../store.js';
import { Badge, Button, EmptyState, useAction } from '../ui.js';

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

function QuickConnect() {
  const [target, setTarget] = useState('');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const action = useAction();
  return (
    <form
      className="quick-connect"
      onSubmit={(e) => {
        e.preventDefault();
        if (target.trim() === '') return;
        void action.run(async () => {
          const ok = await quickConnect(target.trim(), needsPassword ? password : undefined);
          if (ok) {
            setTarget('');
            setPassword('');
          }
        });
      }}
    >
      <input
        aria-label="Quick connect"
        placeholder="Quick connect: user@host[:port]"
        value={target}
        spellCheck={false}
        onChange={(e) => setTarget(e.target.value)}
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
      <Button variant="ghost" onClick={() => setNeedsPassword((v) => !v)}>
        {needsPassword ? 'No password' : 'Password…'}
      </Button>
      <Button variant="primary" type="submit" disabled={target.trim() === ''} busy={action.busy}>
        Connect
      </Button>
    </form>
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
  const createVault = useCreateVault();
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const q = query.trim().toLowerCase();
  const searching = q !== '' || tag !== null;

  const allTags = useMemo(
    () => [...new Set(itemsOfType(visible, 'host').flatMap((h) => h.payload.tags))].sort(),
    [visible],
  );
  const tree = useMemo(() => buildTree(visible, q, tag), [visible, q, tag]);
  const hostCount = itemsOfType(visible, 'host').length;
  const canCreate = createVault !== undefined || filter === 'all';

  /** Groups with something to show: when searching, only branches with matching hosts. */
  const hasContent = useMemo(() => {
    const memo = new Map<string, boolean>();
    const check = (id: string, depth = 0): boolean => {
      const known = memo.get(id);
      if (known !== undefined) return known;
      memo.set(id, false); // cycle guard
      const result =
        depth < 64 &&
        ((tree.hostsByGroup.get(id)?.length ?? 0) > 0 ||
          (tree.childGroups.get(id) ?? []).some((c) => check(c.id, depth + 1)));
      memo.set(id, result);
      return result;
    };
    for (const g of tree.groups) check(g.id);
    return memo;
  }, [tree]);

  const renderHost = (host: ItemOf<'host'>, depth: number) => {
    const vault = vaultById.get(host.vaultId);
    const p = host.payload;
    return (
      <div
        key={host.id}
        className="host-row"
        style={{ paddingLeft: 12 + depth * 18 }}
        onDoubleClick={() => void openHost(host.id)}
        data-testid={`host-${p.label}`}
      >
        <span className="dot" style={{ background: p.color ?? 'var(--border-strong)' }} />
        <div className="host-main">
          <div className="host-label">{p.label}</div>
          <div className="host-sub mono">{describeHost(p)}</div>
        </div>
        <div className="host-tags">
          {p.tags.map((t) => (
            <button key={t} className="chip" onClick={() => setTag(t === tag ? null : t)}>
              {t}
            </button>
          ))}
          {filter === 'all' && vault?.kind === 'shared' ? (
            <Badge tone="accent">{vaultTitle(vault)}</Badge>
          ) : null}
        </div>
        <div className="host-actions">
          <Button variant="primary" onClick={() => void openHost(host.id)}>
            Connect
          </Button>
          <Button onClick={() => openEditor({ type: 'host', item: host })}>
            {canWrite(vault) ? 'Edit' : 'View'}
          </Button>
        </div>
      </div>
    );
  };

  const renderGroup = (group: ItemOf<'group'>, depth: number, seen: Set<string>) => {
    if (seen.has(group.id) || (searching && !hasContent.get(group.id))) return null;
    const open = searching || !collapsed.has(group.id);
    const nextSeen = new Set(seen).add(group.id);
    const vault = vaultById.get(group.vaultId);
    return (
      <div key={group.id} className="group">
        <div className="group-row" style={{ paddingLeft: 8 + depth * 18 }}>
          <button
            className="twisty"
            aria-label={open ? 'Collapse group' : 'Expand group'}
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (!next.delete(group.id)) next.add(group.id);
                return next;
              })
            }
          >
            {open ? '▾' : '▸'}
          </button>
          <span className="group-label">{group.payload.label}</span>
          {filter === 'all' && vault?.kind === 'shared' ? (
            <Badge tone="accent">{vaultTitle(vault)}</Badge>
          ) : null}
          <span className="spacer" />
          {canWrite(vault) ? (
            <>
              <Button
                variant="ghost"
                onClick={() =>
                  openEditor({
                    type: 'host',
                    vaultId: group.vaultId,
                    preset: { group_id: group.id },
                  })
                }
              >
                + Host
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  openEditor({
                    type: 'group',
                    vaultId: group.vaultId,
                    preset: { parent_id: group.id },
                  })
                }
              >
                + Subgroup
              </Button>
            </>
          ) : null}
          <Button variant="ghost" onClick={() => openEditor({ type: 'group', item: group })}>
            {canWrite(vault) ? 'Edit' : 'View'}
          </Button>
        </div>
        {open ? (
          <>
            {(tree.childGroups.get(group.id) ?? []).map((g) => renderGroup(g, depth + 1, nextSeen))}
            {(tree.hostsByGroup.get(group.id) ?? []).map((h) => renderHost(h, depth + 1))}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="view">
      <div className="view-header">
        <h1>Hosts</h1>
        <QuickConnect />
      </div>
      <div className="toolbar">
        <input
          className="search"
          aria-label="Search hosts"
          placeholder="Search by name, address, user or tag"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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
        <span className="spacer" />
        {canCreate ? (
          <>
            <Button
              onClick={() =>
                openEditor({ type: 'group', ...(createVault ? { vaultId: createVault } : {}) })
              }
            >
              New group
            </Button>
            <Button
              variant="primary"
              data-testid="new-host"
              onClick={() =>
                openEditor({ type: 'host', ...(createVault ? { vaultId: createVault } : {}) })
              }
            >
              New host
            </Button>
          </>
        ) : null}
      </div>
      <div className="list" data-testid="host-list">
        {(tree.childGroups.get(undefined) ?? []).map((g) => renderGroup(g, 0, new Set()))}
        {(tree.hostsByGroup.get(undefined) ?? []).map((h) => renderHost(h, 0))}
        {hostCount === 0 ? (
          <EmptyState>
            No hosts yet.{' '}
            {canCreate
              ? 'Create one with “New host”, or connect right away with quick connect.'
              : ''}
          </EmptyState>
        ) : searching && !(tree.hostsByGroup.size > 0) ? (
          <EmptyState>No hosts match.</EmptyState>
        ) : null}
      </div>
    </div>
  );
}
