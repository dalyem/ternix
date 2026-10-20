import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { knownHostPayloadSchema } from '@ternix/core/items';
import type { KnownHostPayload } from '@ternix/core/items';
import {
  SshError,
  SshSession,
  defaultAgentPath,
  fingerprintSha256,
  knownHostPayload,
} from '../src/index.js';
import type {
  HopSettings,
  HostKeyInfo,
  KeyboardInteractiveRequest,
  SessionHooks,
  SessionOptions,
  SessionStatus,
  ShellExit,
  ResolvedConnection,
  ShellStream,
} from '../src/index.js';
import {
  TestSshServer,
  connection,
  generateKey,
  waitFor,
  wirePublicKey,
  withTimeout,
} from './helpers.js';
import type { KeyPair, TestServerOptions } from './helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(options: TestServerOptions): Promise<TestSshServer> {
  const s = await TestSshServer.start(options);
  cleanup.push(() => s.stop());
  return s;
}

function newSession(options?: SessionOptions): SshSession {
  const s = new SshSession(options);
  cleanup.push(() => s.close());
  return s;
}

const trustAll: SessionHooks = { verifyHostKey: async () => true };

/** Distinct consecutive states, in order. */
function trackStates(session: SshSession): string[] {
  const states: string[] = [];
  session.onStatus((s) => {
    if (states.at(-1) !== s.state) states.push(s.state);
  });
  return states;
}

async function rejection(promise: Promise<unknown>): Promise<SshError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SshError) return err;
    throw err;
  }
  throw new Error('expected the promise to reject');
}

function knownHostFor(
  srv: TestSshServer,
  address = '127.0.0.1',
  key: KeyPair = srv.hostKey,
): KnownHostPayload {
  return knownHostPayloadSchema.parse(
    knownHostPayload({
      host: address,
      port: srv.port,
      keyType: 'ssh-ed25519',
      keyB64: wirePublicKey(key.public).toString('base64'),
    }),
  );
}

function collect(shell: ShellStream): { text: () => string } {
  let text = '';
  shell.onData((d) => (text += Buffer.from(d).toString()));
  return { text: () => text };
}

describe('password authentication', () => {
  it('signs in, reports each phase, the banner and the host key', async () => {
    const srv = await server({
      users: { alice: { password: 'pw' } },
      banner: 'Authorized use only\n',
    });
    const session = newSession();
    const states = trackStates(session);
    const infos: HostKeyInfo[] = [];
    const banners: string[] = [];

    await session.connect(connection({ port: srv.port }), {
      verifyHostKey: async (info) => (infos.push(info), true),
      onBanner: (message) => banners.push(message),
    });

    expect(states).toEqual(['connecting', 'verifying-host-key', 'authenticating', 'ready']);
    expect(session.status).toEqual({ state: 'ready' });
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({
      host: '127.0.0.1',
      port: srv.port,
      keyType: 'ssh-ed25519',
      status: 'unknown',
      hop: { index: 0, total: 1, isTarget: true },
    });
    expect(infos[0]?.fingerprint).toBe(fingerprintSha256(wirePublicKey(srv.hostKey.public)));
    expect(banners.join('')).toContain('Authorized use only');
    expect(srv.authMethods).toEqual(['none', 'password']);
  });

  it('fails with auth_failed on a wrong password and closes the session', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession();
    const err = await rejection(
      session.connect(connection({ port: srv.port, password: 'nope' }), trustAll),
    );
    expect(err.code).toBe('auth_failed');
    expect(err.hop).toBe(0);
    expect(session.status).toMatchObject({
      state: 'closed',
      reason: { kind: 'error', error: { code: 'auth_failed' } },
    });
    await waitFor(() => srv.clients.size === 0, 'server to see the disconnect');
  });

  it('cannot be connected twice', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession();
    await session.connect(connection({ port: srv.port }), trustAll);
    expect((await rejection(session.connect(connection({ port: srv.port }), trustAll))).code).toBe(
      'invalid_state',
    );
  });
});

