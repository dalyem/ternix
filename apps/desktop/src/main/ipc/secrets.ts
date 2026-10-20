import type {
  ItemDraft,
  ItemDraftInput,
  ItemDto,
  ItemPayload,
  ItemSecretsDto,
  ListedItemDto,
  ListedPayload,
  ListedVaultItemsDto,
  ListedWriteResultDto,
  VaultItemsDto,
  WriteResultDto,
} from '../../shared/types.js';
import { SECRET_FIELDS } from '../../shared/types.js';

/**
 * Secret fields stay in main unless the renderer asks for one item's (`items.reveal`). Lists
 * carry `has_<field>` flags instead, and edits that leave a secret out keep the stored value.
 */

const present = (value: unknown): value is string => typeof value === 'string' && value !== '';

export function redactPayload(payload: ItemPayload): ListedPayload {
  const out: Record<string, unknown> = { ...payload };
  for (const field of SECRET_FIELDS[payload.type]) {
    out[`has_${field}`] = present(out[field]);
    delete out[field];
  }
  return out as ListedPayload;
}

export const redactItem = (item: ItemDto): ListedItemDto => ({
  ...item,
  payload: redactPayload(item.payload),
});

export const redactItems = (vault: VaultItemsDto): ListedVaultItemsDto => ({
  vaultId: vault.vaultId,
  items: vault.items.map(redactItem),
  unreadable: vault.unreadable,
});

export const redactWrite = (result: WriteResultDto): ListedWriteResultDto => ({
  id: result.id,
  status: result.status,
  item: result.item ? redactItem(result.item) : null,
});

export function secretsOf(payload: ItemPayload): ItemSecretsDto {
  const fields = payload as Partial<Record<string, unknown>>;
  const out: ItemSecretsDto = {};
  for (const field of SECRET_FIELDS[payload.type]) {
    const value = fields[field];
    if (present(value)) out[field] = value;
  }
  return out;
}

/**
 * Applies `ItemDraftInput`'s rule for secret fields: absent keeps the value of `stored` (when
 * it is the same type), a non-empty string sets it, `null` or `''` clears it. The result
 * still has to pass the draft schema (a cleared `private_key` does not).
 */
export function mergeSecrets(draft: ItemDraftInput, stored: ItemPayload | undefined): ItemDraft {
  const out: Record<string, unknown> = { ...draft };
  const previous =
    stored?.type === draft.type ? (stored as Partial<Record<string, unknown>>) : undefined;
  for (const field of SECRET_FIELDS[draft.type]) {
    if (!(field in draft) || out[field] === undefined) {
      const kept = previous?.[field];
      if (present(kept)) out[field] = kept;
      else delete out[field];
    } else if (!present(out[field])) {
      delete out[field];
    }
  }
  return out as ItemDraft;
}
