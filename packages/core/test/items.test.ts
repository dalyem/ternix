import { describe, expect, it } from 'vitest';
import { ITEM_TYPES, itemPayloadSchema } from '../src/index.js';
import { ITEM_ID, NOW, OTHER_ITEM_ID, VAULT_ID } from './helpers.js';

const base = { schema: 1, updated_at: NOW };

const valid = {
  group: { type: 'group', ...base, label: 'Production', port: 2222 },
  host: { type: 'host', ...base, label: 'web-1', address: '10.0.0.5' },
  identity: { type: 'identity', ...base, label: 'deploy', username: 'deploy' },
  ssh_key: {
    type: 'ssh_key',
    ...base,
    label: 'laptop',
    private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\n...',
  },
  snippet: { type: 'snippet', ...base, label: 'uptime', script: 'uptime' },
  port_forward: {
    type: 'port_forward',
    ...base,
    label: 'db',
    host_id: ITEM_ID,
    kind: 'local',
    bind_address: '127.0.0.1',
    bind_port: 5432,
    dest_host: 'db.internal',
    dest_port: 5432,
  },
  known_host: {
    type: 'known_host',
    ...base,
    host: 'web-1.example.com',
    port: 22,
    key_type: 'ssh-ed25519',
    public_key: 'AAAAC3NzaC1lZDI1NTE5AAAAIA==',
  },
} as const;

describe('item payload schema', () => {
  it('has a valid sample for every item type', () => {
    expect(Object.keys(valid).sort()).toEqual([...ITEM_TYPES].sort());
    for (const sample of Object.values(valid)) {
      expect(itemPayloadSchema.safeParse(sample).success).toBe(true);
    }
  });

  it('applies defaults to hosts', () => {
    const parsed = itemPayloadSchema.parse({
      type: 'host',
      updated_at: NOW,
      label: 'h',
      address: 'example.com',
    });
    expect(parsed).toMatchObject({ schema: 1, port: 22, tags: [], agent_forwarding: false });
  });

  it('defaults snippet tags and the schema version', () => {
    const parsed = itemPayloadSchema.parse({
      type: 'snippet',
      updated_at: NOW,
      label: 's',
      script: '',
    });
    expect(parsed).toMatchObject({ schema: 1, tags: [] });
  });

  it('accepts a fully populated host', () => {
    const host = {
      type: 'host',
      ...base,
      label: 'web-1',
      address: 'web-1.example.com',
      port: 2200,
      username: 'root',
      password: 'pw',
      identity_id: ITEM_ID,
      key_id: OTHER_ITEM_ID,
      group_id: VAULT_ID,
      jump_host_id: ITEM_ID,
      tags: ['prod', 'web'],
      startup_snippet_id: ITEM_ID,
      keepalive_interval: 30,
      agent_forwarding: true,
      color: '#ff0000',
      notes: 'hi',
    };
    expect(itemPayloadSchema.parse(host)).toEqual(host);
  });

  it('rejects invalid samples', () => {
    const bad: unknown[] = [
      null,
      {},
      { type: 'host' },
      { ...valid.host, type: 'teleporter' },
      { ...valid.host, schema: 2 },
      { ...valid.host, updated_at: 'yesterday' },
      { ...valid.host, updated_at: undefined },
      { ...valid.host, label: '' },
      { ...valid.host, address: '' },
      { ...valid.host, port: 0 },
      { ...valid.host, port: 65_536 },
      { ...valid.host, port: 22.5 },
      { ...valid.host, identity_id: 'not-a-uuid' },
      { ...valid.host, identity_id: ITEM_ID.toUpperCase() },
      { ...valid.host, tags: 'prod' },
      { ...valid.host, agent_forwarding: 'yes' },
      { ...valid.host, keepalive_interval: -1 },
      { ...valid.identity, username: '' },
      { ...valid.ssh_key, private_key: '' },
      { ...valid.port_forward, kind: 'sideways' },
      { ...valid.port_forward, host_id: undefined },
      { ...valid.known_host, public_key: 'not base64!' },
    ];
    for (const sample of bad) {
      expect(itemPayloadSchema.safeParse(sample).success, JSON.stringify(sample)).toBe(false);
    }
  });
});
