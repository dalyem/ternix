import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ForwardDto, TerminalDto } from '../../shared/app.js';
import { call } from './api.js';
import { byLabel, itemsOfType, vaultTitle } from './items.js';
import {
  closeTerminal,
  openEditor,
  reconnectTerminal,
  reportError,
  toast,
  useStore,
} from './store.js';
import { Badge, Button, EmptyState } from './ui.js';

const isMac = navigator.userAgent.includes('Mac');
const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace';
const WRITE_CHUNK = 32 * 1024;

const THEME = {
  background: '#0d0f12',
  foreground: '#d6dae1',
  cursor: '#8ab4ff',
  selectionBackground: '#33466e',
  black: '#1b1e24',
  brightBlack: '#5b6270',
};

/** Send terminal input to the remote shell, in pieces the IPC limits accept. */
function sendInput(id: string, data: string): void {
  for (let i = 0; i < data.length; i += WRITE_CHUNK) {
    call('ssh.write', { id, data: data.slice(i, i + WRITE_CHUNK) }).catch(() => undefined);
  }
}

/** Snippet text as typed input: terminals take carriage returns for Enter. */
function asInput(script: string): string {
  return script.replace(/\r\n|\n/g, '\r');
}

interface Handle {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
}

function statusText(t: TerminalDto): string {
  switch (t.state) {
    case 'connecting':
      return t.hop && t.hop.total > 1
        ? `Connecting to ${t.hop.label} (${t.hop.index + 1} of ${t.hop.total})…`
        : 'Connecting…';
    case 'verifying-host-key':
      return 'Waiting for you to verify the host key…';
    case 'authenticating':
      return t.hop && t.hop.total > 1
        ? `Signing in to ${t.hop.label} (${t.hop.index + 1} of ${t.hop.total})…`
        : 'Signing in…';
    case 'ready':
      return 'Connected';
    case 'closed':
      if (t.closed?.kind === 'error') return t.closed.message ?? 'Connection failed';
      if (t.exit)
        return `Session ended${t.exit.code !== undefined ? ` (exit ${t.exit.code})` : ''}`;
      return t.closed?.kind === 'remote' ? 'Connection closed by the server' : 'Disconnected';
  }
}

