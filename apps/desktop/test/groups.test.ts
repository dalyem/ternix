import { describe, expect, it } from 'vitest';
import type { ItemPayload } from '@ternix/core/items';
import { groupDefaultPort } from '../src/shared/groups.js';

const view = (id: string, payload: ItemPayload) => ({ id, payload });
const group = (id: string, extra: { port?: number; parent_id?: string } = {}) =>
  view(id, { type: 'group', label: id, schema: 1, updated_at: '', ...extra });

describe('groupDefaultPort', () => {
  it('uses the port of the group itself', () => {
    expect(groupDefaultPort([group('g', { port: 2222 })], 'g')).toBe(2222);
  });

  it('walks up to the nearest group that has a port', () => {
    const items = [
      group('top', { port: 2200 }),
      group('mid', { parent_id: 'top' }),
      group('leaf', { parent_id: 'mid' }),
      group('other', { port: 2300, parent_id: 'top' }),
    ];
    expect(groupDefaultPort(items, 'leaf')).toBe(2200);
    expect(groupDefaultPort(items, 'other')).toBe(2300);
  });

  it('is undefined without a group, an unknown group, or no port in the chain', () => {
    const items = [group('a'), group('b', { parent_id: 'a' })];
    expect(groupDefaultPort(items, undefined)).toBeUndefined();
    expect(groupDefaultPort(items, '')).toBeUndefined();
    expect(groupDefaultPort(items, 'missing')).toBeUndefined();
    expect(groupDefaultPort(items, 'b')).toBeUndefined();
  });

  it('stops on a cycle', () => {
    const items = [group('a', { parent_id: 'b' }), group('b', { parent_id: 'a' })];
    expect(groupDefaultPort(items, 'a')).toBeUndefined();
  });
});
