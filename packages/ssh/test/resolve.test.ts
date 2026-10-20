import { describe, expect, it } from 'vitest';
import { MAX_GROUP_DEPTH, MAX_JUMP_DEPTH, ResolveError, resolveConnection } from '../src/index.js';
import { group, host, identity, itemMap, portForward, snippet, sshKey, uid } from './helpers.js';

const H = uid(1);

function errorOf(fn: () => unknown): ResolveError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ResolveError) return err;
    throw err;
  }
  throw new Error('expected a ResolveError');
}

describe('username precedence', () => {
  const G_NEAR = uid(10);
  const G_FAR = uid(11);
  const I_HOST = uid(20);
  const I_NEAR = uid(21);
  const I_FAR = uid(22);

  const base = (hostFields = {}, nearFields = {}, farFields = {}) =>
    itemMap([
      [I_HOST, identity({ username: 'host-identity' })],
      [I_NEAR, identity({ username: 'near-identity' })],
      [I_FAR, identity({ username: 'far-identity' })],
      [G_FAR, group({ username: 'far-group', identity_id: I_FAR, ...farFields })],
      [
        G_NEAR,
        group({ parent_id: G_FAR, username: 'near-group', identity_id: I_NEAR, ...nearFields }),
      ],
      [H, host({ group_id: G_NEAR, identity_id: I_HOST, username: 'host-user', ...hostFields })],
    ]);

  it.each([
    ['host field beats everything', {}, {}, {}, 'host-user'],
    ['host identity beats groups', { username: undefined }, {}, {}, 'host-identity'],
    [
      'nearest group field beats its identity and the parent',
      { username: undefined, identity_id: undefined },
      {},
      {},
      'near-group',
    ],
    [
      "nearest group's identity beats the parent group",
      { username: undefined, identity_id: undefined },
      { username: undefined },
      {},
      'near-identity',
    ],
    [
      'parent group field when the nearest sets nothing',
      { username: undefined, identity_id: undefined },
      { username: undefined, identity_id: undefined },
      {},
      'far-group',
    ],
    [
      "parent group's identity last",
      { username: undefined, identity_id: undefined },
      { username: undefined, identity_id: undefined },
      { username: undefined },
      'far-identity',
    ],
  ])('%s', (_name, hostFields, nearFields, farFields, expected) => {
    expect(resolveConnection(base(hostFields, nearFields, farFields), H).username).toBe(expected);
  });

  it('treats an empty username as unset', () => {
    const items = itemMap([
      [uid(10), group({ username: 'g' })],
      [H, host({ username: '', group_id: uid(10) })],
    ]);
    expect(resolveConnection(items, H).username).toBe('g');
  });

  it('fails with no_username naming the host when nothing sets one', () => {
    const err = errorOf(() => resolveConnection(itemMap([[H, host({ label: 'db1' })]]), H));
    expect(err.code).toBe('no_username');
    expect(err.hostId).toBe(H);
    expect(err.message).toContain('db1');
  });
});

describe('password, key and port precedence', () => {
  it('takes the password from host, then host identity, then group identity', () => {
    const I1 = uid(20);
    const I2 = uid(21);
    const G = uid(10);
    const items = (hostFields: object, i1: object) =>
      itemMap([
        [I1, identity({ username: 'a', ...i1 })],
        [I2, identity({ username: 'b', password: 'group-pw' })],
        [G, group({ identity_id: I2 })],
        [H, host({ group_id: G, identity_id: I1, ...hostFields })],
      ]);
    expect(
      resolveConnection(items({ password: 'host-pw' }, { password: 'id-pw' }), H).password,
    ).toBe('host-pw');
    expect(resolveConnection(items({}, { password: 'id-pw' }), H).password).toBe('id-pw');
    expect(resolveConnection(items({}, {}), H).password).toBe('group-pw');
    expect(resolveConnection(itemMap([[H, host({ username: 'u' })]]), H).password).toBeUndefined();
  });

  it('takes the key from host key_id, then identity, then group identity, with its passphrase', () => {
    const K_HOST = uid(30);
    const K_ID = uid(31);
    const K_GROUP = uid(32);
    const I1 = uid(20);
    const I2 = uid(21);
    const G = uid(10);
    const items = (hostFields: object, i1: object) =>
      itemMap([
        [K_HOST, sshKey({ label: 'host key', private_key: 'HOST', passphrase: 'pp' })],
        [K_ID, sshKey({ label: 'identity key', private_key: 'ID' })],
        [K_GROUP, sshKey({ label: 'group key', private_key: 'GROUP' })],
        [I1, identity({ username: 'a', ...i1 })],
        [I2, identity({ username: 'b', key_id: K_GROUP })],
        [G, group({ identity_id: I2 })],
        [H, host({ group_id: G, identity_id: I1, ...hostFields })],
      ]);
    const hostKey = resolveConnection(items({ key_id: K_HOST }, { key_id: K_ID }), H).key;
    expect(hostKey).toEqual({
      id: K_HOST,
      label: 'host key',
      privateKey: 'HOST',
      passphrase: 'pp',
    });
    expect(resolveConnection(items({}, { key_id: K_ID }), H).key?.privateKey).toBe('ID');
    const groupKey = resolveConnection(items({}, {}), H).key;
    expect(groupKey?.privateKey).toBe('GROUP');
    expect(groupKey).not.toHaveProperty('passphrase');
  });

  it('uses the host port unless it is the default, then the nearest group port, then 22', () => {
    const G_NEAR = uid(10);
    const G_FAR = uid(11);
    const items = (
      hostPort: number | undefined,
      near: number | undefined,
      far: number | undefined,
    ) =>
      itemMap([
        [G_FAR, group({ username: 'u', ...(far ? { port: far } : {}) })],
        [G_NEAR, group({ parent_id: G_FAR, ...(near ? { port: near } : {}) })],
        [H, host({ group_id: G_NEAR, ...(hostPort ? { port: hostPort } : {}) })],
      ]);
    expect(resolveConnection(items(2200, 2201, 2202), H).port).toBe(2200);
    expect(resolveConnection(items(undefined, 2201, 2202), H).port).toBe(2201);
    expect(resolveConnection(items(22, undefined, 2202), H).port).toBe(2202);
    expect(resolveConnection(items(undefined, undefined, undefined), H).port).toBe(22);
  });
});

