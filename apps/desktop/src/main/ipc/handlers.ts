import type { AppInfo, ImportedFile } from '../../shared/app.js';
import type { ClientSnapshot } from '../../shared/ipc.js';
import type { VaultItemsDto } from '../../shared/types.js';
import type { TernixClient } from '../client/index.js';
import { isTailnetHost } from '../client/serverUrl.js';
import type { SafeStorageSecretStore } from '../app/secretStore.js';
import type { SettingsStore } from '../app/settings.js';
import type { SshManager } from '../ssh/manager.js';
import type { Handlers } from './dispatch.js';

export interface HandlerDeps {
  client: TernixClient;
  settings: SettingsStore;
  ssh: SshManager;
  secrets: SafeStorageSecretStore;
  appInfo(): AppInfo;
  writeClipboard(text: string): void;
  /** Native file dialog; null when the user cancelled. */
  importKeyFile(): Promise<ImportedFile | null>;
  /** Confirm with the user, then open in the default browser. */
  openLink(url: string): Promise<void>;
  onSettingsChanged(): void;
}

/** The method table: what each IPC request does. Arguments are already validated. */
export function createHandlers(deps: HandlerDeps): Handlers {
  const { client, ssh, secrets } = deps;
  const snapshot = (): ClientSnapshot => ({
    state: client.state,
    connection: client.connection,
    account: client.account,
  });
  const allItems = (): VaultItemsDto[] =>
    client.listVaults().map((vault) => {
      try {
        return client.listItems(vault.id);
      } catch {
        return { vaultId: vault.id, items: [], unreadable: [] };
      }
    });

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
      const info = await client.probeServer(address);
      return { ...info, tailnet: isTailnetHost(new URL(info.serverUrl).hostname) };
    },
    'auth.register': async (input) => {
      secrets.assertAvailable();
      return client.register(input);
    },
    'auth.login': async (input) => {
      secrets.assertAvailable();
      return client.login(input);
    },
    'auth.unlock': ({ password }) => client.unlock(password),
    'auth.lock': async () => {
      ssh.cancelAllPrompts();
      await client.lock();
    },
    'auth.logout': async () => {
      const result = await client.logout();
      await ssh.closeAll();
      return result;
    },
    'auth.changePassword': ({ current, next }) => client.changePassword(current, next),
    'account.revalidate': () => client.revalidate(),
    'devices.list': () => client.listDevices(),
    'devices.revoke': ({ deviceId }) => client.revokeDevice(deviceId),

    'admin.invites.list': () => client.listInvites(),
    'admin.invites.create': (input) => client.createInvite(input),
    'admin.invites.delete': ({ code }) => client.deleteInvite(code),
    'admin.users.list': () => client.listUsers(),
    'admin.users.delete': ({ userId }) => client.deleteUser(userId),

    'vaults.list': async () => client.listVaults(),
    'vaults.create': ({ name }) => client.createVault(name),
    'vaults.rename': ({ vaultId, name }) => client.renameVault(vaultId, name),
    'vaults.delete': ({ vaultId }) => client.deleteVault(vaultId),
    'vaults.sync': () => client.sync(),
    'vaults.members': ({ vaultId }) => client.listMembers(vaultId),
    'vaults.lookupUser': ({ email }) => client.lookupUser(email),
    'vaults.addMember': ({ vaultId, userId, role, expectedPublicKey }) =>
      client.addMember(vaultId, userId, role, expectedPublicKey),
    'vaults.markMemberVerified': ({ userId, publicKey }) =>
      client.markMemberVerified(userId, publicKey),
    'vaults.acceptMemberKey': ({ userId, publicKey }) => client.acceptMemberKey(userId, publicKey),
    'vaults.changeRole': ({ vaultId, userId, role }) =>
      client.changeMemberRole(vaultId, userId, role),
    'vaults.removeMember': ({ vaultId, userId }) => client.removeMember(vaultId, userId),
    'vaults.leave': ({ vaultId }) => client.leaveVault(vaultId),
    'vaults.rotate': ({ vaultId }) => client.rotateVault(vaultId),

    'items.all': async () => allItems(),
    'items.put': ({ vaultId, itemId, draft }) => client.putItem(vaultId, itemId, draft),
    'items.delete': ({ vaultId, itemId }) => client.deleteItem(vaultId, itemId),

    'ssh.list': async () => ssh.list(),
    'ssh.open': async ({ hostId, cols, rows }) => ssh.open(hostId, cols, rows),
    'ssh.quickConnect': async ({ target, password, cols, rows }) =>
      ssh.quickConnect(target, password, cols, rows),
    'ssh.attach': async ({ id }) => ssh.attach(id),
    'ssh.write': async ({ id, data }) => ssh.write(id, data),
    'ssh.resize': async ({ id, cols, rows }) => ssh.resize(id, cols, rows),
    'ssh.reconnect': async ({ id, cols, rows }) => ssh.reconnect(id, cols, rows),
    'ssh.close': ({ id }) => ssh.close(id),
    'ssh.answerHostKey': async ({ promptId, decision }) => ssh.answerHostKey(promptId, decision),
    'ssh.answerKeyboard': async ({ promptId, answers }) => ssh.answerKeyboard(promptId, answers),
    'ssh.forward.start': ({ id, forwardId }) => ssh.startForward(id, forwardId),
    'ssh.forward.stop': ({ id, forwardId }) => ssh.stopForward(id, forwardId),
  };
}
