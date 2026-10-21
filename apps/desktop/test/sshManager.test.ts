import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostOs, ItemPayload } from '@ternix/core/items';
import type { VaultRole } from '@ternix/core/protocol';
import type {
  HostKeyInfo,
  KeyboardInteractiveRequest,
  ResolvedConnection,
  SessionHooks,
  SessionOptions,
  SessionStatus,
  ShellStream,
  SshSession,
} from '@ternix/ssh';
import type { AppEventName, AppEvents, HostKeyDecision } from '../src/shared/app.js';
import type { ItemDraft } from '../src/shared/types.js';
import type { HostKeyFacts, RouteHop } from '../src/main/app/trust.js';
import type { TernixClient } from '../src/main/client/index.js';
import { type ItemSnapshot, snapshotItems } from '../src/main/ssh/items.js';
import { SshManager, type SshManagerDeps } from '../src/main/ssh/manager.js';
import { looksLikeLocalBindAddress } from '../src/shared/forwards.js';
import {
  closeClients,
  deferred,
  HOUR,
  loginUser,
  registerUser,
  startServer,
  type TestServer,
  waitFor,
} from './helpers.js';

const HOST_ID = '3f1c9a52-8e6b-4d0a-9b7e-0a1b2c3d4e5f';
const PERSONAL = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const now = new Date().toISOString();

const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIA==';
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIQ==';

function snapshotWith(extra: [string, ItemPayload][] = []): ItemSnapshot {
  const entries: [string, ItemPayload][] = [
    [
      HOST_ID,
      {
        type: 'host',
        schema: 1,
        updated_at: now,
        label: 'box',
        address: 'box.example.com',
        port: 22,
        username: 'me',
        password: 'pw-SECRET',
        tags: [],
        agent_forwarding: false,
      },
    ],
    ...extra,
  ];
  return {
    lookup: new Map(entries),
    records: new Map(
      entries.map(([id, payload]) => [id, { vaultId: PERSONAL, itemId: id, seq: 1, payload }]),
    ),
    personalVaultId: PERSONAL,
  };
}

const knownHost = (host: string, key: string): ItemPayload => ({
  type: 'known_host',
  schema: 1,
  updated_at: now,
  host,
  port: 22,
  key_type: 'ssh-ed25519',
  public_key: key,
});

/** A scripted `SshSession`: the test drives `connect` and sees what the manager calls. */
class FakeSession {
  hooks: SessionHooks | undefined;
  settings: ResolvedConnection | undefined;
  readonly connected = deferred();
  readonly closed = vi.fn(async () => {
    this.emit({ state: 'closed', reason: { kind: 'requested' } });
  });
  openShell = vi.fn(async (): Promise<ShellStream> => {
    throw Object.assign(new Error('Cannot open a shell: refused'), { code: 'channel_failed' });
  });
  private readonly statusListeners = new Set<(s: SessionStatus) => void>();
  constructor(readonly options: SessionOptions) {}
  onStatus(listener: (s: SessionStatus) => void) {
    this.statusListeners.add(listener);
    return () => void this.statusListeners.delete(listener);
  }
  onForwardStatus() {
    return () => undefined;
  }
  startForward = vi.fn(async () => undefined);
  detectOs = vi.fn(async (): Promise<HostOs | undefined> => undefined);
  emit(status: SessionStatus) {
    for (const l of [...this.statusListeners]) l(status);
  }
  async connect(settings: ResolvedConnection, hooks: SessionHooks) {
    this.settings = settings;
    this.hooks = hooks;
    await this.connected.promise;
  }
  close() {
    return this.closed();
  }
}

const hostKey = (status: HostKeyInfo['status'], key = KEY_B): HostKeyInfo => ({
  hop: { index: 0, total: 1, label: 'box', host: 'box.example.com', port: 22, isTarget: true },
  host: 'box.example.com',
  port: 22,
  keyType: 'ssh-ed25519',
  key,
  fingerprint: 'SHA256:new',
  status,
  ...(status === 'mismatch'
    ? { stored: { keyType: 'ssh-ed25519', key: KEY_A, fingerprint: 'SHA256:old' } }
    : {}),
});

const keyboard: KeyboardInteractiveRequest = {
  hop: { index: 0, total: 1, label: 'box', host: 'box.example.com', port: 22, isTarget: true },
  name: '',
  instructions: '',
  prompts: [{ prompt: 'Code:', echo: false }],
};