describe('missing and mistyped references', () => {
  it('treats dangling and wrong-type references as unset and keeps looking', () => {
    const G = uid(10);
    const I = uid(20);
    const items = itemMap([
      [I, identity({ username: 'from-group-identity', key_id: uid(99) })],
      [G, group({ identity_id: I })],
      [
        H,
        host({
          group_id: G,
          identity_id: uid(98), // not in the lookup
          key_id: G, // exists but is a group, not a key
          startup_snippet_id: uid(97),
          jump_host_id: uid(96),
        }),
      ],
    ]);
    const resolved = resolveConnection(items, H);
    expect(resolved.username).toBe('from-group-identity');
    expect(resolved.key).toBeUndefined();
    expect(resolved.startupScript).toBeUndefined();
    expect(resolved.jumpChain).toEqual([]);
  });

  it('falls through a dangling key_id to the next layer that has a real key', () => {
    const I = uid(20);
    const K = uid(30);
    const items = itemMap([
      [K, sshKey({ private_key: 'FROM-IDENTITY' })],
      [I, identity({ key_id: K })],
      [H, host({ identity_id: I, key_id: uid(99) })],
    ]);
    expect(resolveConnection(items, H).key?.privateKey).toBe('FROM-IDENTITY');
  });

  it('ignores a group_id that points at a host', () => {
    const OTHER = uid(2);
    const items = itemMap([
      [OTHER, host({ username: 'not-a-group' })],
      [H, host({ group_id: OTHER })],
    ]);
    expect(errorOf(() => resolveConnection(items, H)).code).toBe('no_username');
  });

  it('reports host_not_found', () => {
    expect(errorOf(() => resolveConnection(itemMap([]), H)).code).toBe('host_not_found');
    const items = itemMap([[uid(3), group()]]);
    expect(errorOf(() => resolveConnection(items, uid(3))).code).toBe('host_not_found');
  });
});

describe('cycles and depth', () => {
  it('detects a cycle in the group hierarchy', () => {
    const A = uid(10);
    const B = uid(11);
    const items = itemMap([
      [A, group({ parent_id: B })],
      [B, group({ parent_id: A })],
      [H, host({ group_id: A, username: 'u' })],
    ]);
    const err = errorOf(() => resolveConnection(items, H));
    expect(err.code).toBe('group_cycle');
    expect(err.path).toEqual([A, B, A]);
  });

  it('detects a group that is its own parent', () => {
    const A = uid(10);
    const items = itemMap([
      [A, group({ parent_id: A })],
      [H, host({ group_id: A, username: 'u' })],
    ]);
    expect(errorOf(() => resolveConnection(items, H)).code).toBe('group_cycle');
  });

  it('caps group depth', () => {
    const entries: [string, ReturnType<typeof group>][] = [];
    for (let i = 0; i < MAX_GROUP_DEPTH + 3; i += 1) {
      entries.push([
        uid(100 + i),
        group(i < MAX_GROUP_DEPTH + 2 ? { parent_id: uid(101 + i) } : {}),
      ]);
    }
    const items = itemMap([...entries, [H, host({ group_id: uid(100), username: 'u' })]]);
    expect(errorOf(() => resolveConnection(items, H)).code).toBe('group_depth');
  });

  it('detects a cycle between jump hosts', () => {
    const A = uid(2);
    const B = uid(3);
    const items = itemMap([
      [H, host({ username: 'u', jump_host_id: A })],
      [A, host({ username: 'u', jump_host_id: B })],
      [B, host({ username: 'u', jump_host_id: A })],
    ]);
    const err = errorOf(() => resolveConnection(items, H));
    expect(err.code).toBe('jump_cycle');
    expect(err.path).toEqual([H, A, B, A]);
  });

  it('detects a host that jumps through itself', () => {
    const items = itemMap([[H, host({ username: 'u', jump_host_id: H })]]);
    expect(errorOf(() => resolveConnection(items, H)).code).toBe('jump_cycle');
  });

  it('caps the jump chain', () => {
    const entries: [string, ReturnType<typeof host>][] = [];
    const total = MAX_JUMP_DEPTH + 2;
    for (let i = 0; i < total; i += 1) {
      entries.push([
        uid(2 + i),
        host({ username: 'u', ...(i < total - 1 ? { jump_host_id: uid(3 + i) } : {}) }),
      ]);
    }
    const items = itemMap([[H, host({ username: 'u', jump_host_id: uid(2) })], ...entries]);
    expect(errorOf(() => resolveConnection(items, H)).code).toBe('jump_depth');
  });

  it('allows a chain of exactly the maximum length', () => {
    const entries: [string, ReturnType<typeof host>][] = [];
    for (let i = 0; i < MAX_JUMP_DEPTH; i += 1) {
      entries.push([
        uid(2 + i),
        host({ username: 'u', ...(i < MAX_JUMP_DEPTH - 1 ? { jump_host_id: uid(3 + i) } : {}) }),
      ]);
    }
    const items = itemMap([[H, host({ username: 'u', jump_host_id: uid(2) })], ...entries]);
    expect(resolveConnection(items, H).jumpChain).toHaveLength(MAX_JUMP_DEPTH);
  });
});

