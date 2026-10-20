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
| port                       | host (if not 22), nearest group with a port, 22                                            |

The host payload defaults `port` to 22, so a host port of 22 cannot be told from "not set" and
yields to a group port. Dangling or wrong-type references count as unset. Jump hosts
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