function setup(
  options: {
    snapshot?: ItemSnapshot | (() => ItemSnapshot);
    confirm?: (facts: HostKeyFacts, signal: AbortSignal) => Promise<HostKeyDecision>;
    /** The "Connect to a new host?" dialog; approves by default. */
    confirmNew?: (route: RouteHop[], signal: AbortSignal) => Promise<boolean>;
    keyboardTimeoutMs?: number;
    detectHostOs?: () => boolean;
    vaultRole?: (vaultId: string) => VaultRole | undefined;
    putItem?: SshManagerDeps['putItem'];
    pullVault?: SshManagerDeps['pullVault'];
    accountId?: () => string | undefined;
  } = {},
) {
  const sessions: FakeSession[] = [];
  const events: { name: AppEventName; payload: unknown }[] = [];
  const putItem = vi.fn<SshManagerDeps['putItem']>(options.putItem ?? (async () => ({})));
  const log = vi.fn();
  const confirmHostKey = vi.fn(options.confirm ?? (async () => 'reject' as HostKeyDecision));
  const confirmNewHosts = vi.fn(options.confirmNew ?? (async () => true));
  const manager = new SshManager({
    snapshot: () =>
      typeof options.snapshot === 'function'
        ? options.snapshot()
        : (options.snapshot ?? snapshotWith()),
    putItem,
    emit: <K extends AppEventName>(name: K, payload: AppEvents[K]) =>
      void events.push({ name, payload }),
    sendTerminal: () => true,
    hasWindow: () => true,
    confirmHostKey,
    confirmNewHosts,
    agentPath: undefined,
    createSession: (o) => {
      const s = new FakeSession(o);
      sessions.push(s);
      return s as unknown as SshSession;
    },
    ...(options.keyboardTimeoutMs !== undefined
      ? { keyboardTimeoutMs: options.keyboardTimeoutMs }
      : {}),
    ...(options.detectHostOs ? { detectHostOs: options.detectHostOs } : {}),
    ...(options.vaultRole ? { vaultRole: options.vaultRole } : {}),
    ...(options.pullVault ? { pullVault: options.pullVault } : {}),
    ...(options.accountId ? { accountId: options.accountId } : {}),
    log,
  });
  const session = async (index = 0) => {
    await vi.waitFor(() => expect(sessions[index]?.hooks).toBeDefined());
    return sessions[index]!;
  };
  return { manager, sessions, session, events, putItem, log, confirmHostKey, confirmNewHosts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SshManager host keys', () => {
  it('asks main’s dialog, saves the key only when it approves', async () => {
    const { manager, session, putItem, confirmHostKey } = setup({ confirm: async () => 'trust' });
    manager.open(HOST_ID, 80, 24);
    const s = await session();
    expect(await s.hooks!.verifyHostKey!(hostKey('unknown'))).toBe(true);
    expect(confirmHostKey).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'box.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:new',
        status: 'unknown',
      }),
      expect.any(AbortSignal),
    );
    expect(putItem).toHaveBeenCalledWith(
      PERSONAL,
      undefined,
      expect.objectContaining({ type: 'known_host', host: 'box.example.com', public_key: KEY_B }),
    );
  });

  it('a declined dialog rejects the key and saves nothing', async () => {
    const { manager, session, putItem } = setup({ confirm: async () => 'reject' });
    manager.open(HOST_ID, 80, 24);
    const s = await session();
    expect(await s.hooks!.verifyHostKey!(hostKey('unknown'))).toBe(false);
    // A changed key needs the explicit replace answer, not trust.
    expect(await s.hooks!.verifyHostKey!(hostKey('mismatch'))).toBe(false);
    expect(putItem).not.toHaveBeenCalled();
  });

  it('a changed key accepted with replace overwrites the stored entry of the hop', async () => {
    const otherId = 'aaaaaaaa-8e6b-4d0a-9b7e-0a1b2c3d4e5f';
    const storedId = 'bbbbbbbb-8e6b-4d0a-9b7e-0a1b2c3d4e5f';
    const { manager, sessions, session, putItem } = setup({
      snapshot: snapshotWith([
        [storedId, knownHost('box.example.com', KEY_A)],
        [otherId, knownHost('unrelated.example.com', KEY_A)],
      ]),
      confirm: async () => 'replace',
    });
    manager.open(HOST_ID, 80, 24);
    const s = await session();
    // Only the hop's own known hosts reach the session.
    expect(sessions[0]!.options.knownHosts).toEqual([knownHost('box.example.com', KEY_A)]);
    expect(await s.hooks!.verifyHostKey!(hostKey('mismatch'))).toBe(true);
    expect(putItem).toHaveBeenCalledWith(
      PERSONAL,
      storedId,
      expect.objectContaining({ type: 'known_host', public_key: KEY_B }),
    );
  });

  it('an answer that arrives after the tab closed is ignored', async () => {
    const answer = deferred<HostKeyDecision>();
    let signal: AbortSignal | undefined;
    const { manager, session, putItem } = setup({
      confirm: (_facts, s) => {
        signal = s;
        return answer.promise;
      },
    });
    const tab = manager.open(HOST_ID, 80, 24);
    const s = await session();
    const verdict = s.hooks!.verifyHostKey!(hostKey('unknown'));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await manager.close(tab.id);
    expect(signal!.aborted).toBe(true); // the native dialog is closed
    answer.resolve('trust');
    expect(await verdict).toBe(false);
    expect(putItem).not.toHaveBeenCalled();
  });

  it('reconnecting cancels the pending host-key dialog of the old attempt', async () => {
    const answer = deferred<HostKeyDecision>();
    const { manager, session, putItem, confirmHostKey } = setup({ confirm: () => answer.promise });
    const tab = manager.open(HOST_ID, 80, 24);
    const first = await session(0);
    const verdict = first.hooks!.verifyHostKey!(hostKey('unknown'));
    await vi.waitFor(() => expect(confirmHostKey).toHaveBeenCalled());
    manager.reconnect(tab.id, 80, 24);
    await session(1);
    answer.resolve('trust');
    expect(await verdict).toBe(false);
    expect(putItem).not.toHaveBeenCalled();
  });
});

