import type { ItemPayload } from '@ternix/core/items';
import type { VaultDto } from '../../shared/types.js';
import type { ItemView } from './store.js';

export type PayloadOf<T extends ItemPayload['type']> = Extract<ItemPayload, { type: T }>;
export type ItemOf<T extends ItemPayload['type']> = ItemView & { payload: PayloadOf<T> };

export function itemsOfType<T extends ItemPayload['type']>(
  items: readonly ItemView[],
  type: T,
): ItemOf<T>[] {
  return items.filter((i): i is ItemOf<T> => i.payload.type === type);
}

/** Items in the same order everywhere: label, then ID. */
export function byLabel<T extends ItemView>(a: T, b: T): number {
  return labelOf(a.payload).localeCompare(labelOf(b.payload)) || a.id.localeCompare(b.id);
}

export function labelOf(payload: ItemPayload): string {
  return payload.type === 'known_host' ? `${payload.host}:${payload.port}` : payload.label;
}

export function vaultTitle(vault: VaultDto | undefined): string {
  if (!vault) return 'Unknown vault';
  return vault.name ?? 'Unreadable vault';
}

/** Owners and editors may write; so can nobody in a vault whose key cannot be opened. */
export function canWrite(vault: VaultDto | undefined): boolean {
  return vault !== undefined && vault.error === null && vault.role !== 'viewer';
}

export function writableVaults(vaults: readonly VaultDto[]): VaultDto[] {
  return vaults.filter(canWrite);
}

/** `user@address:port`, with the parts a host actually has. */
export function describeHost(host: PayloadOf<'host'>): string {
  const user = host.username ? `${host.username}@` : '';
  const port = host.port !== 22 ? `:${host.port}` : '';
  return `${user}${host.address}${port}`;
}

/** SHA-256 fingerprint of a base64 wire-format host key, as OpenSSH prints it. */
export async function hostKeyFingerprint(publicKeyB64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `SHA256:${btoa(binary).replace(/=+$/, '')}`;
}
