import { fingerprint, fromB64 } from '@ternix/core/crypto';
import type { AppInfo, ImportedFile } from '../../shared/app.js';
import type { ClientSnapshot } from '../../shared/ipc.js';
import type { ListedVaultItemsDto, LogoutResultDto } from '../../shared/types.js';
import type { TernixClient } from '../client/index.js';
import { isTailnetHost } from '../client/serverUrl.js';
import { AppError } from '../app/errors.js';
import type { SafeStorageSecretStore } from '../app/secretStore.js';
import type { ServerAddressStore } from '../app/serverAddress.js';
import type { SettingsStore } from '../app/settings.js';
import { confirmMember, type MemberAction, type MessageBox } from '../app/trust.js';
import type { SshManager } from '../ssh/manager.js';
import type { Handlers } from './dispatch.js';
import { type PageGate, type SessionNotices, stalePageError } from './pageGate.js';
import { generateKeyDraft, withPublicKey } from './keys.js';
import { itemDraftSchema } from './schemas.js';
import {
  keepDetectedOs,
  mergeSecrets,
  redactItem,
  redactItems,
  redactWrite,
  secretsOf,
} from './secrets.js';

export interface HandlerDeps {
  client: TernixClient;
  settings: SettingsStore;
  ssh: SshManager;
  secrets: SafeStorageSecretStore;
  /** The server address the sign-in screen starts with. */
  serverAddress: ServerAddressStore;
  /** Why the last session ended, for the page that loads after it. */
  notices: SessionNotices;
  /** Which page load is current (the gate already refused requests from older ones). */
  pages: Pick<PageGate, 'issue' | 'isCurrent'>;
  appInfo(): AppInfo;
  writeClipboard(text: string): void;
  /** Native file dialog; null when the user cancelled. */
  importKeyFile(): Promise<ImportedFile | null>;
  /** Confirm with the user, then open in the default browser. */
  openLink(url: string): Promise<void>;
  onSettingsChanged(): void;
  /** Native message box on the app window, for the trust decisions in `app/trust.ts`. */
  messageBox: MessageBox;
}

/** The user declined a native confirmation: nothing was changed. */
const declined = () => new AppError('cancelled', 'Not confirmed; nothing was changed.');

function fingerprintOf(publicKey: string): string {
  try {
    return fingerprint(fromB64(publicKey));
  } catch {
    throw new AppError('invalid_input', 'That is not a public key.');
  }
}