describe('SshManager prompts', () => {
  it('cancels a keyboard prompt when the attempt reconnects', async () => {
    const { manager, session, events } = setup();
    const tab = manager.open(HOST_ID, 80, 24);
    const s = await session();
    const answers = s.hooks!.keyboardInteractive!(keyboard);
    const prompt = events.find((e) => e.name === 'ssh.prompt')!.payload as { promptId: string };
    manager.reconnect(tab.id, 80, 24);
    await expect(answers).rejects.toThrow();
    expect(events).toContainEqual({
      name: 'ssh.prompt-cancelled',
      payload: { promptId: prompt.promptId },
    });
    expect(() => manager.answerKeyboard(prompt.promptId, ['123456'])).toThrow(/no longer waiting/);
  });

  it('denies a keyboard prompt nobody answers before the deadline', async () => {
    vi.useFakeTimers();
    const { manager, session, events } = setup({ keyboardTimeoutMs: 60_000 });
    manager.open(HOST_ID, 80, 24);
    const s = await session();
    const answers = s.hooks!.keyboardInteractive!(keyboard);
    const outcome = answers.then(
      () => 'answered',
      () => 'denied',
    );
    await vi.advanceTimersByTimeAsync(59_000);
    expect(events.some((e) => e.name === 'ssh.prompt-cancelled')).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toBe('denied');
    expect(events.some((e) => e.name === 'ssh.prompt-cancelled')).toBe(true);
  });

  it('cancels the prompts of a connection that fails', async () => {
    const { manager, session, events } = setup();
    manager.open(HOST_ID, 80, 24);
    const s = await session();
    const answers = s.hooks!.keyboardInteractive!(keyboard).catch(() => 'denied');
    s.emit({
      state: 'closed',
      reason: {
        kind: 'error',
        error: Object.assign(new Error('reset'), { code: 'connect_failed' }),
      },
    } as SessionStatus);
    expect(await answers).toBe('denied');
    expect(events.some((e) => e.name === 'ssh.prompt-cancelled')).toBe(true);
  });
});

describe('SshManager connection failures', () => {
  it('closes the signed-in session when the shell cannot be opened', async () => {
    const { manager, session } = setup();
    const tab = manager.open(HOST_ID, 80, 24);
    const s = await session();
    s.connected.resolve();
    await vi.waitFor(() => expect(manager.list()[0]?.state).toBe('closed'));
    expect(s.openShell).toHaveBeenCalled();
    expect(s.closed).toHaveBeenCalled();
    expect(manager.list()[0]).toMatchObject({
      id: tab.id,
      state: 'closed',
      closed: { kind: 'error', code: 'channel_failed' },
    });
  });
});