function TerminalPane({
  dto,
  active,
  fontSize,
  panel,
  onPanel,
}: {
  dto: TerminalDto;
  active: boolean;
  fontSize: number;
  panel: 'snippets' | 'forwards' | null;
  onPanel: (panel: 'snippets' | 'forwards' | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const lastNotice = useRef<string>('');
  const id = dto.id;

  const fitNow = useCallback(() => {
    const c = containerRef.current;
    if (!c || c.offsetParent === null || !handle.current) return;
    try {
      handle.current.fit.fit();
    } catch {
      // Not laid out yet.
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize,
      cursorBlink: true,
      scrollback: 10_000,
      theme: THEME,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        call('shell.openLink', { url: uri }).catch(reportError);
      }),
    );
    term.open(container);
    handle.current = { term, fit, search };

    const copySelection = () => {
      const text = term.getSelection();
      if (text === '') return false;
      call('clipboard.write', { text }).catch(reportError);
      return true;
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const key = e.key.toLowerCase();
      if (key === 'f' && (isMac ? e.metaKey : e.ctrlKey && e.shiftKey)) {
        setSearching(true);
        return false;
      }
      if (key === 'c') {
        // Mac: Cmd+C. Elsewhere Ctrl+Shift+C always copies; plain Ctrl+C copies only with a
        // selection and otherwise stays the interrupt key.
        const copyCombo = isMac ? e.metaKey : e.ctrlKey && (e.shiftKey || term.hasSelection());
        if (copyCombo) {
          if (copySelection()) term.clearSelection();
          return false;
        }
      }
      // Paste is the browser's own paste event (no clipboard permission needed).
      if (key === 'v' && (isMac ? e.metaKey : e.ctrlKey)) return false;
      return true;
    });

    const offData = window.ternix.onTerminalData(id, (bytes) => term.write(bytes));
    const onInput = term.onData((data) => sendInput(id, data));
    const onSize = term.onResize(({ cols, rows }) => {
      call('ssh.resize', { id, cols, rows }).catch(() => undefined);
    });
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(container);
    fitNow();
    call('ssh.resize', { id, cols: term.cols, rows: term.rows }).catch(() => undefined);
    // Subscribe first, then ask for the output so far: nothing is lost in between.
    call('ssh.attach', { id }).catch(reportError);

    return () => {
      observer.disconnect();
      offData();
      onInput.dispose();
      onSize.dispose();
      term.dispose();
      handle.current = null;
    };
    // The terminal is created once per session; font size is applied separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.term.options.fontSize = fontSize;
    fitNow();
  }, [fontSize, fitNow]);

  useEffect(() => {
    if (!active) return;
    fitNow();
    handle.current?.term.focus();
  }, [active, panel, fitNow]);

  // Notes in the scrollback for the moments a session ends or starts again.
  useEffect(() => {
    const term = handle.current?.term;
    if (!term) return;
    const marker = `${dto.state}:${dto.closed?.kind ?? ''}:${dto.exit ? 'exit' : ''}`;
    if (marker === lastNotice.current) return;
    const previous = lastNotice.current;
    lastNotice.current = marker;
    if (dto.state === 'closed') {
      term.write(`\r\n\x1b[2m[${statusText(dto)}]\x1b[0m\r\n`);
    } else if (dto.state === 'connecting' && previous.startsWith('closed')) {
      term.write('\r\n\x1b[2m[Reconnecting…]\x1b[0m\r\n');
    }
  }, [dto]);

  const find = (direction: 'next' | 'previous') => {
    const h = handle.current;
    if (!h || query === '') return;
    if (direction === 'next') h.search.findNext(query, { incremental: false });
    else h.search.findPrevious(query);
  };

  const showBanner = dto.state !== 'ready';

  return (
    <div className="terminal-pane" style={{ display: active ? 'flex' : 'none' }}>
      <div className="terminal-toolbar">
        <div className="terminal-title">
          <strong>{dto.label}</strong>
          <span className="muted mono"> {dto.target}</span>
        </div>
        <span className="spacer" />
        <Button variant="ghost" onClick={() => setSearching((s) => !s)}>
          Search
        </Button>
        <Button
          variant="ghost"
          aria-pressed={panel === 'snippets'}
          onClick={() => onPanel(panel === 'snippets' ? null : 'snippets')}
        >
          Snippets
        </Button>
        <Button
          variant="ghost"
          aria-pressed={panel === 'forwards'}
          onClick={() => onPanel(panel === 'forwards' ? null : 'forwards')}
        >
          Forwards{dto.forwards.length > 0 ? ` (${dto.forwards.length})` : ''}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            const text = handle.current?.term.getSelection() ?? '';
            if (text) call('clipboard.write', { text }).catch(reportError);
            else toast('Select some text first.', 'info');
          }}
        >
          Copy
        </Button>
      </div>
      {showBanner ? (
        <div
          className={`terminal-banner ${dto.state === 'closed' && dto.closed?.kind === 'error' ? 'error' : ''}`}
          data-testid="terminal-status"
        >
          <span>{statusText(dto)}</span>
          <span className="spacer" />
          {dto.state === 'closed' ? (
            <>
              <Button
                variant="primary"
                onClick={() => {
                  const t = handle.current?.term;
                  void reconnectTerminal(id, t?.cols ?? 120, t?.rows ?? 32);
                }}
              >
                Reconnect
              </Button>
              <Button onClick={() => void closeTerminal(id)}>Close tab</Button>
            </>
          ) : null}
        </div>
      ) : null}
      {searching ? (
        <form
          className="terminal-search"
          onSubmit={(e) => {
            e.preventDefault();
            find('next');
          }}
        >
          <input
            autoFocus
            aria-label="Search terminal"
            placeholder="Search scrollback"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearching(false);
                handle.current?.term.focus();
              }
            }}
          />
          <Button onClick={() => find('previous')}>Prev</Button>
          <Button type="submit">Next</Button>
          <Button variant="ghost" onClick={() => setSearching(false)}>
            ✕
          </Button>
        </form>
      ) : null}
      <div className="terminal-body">
        <div ref={containerRef} className="terminal-container" data-testid="terminal" />
        {active && panel === 'snippets' ? <SnippetsPanel dto={dto} /> : null}
        {active && panel === 'forwards' ? <ForwardsPanel dto={dto} /> : null}
      </div>
    </div>
  );
}

