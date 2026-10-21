import type { ItemPayload } from '@ternix/core/items';
import type { TernixClient } from '../client/index.js';

export interface ItemRecord {
  vaultId: string;
  itemId: string;
  /** The server version the payload is, for writes that must not override a newer one. */
  seq: number;
  payload: ItemPayload;
}

/** Every readable item across all vaults, as the SSH engine wants it. */
export interface ItemSnapshot {
  lookup: Map<string, ItemPayload>;
  records: Map<string, ItemRecord>;
  personalVaultId: string | null;
}

export type VaultReader = Pick<TernixClient, 'listVaults' | 'listItems'>;

/**
 * Decrypted items from memory (the client must be unlocked). Vaults that cannot be opened
 * are skipped; the personal vault comes first so its items win an ID collision.
 */
export function snapshotItems(client: VaultReader): ItemSnapshot {
  const vaults = client
    .listVaults()
    .slice()
    .sort((a, b) => Number(b.kind === 'personal') - Number(a.kind === 'personal'));
  const lookup = new Map<string, ItemPayload>();
  const records = new Map<string, ItemRecord>();
  let personalVaultId: string | null = null;
  for (const vault of vaults) {
    if (vault.kind === 'personal' && vault.role === 'owner') personalVaultId ??= vault.id;
    if (vault.error !== null) continue;
    for (const item of client.listItems(vault.id).items) {
      if (lookup.has(item.id)) continue;
      lookup.set(item.id, item.payload);
      records.set(item.id, {
        vaultId: vault.id,
        itemId: item.id,
        seq: item.seq,
        payload: item.payload,
      });
    }
  }
  return { lookup, records, personalVaultId };
}
