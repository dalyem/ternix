import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ssh2 from 'ssh2';
import { OS_PROBE_COMMAND } from '@ternix/ssh';
import { serveSftp } from '../../../../packages/ssh/test/sftpServer.js';

const { Server, utils } = ssh2;

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

export interface RunningServer {
  url: string;
  /**
   * What a malicious server could do to the database. `substituteKey` replaces a user's
   * public key (by email) with a random one and returns the new key; `sharedKeyVersions`
   * lists the key versions of the shared vaults the user belongs to, to prove that nothing
   * was rotated.
   */
  db: { substituteKey(email: string): string; sharedKeyVersions(email: string): number[] };
  stop(): Promise<void>;
}

/** The server package's own `better-sqlite3`, opened on the server's database file. */
function openServerDb(dataDir: string) {
  const serverPackage = resolve(import.meta.dirname, '../../../server/package.json');
  const Database = createRequire(serverPackage)('better-sqlite3') as new (file: string) => {
    prepare(sql: string): {
      run(...args: unknown[]): { changes: number };
      all(...args: unknown[]): unknown[];
    };
    pragma(sql: string): unknown;
    close(): void;
  };
  const db = new Database(join(dataDir, 'ternix.db'));
  db.pragma('busy_timeout = 5000');
  return db;
}

/** The real `@ternix/server` (built with `pnpm --filter @ternix/server build`), open registration. */
export async function startTernixServer(): Promise<RunningServer> {
  const main = resolve(import.meta.dirname, '../../../server/dist/main.js');
  const dataDir = mkdtempSync(join(tmpdir(), 'ternix-e2e-server-'));
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [main], {
    env: {
      ...process.env,
      TERNIX_DATA_DIR: dataDir,
      TERNIX_REGISTRATION: 'open',
      TERNIX_LOG_LEVEL: 'warn',
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/v1/server`);
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    db: {
      substituteKey: (email) => {
        const db = openServerDb(dataDir);
        try {
          const publicKey = randomBytes(32).toString('base64');
          const result = db
            .prepare('UPDATE users SET public_key = ? WHERE email = ?')
            .run(publicKey, email);
          if (result.changes !== 1) throw new Error(`no user ${email}`);
          return publicKey;
        } finally {
          db.close();
        }
      },
      sharedKeyVersions: (email) => {
        const db = openServerDb(dataDir);
        try {
          const rows = db
            .prepare(
              `SELECT v.key_version FROM vaults v
                 JOIN vault_members m ON m.vault_id = v.id
                 JOIN users u ON u.id = m.user_id
                WHERE u.email = ? AND v.kind = 'shared'
                ORDER BY v.created_at, v.id`,
            )
            .all(email) as { key_version: number }[];
          return rows.map((row) => row.key_version);
        } finally {
          db.close();
        }
      },
    },
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * A malicious server in front of `target`: it forwards every request, but answers a
 * registration with another account key than the one the app sent.
 */
export async function startKeySwappingProxy(
  target: string,
): Promise<{ url: string; stop(): Promise<void> }> {
  const proxy = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'authorization']) {
          const value = req.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        const upstream = await fetch(`${target}${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers,
          ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
          redirect: 'manual',
        });
        let body = Buffer.from(await upstream.arrayBuffer());
        if (req.method === 'POST' && req.url === '/api/v1/auth/register' && upstream.ok) {
          const json = JSON.parse(body.toString('utf8')) as { user: { public_key: string } };
          json.user.public_key = randomBytes(32).toString('base64');
          body = Buffer.from(JSON.stringify(json));
        }
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        res.end(body);
      })().catch(() => {
        res.writeHead(502);
        res.end();
      });
    });
  });
  await new Promise<void>((ready) => proxy.listen(0, '127.0.0.1', ready));
  const { port } = proxy.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((done) => proxy.close(() => done())),
  };
}

export interface SshTarget {
  address: string;
  port: number;
  username: string;
  password: string;
  /** `SHA256:...` of the host key, when known (the in-process server). */
  fingerprint: string | undefined;
  /** In-process server only: a key pair whose public half the server accepts for `username`. */
  userKey: { privateKey: string; publicKey: string } | undefined;
  /** In-process server only: also accept this OpenSSH public key line for `username`. */
  authorizeKey(publicKey: string): void;
  /** In-process server only: restart on the same port with a different host key. */
  rotateHostKey(): Promise<void>;
  stop(): Promise<void>;
}

const USERNAME = 'tester';
const PASSWORD = 'correct horse battery';

interface FakeSshd {
  fingerprint: string;
  stop(): Promise<void>;
}

/**
 * An `ssh2` server with a tiny fake shell (password auth, `echo`, `exit`) and port forwarding.
 * `exec` is refused, except the OS probe when `probeOutput` is set: then it prints that. With
 * `sftpRoot`, the SFTP subsystem serves that directory as `/` (the same server the
 * `@ternix/ssh` tests use); without it, SFTP is refused.
 */
