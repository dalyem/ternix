import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { hostPayloadSchema, type ItemPayload, type KnownHostPayload } from '@ternix/core/items';
import {
  type CloseReason,
  type HostKeyInfo,
  type KeyboardInteractiveRequest,
  knownHostPayload,
  type PortForwardSpec,
  resolveConnection,
  type ResolvedConnection,
  type SessionHooks,
  type SessionOptions,
  type ShellStream,
  SshSession,
  type Unsubscribe,
} from '@ternix/ssh';
import type {
  AppEventName,
  AppEvents,
  ForwardDto,
  HostKeyDecision,
  KeyboardPromptDto,
  TerminalClosedDto,
  TerminalDto,
} from '../../shared/app.js';
import { BIND_ADDRESS_MESSAGE } from '../../shared/forwards.js';
import type { ItemDraft } from '../../shared/types.js';
import { AppError } from '../app/errors.js';
import type { HostKeyFacts, RouteHop } from '../app/trust.js';
import type { ItemSnapshot } from './items.js';
import { parseQuickTarget } from './quick.js';

export interface SshManagerDeps {
  /** Decrypted items of every readable vault; throws when the vault is locked. */
  snapshot(): ItemSnapshot;
  putItem(vaultId: string, itemId: string | undefined, draft: ItemDraft): Promise<unknown>;
  emit<K extends AppEventName>(name: K, payload: AppEvents[K]): void;
  /** Terminal output for the renderer; false when no window is there to receive it. */
  sendTerminal(id: string, data: Uint8Array): boolean;
  /** Whether a window exists to answer prompts. */
  hasWindow(): boolean;
  /**
   * Ask the user about a host key that is not trusted yet, in a dialog main owns (never the
   * renderer). Aborting `signal` closes the dialog; the answer is then ignored.
   */
  confirmHostKey(facts: HostKeyFacts, signal: AbortSignal): Promise<HostKeyDecision>;
  /**
   * Ask the user, in a dialog main owns, whether to connect to hops without a stored host key.
   * Called before anything goes out on the network (DNS included); false or a rejection denies.
   */
  confirmNewHosts(route: RouteHop[], signal: AbortSignal): Promise<boolean>;
  agentPath: string | undefined;
  createSession?: (options: SessionOptions) => SshSession;
  /** How long a keyboard-interactive prompt waits before it is denied. Default 5 minutes. */
  keyboardTimeoutMs?: number;
}

/** A stored `known_host` item for one of the hops of a connection. */
interface KnownHostRecord {
  vaultId: string;
  itemId: string;
  payload: KnownHostPayload;
}

/**
 * What the hooks of one connection attempt may use after `resolveConnection`: the known hosts
 * of its hops and where to save a new one. Never the whole decrypted vault.
 */
interface TrustContext {
  knownHosts: KnownHostRecord[];
  personalVaultId: string | null;
}

type Source =
  | { kind: 'host'; hostId: string }
  | { kind: 'quick'; target: string; password: string | undefined };

interface Terminal {
  id: string;
  source: Source;
  label: string;
  target: string;
  state: TerminalDto['state'];
  hop: TerminalDto['hop'];
  closed: TerminalClosedDto | undefined;
  exit: TerminalDto['exit'];
  forwards: Map<string, ForwardDto>;
  specs: Map<string, PortForwardSpec>;
  session: SshSession | null;
  shell: ShellStream | null;
  /** Bumped for every connection attempt; events from older attempts are ignored. */
  attempt: number;
  attached: boolean;
  /** A page has shown this terminal's output (a later page starts with a blank display). */
  shown: boolean;
  unsubscribeData: Unsubscribe | null;
  outBuffer: Uint8Array[];
  outBytes: number;
  outTimer: NodeJS.Timeout | null;
  cols: number;
  rows: number;
}

/** A question waiting for the user, bound to the connection attempt that asked it. */
type Pending =
  | {
      /** One of main's native dialogs (new host, host key). */
      kind: 'native';
      terminalId: string;
      attempt: number;
      /** Closes the dialog; the attempt sees the deny answer. */
      cancel: () => void;
    }
  | {
      kind: 'keyboard';
      terminalId: string;
      attempt: number;
      count: number;
      timer: NodeJS.Timeout;
      resolve: (answers: string[] | null) => void;
    };

