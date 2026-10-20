import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ssh2 from 'ssh2';

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

export interface SshTarget {
  address: string;
  port: number;
  username: string;
  password: string;
  /** `SHA256:...` of the host key, when known (the in-process server). */
  fingerprint: string | undefined;
  /** In-process server only: a key pair whose public half the server accepts for `username`. */
  userKey: { privateKey: string; publicKey: string } | undefined;
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

/** An `ssh2` server with a tiny fake shell (password auth, `echo`, `exit`) and port forwarding. */
async function startFakeSshd(port: number, authorizedKey: string): Promise<FakeSshd> {
  const allowed = utils.parseKey(authorizedKey) as ssh2.ParsedKey;
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
        const sameKey =
          ctx.key.algo === allowed.type &&
          Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0;
        if (!sameKey) return ctx.reject(['password']);
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
export async function startSshTarget(): Promise<SshTarget> {
  const external = process.env['E2E_SSH_ADDRESS'];
  if (external) {
    return {
      address: external,
      port: Number(process.env['E2E_SSH_PORT'] ?? 22),
      username: process.env['E2E_SSH_USER'] ?? 'e2e',
      password: process.env['E2E_SSH_PASSWORD'] ?? '',
      fingerprint: undefined,
      userKey: undefined,
      rotateHostKey: async () => {
        throw new Error('A real sshd cannot rotate its host key from the test');
      },
      stop: async () => undefined,
    };
  }
  const port = await freePort();
  const pair = utils.generateKeyPairSync('ed25519', { comment: 'e2e' });
  let current = await startFakeSshd(port, pair.public);
  const target: SshTarget = {
    address: '127.0.0.1',
    port,
    username: USERNAME,
    password: PASSWORD,
    fingerprint: current.fingerprint,
    userKey: { privateKey: pair.private, publicKey: pair.public },
    rotateHostKey: async () => {
      await current.stop();
      current = await startFakeSshd(port, pair.public);
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