describe('key authentication', () => {
  it('signs in with a private key and no password', async () => {
    const key = generateKey();
    const srv = await server({ users: { alice: { publicKey: key.public } } });
    const session = newSession();
    await session.connect(
      connection({
        port: srv.port,
        password: undefined,
        key: { id: 'k', label: 'k', privateKey: key.private },
      }),
      trustAll,
    );
    expect(srv.authMethods).toContain('publickey');
    expect(srv.authMethods).not.toContain('password');
  });

  it('decrypts a key with its passphrase', async () => {
    const key = generateKey('correct horse');
    const srv = await server({ users: { alice: { publicKey: key.public } } });
    const session = newSession();
    await session.connect(
      connection({
        port: srv.port,
        password: undefined,
        key: { id: 'k', label: 'k', privateKey: key.private, passphrase: 'correct horse' },
      }),
      trustAll,
    );
    expect(session.status.state).toBe('ready');
  });

  it('reports bad_passphrase before touching the network', async () => {
    const key = generateKey('correct horse');
    const srv = await server({ users: { alice: { publicKey: key.public, password: 'pw' } } });
    const session = newSession();
    const err = await rejection(
      session.connect(
        connection({
          port: srv.port,
          key: { id: 'k', label: 'deploy key', privateKey: key.private, passphrase: 'wrong' },
        }),
        trustAll,
      ),
    );
    expect(err.code).toBe('bad_passphrase');
    expect(err.message).toContain('deploy key');
    expect(srv.connections).toBe(0);
  });

  it('reports passphrase_required for an encrypted key with none stored', async () => {
    const key = generateKey('correct horse');
    const srv = await server({ users: { alice: { publicKey: key.public } } });
    const session = newSession();
    const err = await rejection(
      session.connect(
        connection({ port: srv.port, key: { id: 'k', label: 'k', privateKey: key.private } }),
        trustAll,
      ),
    );
    expect(err.code).toBe('passphrase_required');
    expect(srv.connections).toBe(0);
  });

  it('reports invalid_key for text that is not a key', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession();
    const err = await rejection(
      session.connect(
        connection({ port: srv.port, key: { id: 'k', label: 'k', privateKey: 'not a key' } }),
        trustAll,
      ),
    );
    expect(err.code).toBe('invalid_key');
  });

  it('falls back to the password when the server does not accept the key', async () => {
    const stranger = generateKey();
    const srv = await server({
      users: { alice: { publicKey: generateKey().public, password: 'pw' } },
    });
    const session = newSession();
    await session.connect(
      connection({ port: srv.port, key: { id: 'k', label: 'k', privateKey: stranger.private } }),
      trustAll,
    );
    const methods = srv.authMethods;
    expect(methods.indexOf('publickey')).toBeGreaterThan(-1);
    expect(methods.indexOf('password')).toBeGreaterThan(methods.indexOf('publickey'));
  });
});

describe('keyboard-interactive', () => {
  const interactive = {
    prompts: [{ prompt: 'Verification code: ', echo: true }],
    answers: ['123456'],
  };

  it('passes prompts to the hook and sends its answers', async () => {
    const srv = await server({ users: { alice: { interactive } } });
    const session = newSession();
    const requests: KeyboardInteractiveRequest[] = [];
    await session.connect(connection({ port: srv.port, password: undefined }), {
      ...trustAll,
      keyboardInteractive: async (request) => (requests.push(request), ['123456']),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      prompts: [{ prompt: 'Verification code: ', echo: true }],
      hop: { index: 0 },
    });
  });

  it('fails when the answers are wrong or there is no hook', async () => {
    const srv = await server({ users: { alice: { interactive } } });
    const wrong = await rejection(
      newSession().connect(connection({ port: srv.port, password: undefined }), {
        ...trustAll,
        keyboardInteractive: async () => ['000000'],
      }),
    );
    expect(wrong.code).toBe('auth_failed');
    const none = await rejection(
      newSession().connect(connection({ port: srv.port, password: undefined }), trustAll),
    );
    expect(none.code).toBe('auth_failed');
  });

  it('answers a lone password prompt with the stored password when the password method is not offered', async () => {
    const srv = await server({
      users: {
        alice: {
          interactive: {
            prompts: [{ prompt: "alice's password: ", echo: false }],
            answers: ['pw'],
          },
        },
      },
    });
    let asked = 0;
    await newSession().connect(connection({ port: srv.port }), {
      ...trustAll,
      keyboardInteractive: async () => ((asked += 1), []),
    });
    expect(asked).toBe(0);
  });

  it('does not feed the stored password to a one-time-password prompt', async () => {
    const srv = await server({
      users: {
        alice: {
          interactive: {
            prompts: [{ prompt: 'One-time password: ', echo: false }],
            answers: ['998877'],
          },
        },
      },
    });
    const requests: KeyboardInteractiveRequest[] = [];
    await newSession().connect(connection({ port: srv.port }), {
      ...trustAll,
      keyboardInteractive: async (request) => (requests.push(request), ['998877']),
    });
    expect(requests).toHaveLength(1);
  });
});