function SnippetsPanel({ dto }: { dto: TerminalDto }) {
  const items = useStore((s) => s.items);
  const vaultById = useStore((s) => s.vaultById);
  const snippets = itemsOfType(items, 'snippet').sort(byLabel);
  const ready = dto.state === 'ready';
  return (
    <aside className="side-panel" aria-label="Snippets">
      <h3>Snippets</h3>
      {snippets.length === 0 ? <EmptyState>No snippets yet.</EmptyState> : null}
      {snippets.map((s) => (
        <div key={s.id} className="snippet">
          <div className="snippet-title">
            {s.payload.label}
            {vaultById.get(s.vaultId)?.kind === 'shared' ? (
              <Badge tone="accent">{vaultTitle(vaultById.get(s.vaultId))}</Badge>
            ) : null}
          </div>
          <pre className="snippet-preview">{s.payload.script.slice(0, 200)}</pre>
          <div className="row">
            <Button
              disabled={!ready}
              onClick={() => sendInput(dto.id, asInput(s.payload.script))}
              title="Type the script into the terminal without running it"
            >
              Paste
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              onClick={() => sendInput(dto.id, asInput(s.payload.script) + '\r')}
            >
              Run
            </Button>
          </div>
        </div>
      ))}
    </aside>
  );
}

function ForwardRow({ dto, forward }: { dto: TerminalDto; forward: ForwardDto }) {
  const [busy, setBusy] = useState(false);
  const running = forward.state === 'active' || forward.state === 'starting';
  const toggle = async () => {
    setBusy(true);
    try {
      await call(running ? 'ssh.forward.stop' : 'ssh.forward.start', {
        id: dto.id,
        forwardId: forward.id,
      });
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const listen =
    forward.boundPort !== undefined
      ? `${forward.boundAddress ?? forward.bindAddress}:${forward.boundPort}`
      : `${forward.bindAddress}:${forward.bindPort}`;
  const tone = forward.state === 'active' ? 'good' : forward.state === 'error' ? 'bad' : 'neutral';
  return (
    <div className="snippet" data-testid={`forward-${forward.label}`}>
      <div className="snippet-title">
        {forward.label} <Badge tone={tone}>{forward.state}</Badge>
      </div>
      <div className="muted mono">
        {forward.kind}: {listen}
        {forward.destHost ? ` → ${forward.destHost}:${forward.destPort}` : ''}
      </div>
      {forward.state === 'active' ? (
        <div className="muted">{forward.connections} connection(s)</div>
      ) : null}
      {forward.error ? <div className="error-text">{forward.error}</div> : null}
      <div className="row">
        <Button
          variant={running ? 'default' : 'primary'}
          busy={busy}
          disabled={dto.state !== 'ready'}
          onClick={() => void toggle()}
        >
          {running ? 'Stop' : 'Start'}
        </Button>
      </div>
    </div>
  );
}

function ForwardsPanel({ dto }: { dto: TerminalDto }) {
  return (
    <aside className="side-panel" aria-label="Port forwards">
      <h3>Port forwards</h3>
      {dto.forwards.length === 0 ? (
        <EmptyState>No port forwards are set up for this host.</EmptyState>
      ) : null}
      {dto.forwards.map((f) => (
        <ForwardRow key={f.id} dto={dto} forward={f} />
      ))}
      {dto.hostId ? (
        <>
          <Button
            onClick={() => openEditor({ type: 'port_forward', preset: { host_id: dto.hostId! } })}
          >
            New port forward for this host
          </Button>
          <div className="hint">New forwards appear here after you reconnect.</div>
        </>
      ) : null}
    </aside>
  );
}

/** All terminal panes stay mounted so scrollback survives switching tabs. */
export function TerminalHost() {
  const terminals = useStore((s) => s.terminals);
  const activeTab = useStore((s) => s.activeTab);
  const fontSize = useStore((s) => s.settings.terminalFontSize);
  const [panels, setPanels] = useState<Record<string, 'snippets' | 'forwards' | null>>({});
  return (
    <div className="terminal-host" style={{ display: activeTab ? 'flex' : 'none' }}>
      {terminals.map((t) => (
        <TerminalPane
          key={t.id}
          dto={t}
          active={t.id === activeTab}
          fontSize={fontSize}
          panel={panels[t.id] ?? null}
          onPanel={(panel) => setPanels((p) => ({ ...p, [t.id]: panel }))}
        />
      ))}
    </div>
  );
}
