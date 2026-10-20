import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ItemPayload } from '@ternix/core/items';
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
import type { HostKeyFacts, RouteHop } from '../src/main/app/trust.js';
import type { ItemSnapshot } from '../src/main/ssh/items.js';
import { SshManager } from '../src/main/ssh/manager.js';
import { deferred } from './helpers.js';

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
      entries.map(([id, payload]) => [id, { vaultId: PERSONAL, itemId: id, payload }]),
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
    snapshot?: ItemSnapshot;
    confirm?: (facts: HostKeyFacts, signal: AbortSignal) => Promise<HostKeyDecision>;
    /** The "Connect to a new host?" dialog; approves by default. */
    confirmNew?: (route: RouteHop[], signal: AbortSignal) => Promise<boolean>;
    keyboardTimeoutMs?: number;
  } = {},
) {
  const sessions: FakeSession[] = [];
  const events: { name: AppEventName; payload: unknown }[] = [];
  const putItem = vi.fn(async () => ({}));
  const confirmHostKey = vi.fn(options.confirm ?? (async () => 'reject' as HostKeyDecision));
  const confirmNewHosts = vi.fn(options.confirmNew ?? (async () => true));
  const manager = new SshManager({
    snapshot: () => options.snapshot ?? snapshotWith(),
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
  });
  const session = async (index = 0) => {
    await vi.waitFor(() => expect(sessions[index]?.hooks).toBeDefined());
    return sessions[index]!;
  };
  return { manager, sessions, session, events, putItem, confirmHostKey, confirmNewHosts };
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