describe('host key verification', () => {
  it('aborts before authenticating when the hook rejects', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession();
    const err = await rejection(
      session.connect(connection({ port: srv.port }), { verifyHostKey: async () => false }),
    );
    expect(err.code).toBe('host_key_rejected');
    expect(session.status).toMatchObject({ state: 'closed', reason: { kind: 'error' } });
    expect(srv.authMethods).toEqual([]);
  });

  it('denies when the hook throws', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const err = await rejection(
      newSession().connect(connection({ port: srv.port }), {
        verifyHostKey: async () => {
          throw new Error('dialog crashed');
        },
      }),
    );
    expect(err.code).toBe('host_key_rejected');
    expect(srv.authMethods).toEqual([]);
  });

  it('with no hook, accepts a trusted key and denies an unknown one', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const unknown = await rejection(newSession().connect(connection({ port: srv.port })));
    expect(unknown.code).toBe('host_key_rejected');

    const trusted = newSession({ knownHosts: [knownHostFor(srv)] });
    await trusted.connect(connection({ port: srv.port }));
    expect(trusted.status.state).toBe('ready');
  });

  it('tells the hook a stored key is trusted', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const infos: HostKeyInfo[] = [];
    await newSession({ knownHosts: [knownHostFor(srv)] }).connect(connection({ port: srv.port }), {
      verifyHostKey: async (info) => (infos.push(info), true),
    });
    expect(infos[0]?.status).toBe('trusted');
    expect(infos[0]?.stored).toBeUndefined();
  });

  it('shows a changed key to the hook as a mismatch with the stored fingerprint, and denies by default', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const oldKey = generateKey();
    const knownHosts = [knownHostFor(srv, '127.0.0.1', oldKey)];
    const infos: HostKeyInfo[] = [];

    const err = await rejection(
      newSession({ knownHosts }).connect(connection({ port: srv.port }), {
        verifyHostKey: async (info) => (infos.push(info), false),
      }),
    );
    expect(err.code).toBe('host_key_rejected');
    expect(err.message).toContain('CHANGED');
    expect(infos[0]).toMatchObject({ status: 'mismatch' });
    expect(infos[0]?.stored?.fingerprint).toBe(fingerprintSha256(wirePublicKey(oldKey.public)));
    expect(infos[0]?.fingerprint).not.toBe(infos[0]?.stored?.fingerprint);

    const noHook = await rejection(
      newSession({ knownHosts }).connect(connection({ port: srv.port })),
    );
    expect(noHook.code).toBe('host_key_rejected');
    expect(srv.authMethods).toEqual([]);
  });

  it('lets the caller override a mismatch after warning the user', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession({ knownHosts: [knownHostFor(srv, '127.0.0.1', generateKey())] });
    await session.connect(connection({ port: srv.port }), trustAll);
    expect(session.status.state).toBe('ready');
  });
});

describe('failures and timeouts', () => {
  it('reports connect_failed when nothing is listening', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const err = await rejection(newSession().connect(connection({ port }), trustAll));
    expect(err.code).toBe('connect_failed');
  });

  it('times out when the server never speaks', async () => {
    const silent = createServer();
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => void silent.close());
    const sockets: { destroy(): void }[] = [];
    silent.on('connection', (s) => sockets.push(s));
    cleanup.push(() => sockets.forEach((s) => s.destroy()));
    const err = await rejection(
      newSession({ connectTimeoutMs: 200 }).connect(
        connection({ port: (silent.address() as AddressInfo).port }),
        trustAll,
      ),
    );
    expect(err.code).toBe('timeout');
    expect(err.message).toContain('connecting');
  });

  it('times out when sign-in stalls', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } }, stallAuth: true });
    const err = await rejection(
      newSession({ readyTimeoutMs: 500 }).connect(connection({ port: srv.port }), trustAll),
    );
    expect(err.code).toBe('timeout');
    expect(err.message).toContain('signing in');
  });

  it('does not count time spent waiting for the user against the timeouts', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession({ connectTimeoutMs: 1000, readyTimeoutMs: 1000 });
    await session.connect(connection({ port: srv.port }), {
      verifyHostKey: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1600));
        return true;
      },
    });
    expect(session.status.state).toBe('ready');
  });

  it('rejects with closed when close() is called mid-connect', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession();
    let release: (accept: boolean) => void = () => undefined;
    const waiting = new Promise<boolean>((resolve) => (release = resolve));
    const connecting = session.connect(connection({ port: srv.port }), {
      verifyHostKey: () => waiting,
    });
    await waitFor(() => session.status.state === 'verifying-host-key', 'the host key prompt');
    await session.close();
    release(true);
    expect((await rejection(connecting)).code).toBe('closed');
    expect(session.status).toMatchObject({ state: 'closed' });
  });
});