describe('SshManager new hosts', () => {
  const JUMP_ID = 'cccccccc-8e6b-4d0a-9b7e-0a1b2c3d4e5f';
  const TARGET_ID = 'dddddddd-8e6b-4d0a-9b7e-0a1b2c3d4e5f';
  const host = (address: string, extra: Record<string, unknown> = {}): ItemPayload =>
    ({
      type: 'host',
      schema: 1,
      updated_at: now,
      label: address,
      address,
      port: 22,
      username: 'me',
      tags: [],
      agent_forwarding: false,
      ...extra,
    }) as ItemPayload;

  it('asks before the engine sees an address without a stored host key', async () => {
    const answer = deferred<boolean>();
    const { manager, sessions, session, confirmNewHosts } = setup({
      confirmNew: () => answer.promise,
    });
    manager.open(HOST_ID, 80, 24);
    await vi.waitFor(() => expect(confirmNewHosts).toHaveBeenCalled());
    expect(confirmNewHosts.mock.calls[0]![0]).toEqual([
      { host: 'box.example.com', port: 22, isNew: true },
    ]);
    // Nothing exists that could resolve or connect while the dialog is open.
    expect(sessions).toHaveLength(0);
    answer.resolve(true);
    const s = await session();
    expect(s.settings).toMatchObject({ address: 'box.example.com', port: 22 });
  });

  it('a declined dialog closes the tab and the engine is never called', async () => {
    const { manager, sessions } = setup({ confirmNew: async () => false });
    const tab = manager.quickConnect('me@leak-SECRET.attacker.example', 'pw', 80, 24);
    await vi.waitFor(() => expect(manager.list()[0]?.state).toBe('closed'));
    expect(sessions).toHaveLength(0);
    expect(manager.list()[0]).toMatchObject({
      id: tab.id,
      closed: { kind: 'error', code: 'not_approved' },
    });
  });

  it('closing the tab while the dialog is open closes the dialog and connects nowhere', async () => {
    const answer = deferred<boolean>();
    let signal: AbortSignal | undefined;
    const { manager, sessions } = setup({
      confirmNew: (_route, s) => {
        signal = s;
        return answer.promise;
      },
    });
    const tab = manager.open(HOST_ID, 80, 24);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await manager.close(tab.id);
    expect(signal!.aborted).toBe(true);
    answer.resolve(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(sessions).toHaveLength(0);
  });

  it('connects to hosts with a stored key without asking (host matched case-insensitively)', async () => {
    const { manager, session, confirmNewHosts } = setup({
      snapshot: snapshotWith([
        ['aaaaaaaa-8e6b-4d0a-9b7e-0a1b2c3d4e5f', knownHost('BOX.example.com', KEY_A)],
      ]),
    });
    manager.open(HOST_ID, 80, 24);
    await session();
    expect(confirmNewHosts).not.toHaveBeenCalled();
  });

  it('a stored key for another port does not count', async () => {
    const { manager, session, confirmNewHosts } = setup({
      snapshot: snapshotWith([
        [
          'aaaaaaaa-8e6b-4d0a-9b7e-0a1b2c3d4e5f',
          { ...knownHost('box.example.com', KEY_A), port: 2222 } as ItemPayload,
        ],
      ]),
    });
    manager.open(HOST_ID, 80, 24);
    await session();
    expect(confirmNewHosts).toHaveBeenCalledTimes(1);
  });

  it('lists the whole route of a jump chain, marking the new hop', async () => {
    const { manager, session, confirmNewHosts } = setup({
      snapshot: snapshotWith([
        [JUMP_ID, host('jump.example.com')],
        [TARGET_ID, host('inner.example.com', { jump_host_id: JUMP_ID })],
        ['aaaaaaaa-8e6b-4d0a-9b7e-0a1b2c3d4e5f', knownHost('jump.example.com', KEY_A)],
      ]),
    });
    manager.open(TARGET_ID, 80, 24);
    await session();
    expect(confirmNewHosts).toHaveBeenCalledTimes(1);
    expect(confirmNewHosts.mock.calls[0]![0]).toEqual([
      { host: 'jump.example.com', port: 22, isNew: false },
      { host: 'inner.example.com', port: 22, isNew: true },
    ]);
  });

  it('asks again on every attempt until a key is stored', async () => {
    const { manager, session, confirmNewHosts } = setup();
    const tab = manager.open(HOST_ID, 80, 24);
    await session(0);
    manager.reconnect(tab.id, 80, 24);
    await session(1);
    expect(confirmNewHosts).toHaveBeenCalledTimes(2);
  });
});

describe('SshManager quick connect', () => {
  it('forgets the typed password once the session has signed in', async () => {
    const { manager, session } = setup();
    const tab = manager.quickConnect('me@quick.example.com:2200', 'typed-PW', 80, 24);
    const first = await session(0);
    expect(first.settings?.password).toBe('typed-PW');
    first.connected.resolve();
    await vi.waitFor(() => expect(manager.list()[0]?.state).toBe('closed'));
    manager.reconnect(tab.id, 80, 24);
    const second = await session(1);
    expect(second.settings).toMatchObject({ address: 'quick.example.com', port: 2200 });
    expect(second.settings?.password).toBeUndefined();
  });

  it('keeps the password for a retry when signing in never succeeded', async () => {
    const { manager, session } = setup();
    const tab = manager.quickConnect('me@quick.example.com', 'typed-PW', 80, 24);
    const first = await session(0);
    first.emit({
      state: 'closed',
      reason: {
        kind: 'error',
        error: Object.assign(new Error('refused'), { code: 'connect_failed' }),
      },
    } as SessionStatus);
    manager.reconnect(tab.id, 80, 24);
    expect((await session(1)).settings?.password).toBe('typed-PW');
  });
});

describe('SshManager port forwards', () => {
  const forward = (n: number, kind: string, bindAddress: string): [string, ItemPayload] => [
    `eeeeeee${n}-8e6b-4d0a-9b7e-0a1b2c3d4e5f`,
    {
      type: 'port_forward',
      schema: 1,
      updated_at: now,
      label: `f${n}`,
      host_id: HOST_ID,
      kind,
      bind_address: bindAddress,
      bind_port: 8000 + n,
      ...(kind === 'dynamic' ? {} : { dest_host: 'db.internal', dest_port: 5432 }),
    } as ItemPayload,
  ];

  it('a local or dynamic forward must listen on an IP address or localhost', async () => {
    const refused = [
      forward(1, 'local', 'leak-SECRET.attacker.example'),
      forward(2, 'dynamic', 'leak-SECRET.attacker.example'),
      forward(3, 'local', 'localhost.'),
    ];
    const allowed = [
      forward(4, 'local', '127.0.0.1'),
      forward(5, 'dynamic', '::1'),
      forward(6, 'local', 'localhost'),
      forward(7, 'local', '0.0.0.0'),
      forward(8, 'local', ''), // the engine's default, 127.0.0.1
      // Remote forwards listen on the server, which resolves the name itself.
      forward(9, 'remote', 'gateway.example'),
    ];
    const { manager, session } = setup({ snapshot: snapshotWith([...refused, ...allowed]) });
    const tab = manager.open(HOST_ID, 80, 24);
    const s = await session();
    for (const [id] of refused) {
      await expect(manager.startForward(tab.id, id)).rejects.toMatchObject({
        code: 'invalid_input',
        message: 'Bind address must be an IP address or localhost',
      });
      expect(manager.list()[0]?.forwards.find((f) => f.id === id)).toMatchObject({
        state: 'error',
      });
    }
    expect(s.startForward).not.toHaveBeenCalled();
    for (const [id] of allowed) await manager.startForward(tab.id, id);
    expect(s.startForward).toHaveBeenCalledTimes(allowed.length);

    // The editor's early check agrees with main.
    for (const [, p] of [...refused, ...allowed.slice(0, 4)]) {
      const { bind_address } = p as { bind_address: string };
      expect(looksLikeLocalBindAddress(bind_address), bind_address).toBe(
        allowed.some(([, a]) => a === p),
      );
    }
  });
});

describe('SshManager attaching a page', () => {
  it('tells a later page its display starts fresh, once a page has shown the shell', async () => {
    const { manager, session } = setup();
    const tab = manager.open(HOST_ID, 80, 24);
    const s = await session();
    const shell = {
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
      resize: vi.fn(),
      write: vi.fn(),
      close: vi.fn(),
    };
    s.openShell.mockResolvedValue(shell as unknown as ShellStream);
    s.connected.resolve();
    await vi.waitFor(() => expect(manager.list()[0]?.state).toBe('ready'));

    expect(manager.attach(tab.id)).toEqual({ displayReset: false });
    // Leaving the session reloads the page; the new page attaches again.
    manager.detachAll();
    expect(manager.attach(tab.id)).toEqual({ displayReset: true });
  });

  it('a page that attaches before the shell is open has nothing to reset', async () => {
    const { manager, session } = setup();
    const tab = manager.open(HOST_ID, 80, 24);
    await session();
    expect(manager.attach(tab.id)).toEqual({ displayReset: false });
    manager.detachAll();
    expect(manager.attach(tab.id)).toEqual({ displayReset: false });
  });
});

/** A shell that stays open and drops input. */
function openShellStream(): ShellStream {
  return {
    write: () => undefined,
    resize: () => undefined,
    onData: () => () => undefined,
    onExit: () => () => undefined,
    close: () => undefined,
  };
}

describe('SshManager operating system detection', () => {
  const snapshotWithOs = (os?: HostOs): ItemSnapshot => {
    const snap = snapshotWith();
    const host = snap.lookup.get(HOST_ID)!;
    const payload = (os ? { ...host, os } : host) as ItemPayload;
    snap.lookup.set(HOST_ID, payload);
    snap.records.set(HOST_ID, { vaultId: PERSONAL, itemId: HOST_ID, seq: 1, payload });
    return snap;
  };

  /** Open the host, let it sign in and open a shell, with `detected` as the probe's answer. */
  async function connectWith(
    detected: HostOs | undefined | Promise<HostOs | undefined>,
    options: Parameters<typeof setup>[0] = {},
  ) {
    const env = setup({ detectHostOs: () => true, vaultRole: () => 'owner', ...options });
    const opened = env.manager.open(HOST_ID, 80, 24);
    const s = await env.session();
    s.openShell.mockImplementation(async () => openShellStream());
    s.detectOs.mockImplementation(() => Promise.resolve(detected));
    s.connected.resolve();
    await vi.waitFor(() =>
      expect(env.manager.list().find((t) => t.id === opened.id)?.state).toBe('ready'),
    );
    return { ...env, s, id: opened.id };
  }

  it('writes a changed OS once, from main’s copy with its secrets', async () => {
    const { s, putItem } = await connectWith('ubuntu', { snapshot: snapshotWithOs('debian') });
    await vi.waitFor(() => expect(putItem).toHaveBeenCalledTimes(1));
    expect(s.detectOs).toHaveBeenCalledTimes(1);
    const [vaultId, itemId, draft, options] = putItem.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      unknown,
    ];
    // A background write: never wins a conflict, only updates the version it was built from.
    expect(options).toEqual({ background: { baseSeq: 1 } });
    expect(vaultId).toBe(PERSONAL);
    expect(itemId).toBe(HOST_ID);
    expect(draft).toMatchObject({
      type: 'host',
      label: 'box',
      address: 'box.example.com',
      username: 'me',
      password: 'pw-SECRET',
      os: 'ubuntu',
    });
    // The client stamps the write time; main does not pass the old one along.
    expect(draft).not.toHaveProperty('updated_at');
  });

  it('writes an OS on a host that had none', async () => {
    const { putItem } = await connectWith('alpine');
    await vi.waitFor(() => expect(putItem).toHaveBeenCalledTimes(1));
    expect(putItem.mock.calls[0]).toEqual([
      PERSONAL,
      HOST_ID,
      expect.objectContaining({ os: 'alpine', password: 'pw-SECRET' }),
      { background: { baseSeq: 1 } },
    ]);
  });

  it('writes nothing when the OS is unchanged or unknown', async () => {
    const same = await connectWith('debian', { snapshot: snapshotWithOs('debian') });
    await vi.waitFor(() => expect(same.s.detectOs).toHaveBeenCalled());
    const unknown = await connectWith(undefined, { snapshot: snapshotWithOs('debian') });
    await vi.waitFor(() => expect(unknown.s.detectOs).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(same.putItem).not.toHaveBeenCalled();
    expect(unknown.putItem).not.toHaveBeenCalled();
  });

  it('only shows the OS on this device for a viewer, and never writes', async () => {
    const { manager, putItem, events } = await connectWith('fedora', {
      vaultRole: () => 'viewer',
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        name: 'client.items-changed',
        payload: { vaultId: PERSONAL },
      }),
    );
    expect(putItem).not.toHaveBeenCalled();
    const host = snapshotWith().records.get(HOST_ID)!;
    const item = {
      id: HOST_ID,
      vaultId: PERSONAL,
      seq: 1,
      keyVersion: 1,
      updatedAt: now,
      updatedBy: 'u',
      payload: host.payload,
    };
    const shown = manager.displayItems({ vaultId: PERSONAL, items: [item], unreadable: [] });
    expect(shown.items[0]!.payload).toMatchObject({ type: 'host', os: 'fedora' });
    // Another vault's item with the same ID is not touched, and the original is not mutated.
    const other = manager.displayItems({ vaultId: 'other', items: [item], unreadable: [] });
    expect(other.items[0]!.payload).not.toHaveProperty('os');
    expect(item.payload).not.toHaveProperty('os');
    // Signing out forgets it.
    await manager.closeAll();
    const after = manager.displayItems({ vaultId: PERSONAL, items: [item], unreadable: [] });
    expect(after.items[0]!.payload).not.toHaveProperty('os');
  });

  it('does not detect when the setting is off, or for a quick connect', async () => {
    const off = await connectWith('ubuntu', { detectHostOs: () => false });
    await new Promise((r) => setTimeout(r, 20));
    expect(off.s.detectOs).not.toHaveBeenCalled();
    expect(off.putItem).not.toHaveBeenCalled();

    const env = setup({ detectHostOs: () => true, vaultRole: () => 'owner' });
    const opened = env.manager.quickConnect('me@quick.example.com', undefined, 80, 24);
    const s = await env.session();
    s.openShell.mockImplementation(async () => openShellStream());
    s.detectOs.mockResolvedValue('ubuntu');
    s.connected.resolve();
    await vi.waitFor(() =>
      expect(env.manager.list().find((t) => t.id === opened.id)?.state).toBe('ready'),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(s.detectOs).not.toHaveBeenCalled();
    expect(env.putItem).not.toHaveBeenCalled();
  });

  it('never holds up the terminal, and a failing write only reaches the log', async () => {
    const answer = deferred<HostOs | undefined>();
    const { putItem, log, manager, id } = await connectWith(answer.promise, {
      putItem: async () => {
        throw new Error('offline');
      },
    });
    // The tab is ready while the probe is still out.
    expect(manager.list().find((t) => t.id === id)?.state).toBe('ready');
    answer.resolve('arch');
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(putItem).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('offline');
  });

  it('a vault locked by the time the probe answers writes nothing', async () => {
    let locked = false;
    const answer = deferred<HostOs | undefined>();
    const { putItem, log } = await connectWith(answer.promise, {
      snapshot: () => {
        if (locked) throw new Error('The vault is locked');
        return snapshotWith();
      },
    });
    locked = true;
    answer.resolve('arch');
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(putItem).not.toHaveBeenCalled();
  });

  it('probes once when several tabs of the host connect together', async () => {
    const answer = deferred<HostOs | undefined>();
    const env = setup({ detectHostOs: () => true, vaultRole: () => 'owner' });
    env.manager.open(HOST_ID, 80, 24);
    env.manager.open(HOST_ID, 80, 24);
    for (const index of [0, 1]) {
      const s = await env.session(index);
      s.openShell.mockImplementation(async () => openShellStream());
      s.detectOs.mockImplementation(() => answer.promise);
      s.connected.resolve();
    }
    await vi.waitFor(() => expect(env.manager.list().every((t) => t.state === 'ready')).toBe(true));
    answer.resolve('nixos');
    await vi.waitFor(() => expect(env.putItem).toHaveBeenCalledTimes(1));
    expect(env.sessions.reduce((n, s) => n + s.detectOs.mock.calls.length, 0)).toBe(1);
  });
  const hostItem = (payload: ItemPayload) => ({
    id: HOST_ID,
    vaultId: PERSONAL,
    seq: 1,
    keyVersion: 1,
    updatedAt: now,
    updatedBy: 'u',
    payload,
  });
  const shownOs = (manager: SshManager, payload = snapshotWith().records.get(HOST_ID)!.payload) => {
    const shown = manager.displayItems({
      vaultId: PERSONAL,
      items: [hostItem(payload)],
      unreadable: [],
    });
    const p = shown.items[0]!.payload;
    return p.type === 'host' ? p.os : undefined;
  };

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'beos'])(
    'drops a detected value outside the closed list (%s), for writers and viewers',
    async (value) => {
      const writer = await connectWith(value as HostOs);
      const viewer = await connectWith(value as HostOs, { vaultRole: () => 'viewer' });
      await vi.waitFor(() => expect(writer.s.detectOs).toHaveBeenCalled());
      await vi.waitFor(() => expect(viewer.s.detectOs).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(writer.putItem).not.toHaveBeenCalled();
      expect(viewer.events.map((e) => e.name)).not.toContain('client.items-changed');
      expect(shownOs(viewer.manager)).toBeUndefined();
    },
  );

  it('shows a viewer’s OS to that account only: an expired session’s next account sees none', async () => {
    let account: string | undefined = 'server user-a';
    const viewer = await connectWith('fedora', {
      vaultRole: () => 'viewer',
      accountId: () => account,
    });
    await vi.waitFor(() => expect(shownOs(viewer.manager)).toBe('fedora'));
    // The session expires (terminals stay open) and someone else signs in to the same vault.
    account = undefined;
    expect(shownOs(viewer.manager)).toBeUndefined();
    account = 'server user-b';
    expect(shownOs(viewer.manager)).toBeUndefined();
    // Even if the first account comes back, the expiry forgot it.
    viewer.manager.forgetAccount();
    account = 'server user-a';
    expect(shownOs(viewer.manager)).toBeUndefined();
  });

  it('drops a detection that was still running when the account changed', async () => {
    let account: string | undefined = 'server user-a';
    const answer = deferred<HostOs | undefined>();
    const writer = await connectWith(answer.promise, { accountId: () => account });
    const viewer = await connectWith(answer.promise, {
      vaultRole: () => 'viewer',
      accountId: () => account,
    });
    writer.manager.forgetAccount();
    viewer.manager.forgetAccount();
    account = 'server user-b';
    answer.resolve('arch');
    await new Promise((r) => setTimeout(r, 20));
    expect(writer.putItem).not.toHaveBeenCalled();
    expect(shownOs(viewer.manager)).toBeUndefined();
  });

  it('writes nothing when the host’s address or port changed while the probe ran', async () => {
    for (const change of [{ address: 'other.example.com' }, { port: 2222 }]) {
      let changed = false;
      const answer = deferred<HostOs | undefined>();
      const env = await connectWith(answer.promise, {
        snapshot: () => {
          const snap = snapshotWith();
          if (!changed) return snap;
          const payload = { ...snap.lookup.get(HOST_ID)!, ...change } as ItemPayload;
          snap.lookup.set(HOST_ID, payload);
          snap.records.set(HOST_ID, { vaultId: PERSONAL, itemId: HOST_ID, seq: 2, payload });
          return snap;
        },
      });
      changed = true;
      answer.resolve('arch');
      await new Promise((r) => setTimeout(r, 20));
      expect(env.putItem).not.toHaveBeenCalled();
    }
  });

  it('a case or whitespace difference in the address is the same destination', async () => {
    const env = await connectWith('arch', {
      snapshot: () => {
        const snap = snapshotWith();
        const payload = { ...snap.lookup.get(HOST_ID)!, address: ' Box.Example.COM ' };
        snap.lookup.set(HOST_ID, payload as ItemPayload);
        snap.records.set(HOST_ID, {
          vaultId: PERSONAL,
          itemId: HOST_ID,
          seq: 1,
          payload: payload as ItemPayload,
        });
        return snap;
      },
    });
    await vi.waitFor(() => expect(env.putItem).toHaveBeenCalledTimes(1));
  });

  it('a viewer’s OS is not shown once the host points somewhere else', async () => {
    const viewer = await connectWith('fedora', { vaultRole: () => 'viewer' });
    const payload = snapshotWith().records.get(HOST_ID)!.payload;
    await vi.waitFor(() => expect(shownOs(viewer.manager, payload)).toBe('fedora'));
    expect(
      shownOs(viewer.manager, { ...payload, address: 'elsewhere.example.com' } as ItemPayload),
    ).toBeUndefined();
    expect(shownOs(viewer.manager, { ...payload, port: 2200 } as ItemPayload)).toBeUndefined();
  });

  it('drops the answer of an attempt a reconnect replaced', async () => {
    const answer = deferred<HostOs | undefined>();
    const env = await connectWith(answer.promise);
    env.manager.reconnect(env.id, 80, 24);
    answer.resolve('arch');
    await new Promise((r) => setTimeout(r, 20));
    expect(env.putItem).not.toHaveBeenCalled();
  });

  it('drops the answer once the tab is closed', async () => {
    const answer = deferred<HostOs | undefined>();
    const env = await connectWith(answer.promise);
    await env.manager.close(env.id);
    answer.resolve('arch');
    await new Promise((r) => setTimeout(r, 20));
    expect(env.putItem).not.toHaveBeenCalled();
  });
});

