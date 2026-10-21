import {
  ArrowDown,
  ArrowUp,
  CircleX,
  Copy,
  Download,
  File,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  FolderUp,
  HardDrive,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  SftpEntryDto,
  SftpListingDto,
  SftpSessionDto,
  TransferBatchDto,
  TransferDto,
} from '../../../shared/app.js';
import { apiErrorFrom, call, errorMessage } from '../api.js';
import { EntityCard, HostTile } from '../cards.js';
import { byLabel, describeHost, itemsOfType } from '../items.js';
import {
  closeSftp,
  openSftp,
  reconnectSftp,
  reportError,
  setSftpPath,
  setState,
  toast,
  useStore,
} from '../store.js';
import {
  crumbsOf,
  formatMode,
  formatSize,
  joinRemote,
  opensAsFolder,
  parentOf,
  resolveRemoteInput,
  type SortKey,
  sortEntries,
} from '../sftpFormat.js';
import { Button, EmptyState, IconButton, Modal, TextField, useAction } from '../ui.js';

/**
 * The SFTP tab: one browser per SFTP session (each its own connection to a saved host), a host
 * picker to open more, and the transfers. There is no local file pane: uploads come from main's
 * open dialog or from files dropped here, and downloads go where main's save or folder dialog
 * says, so the page never names a local path.
 */
export function SftpView() {
  const sessions = useStore((s) => s.sftpSessions);
  const active = useStore((s) => s.activeSftp);
  const session = sessions.find((x) => x.id === active);
  return (
    <div className="view sftp-view" data-testid="sftp-view">
      <SessionBar sessions={sessions} active={session?.id ?? null} />
      {session ? <Browser key={session.id} session={session} /> : <HostPicker />}
      <TransfersPanel />
    </div>
  );
}

function stateLabel(s: SftpSessionDto): string {
  switch (s.state) {
    case 'connecting':
      return s.hop && s.hop.total > 1
        ? `Connecting to ${s.hop.label} (${s.hop.index + 1} of ${s.hop.total})…`
        : 'Connecting…';
    case 'verifying-host-key':
      return 'Waiting for you to verify the host key…';
    case 'authenticating':
      return 'Signing in…';
    case 'ready':
      return 'Connected';
    case 'closed':
      if (s.closed?.kind === 'error') return s.closed.message ?? 'Connection failed';
      return s.closed?.kind === 'remote' ? 'Connection closed by the server' : 'Disconnected';
  }
}