/** The method table: what each IPC request does. Arguments are already validated. */
export function createHandlers(deps: HandlerDeps): Handlers {
  const { client, ssh, secrets } = deps;
  const snapshot = (): ClientSnapshot => ({
    state: client.state,
    connection: client.connection,
    account: client.account,
    serverUrl: deps.serverAddress.get(),
    notice: deps.notices.current,
  });
  const signedOut = () => client.state === 'loggedOut' || client.state === 'expired';
  /** The page generation of each `auth.logout` that has not returned yet. */
  const loggingOut: number[] = [];
  /**
   * For requests that pick a server (probe, remember, login, register): only while signed out,
   * and not from a page whose own logout is still running, so a signed-in page cannot queue one
   * behind that logout and have it run after the page was replaced. (The page that loads after
   * the logout has a new generation and may go ahead.) Returns a check for after each `await`:
   * the page that sent the request must still be the current one.
   *
   * Called synchronously at handler entry, where the gate has just checked the caller's
   * generation, so `pages.issue()` is the caller's generation.
   */
  const choosingServer = (): (() => void) => {
    const page = deps.pages.issue();
    if (!signedOut() || loggingOut.includes(page)) {
      throw new AppError('forbidden', 'Sign out before connecting to another server.');
    }
    return () => {
      if (!deps.pages.isCurrent(page)) throw stalePageError();
    };
  };
  /** A successful sign-in decides the address the sign-in screen offers next time. */
  const rememberServer = async <T extends { serverUrl: string }>(account: T): Promise<T> => {
    await deps.serverAddress.set(account.serverUrl).catch(() => undefined);
    return account;
  };
  const allItems = (): ListedVaultItemsDto[] =>
    client.listVaults().map((vault) => {
      try {
        return redactItems(ssh.displayItems(client.listItems(vault.id)));
      } catch {
        return { vaultId: vault.id, items: [], unreadable: [] };
      }
    });

  // Email and name of every user the server reported to this account (lookups, member and user
  // lists): what the trust dialogs show, instead of anything the renderer says about the user.
  const people = new Map<string, { email: string; name: string }>();
  const personKey = (userId: string) => `${client.account?.user.id ?? ''}:${userId}`;
  const remember = <T extends { email: string; name: string }>(userId: string, who: T): T => {
    people.set(personKey(userId), { email: who.email, name: who.name });
    return who;
  };
  const askAboutMember = async (userId: string, publicKey: string, action: MemberAction) => {
    const who = people.get(personKey(userId));
    if (!who) {
      throw new AppError('invalid_input', 'Look the person up again before trusting their key.');
    }
    const fp = fingerprintOf(publicKey);
    if (!(await confirmMember(deps.messageBox, { ...who, fingerprint: fp }, action))) {
      throw declined();
    }
  };
  /** Fingerprint of the key this device pinned for `userId`, when a member list showed it. */
  const pinnedFingerprints = new Map<string, string>();

  return {
    'app.info': async () => deps.appInfo(),
    'settings.get': async () => deps.settings.get(),
    'settings.set': async (patch) => {
      const next = await deps.settings.update(patch);
      deps.onSettingsChanged();
      return next;
    },
    'clipboard.write': async ({ text }) => deps.writeClipboard(text),
    'dialog.importKey': () => deps.importKeyFile(),
    'shell.openLink': ({ url }) => deps.openLink(url),

    'client.snapshot': async () => snapshot(),
    'server.probe': async ({ address }) => {
      // An unlocked (or locked) renderer must not reach arbitrary URLs: the path alone could
      // carry vault data out. The server address is only chosen while signed out.
      const checkPage = choosingServer();
      const info = await client.probeServer(address);
      checkPage();
      return { ...info, tailnet: isTailnetHost(new URL(info.serverUrl).hostname) };
    },
    'server.remember': async ({ serverUrl }) => {
      // Like probing: a signed-in page could otherwise plant an address (with data in its
      // path) for the page after sign-out to probe.
      choosingServer();
      await deps.serverAddress.set(serverUrl);
    },
    'auth.register': async (input) => {
      const checkPage = choosingServer();
      secrets.assertAvailable();
      ssh.forgetAccount();
      const account = await client.register(input);
      checkPage();
      return rememberServer(account);
    },
    'auth.login': async (input) => {
      const checkPage = choosingServer();
      secrets.assertAvailable();
      ssh.forgetAccount();
      const account = await client.login(input);
      checkPage();
      return rememberServer(account);
    },
    'auth.unlock': ({ password }) => client.unlock(password),
    'auth.lock': async () => {
      ssh.cancelAllPrompts();
      await client.lock();
    },
    'auth.logout': async ({ forgetServer }) => {
      const page = deps.pages.issue();
      loggingOut.push(page);
      try {
        let result: LogoutResultDto;
        try {
          result = await client.logout();
        } catch (err) {
          // No session to end (an own-key mismatch during login or register leaves none): the
          // user is signed out already, which is what they asked for.
          if ((err as { code?: unknown } | null)?.code !== 'not_logged_in') throw err;
          result = { serverRevoked: true };
        }
        // For the page that loads after the sign-out (this one is being replaced).
        deps.notices.current = result.serverRevoked ? null : 'logout_unrevoked';
        if (forgetServer) await deps.serverAddress.set(null).catch(() => undefined);
        await ssh.closeAll();
        return result;
      } finally {
        loggingOut.splice(loggingOut.indexOf(page), 1);
      }
    },
    'auth.changePassword': ({ current, next }) => client.changePassword(current, next),
    'account.revalidate': () => client.revalidate(),
    'devices.list': () => client.listDevices(),
    'devices.revoke': ({ deviceId }) => client.revokeDevice(deviceId),

    'admin.invites.list': () => client.listInvites(),
    'admin.invites.create': (input) => client.createInvite(input),
    'admin.invites.delete': ({ code }) => client.deleteInvite(code),
    'admin.users.list': async () =>
      (await client.listUsers()).map((user) => remember(user.id, user)),
    'admin.users.delete': ({ userId }) => client.deleteUser(userId),

    'vaults.list': async () => client.listVaults(),
    'vaults.create': ({ name }) => client.createVault(name),
    'vaults.rename': ({ vaultId, name }) => client.renameVault(vaultId, name),
    'vaults.delete': ({ vaultId }) => client.deleteVault(vaultId),
    'vaults.sync': () => client.sync(),
    'vaults.members': async ({ vaultId }) => {
      const members = await client.listMembers(vaultId);
      for (const m of members) {
        remember(m.userId, m);
        pinnedFingerprints.set(personKey(m.userId), m.pinnedFingerprint);
      }
      return members;
    },
    'vaults.lookupUser': async ({ email }) => {
      const found = await client.lookupUser(email);
      if (found.pinnedFingerprint !== null) {
        pinnedFingerprints.set(personKey(found.id), found.pinnedFingerprint);
      }
      return remember(found.id, found);
    },
    'vaults.addMember': async ({ vaultId, userId, role, expectedPublicKey }) => {
      const vault = client.getVault(vaultId);
      await askAboutMember(userId, expectedPublicKey, {
        kind: 'add',
        vaultName: vault.name ?? 'this vault',
        role,
      });
      return client.addMember(vaultId, userId, role, expectedPublicKey);
    },
    'vaults.markMemberVerified': async ({ userId, publicKey }) => {
      await askAboutMember(userId, publicKey, { kind: 'verify' });
      return client.markMemberVerified(userId, publicKey);
    },
    'vaults.acceptMemberKey': async ({ userId, publicKey }) => {
      const pinned = pinnedFingerprints.get(personKey(userId));
      await askAboutMember(userId, publicKey, {
        kind: 'accept',
        ...(pinned !== undefined && pinned !== fingerprintOf(publicKey)
          ? { pinnedFingerprint: pinned }
          : {}),
      });
      return client.acceptMemberKey(userId, publicKey);
    },
    'vaults.changeRole': ({ vaultId, userId, role }) =>
      client.changeMemberRole(vaultId, userId, role),
    'vaults.removeMember': ({ vaultId, userId }) => client.removeMember(vaultId, userId),
    'vaults.leave': ({ vaultId }) => client.leaveVault(vaultId),
    'vaults.rotate': ({ vaultId }) => client.rotateVault(vaultId),

    'items.all': async () => allItems(),
    'items.reveal': async ({ vaultId, itemId }) => {
      const item = client.getItem(vaultId, itemId);
      if (!item) throw new AppError('not_found', 'That item no longer exists.');
      return secretsOf(item.payload);
    },
    'items.put': async ({ vaultId, itemId, draft }) => {
      const stored = itemId ? client.getItem(vaultId, itemId) : null;
      // Known hosts are written by main only, after the user accepted the key in its dialog.
      if (draft.type === 'known_host' || stored?.payload.type === 'known_host') {
        throw new AppError('forbidden', 'Known hosts are saved when you accept a host key.');
      }
      const parsed = itemDraftSchema.safeParse(
        withPublicKey(
          keepDetectedOs(mergeSecrets(draft, stored?.payload), stored?.payload),
          stored?.payload,
        ),
      );
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
        throw new AppError(
          'invalid_input',
          `Invalid item${where}: ${issue?.message ?? 'bad input'}`,
        );
      }
      return redactWrite(await client.putItem(vaultId, itemId, parsed.data));
    },
    'items.delete': async ({ vaultId, itemId }) =>
      redactWrite(await client.deleteItem(vaultId, itemId)),
    'keys.generate': async (input) => {
      // Generation takes a while (RSA 4096 seconds): the page, the session and the account
      // must still be the ones that asked when the key is ready to be saved.
      const page = deps.pages.issue();
      const accountId = client.account?.user.id;
      const vault = client.getVault(input.vaultId);
      if (vault.error !== null || vault.role === 'viewer') {
        throw new AppError('forbidden', 'You cannot add keys to this vault.');
      }
      const { key, draft } = await generateKeyDraft(input);
      if (
        !deps.pages.isCurrent(page) ||
        client.state !== 'unlocked' ||
        client.account?.user.id !== accountId
      ) {
        throw new AppError(
          'cancelled',
          'The session changed while the key was generated; it was not saved.',
        );
      }
      const parsed = itemDraftSchema.parse(draft);
      const written = await client.putItem(input.vaultId, undefined, parsed);
      if (written.status !== 'saved' || !written.item) {
        throw new AppError('conflict', 'The key could not be saved. Try again.');
      }
      return {
        item: redactItem(written.item),
        keyType: key.keyType,
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
      };
    },

    'ssh.list': async () => ssh.list(),
    'ssh.open': async ({ hostId, cols, rows }) => ssh.open(hostId, cols, rows),
    'ssh.quickConnect': async ({ target, password, cols, rows }) =>
      ssh.quickConnect(target, password, cols, rows),
    'ssh.attach': async ({ id }) => ssh.attach(id),
    'ssh.write': async ({ id, data }) => ssh.write(id, data),
    'ssh.resize': async ({ id, cols, rows }) => ssh.resize(id, cols, rows),
    'ssh.reconnect': async ({ id, cols, rows }) => ssh.reconnect(id, cols, rows),
    'ssh.close': ({ id }) => ssh.close(id),
    'ssh.answerKeyboard': async ({ promptId, answers }) => ssh.answerKeyboard(promptId, answers),
    'ssh.forward.start': ({ id, forwardId }) => ssh.startForward(id, forwardId),
    'ssh.forward.stop': ({ id, forwardId }) => ssh.stopForward(id, forwardId),
  };
}