async function startFakeSshd(
  port: number,
  authorizedKeys: readonly ssh2.ParsedKey[],
  probeOutput?: string,
  sftpRoot?: string,
): Promise<FakeSshd> {
  const hostKey = utils.generateKeyPairSync('ed25519');
  const wire = (utils.parseKey(hostKey.public) as ssh2.ParsedKey).getPublicSSH();
  const fingerprint = `SHA256:${createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;
  const clients = new Set<ssh2.Connection>();

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) {
        ctx.accept();
      } else if (ctx.method === 'publickey' && ctx.username === USERNAME) {
        const allowed = authorizedKeys.find(
          (key) =>
            ctx.key.algo === key.type && Buffer.compare(ctx.key.data, key.getPublicSSH()) === 0,
        );
        if (!allowed) return ctx.reject(['password']);
        // Without a signature the client only asks whether the key would be accepted.
        if (
          ctx.signature &&
          ctx.blob &&
          allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true
        ) {
          return ctx.reject(['password']);
        }
        ctx.accept();
      } else {
        ctx.reject(['password', 'publickey']);
      }
    });
    client.on('error', () => undefined);
    client.on('tcpip', (accept, _reject, info) => {
      const channel = accept();
      const socket = connect(info.destPort, info.destIP);
      socket.on('error', () => channel.destroy());
      channel.on('error', () => socket.destroy());
      channel.pipe(socket).pipe(channel);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('window-change', (acceptResize) => acceptResize?.());
        session.on('sftp', (acceptSftp, rejectSftp) => {
          if (sftpRoot === undefined) return void rejectSftp?.();
          serveSftp(acceptSftp(), { root: sftpRoot });
        });
        session.on('exec', (acceptExec, rejectExec, info) => {
          if (probeOutput === undefined || info.command !== OS_PROBE_COMMAND) {
            return void rejectExec?.();
          }
          const stream = acceptExec();
          stream.write(probeOutput);
          stream.exit(0);
          stream.end();
        });
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          let line = '';
          stream.write('Welcome to fake-sshd\r\n$ ');
          stream.on('data', (chunk: Buffer) => {
            for (const ch of chunk.toString('utf8')) {
              if (ch === '\r') {
                stream.write('\r\n');
                const command = line.trim();
                line = '';
                const echo = /^echo (.*)$/.exec(command);
                if (command === 'exit') {
                  stream.exit(0);
                  stream.end();
                  return;
                }
                if (echo) stream.write(`${(echo[1] ?? '').replace(/''|""/g, '')}\r\n`);
                else if (command !== '')
                  stream.write(`fake-sshd: ${command}: command not found\r\n`);
                stream.write('$ ');
              } else if (ch === '\x7f') {
                if (line.length > 0) {
                  line = line.slice(0, -1);
                  stream.write('\b \b');
                }
              } else {
                line += ch;
                stream.write(ch);
              }
            }
          });
        });
      });
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    fingerprint,
    stop: () =>
      new Promise<void>((r) => {
        for (const client of clients) client.end();
        server.close(() => r());
      }),
  };
}

/**
 * An SSH server for the test to connect to. By default an in-process `ssh2` server; set
 * E2E_SSH_ADDRESS, E2E_SSH_PORT, E2E_SSH_USER and E2E_SSH_PASSWORD to use a real OpenSSH
 * `sshd` instead (then `fingerprint` is undefined and `rotateHostKey` is unavailable).
 */
export async function startSshTarget(
  options: {
    /** What the fake server prints for the OS probe (ignored for a real sshd). */
    probeOutput?: string;
    /** A directory the fake server's SFTP serves as `/` (ignored for a real sshd). */
    sftpRoot?: string;
  } = {},
): Promise<SshTarget> {
  const external = process.env['E2E_SSH_ADDRESS'];
  if (external) {
    return {
      address: external,
      port: Number(process.env['E2E_SSH_PORT'] ?? 22),
      username: process.env['E2E_SSH_USER'] ?? 'e2e',
      password: process.env['E2E_SSH_PASSWORD'] ?? '',
      fingerprint: undefined,
      userKey: undefined,
      authorizeKey: () => {
        throw new Error('A real sshd cannot authorize a key from the test');
      },
      rotateHostKey: async () => {
        throw new Error('A real sshd cannot rotate its host key from the test');
      },
      stop: async () => undefined,
    };
  }
  const port = await freePort();
  const pair = utils.generateKeyPairSync('ed25519', { comment: 'e2e' });
  // Shared with every restart of the server, so keys authorized later survive a host key rotation.
  const authorized = [utils.parseKey(pair.public) as ssh2.ParsedKey];
  let current = await startFakeSshd(port, authorized, options.probeOutput, options.sftpRoot);
  const target: SshTarget = {
    address: '127.0.0.1',
    port,
    username: USERNAME,
    password: PASSWORD,
    fingerprint: current.fingerprint,
    userKey: { privateKey: pair.private, publicKey: pair.public },
    authorizeKey: (publicKey) => {
      const key = utils.parseKey(publicKey.trim());
      const first = Array.isArray(key) ? key[0] : key;
      if (!first || first instanceof Error) throw new Error('Not an OpenSSH public key line');
      authorized.push(first);
    },
    rotateHostKey: async () => {
      await current.stop();
      current = await startFakeSshd(port, authorized, options.probeOutput, options.sftpRoot);
      target.fingerprint = current.fingerprint;
    },
    stop: () => current.stop(),
  };
  return target;
}

/** A TCP echo server, the destination of the port-forward test. */
export async function startEchoServer(): Promise<{ port: number; stop(): Promise<void> }> {
  const server = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { port, stop: () => new Promise<void>((r) => server.close(() => r())) };
}