/**
 * Detection writing through a real client and server, wired as main wires it: a person's edit,
 * here or on another device, must never be lost to the background write.
 */
describe('SshManager operating system write-back, against the server', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await closeClients();
    await server.close();
  });

  /** A payload as a draft with `changes`, as an editor sends it. */
  const edit = (payload: ItemPayload, changes: Record<string, unknown>) => {
    const { updated_at: _stamp, ...rest } = payload;
    return { ...rest, ...changes } as ItemDraft;
  };

  /** One account on two devices without realtime, so neither sees the other's writes unasked. */
  async function twoDevices() {
    const a = await registerUser(server, { realtime: false });
    const b = await loginUser(server, a.email, a.password, { realtime: false });
    const vaultId = a.personalVaultId;
    const created = await a.client.putItem(vaultId, undefined, {
      type: 'host',
      label: 'box',
      address: 'box.example.com',
      username: 'me',
      password: 'pw-original',
    });
    const hostId = created.item!.id;
    await b.client.pullVault(vaultId);
    return { a, b, vaultId, hostId };
  }

  /** The manager as main builds it, on `client`; every tab's probe answers `detected`. */
  function managerOn(client: TernixClient, detected: HostOs | undefined) {
    const sessions: FakeSession[] = [];
    const log = vi.fn();
    const manager = new SshManager({
      snapshot: () => snapshotItems(client),
      putItem: (vaultId, itemId, draft, options) =>
        options && itemId !== undefined
          ? client.putItem(vaultId, itemId, draft, options)
          : client.putItem(vaultId, itemId, draft),
      pullVault: (vaultId) => client.pullVault(vaultId),
      accountId: () => client.account?.user.id,
      vaultRole: (vaultId) => client.listVaults().find((v) => v.id === vaultId)?.role,
      detectHostOs: () => true,
      emit: () => undefined,
      sendTerminal: () => true,
      hasWindow: () => true,
      confirmHostKey: async () => 'reject',
      confirmNewHosts: async () => true,
      agentPath: undefined,
      log,
      createSession: (o) => {
        const s = new FakeSession(o);
        s.openShell.mockImplementation(async () => openShellStream());
        s.detectOs.mockImplementation(async () => detected);
        s.connected.resolve();
        sessions.push(s);
        return s as unknown as SshSession;
      },
    });
    return { manager, sessions, log };
  }

  const serverCopy = async (reader: TernixClient, vaultId: string, hostId: string) => {
    await reader.pullVault(vaultId);
    return reader.getItem(vaultId, hostId)?.payload ?? null;
  };

  it('keeps another device’s edit this device has not pulled yet, and still records the OS', async () => {
    const { a, b, vaultId, hostId } = await twoDevices();
    const before = b.client.getItem(vaultId, hostId)!.payload;
    await b.client.putItem(vaultId, hostId, edit(before, { password: 'pw-from-b' }));

    const env = managerOn(a.client, 'ubuntu');
    env.manager.open(hostId, 80, 24);
    const after = await waitFor(async () => {
      const p = await serverCopy(b.client, vaultId, hostId);
      return p?.type === 'host' && p.os === 'ubuntu' ? p : undefined;
    }, 'the detected OS on the server');
    expect(after).toMatchObject({ password: 'pw-from-b', label: 'box' });
    expect(env.log).not.toHaveBeenCalled();
  });

  it('keeps an edit that lands between its pull and its write', async () => {
    const { a, b, vaultId, hostId } = await twoDevices();
    // This device's clock runs ahead: a normal write would win the conflict rule.
    a.clock.offsetMs = HOUR;
    let raced = false;
    a.spy.before = async (method, path) => {
      if (raced || method !== 'PUT' || !path.endsWith(hostId)) return;
      raced = true;
      const current = b.client.getItem(vaultId, hostId)!.payload;
      await b.client.putItem(vaultId, hostId, edit(current, { password: 'pw-raced' }));
    };
    const env = managerOn(a.client, 'ubuntu');
    env.manager.open(hostId, 80, 24);
    await waitFor(() => raced, 'the background write');
    await new Promise((r) => setTimeout(r, 300));
    const after = await serverCopy(b.client, vaultId, hostId);
    expect(after).toMatchObject({ password: 'pw-raced' });
    expect(after).not.toHaveProperty('os');
    // Skipped, not retried: one write went out.
    expect(a.spy.count('PUT', `/items/${hostId}`)).toBe(2); // the create, the skipped write
    expect(env.log).not.toHaveBeenCalled();
  });

  it('does not revive a host another device deleted', async () => {
    const { a, b, vaultId, hostId } = await twoDevices();
    await b.client.deleteItem(vaultId, hostId);
    const putsBefore = a.spy.count('PUT', `/items/${hostId}`);

    const env = managerOn(a.client, 'ubuntu');
    env.manager.open(hostId, 80, 24);
    await waitFor(() => env.sessions[0]?.detectOs.mock.calls.length === 1, 'the probe');
    await new Promise((r) => setTimeout(r, 300));
    expect(await serverCopy(b.client, vaultId, hostId)).toBeNull();
    expect(a.spy.count('PUT', `/items/${hostId}`)).toBe(putsBefore);
  });

  it('loses to an editor save on this device that was already on its way', async () => {
    const { a, b, vaultId, hostId } = await twoDevices();
    const gate = deferred();
    let held = false;
    a.spy.before = async (method, path) => {
      if (held || method !== 'PUT' || !path.endsWith(hostId)) return;
      held = true;
      await gate.promise;
    };
    // The editor saves (without `os`, as the renderer does); the request is held on the way.
    const original = a.client.getItem(vaultId, hostId)!.payload;
    const saving = a.client.putItem(
      vaultId,
      hostId,
      edit(original, { label: 'edited', password: 'pw-typed' }),
    );
    await waitFor(() => held, 'the editor save to be on its way');

    // Detection writes first.
    const env = managerOn(a.client, 'ubuntu');
    env.manager.open(hostId, 80, 24);
    await waitFor(async () => {
      const p = await serverCopy(b.client, vaultId, hostId);
      return p?.type === 'host' && p.os === 'ubuntu';
    }, 'the detected OS on the server');

    gate.resolve();
    const result = await saving;
    expect(result.status).toBe('saved');
    expect(await serverCopy(b.client, vaultId, hostId)).toMatchObject({
      label: 'edited',
      password: 'pw-typed',
    });
  });
});