const OUTPUT_FLUSH_MS = 8;
const KEYBOARD_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_FLUSH_BYTES = 64 * 1024;

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** How hops and `known_host` items are matched, as `checkHostKey` does: host case-insensitive. */
const hopKey = (host: string, port: number) => `${host.toLowerCase()}:${port}`;

function toClosed(reason: CloseReason): TerminalClosedDto {
  if (reason.kind === 'error') {
    return { kind: 'error', message: reason.error.message, code: reason.error.code };
  }
  return { kind: reason.kind };
}

/** Empty means the engine's default, 127.0.0.1. */
function isLocalBindAddress(address: string): boolean {
  const a = address.trim();
  return a === '' || a.toLowerCase() === 'localhost' || isIP(a) !== 0;
}

/**
 * One `SshSession` per terminal tab, in the main process. The renderer sees only tab state
 * (`TerminalDto`), prompts to answer, and the shell's bytes; credentials and keys resolved
 * from the vault stay here.
 */
export class SshManager {
  private readonly terminals = new Map<string, Terminal>();
  private readonly prompts = new Map<string, Pending>();

  constructor(private readonly deps: SshManagerDeps) {}

  list(): TerminalDto[] {
    return [...this.terminals.values()].map((t) => this.toDto(t));
  }

  open(hostId: string, cols: number, rows: number): TerminalDto {
    return this.create({ kind: 'host', hostId }, cols, rows);
  }

  quickConnect(target: string, password: string | undefined, cols: number, rows: number) {
    parseQuickTarget(target); // fail fast, before a tab exists
    return this.create({ kind: 'quick', target, password }, cols, rows);
  }

  private create(source: Source, cols: number, rows: number): TerminalDto {
    const t: Terminal = {
      id: randomUUID(),
      source,
      label: source.kind === 'quick' ? source.target : 'Connecting',
      target: source.kind === 'quick' ? source.target : '',
      state: 'connecting',
      hop: undefined,
      closed: undefined,
      exit: undefined,
      forwards: new Map(),
      specs: new Map(),
      session: null,
      shell: null,
      attempt: 0,
      attached: false,
      shown: false,
      unsubscribeData: null,
      outBuffer: [],
      outBytes: 0,
      outTimer: null,
      cols,
      rows,
    };
    this.terminals.set(t.id, t);
    void this.connect(t);
    return this.toDto(t);
  }

  reconnect(id: string, cols: number, rows: number): TerminalDto {
    const t = this.require(id);
    t.cols = cols;
    t.rows = rows;
    void this.connect(t);
    return this.toDto(t);
  }

  /**
   * Start sending output to the page. `displayReset` when an earlier page showed this shell:
   * the new page's terminal has none of the modes the shell set there (mouse reporting,
   * application cursor keys, the alternate screen), and main does not keep a copy of them.
   */
  attach(id: string): { displayReset: boolean } {
    const t = this.require(id);
    const displayReset = t.shown && t.state === 'ready';
    t.attached = true;
    t.shown = true;
    this.pump(t);
    return { displayReset };
  }

  /**
   * The window is gone (macOS keeps the app running): stop forwarding output. The shells keep
   * buffering, and the next `attach` replays what arrived in the meantime.
   */
  detachAll(): void {
    for (const t of this.terminals.values()) {
      t.attached = false;
      t.unsubscribeData?.();
      t.unsubscribeData = null;
      if (t.outTimer) clearTimeout(t.outTimer);
      t.outTimer = null;
    }
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.shell?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terminals.get(id);
    if (!t) return;
    t.cols = cols;
    t.rows = rows;
    t.shell?.resize(cols, rows);
  }

