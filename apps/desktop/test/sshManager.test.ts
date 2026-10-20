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
import type { HostKeyFacts } from '../src/main/app/trust.js';
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
    keyboardTimeoutMs?: number;
  } = {},
) {
  const sessions: FakeSession[] = [];
  const events: { name: AppEventName; payload: unknown }[] = [];
  const putItem = vi.fn(async () => ({}));
  const confirmHostKey = vi.fn(options.confirm ?? (async () => 'reject' as HostKeyDecision));
  const manager = new SshManager({
    snapshot: () => options.snapshot ?? snapshotWith(),
    putItem,
    emit: <K extends AppEventName>(name: K, payload: AppEvents[K]) =>
      void events.push({ name, payload }),
    sendTerminal: () => true,
    hasWindow: () => true,
    confirmHostKey,
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
  return { manager, sessions, session, events, putItem, confirmHostKey };
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