describe('shell', () => {
  async function ready(
    overrides: Partial<ResolvedConnection>,
    srvOptions: TestServerOptions = { users: { alice: { password: 'pw' } } },
  ) {
    const srv = await server(srvOptions);
    const session = newSession();
    await session.connect(connection({ ...overrides, port: srv.port }), trustAll);
    return { srv, session };
  }

  it('allocates an xterm-256color pty of the requested size and echoes input', async () => {
    const { srv, session } = await ready({});
    const shell = await session.openShell({ cols: 100, rows: 30 });
    const out = collect(shell);
    shell.write('hello\n');
    await waitFor(() => out.text().includes('hello'), 'the echo');
    expect(srv.ptys).toEqual([{ term: 'xterm-256color', cols: 100, rows: 30 }]);
  });

  it('forwards window resizes', async () => {
    const { srv, session } = await ready({});
    const shell = await session.openShell({ cols: 80, rows: 24 });
    shell.resize(132, 43);
    await waitFor(() => srv.windows.length > 0, 'the window change');
    expect(srv.windows.at(-1)).toEqual({ cols: 132, rows: 43 });
  });

  it('sends the startup snippet once, after the shell opens', async () => {
    const { srv, session } = await ready({ startupScript: 'export FOO=1\r\nls -la' });
    const shell = await session.openShell({ cols: 80, rows: 24 });
    shell.write('whoami\n');
    await waitFor(() => srv.shellInput.includes('whoami'), 'the typed command');
    expect(srv.shellInput).toBe('export FOO=1\nls -la\nwhoami\n');
  });

  it('can skip the startup snippet', async () => {
    const { srv, session } = await ready({ startupScript: 'echo startup' });
    const shell = await session.openShell({ cols: 80, rows: 24, runStartup: false });
    shell.write('x\n');
    await waitFor(() => srv.shellInput.includes('x'), 'the typed command');
    expect(srv.shellInput).toBe('x\n');
  });

  it('buffers output until a listener subscribes', async () => {
    const { session } = await ready({ startupScript: 'early-output' });
    const shell = await session.openShell({ cols: 80, rows: 24 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const out = collect(shell);
    await waitFor(() => out.text().includes('early-output'), 'buffered output');
  });

  it('reports the remote exit status, also to late subscribers', async () => {
    const { session } = await ready({});
    const shell = await session.openShell({ cols: 80, rows: 24 });
    const exits: ShellExit[] = [];
    shell.onExit((e) => exits.push(e));
    shell.write('exit\n');
    await waitFor(() => exits.length === 1, 'the exit');
    expect(exits[0]?.code).toBe(3);
    const late: ShellExit[] = [];
    shell.onExit((e) => late.push(e));
    expect(late).toEqual(exits);
  });

  it('refuses to open a shell before connecting or after closing', async () => {
    const fresh = newSession();
    expect((await rejection(fresh.openShell({ cols: 80, rows: 24 }))).code).toBe('invalid_state');
    const { session } = await ready({});
    await session.close();
    expect((await rejection(session.openShell({ cols: 80, rows: 24 }))).code).toBe('invalid_state');
  });
});

describe('jump hosts', () => {
  const INNER = '10.0.0.2';

  async function chain(innerKey: KeyPair, route?: TestServerOptions['route']) {
    const inner = await server({ users: { bob: { publicKey: innerKey.public } } });
    const bastion = await server({
      users: { jump: { password: 'jpw' } },
      route:
        route ??
        ((h, p) => (h === INNER && p === 22 ? { host: '127.0.0.1', port: inner.port } : undefined)),
    });
    const jump: HopSettings = {
      hostId: 'bastion-id',
      label: 'bastion',
      address: '127.0.0.1',
      port: bastion.port,
      username: 'jump',
      password: 'jpw',
    };
    const target = connection({
      port: 22,
      address: INNER,
      label: 'inner',
      username: 'bob',
      password: undefined,
      key: { id: 'k', label: 'k', privateKey: innerKey.private },
      jumpChain: [jump],
    });
    return { inner, bastion, target };
  }

  it('reaches a host that is only routable through the jump host, verifying every hop', async () => {
    const innerKey = generateKey();
    const { inner, bastion, target } = await chain(innerKey);
    const session = newSession();
    const states = trackStates(session);
    const infos: HostKeyInfo[] = [];
    await session.connect(target, { verifyHostKey: async (info) => (infos.push(info), true) });

    expect(infos.map((i) => [i.hop.index, i.host, i.port, i.hop.isTarget])).toEqual([
      [0, '127.0.0.1', bastion.port, false],
      [1, INNER, 22, true],
    ]);
    expect(infos[0]?.fingerprint).toBe(fingerprintSha256(wirePublicKey(bastion.hostKey.public)));
    expect(infos[1]?.fingerprint).toBe(fingerprintSha256(wirePublicKey(inner.hostKey.public)));
    expect(states.filter((s) => s === 'ready')).toHaveLength(1);
    expect(bastion.tcpip).toEqual([{ host: INNER, port: 22 }]);
    expect(bastion.authMethods).toContain('password');
    expect(inner.authMethods).toContain('publickey');

    const shell = await session.openShell({ cols: 80, rows: 24 });
    const out = collect(shell);
    shell.write('through the bastion\n');
    await waitFor(() => out.text().includes('through the bastion'), 'the echo from the inner host');
    expect(inner.shellInput).toContain('through the bastion');
    expect(bastion.shellInput).toBe('');
  });

  it('ends every connection in the chain on close', async () => {
    const { inner, bastion, target } = await chain(generateKey());
    const session = newSession();
    await session.connect(target, trustAll);
    expect(inner.clients.size).toBe(1);
    expect(bastion.clients.size).toBe(1);
    await session.close();
    await waitFor(
      () => inner.clients.size === 0 && bastion.clients.size === 0,
      'both servers to see the disconnect',
    );
  });

  it('blames the target hop when its host key is rejected', async () => {
    const { bastion, target } = await chain(generateKey());
    const err = await rejection(
      newSession().connect(target, { verifyHostKey: async (info) => info.hop.isTarget === false }),
    );
    expect(err.code).toBe('host_key_rejected');
    expect(err.hop).toBe(1);
    expect(bastion.connections).toBe(1);
  });

  it('blames the jump hop when it rejects the password', async () => {
    const { target } = await chain(generateKey());
    const bad = { ...target, jumpChain: [{ ...target.jumpChain[0]!, password: 'wrong' }] };
    const err = await rejection(newSession().connect(bad, trustAll));
    expect(err.code).toBe('auth_failed');
    expect(err.hop).toBe(0);
  });

  it('fails the target hop when the jump host cannot reach it', async () => {
    const { target } = await chain(generateKey(), () => undefined);
    const err = await rejection(newSession().connect(target, trustAll));
    expect(err.code).toBe('connect_failed');
    expect(err.hop).toBe(1);
  });
});

describe('connection lifetime', () => {
  it('closes with reason remote when the server drops the connection', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession();
    await session.connect(connection({ port: srv.port }), trustAll);
    const shell = await session.openShell({ cols: 80, rows: 24 });
    const exits: ShellExit[] = [];
    shell.onExit((e) => exits.push(e));
    srv.dropClients();
    await waitFor(() => session.status.state === 'closed', 'the session to close');
    expect((session.status as Extract<SessionStatus, { state: 'closed' }>).reason).toEqual({
      kind: 'remote',
    });
    expect(exits).toHaveLength(1);
  });

  it('close() is idempotent and reports a requested close', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession();
    await session.connect(connection({ port: srv.port }), trustAll);
    await Promise.all([session.close(), session.close()]);
    await session.close();
    expect(session.status).toEqual({ state: 'closed', reason: { kind: 'requested' } });
    await waitFor(() => srv.clients.size === 0, 'the server to see the disconnect');
  });

  it('sends SSH keepalives at the configured interval', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    await newSession().connect(connection({ port: srv.port, keepaliveInterval: 1 }), trustAll);
    await waitFor(() => srv.keepalives.length >= 1, 'a keepalive', 4000);
  });

  it('sends no keepalives when none is configured', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    await newSession().connect(connection({ port: srv.port }), trustAll);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(srv.keepalives).toHaveLength(0);
  });
});

