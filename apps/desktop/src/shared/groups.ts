import type { ItemPayload } from '@ternix/core/items';
import type { ListedPayload } from './types.js';

/**
 * The default port for a new host in `groupId`: the `port` of the nearest group up the parent
 * chain that has one. A host's own port is authoritative when connecting (see `@ternix/ssh`);
 * this only pre-fills the host editor.
 */
export function groupDefaultPort(
  items: readonly { id: string; payload: ItemPayload | ListedPayload }[],
  groupId: string | undefined,
): number | undefined {
  const groups = new Map<string, Extract<ItemPayload | ListedPayload, { type: 'group' }>>();
  for (const { id, payload } of items) if (payload.type === 'group') groups.set(id, payload);
  const seen = new Set<string>();
  for (let id = groupId; id && !seen.has(id);) {
    seen.add(id);
    const group = groups.get(id);
    if (!group) return undefined;
    if (group.port !== undefined) return group.port;
    id = group.parent_id;
  }
  return undefined;
}
