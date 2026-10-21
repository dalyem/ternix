# @ternix/ssh

The SSH engine of the Ternix desktop app. It turns decrypted vault items
(`@ternix/core/items`) into live SSH sessions with [`ssh2`](https://github.com/mscdex/ssh2).
It has no dependency on Electron or any UI: the main process wires it to the vault and to an
xterm.js terminal.

Build it with `pnpm build:packages` (core first, then this package).

## Usage

```ts
import {
  SshSession,
  checkHostKey,
  defaultAgentPath,
  knownHostItems,
  knownHostPayload,
  resolveConnection,
} from '@ternix/ssh';

// `items` is every decrypted item the user can read, across all vaults: Map<id, ItemPayload>.
const settings = resolveConnection(items, hostId); // throws ResolveError

const session = new SshSession({
  knownHosts: knownHostItems(items.values()),
  agentPath: defaultAgentPath(process.platform, process.env),
});
session.onStatus((s) => console.log(s.state)); // connecting, verifying-host-key, authenticating, ready, closed

await session.connect(settings, {
  // Called for every hop, jump hosts included.
  async verifyHostKey(info) {
    if (info.status === 'trusted') return true;
    // 'unknown': show info.fingerprint and ask. 'mismatch': warn loudly, show info.stored.
    const ok = await askUser(info);
    if (ok && info.status === 'unknown')
      saveItem(
        knownHostPayload({
          host: info.host,
          port: info.port,
          keyType: info.keyType,
          keyB64: info.key,
        }),
      );
    return ok;
  },
  keyboardInteractive: (request) => askForAnswers(request.prompts), // 2FA, password prompts
  onBanner: (message) => showBanner(message),
});

const shell = await session.openShell({ cols: 120, rows: 40 });
shell.onData((bytes) => terminal.write(bytes));
shell.onExit(({ code }) => terminal.writeln(`exited ${code}`));
terminal.onData((text) => shell.write(text));
terminal.onResize(({ cols, rows }) => shell.resize(cols, rows));

for (const forward of settings.portForwards) await session.startForward(forward);
const os = await session.detectOs(); // 'ubuntu', 'macos', ... or undefined; never rejects
await session.close();
```

Failures are `SshError`s with a stable `code` (`auth_failed`, `bad_passphrase`,
`host_key_rejected`, `timeout`, ...) and the `hop` they belong to. Resolution failures are
`ResolveError`s (`no_username`, `jump_cycle`, ...).

## Resolution rules

`resolveConnection` follows `docs/protocol.md`: for each setting the first source that has it wins.

| Setting                    | Order                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| username                   | host, host's identity, then each group nearest first: the group, then the group's identity |
| password                   | host, host's identity, group identities                                                    |
| private key and passphrase | host `key_id`, host's identity `key_id`, group identities                                  |
| port                       | host (always has one; the payload defaults it to 22)                                       |

A host always has a port (the payload defaults it to 22), so its port is authoritative and an
explicit 22 is respected. A group's `port` is not inherited when resolving: it is only a default
for the UI to pre-fill when creating a new host in that group. Dangling or wrong-type references count as unset. Jump hosts
(`jump_host_id`, up to 8, cycles are errors) are resolved the same way, each with its own
identity. Keepalive, agent forwarding and the startup snippet come from the host only.

## Behavior notes

- Authentication order per hop: `none` (to learn the methods), private key, password,
  keyboard-interactive. Methods the server does not offer are skipped. A lone password prompt in
  keyboard-interactive is answered with the stored password when the password method was not
  tried; other prompts go to the hook.
- `verifyHostKey` is called with status `trusted`, `unknown` or `mismatch`. With no hook, only
  `trusted` passes. A hook that returns false or throws aborts before any credentials are sent.
- The connect and sign-in timeouts do not run while a hook is waiting for the user.
- The startup snippet is sent each time a shell opens (`runStartup: false` skips it).
- Agent forwarding applies to the target hop only, never to jump hosts.
- Port forwards bind to 127.0.0.1 when `bindAddress` is empty. `dynamic` is a SOCKS5 server
  (no authentication, CONNECT only).

## Operating system detection

`session.detectOs()` guesses the target's operating system (the `os` values of a host item in
`docs/protocol.md`). It first reads the server's identification line: distribution builds of
OpenSSH append their name (`SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5`), and Windows reports
`OpenSSH_for_Windows`. Unless that says Windows, it then opens one exec channel (no PTY, stdin
closed at once, stderr discarded) running exactly `OS_PROBE_COMMAND`:

```sh
uname -s 2>/dev/null; cat /etc/os-release 2>/dev/null
```

The kernel name decides macOS, the BSDs and Cygwin/MSYS; on Linux the os-release `ID`, then each
`ID_LIKE` entry, picks the distribution, else plain `linux`. Output past 16 KiB is not read (the
channel is closed) and the probe gives up after 5 s. The output is untrusted: only exact
`KEY=value` lines with plain or simply quoted values count. When the probe is refused, times out
or says nothing, the identification line decides; when neither knows, the result is `undefined`.
The command runs on the remote host and shows up in its logs like any other `ssh host command`.

## Generating keys

`generateSshKey({ spec, comment, passphrase })` makes an OpenSSH key pair (Ed25519 by default;
`{ type: 'rsa', bits }` with 2048, 3072 or 4096, default 4096; `{ type: 'ecdsa', bits }` with 256,
384 or 521, default 256) and returns `{ privateKey, publicKey, keyType, fingerprint }`: the PEM,
the `authorized_keys` line (with the comment), the SSH algorithm name and the `SHA256:...`
fingerprint. The key search runs on libuv's thread pool, so a 4096-bit RSA key does not block the
event loop. A passphrase encrypts the private key with aes256-ctr and 16 bcrypt rounds, as
`ssh-keygen` does.

ssh2's generator now and then returns an Ed25519 key its own `parseKey` rejects (about 1 in 256:
it strips every leading zero byte of the public key, so a public key that starts with `0x00` is one
byte short). So every draw is read back before it is returned: the private key must parse with the
passphrase, be of the requested type, and sign data that the public line verifies. A draw that
fails is thrown away and drawn again; sixteen failures in a row throw `SshError('invalid_key')`.

`describePrivateKey(privateKey, passphrase?)` gives the same `{ keyType, publicKey, fingerprint }`
for a key that already exists (OpenSSH or PEM; the comment is the one stored in the key) and throws
`SshError` `invalid_key`, `passphrase_required` or `bad_passphrase`. `samePublicKey` and
`fingerprintOfPublicKey` work on `authorized_keys` lines.