describe('agent forwarding', () => {
  it('requests forwarding on the shell when an agent path is given', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const warnings: string[] = [];
    const session = newSession({ agentPath: '/nonexistent/agent.sock' });
    await session.connect(connection({ port: srv.port, agentForwarding: true }), {
      ...trustAll,
      onWarning: (m) => warnings.push(m),
    });
    await session.openShell({ cols: 80, rows: 24 });
    await waitFor(() => srv.agentForwardRequests.length === 1, 'the agent forwarding request');
    expect(warnings).toEqual([]);
  });

  it('warns and does not forward when no agent is available', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const warnings: string[] = [];
    const session = newSession();
    await session.connect(connection({ port: srv.port, agentForwarding: true }), {
      ...trustAll,
      onWarning: (m) => warnings.push(m),
    });
    const shell = await session.openShell({ cols: 80, rows: 24 });
    shell.write('x\n');
    await waitFor(() => srv.shellInput.includes('x'), 'the shell to be live');
    expect(warnings).toHaveLength(1);
    expect(srv.agentForwardRequests).toHaveLength(0);
  });

  it('does not forward when the host has it off', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession({ agentPath: '/nonexistent/agent.sock' });
    await session.connect(connection({ port: srv.port }), trustAll);
    const shell = await session.openShell({ cols: 80, rows: 24 });
    shell.write('x\n');
    await waitFor(() => srv.shellInput.includes('x'), 'the shell to be live');
    expect(srv.agentForwardRequests).toHaveLength(0);
  });
});