describe('jump chain and the rest of the connection', () => {
  it('resolves each hop with its own identity, outermost first', () => {
    const J1 = uid(2);
    const J2 = uid(3);
    const I1 = uid(20);
    const K = uid(30);
    const items = itemMap([
      [K, sshKey({ private_key: 'JUMP1-KEY' })],
      [I1, identity({ username: 'jumper', key_id: K })],
      [J1, host({ label: 'bastion', address: 'bastion.example', port: 2222, identity_id: I1 })],
      [
        J2,
        host({
          label: 'inner',
          address: '10.0.0.5',
          username: 'inner-user',
          password: 'p',
          jump_host_id: J1,
        }),
      ],
      [H, host({ label: 'target', address: '10.0.1.9', username: 'root', jump_host_id: J2 })],
    ]);
    const resolved = resolveConnection(items, H);
    expect(resolved.jumpChain.map((h) => h.label)).toEqual(['bastion', 'inner']);
    expect(resolved.jumpChain[0]).toMatchObject({
      hostId: J1,
      address: 'bastion.example',
      port: 2222,
      username: 'jumper',
      key: { privateKey: 'JUMP1-KEY' },
    });
    expect(resolved.jumpChain[1]).toMatchObject({ username: 'inner-user', password: 'p' });
    expect(resolved).toMatchObject({ hostId: H, address: '10.0.1.9', username: 'root' });
  });

  it('carries keepalive, agent forwarding, the startup script and only its own port forwards', () => {
    const S = uid(40);
    const P1 = uid(50);
    const P2 = uid(51);
    const P3 = uid(52);
    const items = itemMap([
      [S, snippet({ script: 'cd /srv\nls' })],
      [
        H,
        host({
          username: 'u',
          keepalive_interval: 30,
          agent_forwarding: true,
          startup_snippet_id: S,
        }),
      ],
      [uid(2), host({ username: 'u' })],
      [
        P2,
        portForward({
          label: 'b-web',
          host_id: H,
          kind: 'local',
          bind_address: '127.0.0.1',
          bind_port: 8080,
          dest_host: 'localhost',
          dest_port: 80,
        }),
      ],
      [
        P1,
        portForward({
          label: 'a-socks',
          host_id: H,
          kind: 'dynamic',
          bind_address: '127.0.0.1',
          bind_port: 1080,
        }),
      ],
      [
        P3,
        portForward({
          label: 'other',
          host_id: uid(2),
          kind: 'local',
          bind_address: '127.0.0.1',
          bind_port: 1,
          dest_host: 'x',
          dest_port: 1,
        }),
      ],
    ]);
    const resolved = resolveConnection(items, H);
    expect(resolved.keepaliveInterval).toBe(30);
    expect(resolved.agentForwarding).toBe(true);
    expect(resolved.startupScript).toBe('cd /srv\nls');
    expect(resolved.portForwards.map((p) => p.id)).toEqual([P1, P2]);
    expect(resolved.portForwards[1]).toEqual({
      id: P2,
      label: 'b-web',
      kind: 'local',
      bindAddress: '127.0.0.1',
      bindPort: 8080,
      destHost: 'localhost',
      destPort: 80,
    });
  });

  it('leaves keepalive and the script unset by default', () => {
    const resolved = resolveConnection(itemMap([[H, host({ username: 'u' })]]), H);
    expect(resolved.keepaliveInterval).toBeUndefined();
    expect(resolved.agentForwarding).toBe(false);
    expect(resolved.portForwards).toEqual([]);
  });
});