function SessionBar({ sessions, active }: { sessions: SftpSessionDto[]; active: string | null }) {
  const itemById = useStore((s) => s.itemById);
  return (
    <div className="toolbar sftp-sessions" role="tablist" aria-label="SFTP sessions">
      {sessions.map((s) => {
        const host = itemById.get(s.hostId)?.payload;
        return (
          <div
            key={s.id}
            role="tab"
            aria-selected={s.id === active}
            className={`sftp-chip ${s.id === active ? 'active' : ''}`}
            title={`${s.label}: ${s.target} · ${stateLabel(s)}`}
            onClick={() => setState({ activeSftp: s.id })}
            data-testid="sftp-session"
          >
            <HostTile
              small
              label={s.label}
              color={host?.type === 'host' ? host.color : undefined}
              os={host?.type === 'host' ? host.os : undefined}
            />
            <span className="ellipsis">{s.label}</span>
            <span
              className={`state-dot ${s.state === 'ready' ? 'ready' : s.state === 'closed' ? 'closed' : ''}`}
              aria-hidden
            />
            <button
              className="tab-close"
              aria-label={`Close ${s.label}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeSftp(s.id);
              }}
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        );
      })}
      <Button
        size="md"
        variant={sessions.length === 0 ? 'default' : 'ghost'}
        icon={Plus}
        aria-pressed={active === null}
        onClick={() => setState({ activeSftp: null })}
      >
        {sessions.length === 0 ? 'Choose a host' : 'Host'}
      </Button>
    </div>
  );
}

function HostPicker() {
  const items = useStore((s) => s.items);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const hosts = useMemo(
    () =>
      itemsOfType(items, 'host')
        .filter((h) =>
          q === ''
            ? true
            : [h.payload.label, h.payload.address, h.payload.username ?? '', ...h.payload.tags]
                .join('\n')
                .toLowerCase()
                .includes(q),
        )
        .sort(byLabel),
    [items, q],
  );
  return (
    <>
      <div className="quick-bar">
        <label className="quick-connect">
          <Search size={14} aria-hidden />
          <input
            aria-label="Find a host"
            placeholder="Find a host to browse with SFTP…"
            value={query}
            spellCheck={false}
            autoComplete="off"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="view-scroll">
        <div className="page">
          <h3 className="section-title">Open SFTP on a host</h3>
          {hosts.length > 0 ? (
            <div className="grid">
              {hosts.map((h) => (
                <EntityCard
                  key={h.id}
                  testId={`sftp-host-${h.payload.label}`}
                  tile={
                    <HostTile label={h.payload.label} color={h.payload.color} os={h.payload.os} />
                  }
                  title={<span className="entity-title-text">{h.payload.label}</span>}
                  sub={describeHost(h.payload)}
                  onOpen={() => void openSftp(h.id)}
                  actions={
                    <IconButton
                      icon={FolderOpen}
                      label={`Open SFTP on ${h.payload.label}`}
                      size="sm"
                      className="btn-connect"
                      onClick={() => void openSftp(h.id)}
                    />
                  }
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={HardDrive} title={q ? 'No host matches' : 'No hosts yet'}>
              {q ? 'Try another name or address.' : 'Save a host in Vaults → Hosts first.'}
            </EmptyState>
          )}
        </div>
      </div>
    </>
  );
}

type Dialog = { kind: 'mkdir' } | { kind: 'rename'; entry: SftpEntryDto };

interface Menu {
  x: number;
  y: number;
  /** The entries the menu acts on; empty for the folder background. */
  entries: SftpEntryDto[];
}

function Browser({ session }: { session: SftpSessionDto }) {
  const id = session.id;
  const ready = session.state === 'ready';
  const home = session.home ?? '/';
  const path = useStore((s) => s.sftpPaths[id]) ?? home;
  const transfers = useStore((s) => s.transfers);
  const [listing, setListing] = useState<SftpListingDto | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dropping, setDropping] = useState(false);
  const refresh = () => setVersion((v) => v + 1);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setLoading(true);
    call('sftp.readdir', { id, path })
      .then((result) => {
        if (!alive) return;
        setListing(result);
        setLoadError(null);
        if (result.path !== path) setSftpPath(id, result.path);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => void (alive = false);
  }, [id, path, version, ready]);

  // A new directory starts with nothing selected.
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [path]);

  // Uploads into this folder show up when they finish.
  const uploadsHere = transfers.filter(
    (t) =>
      t.sessionId === id &&
      t.direction === 'upload' &&
      t.state === 'done' &&
      parentOf(t.remotePath) === path,
  ).length;
  useEffect(() => {
    if (uploadsHere === 0) return;
    const timer = setTimeout(() => setVersion((v) => v + 1), 250);
    return () => clearTimeout(timer);
  }, [uploadsHere]);

  const entries = useMemo(
    () =>
      listing && listing.path === path ? sortEntries(listing.entries, sort.key, sort.dir) : [],
    [listing, path, sort],
  );
  const chosen = entries.filter((e) => selected.has(e.path));

  const go = (next: string) => {
    setEditing(false);
    setMenu(null);
    setSftpPath(id, next);
  };
  const open = (entry: SftpEntryDto) => {
    if (opensAsFolder(entry)) go(entry.path);
    else void download([entry]);
  };
  const report = (batch: TransferBatchDto, verb: string) => {
    if (batch.queued > 0) {
      toast(`${verb} ${batch.queued} file${batch.queued === 1 ? '' : 's'}`, 'info');
    }
    if (batch.skipped > 0) {
      toast(`${batch.skipped} item${batch.skipped === 1 ? ' was' : 's were'} left out`, 'warning');
    }
  };
  const download = async (list: SftpEntryDto[]) => {
    if (list.length === 0) return;
    try {
      report(await call('sftp.download', { id, paths: list.map((e) => e.path) }), 'Downloading');
    } catch (err) {
      reportError(err);
    }
  };
  const upload = async (kind: 'files' | 'folder') => {
    try {
      report(await call('sftp.upload', { id, remoteDir: path, kind }), 'Uploading');
    } catch (err) {
      reportError(err);
    }
  };
  const remove = async (list: SftpEntryDto[]) => {
    if (list.length === 0) return;
    try {
      await call('sftp.remove', { id, paths: list.map((e) => e.path) });
    } catch (err) {
      reportError(err);
    }
    refresh();
  };
  const copyPath = (text: string) => void call('clipboard.write', { text }).catch(reportError);

  const select = (entry: SftpEntryDto, e: MouseEvent | KeyboardEvent) => {
    const toggle = e.metaKey || e.ctrlKey;
    if (e.shiftKey && anchor) {
      const a = entries.findIndex((x) => x.path === anchor);
      const b = entries.findIndex((x) => x.path === entry.path);
      const [from, to] = a < b ? [a, b] : [b, a];
      setSelected(new Set(entries.slice(from, to + 1).map((x) => x.path)));
      return;
    }
    setAnchor(entry.path);
    setSelected((current) => {
      if (!toggle) return new Set([entry.path]);
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (dialog || menu) return;
    if (e.key === 'Delete' && chosen.length > 0) {
      e.preventDefault();
      void remove(chosen);
    } else if (e.key === 'F2' && chosen.length === 1) {
      e.preventDefault();
      setDialog({ kind: 'rename', entry: chosen[0]! });
    } else if (e.key === 'Enter' && chosen.length === 1) {
      e.preventDefault();
      open(chosen[0]!);
    } else if (e.key === 'Backspace' && path !== '/') {
      e.preventDefault();
      go(parentOf(path));
    } else if (e.key.toLowerCase() === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setSelected(new Set(entries.map((x) => x.path)));
    }
  };

  const onDragOver = (e: DragEvent) => {
    if (!ready || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    if (!ready) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    // The preload looks up where the dropped files are; the page never sends a path.
    void window.ternix.uploadDropped(id, path, files).then((result) => {
      if (result.ok) {
        if (result.value.queued === 0)
          toast('Nothing to upload: drop files or folders from your computer.', 'warning');
        else report(result.value, 'Uploading');
      } else {
        reportError(apiErrorFrom(result.error));
      }
    });
  };

  const sortButton = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button
        className="sftp-sort"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
      >
        {label}
        {sort.key === key ? (
          sort.dir === 1 ? (
            <ArrowUp size={12} aria-hidden />
          ) : (
            <ArrowDown size={12} aria-hidden />
          )
        ) : null}
      </button>
    </th>
  );

  return (
    <>
      <div className="toolbar sftp-pathbar">
        <IconButton
          icon={FolderUp}
          label="Up one folder"
          disabled={!ready || path === '/'}
          onClick={() => go(parentOf(path))}
        />
        <IconButton icon={RefreshCw} label="Refresh" disabled={!ready} onClick={refresh} />
        {editing ? (
          <PathInput
            initial={path}
            onCancel={() => setEditing(false)}
            onSubmit={(value) => go(resolveRemoteInput(value, path, home))}
          />
        ) : (
          <nav
            className="sftp-crumbs"
            aria-label="Remote path"
            data-testid="sftp-path"
            data-path={path}
            onDoubleClick={() => setEditing(true)}
          >
            {crumbsOf(path).map((c, index, all) => (
              <span key={c.path} className="sftp-crumb-wrap">
                {index > 1 ? (
                  <span aria-hidden className="sftp-crumb-sep">
                    /
                  </span>
                ) : null}
                <button
                  className="crumb"
                  aria-current={index === all.length - 1 ? 'true' : undefined}
                  onClick={() => go(c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
            <span className="spacer" />
            <IconButton
              icon={Pencil}
              size="sm"
              label="Edit path"
              onClick={() => setEditing(true)}
            />
          </nav>
        )}
        <IconButton
          icon={FolderPlus}
          label="New folder"
          disabled={!ready}
          onClick={() => setDialog({ kind: 'mkdir' })}
        />
        <Button size="md" icon={Upload} disabled={!ready} onClick={() => void upload('files')}>
          Upload
        </Button>
        <Button
          size="md"
          variant="ghost"
          icon={Upload}
          disabled={!ready}
          onClick={() => void upload('folder')}
        >
          Folder
        </Button>
        <Button
          size="md"
          variant="ghost"
          icon={Download}
          disabled={!ready || chosen.length === 0}
          onClick={() => void download(chosen)}
        >
          Download
        </Button>
      </div>
      {!ready ? (
        <div
          className={`terminal-banner ${session.state === 'closed' && session.closed?.kind === 'error' ? 'error' : ''}`}
          data-testid="sftp-status"
        >
          <span>{stateLabel(session)}</span>
          <span className="spacer" />
          {session.state === 'closed' ? (
            <>
              <Button variant="primary" size="md" onClick={() => void reconnectSftp(id)}>
                Reconnect
              </Button>
              <Button size="md" onClick={() => void closeSftp(id)}>
                Close
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <div
        className={`sftp-list ${dropping ? 'dropping' : ''}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
        onContextMenu={(e) => {
          if (!ready) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entries: [] });
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(new Set());
        }}
        data-testid="sftp-list"
      >
        {loadError && ready ? (
          <EmptyState
            icon={CircleX}
            title="Cannot open this folder"
            actions={
              <Button size="md" onClick={() => go(home)}>
                Go to home folder
              </Button>
            }
          >
            {errorMessage(loadError)}
          </EmptyState>
        ) : ready && listing && entries.length === 0 && !loading ? (
          <EmptyState icon={Folder} title="This folder is empty">
            Drop files here, or use Upload.
          </EmptyState>
        ) : (
          <table className="sftp-table" aria-busy={loading}>
            <thead>
              <tr>
                {sortButton('name', 'Name')}
                {sortButton('size', 'Size')}
                {sortButton('mtime', 'Modified')}
                {sortButton('mode', 'Permissions')}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.path}
                  className={selected.has(entry.path) ? 'selected' : ''}
                  aria-selected={selected.has(entry.path)}
                  data-testid={`sftp-row-${entry.name}`}
                  onClick={(e) => select(entry, e)}
                  onDoubleClick={() => open(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const list = selected.has(entry.path) ? chosen : [entry];
                    if (!selected.has(entry.path)) {
                      setSelected(new Set([entry.path]));
                      setAnchor(entry.path);
                    }
                    setMenu({ x: e.clientX, y: e.clientY, entries: list });
                  }}
                >
                  <td className="sftp-name">
                    <span className="sftp-name-inner">
                      <EntryIcon entry={entry} />
                      <span className="ellipsis">{entry.name}</span>
                    </span>
                  </td>
                  <td className="sftp-size">
                    {opensAsFolder(entry) ? '' : formatSize(entry.size)}
                  </td>
                  <td className="sftp-date">
                    {entry.mtime
                      ? new Date(entry.mtime * 1000).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })
                      : ''}
                  </td>
                  <td className="sftp-mode mono">{formatMode(entry.mode, entry.type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {menu ? (
        <ContextMenu menu={menu} onClose={() => setMenu(null)}>
          {(close) =>
            menu.entries.length > 0 ? (
              <>
                {menu.entries.length === 1 && opensAsFolder(menu.entries[0]!) ? (
                  <MenuItem
                    icon={Folder}
                    label="Open"
                    onClick={() => close(() => go(menu.entries[0]!.path))}
                  />
                ) : null}
                <MenuItem
                  icon={Download}
                  label="Download"
                  onClick={() => close(() => void download(menu.entries))}
                />
                {menu.entries.length === 1 ? (
                  <MenuItem
                    icon={Pencil}
                    label="Rename"
                    onClick={() =>
                      close(() => setDialog({ kind: 'rename', entry: menu.entries[0]! }))
                    }
                  />
                ) : null}
                <MenuItem
                  icon={Copy}
                  label={menu.entries.length === 1 ? 'Copy path' : 'Copy paths'}
                  onClick={() => close(() => copyPath(menu.entries.map((e) => e.path).join('\n')))}
                />
                <div className="menu-sep" />
                <MenuItem
                  icon={FolderPlus}
                  label="New folder"
                  onClick={() => close(() => setDialog({ kind: 'mkdir' }))}
                />
                <MenuItem
                  icon={Trash2}
                  label="Delete"
                  danger
                  onClick={() => close(() => void remove(menu.entries))}
                />
              </>
            ) : (
              <>
                <MenuItem
                  icon={FolderPlus}
                  label="New folder"
                  onClick={() => close(() => setDialog({ kind: 'mkdir' }))}
                />
                <MenuItem
                  icon={Upload}
                  label="Upload files…"
                  onClick={() => close(() => void upload('files'))}
                />
                <MenuItem
                  icon={Upload}
                  label="Upload folder…"
                  onClick={() => close(() => void upload('folder'))}
                />
                <MenuItem
                  icon={Copy}
                  label="Copy path"
                  onClick={() => close(() => copyPath(path))}
                />
                <MenuItem icon={RefreshCw} label="Refresh" onClick={() => close(refresh)} />
              </>
            )
          }
        </ContextMenu>
      ) : null}
      {dialog?.kind === 'mkdir' ? (
        <NameDialog
          title="New folder"
          label="Folder name"
          initial=""
          confirm="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await call('sftp.mkdir', { id, path: joinRemote(path, name) });
            refresh();
          }}
        />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <NameDialog
          title="Rename"
          label="New name"
          initial={dialog.entry.name}
          confirm="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await call('sftp.rename', { id, from: dialog.entry.path, to: joinRemote(path, name) });
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

function EntryIcon({ entry }: { entry: SftpEntryDto }) {
  const props = { size: 16, 'aria-hidden': true, className: 'sftp-icon' } as const;
  if (entry.type === 'directory') return <Folder {...props} className="sftp-icon folder" />;
  if (entry.type === 'symlink') {
    return entry.targetType === 'directory' ? (
      <FolderSymlink {...props} className="sftp-icon folder" />
    ) : (
      <FileSymlink
        {...props}
        className={`sftp-icon ${entry.targetType === 'missing' ? 'broken' : ''}`}
      />
    );
  }
  return <File {...props} />;
}

function PathInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="sftp-path-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <input
        aria-label="Path"
        className="mono"
        value={value}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
    </form>
  );
}

function NameDialog({
  title,
  label,
  initial,
  confirm,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  initial: string;
  confirm: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const action = useAction();
  const trimmed = name.trim();
  const invalid = trimmed === '' || trimmed === '.' || trimmed === '..' || trimmed.includes('/');
  const submit = () =>
    void action.run(async () => {
      await onSubmit(trimmed);
      onClose();
    });
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={action.busy} disabled={invalid} onClick={submit}>
            {confirm}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) submit();
        }}
      >
        <TextField
          label={label}
          value={name}
          onChange={setName}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          maxLength={255}
        />
        {name !== '' && invalid ? (
          <div className="error-text">A name cannot contain “/” or be “.” or “..”.</div>
        ) : null}
        {action.error ? <div className="error-text">{errorMessage(action.error)}</div> : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ContextMenu({
  menu,
  onClose,
  children,
}: {
  menu: Menu;
  onClose: () => void;
  children: (close: (then: () => void) => void) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  // The page re-renders while transfers report progress; the menu must not reset each time.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    const box = ref.current?.getBoundingClientRect();
    if (box) {
      setPosition({
        left: Math.min(menu.x, window.innerWidth - box.width - 8),
        top: Math.min(menu.y, window.innerHeight - box.height - 8),
      });
    }
    ref.current?.querySelector<HTMLElement>('.menu-item')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);
  const close = (then: () => void) => {
    onClose();
    then();
  };
  return (
    <div ref={ref} className="menu sftp-menu" role="menu" style={position}>
      {children(close)}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof Folder;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className={`menu-item ${danger ? 'menu-item-danger' : ''}`}
      role="menuitem"
      onClick={onClick}
    >
      <Icon size={14} aria-hidden />
      {label}
    </button>
  );
}

const isActive = (t: TransferDto) =>
  t.state === 'preparing' || t.state === 'queued' || t.state === 'running';

/**
 * Toasts sit at the bottom left, where this panel is: while it is on screen, its height goes to
 * `--toast-clearance` on the root element and the toasts stay above it.
 */
function useToastClearance(panel: { current: HTMLElement | null }, shown: boolean): void {
  useEffect(() => {
    const el = panel.current;
    if (!shown || !el) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty('--toast-clearance', `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--toast-clearance');
    };
  }, [panel, shown]);
}

function TransfersPanel() {
  const transfers = useStore((s) => s.transfers);
  const sessions = useStore((s) => s.sftpSessions);
  const [open, setOpen] = useState(true);
  const panel = useRef<HTMLElement>(null);
  useToastClearance(panel, transfers.length > 0);
  if (transfers.length === 0) return null;
  const active = transfers.filter(isActive).length;
  const label = (t: TransferDto) => sessions.find((s) => s.id === t.sessionId)?.label ?? '';
  return (
    <section
      ref={panel}
      className="sftp-transfers"
      aria-label="Transfers"
      data-testid="sftp-transfers"
    >
      <header>
        <button
          className="sftp-transfers-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Transfers{active > 0 ? ` · ${active} active` : ''}
        </button>
        <span className="spacer" />
        <Button
          size="sm"
          variant="quiet"
          onClick={() => void call('sftp.clearTransfers').catch(reportError)}
        >
          Clear finished
        </Button>
      </header>
      {open ? (
        <ul>
          {[...transfers].reverse().map((t) => {
            const percent =
              t.total > 0
                ? Math.min(100, (t.transferred / t.total) * 100)
                : t.state === 'done'
                  ? 100
                  : 0;
            const running = isActive(t);
            return (
              <li
                key={t.id}
                className={`sftp-transfer ${t.state}`}
                data-testid={`transfer-${t.name}`}
                data-state={t.state}
              >
                {t.direction === 'upload' ? (
                  <Upload size={14} aria-hidden />
                ) : (
                  <Download size={14} aria-hidden />
                )}
                <div className="sftp-transfer-main">
                  <div className="sftp-transfer-title">
                    <span className="ellipsis" title={t.remotePath}>
                      {t.name}
                    </span>
                    <span className="muted">{label(t)}</span>
                  </div>
                  <div
                    className="sftp-progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(percent)}
                  >
                    <span style={{ width: `${percent}%` }} />
                  </div>
                  <div className="sftp-transfer-meta muted">
                    {t.state === 'running'
                      ? `${formatSize(t.transferred)} of ${formatSize(t.total)}`
                      : t.state === 'done'
                        ? formatSize(t.transferred)
                        : t.state === 'preparing'
                          ? 'Preparing…'
                          : t.state}
                    {t.error ? <span className="error-text"> · {t.error}</span> : null}
                  </div>
                </div>
                {running ? (
                  <IconButton
                    icon={X}
                    size="sm"
                    label={`Cancel ${t.name}`}
                    onClick={() =>
                      void call('sftp.cancelTransfer', { transferId: t.id }).catch(reportError)
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