describe('key re-exchange', () => {
  it('completes a server-initiated rekey without asking about the host key again', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession();
    let asked = 0;
    await session.connect(connection({ port: srv.port }), {
      verifyHostKey: async () => (asked++, true),
    });
    const shell = await session.openShell({ cols: 80, rows: 24 });
    const out = collect(shell);

    await withTimeout(srv.rekeyAll(), 'the rekey to complete');
    shell.write('after rekey\n');
    await waitFor(() => out.text().includes('after rekey'), 'the shell to answer after the rekey');
    expect(asked).toBe(1);
    expect(session.status).toEqual({ state: 'ready' });
  });

  it('closes the session when a rekey presents a different host key', async () => {
    const srv = await server({ users: { alice: { password: 'pw' } } });
    const session = newSession();
    let asked = 0;
    await session.connect(connection({ port: srv.port }), {
      verifyHostKey: async () => (asked++, true),
    });

    void srv.rekeyAll(generateKey()).catch(() => undefined);
    await withTimeout(
      new Promise<void>((resolve) =>
        session.onStatus((status) => status.state === 'closed' && resolve()),
      ),
      'the session to close',
    );

    expect(session.status).toMatchObject({
      state: 'closed',
      reason: { kind: 'error', error: { code: 'host_key_rejected' } },
    });
    expect(asked).toBe(1);
  });
});

describe('defaultAgentPath', () => {
  it('uses SSH_AUTH_SOCK on macOS and Linux', () => {
    expect(defaultAgentPath('darwin', { SSH_AUTH_SOCK: '/tmp/agent.1' })).toBe('/tmp/agent.1');
    expect(defaultAgentPath('linux', { SSH_AUTH_SOCK: ' /run/agent ' })).toBe('/run/agent');
    expect(defaultAgentPath('darwin', {})).toBeUndefined();
    expect(defaultAgentPath('linux', { SSH_AUTH_SOCK: '' })).toBeUndefined();
  });

  it('falls back to the OpenSSH named pipe on Windows', () => {
    expect(defaultAgentPath('win32', {})).toBe('\\\\.\\pipe\\openssh-ssh-agent');
    expect(defaultAgentPath('win32', { SSH_AUTH_SOCK: '\\\\.\\pipe\\custom' })).toBe(
      '\\\\.\\pipe\\custom',
    );
  });
});