  async close(id: string): Promise<void> {
    const t = this.terminals.get(id);
    if (!t) return;
    this.terminals.delete(id);
    t.attempt++;
    this.cancelPrompts(t.id);
    this.dropOutput(t);
    await t.session?.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.terminals.keys()].map((id) => this.close(id)));
  }

  async startForward(id: string, forwardId: string): Promise<void> {
    const t = this.require(id);
    const spec = t.specs.get(forwardId);
    if (!spec || !t.session) throw new AppError('invalid_input', 'Unknown port forward');
    try {
      // A local or dynamic forward listens here, and a name would go to DNS unapproved.
      if (spec.kind !== 'remote' && !isLocalBindAddress(spec.bindAddress)) {
        throw new AppError('invalid_input', BIND_ADDRESS_MESSAGE);
      }
      await t.session.startForward(spec);
    } catch (err) {
      this.updateForward(t, forwardId, { state: 'error', error: errMessage(err) });
      throw err;
    }
  }

  async stopForward(id: string, forwardId: string): Promise<void> {
    const t = this.require(id);
    await t.session?.stopForward(forwardId);
  }

  // Prompts

  answerKeyboard(promptId: string, answers: string[] | null): void {
    const pending = this.prompts.get(promptId);
    if (!pending || pending.kind !== 'keyboard') {
      throw new AppError('invalid_input', 'That prompt is no longer waiting for an answer');
    }
    this.prompts.delete(promptId);
    clearTimeout(pending.timer);
    if (answers !== null && answers.length !== pending.count) {
      pending.resolve(null);
      throw new AppError('invalid_input', 'The number of answers does not match the prompts');
    }
    pending.resolve(answers);
  }

  /** Deny every unanswered prompt (the vault locked, the window closed, the user logged out). */
  cancelAllPrompts(): void {
    for (const id of [...this.prompts.keys()]) this.cancelPrompt(id);
  }

  /** Deny the prompts of a terminal's attempts: it failed, closed, or connects again. */
  private cancelPrompts(terminalId: string): void {
    for (const [id, p] of [...this.prompts]) if (p.terminalId === terminalId) this.cancelPrompt(id);
  }

  private cancelPrompt(promptId: string): void {
    const pending = this.prompts.get(promptId);
    if (!pending) return;
    this.prompts.delete(promptId);
    if (pending.kind === 'native') {
      pending.cancel();
      return;
    }
    clearTimeout(pending.timer);
    pending.resolve(null);
    this.deps.emit('ssh.prompt-cancelled', { promptId });
  }

  /**
   * Open one of main's native dialogs for an attempt. Closing, failing or reconnecting the tab
   * aborts it, and the answer is then `denied` whatever the user clicked.
   */
  private askNative<T>(
    t: Terminal,
    attempt: number,
    ask: (signal: AbortSignal) => Promise<T>,
    denied: T,
  ): Promise<T> {
    if (!this.deps.hasWindow()) return Promise.resolve(denied);
    const promptId = randomUUID();
    const abort = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const settle = (answer: T) => {
        if (settled) return;
        settled = true;
        this.prompts.delete(promptId);
        resolve(abort.signal.aborted ? denied : answer);
      };
      this.prompts.set(promptId, {
        kind: 'native',
        terminalId: t.id,
        attempt,
        cancel: () => {
          abort.abort();
          settle(denied);
        },
      });
      ask(abort.signal).then(settle, () => settle(denied));
    });
  }

  /** Main's own dialog decides; the renderer only sees the tab's `verifying-host-key` state. */
  private askHostKey(t: Terminal, attempt: number, info: HostKeyInfo): Promise<HostKeyDecision> {
    if (info.status === 'trusted') return Promise.resolve('reject');
    const facts: HostKeyFacts = {
      hopLabel: info.hop.label,
      hopIndex: info.hop.index,
      hopTotal: info.hop.total,
      host: info.host,
      port: info.port,
      keyType: info.keyType,
      fingerprint: info.fingerprint,
      status: info.status,
      ...(info.stored
        ? { stored: { keyType: info.stored.keyType, fingerprint: info.stored.fingerprint } }
        : {}),
    };
    return this.askNative<HostKeyDecision>(
      t,
      attempt,
      (signal) => this.deps.confirmHostKey(facts, signal),
      'reject',
    );
  }

  private askKeyboard(
    t: Terminal,
    attempt: number,
    request: KeyboardInteractiveRequest,
  ): Promise<string[]> {
    if (!this.deps.hasWindow()) return Promise.reject(new Error('No window to ask'));
    const promptId = randomUUID();
    const prompt: KeyboardPromptDto = {
      kind: 'keyboard',
      promptId,
      sessionId: t.id,
      hopLabel: request.hop.label,
      name: request.name,
      instructions: request.instructions,
      prompts: request.prompts.map((p) => ({ prompt: p.prompt, echo: p.echo })),
    };
    return new Promise((resolve, reject) => {
      // Nobody answering is a no: the hop's own timers are paused while the user is asked.
      const timer = setTimeout(
        () => this.cancelPrompt(promptId),
        this.deps.keyboardTimeoutMs ?? KEYBOARD_TIMEOUT_MS,
      );
      timer.unref?.();
      this.prompts.set(promptId, {
        kind: 'keyboard',
        terminalId: t.id,
        attempt,
        count: request.prompts.length,
        timer,
        resolve: (answers) => (answers ? resolve(answers) : reject(new Error('Cancelled'))),
      });
      this.deps.emit('ssh.prompt', prompt);
    });
  }

  /** Remember a key the user trusted: a new `known_host` item in the personal vault. */
  private async rememberHostKey(
    info: HostKeyInfo,
    decision: HostKeyDecision,
    trust: TrustContext,
  ): Promise<void> {
    const { updated_at: _ignored, ...draft } = knownHostPayload({
      host: info.host,
      port: info.port,
      keyType: info.keyType,
      keyB64: info.key,
    });
    if (info.status === 'mismatch' && decision === 'replace' && info.stored) {
      const stored = info.stored;
      for (const record of trust.knownHosts) {
        const p = record.payload;
        if (
          p.host.toLowerCase() === info.host.toLowerCase() &&
          p.port === info.port &&
          p.key_type === stored.keyType &&
          p.public_key === stored.key
        ) {
          try {
            await this.deps.putItem(record.vaultId, record.itemId, draft as ItemDraft);
            return;
          } catch {
            break; // for example a viewer in a shared vault: save a personal entry instead
          }
        }
      }
    }
    if (!trust.personalVaultId) throw new Error('No personal vault to save the host key in');
    await this.deps.putItem(trust.personalVaultId, undefined, draft as ItemDraft);
  }

  // Connection

  private async connect(t: Terminal): Promise<void> {
    const attempt = ++t.attempt;
    const previous = t.session;
    const previousShell = t.shell;
    t.session = null;
    t.shell = null;
    t.exit = undefined;
    t.closed = undefined;
    t.state = 'connecting';
    t.hop = undefined;
    this.cancelPrompts(t.id);
    this.dropOutput(t);
    previousShell?.close();
    void previous?.close();
    const current = () => t.attempt === attempt && this.terminals.has(t.id);

    // Credentials stay in `settings` only until the session has signed in.
    let settings: ResolvedConnection | undefined;
    let trust: TrustContext;
    try {
      ({ settings, trust } = this.prepare(t));
    } catch (err) {
      if (current()) this.fail(t, err);
      return;
    }
    t.label = settings.label;
    t.target = `${settings.username}@${settings.address}:${settings.port}`;
    t.specs = new Map(settings.portForwards.map((p) => [p.id, p]));
    t.forwards = new Map(
      settings.portForwards.map((p) => [
        p.id,
        {
          id: p.id,
          label: p.label,
          kind: p.kind,
          bindAddress: p.bindAddress,
          bindPort: p.bindPort,
          ...(p.destHost !== undefined ? { destHost: p.destHost } : {}),
          ...(p.destPort !== undefined ? { destPort: p.destPort } : {}),
          state: 'idle',
          connections: 0,
        } satisfies ForwardDto,
      ]),
    );

    // An address without a stored host key is approved in main's dialog before anything is
    // sent, DNS lookup included: the name itself could carry data out.
    const known = new Set(trust.knownHosts.map((r) => hopKey(r.payload.host, r.payload.port)));
    const route: RouteHop[] = [...settings.jumpChain, settings].map((hop) => ({
      host: hop.address,
      port: hop.port,
      isNew: !known.has(hopKey(hop.address, hop.port)),
    }));
    if (route.some((hop) => hop.isNew)) {
      this.publish(t);
      const approved = await this.askNative(
        t,
        attempt,
        (signal) => this.deps.confirmNewHosts(route, signal),
        false,
      );
      if (!current()) return;
      if (!approved) {
        settings = undefined;
        this.fail(
          t,
          new AppError(
            'not_approved',
            'Connection not approved. Nothing was sent to the new host.',
          ),
        );
        return;
      }
    }

    const options: SessionOptions = {
      knownHosts: trust.knownHosts.map((r) => r.payload),
      ...(this.deps.agentPath ? { agentPath: this.deps.agentPath } : {}),
    };
    const session = (this.deps.createSession ?? ((o) => new SshSession(o)))(options);
    t.session = session;
    session.onStatus((status) => {
      if (!current() || t.session !== session) return;
      if (status.state === 'idle') return;
      if (status.state === 'closed') {
        this.cancelPrompts(t.id);
        t.state = 'closed';
        t.hop = undefined;
        t.closed ??= toClosed(status.reason);
        for (const f of t.forwards.values()) if (f.state === 'active') f.state = 'stopped';
      } else if (status.state === 'ready') {
        // The tab reads `ready` once the shell is open (see below), so typing never goes nowhere.
        return;
      } else {
        t.state = status.state;
        t.hop = { label: status.hop.label, index: status.hop.index, total: status.hop.total };
      }
      this.publish(t);
    });
    session.onForwardStatus((f) => {
      if (!current() || t.session !== session) return;
      this.updateForward(t, f.id, {
        state: f.state,
        connections: f.connections,
        ...(f.boundAddress !== undefined ? { boundAddress: f.boundAddress } : {}),
        ...(f.boundPort !== undefined ? { boundPort: f.boundPort } : {}),
        ...(f.error !== undefined ? { error: f.error } : {}),
      });
    });
    this.publish(t);

    const live = () => current() && t.session === session;
    const hooks: SessionHooks = {
      verifyHostKey: async (info) => {
        if (info.status === 'trusted') return true;
        const decision = await this.askHostKey(t, attempt, info);
        // The tab may have closed or reconnected while the dialog was open.
        if (!live() || decision === 'reject') return false;
        // A changed key is only accepted by the explicit "replace" answer.
        if (info.status === 'mismatch' && decision !== 'replace') return false;
        try {
          await this.rememberHostKey(info, decision, trust);
        } catch (err) {
          this.deps.emit('ssh.notice', {
            sessionId: t.id,
            level: 'warning',
            message: `The host key was accepted but could not be saved (${errMessage(err)}); you will be asked again next time.`,
          });
        }
        return live();
      },
      keyboardInteractive: (request) => this.askKeyboard(t, attempt, request),
      onBanner: (message) => this.sendBanner(t, message),
      onWarning: (message) =>
        this.deps.emit('ssh.notice', { sessionId: t.id, level: 'warning', message }),
    };

    try {
      const signingIn = session.connect(settings, hooks);
      settings = undefined;
      await signingIn;
      if (!live()) {
        void session.close();
        return;
      }
      // A typed quick-connect password is not kept for reconnecting: the next attempt signs in
      // with keyboard-interactive, if the server offers it (the engine never uses the agent to
      // sign in).
      if (t.source.kind === 'quick' && t.source.password !== undefined) {
        t.source = { kind: 'quick', target: t.source.target, password: undefined };
      }
      const shell = await session.openShell({ cols: t.cols, rows: t.rows });
      if (!live()) {
        shell.close();
        void session.close();
        return;
      }
      t.shell = shell;
      t.state = 'ready';
      t.hop = undefined;
      shell.onExit((exit) => {
        if (t.shell !== shell) return;
        this.flushOutput(t);
        t.exit = {
          ...(exit.code !== undefined ? { code: exit.code } : {}),
          ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
        };
        this.publish(t);
        void session.close();
      });
      this.pump(t);
      this.publish(t);
    } catch (err) {
      // Signed in but no shell (or any other late failure): end this attempt's connection,
      // its prompts and its output before the tab reads closed.
      void session.close();
      if (!live()) return;
      this.cancelPrompts(t.id);
      this.flushOutput(t);
      this.dropOutput(t);
      this.fail(t, err);
    }
  }

  /**
   * Resolve the connection from a snapshot of every decrypted item, and keep only what the
   * attempt needs later: the known hosts of its hops and the personal vault. The snapshot
   * itself is dropped when this returns.
   */
  private prepare(t: Terminal): { settings: ResolvedConnection; trust: TrustContext } {
    const snapshot = this.deps.snapshot();
    const settings = this.resolve(t, snapshot);
    const hops = new Set([...settings.jumpChain, settings].map((h) => hopKey(h.address, h.port)));
    const knownHosts: KnownHostRecord[] = [];
    for (const record of snapshot.records.values()) {
      const p = record.payload;
      if (p.type === 'known_host' && hops.has(hopKey(p.host, p.port))) {
        knownHosts.push({ vaultId: record.vaultId, itemId: record.itemId, payload: p });
      }
    }
    return { settings, trust: { knownHosts, personalVaultId: snapshot.personalVaultId } };
  }

  private resolve(t: Terminal, snapshot: ItemSnapshot): ResolvedConnection {
    if (t.source.kind === 'host') return resolveConnection(snapshot.lookup, t.source.hostId);
    const { username, host, port } = parseQuickTarget(t.source.target);
    const hostId = randomUUID();
    const lookup = new Map<string, ItemPayload>(snapshot.lookup);
    lookup.set(
      hostId,
      hostPayloadSchema.parse({
        type: 'host',
        updated_at: new Date().toISOString(),
        label: t.source.target,
        address: host,
        port,
        username,
        ...(t.source.password ? { password: t.source.password } : {}),
      }),
    );
    return resolveConnection(lookup, hostId);
  }

  private fail(t: Terminal, err: unknown): void {
    this.cancelPrompts(t.id);
    const code = (err as { code?: unknown } | null)?.code;
    t.state = 'closed';
    t.hop = undefined;
    t.closed = {
      kind: 'error',
      message: errMessage(err),
      ...(typeof code === 'string' ? { code } : {}),
    };
    this.publish(t);
  }

  private sendBanner(t: Terminal, message: string): void {
    this.queueOutput(t, new TextEncoder().encode(`${message.replace(/\r?\n/g, '\r\n')}\r\n`));
  }

  // Terminal output

  /** Start forwarding shell output once the renderer is listening and the shell exists. */
  private pump(t: Terminal): void {
    if (!t.attached || !t.shell) return;
    t.unsubscribeData?.();
    t.unsubscribeData = t.shell.onData((bytes) => this.queueOutput(t, bytes));
    this.flushOutput(t);
  }

  /** Coalesce small chunks so a flood of output is a few IPC messages, not thousands. */
  private queueOutput(t: Terminal, bytes: Uint8Array): void {
    t.outBuffer.push(bytes);
    t.outBytes += bytes.length;
    if (!t.attached) return;
    if (t.outBytes >= OUTPUT_FLUSH_BYTES) return this.flushOutput(t);
    t.outTimer ??= setTimeout(() => this.flushOutput(t), OUTPUT_FLUSH_MS);
  }

  private flushOutput(t: Terminal): void {
    if (t.outTimer) clearTimeout(t.outTimer);
    t.outTimer = null;
    if (t.outBytes === 0 || !t.attached) return;
    const out = new Uint8Array(t.outBytes);
    let offset = 0;
    for (const chunk of t.outBuffer) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    t.outBuffer = [];
    t.outBytes = 0;
    this.deps.sendTerminal(t.id, out);
  }

  private dropOutput(t: Terminal): void {
    if (t.outTimer) clearTimeout(t.outTimer);
    t.outTimer = null;
    t.outBuffer = [];
    t.outBytes = 0;
    t.unsubscribeData?.();
    t.unsubscribeData = null;
  }

  // State

  private require(id: string): Terminal {
    const t = this.terminals.get(id);
    if (!t) throw new AppError('invalid_input', 'That terminal no longer exists');
    return t;
  }

  private updateForward(t: Terminal, forwardId: string, patch: Partial<ForwardDto>): void {
    const current = t.forwards.get(forwardId);
    if (!current) return;
    const next: ForwardDto = { ...current, ...patch };
    // `error` clears when a later status carries none.
    if (!('error' in patch)) delete next.error;
    t.forwards.set(forwardId, next);
    this.publish(t);
  }

  private publish(t: Terminal): void {
    if (this.terminals.has(t.id)) this.deps.emit('ssh.status', this.toDto(t));
  }

  private toDto(t: Terminal): TerminalDto {
    return {
      id: t.id,
      hostId: t.source.kind === 'host' ? t.source.hostId : null,
      label: t.label,
      target: t.target,
      state: t.state,
      ...(t.hop ? { hop: t.hop } : {}),
      ...(t.closed ? { closed: t.closed } : {}),
      ...(t.exit ? { exit: t.exit } : {}),
      forwards: [...t.forwards.values()],
    };
  }
}
