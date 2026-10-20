import type {
  GroupPayload,
  HostPayload,
  IdentityPayload,
  ItemPayload,
  PortForwardPayload,
  SshKeyPayload,
} from '@ternix/core/items';

/** All decrypted items the user can read (every vault), by item ID. */
export type ItemLookup = ReadonlyMap<string, ItemPayload>;

export const DEFAULT_PORT = 22;
/** Longest jump-host chain accepted, target excluded. */
export const MAX_JUMP_DEPTH = 8;
/** Longest group ancestry walked for one host. */
export const MAX_GROUP_DEPTH = 32;

export type ResolveErrorCode =
  'host_not_found' | 'no_username' | 'group_cycle' | 'group_depth' | 'jump_cycle' | 'jump_depth';

export class ResolveError extends Error {
  override readonly name = 'ResolveError';
  readonly code: ResolveErrorCode;
  /** The host the failure belongs to (a jump host for an error inside the chain). */
  readonly hostId: string;
  /** Item IDs walked up to the failure, for cycle and depth errors. */
  readonly path: readonly string[];

  constructor(
    code: ResolveErrorCode,
    message: string,
    hostId: string,
    path: readonly string[] = [],
  ) {
    super(message);
    this.code = code;
    this.hostId = hostId;
    this.path = path;
  }
}

export interface ResolvedKey {
  id: string;
  label: string;
  privateKey: string;
  passphrase?: string;
}

/** Effective settings for one hop. Optional fields are absent, never `undefined`-valued. */
export interface HopSettings {
  hostId: string;
  label: string;
  address: string;
  port: number;
  username: string;
  password?: string;
  key?: ResolvedKey;
}

export interface PortForwardSpec {
  id: string;
  label: string;
  kind: PortForwardPayload['kind'];
  bindAddress: string;
  bindPort: number;
  destHost?: string;
  destPort?: number;
}

export interface ResolvedConnection extends HopSettings {
  /** Seconds between SSH keepalives; absent or 0 disables them. */
  keepaliveInterval?: number;
  agentForwarding: boolean;
  /** Script text of the startup snippet, run once after the shell opens. */
  startupScript?: string;
  /** Jump hosts, outermost (first to dial) first. Empty when the host is reached directly. */
  jumpChain: HopSettings[];
  portForwards: PortForwardSpec[];
}

interface Layer {
  username?: string | undefined;
  password?: string | undefined;
  keyId?: string | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function lookupAs<T extends ItemPayload['type']>(
  items: ItemLookup,
  id: string | undefined,
  type: T,
): Extract<ItemPayload, { type: T }> | undefined {
  if (id === undefined) return undefined;
  const item = items.get(id);
  return item?.type === type ? (item as Extract<ItemPayload, { type: T }>) : undefined;
}

/** Group chain, nearest group first. */
function groupChain(items: ItemLookup, host: HostPayload, hostId: string): GroupPayload[] {
  const chain: GroupPayload[] = [];
  const seen: string[] = [];
  let nextId = host.group_id;
  while (nextId !== undefined) {
    const group = lookupAs(items, nextId, 'group');
    if (!group) break;
    if (seen.includes(nextId)) {
      throw new ResolveError('group_cycle', `Group hierarchy loops back to ${nextId}`, hostId, [
        ...seen,
        nextId,
      ]);
    }
    seen.push(nextId);
    if (seen.length > MAX_GROUP_DEPTH) {
      throw new ResolveError(
        'group_depth',
        `Groups nest deeper than ${MAX_GROUP_DEPTH}`,
        hostId,
        seen,
      );
    }
    chain.push(group);
    nextId = group.parent_id;
  }
  return chain;
}

function identityLayer(identity: IdentityPayload | undefined): Layer {
  return {
    username: nonEmpty(identity?.username),
    password: nonEmpty(identity?.password),
    keyId: identity?.key_id,
  };
}

function resolveHop(items: ItemLookup, hostId: string, host: HostPayload): HopSettings {
  // Precedence: host fields, the host's identity, then each group (nearest first) followed by
  // that group's identity. The first layer that sets a field wins.
  const layers: Layer[] = [
    {
      username: nonEmpty(host.username),
      password: nonEmpty(host.password),
      keyId: host.key_id,
    },
    identityLayer(lookupAs(items, host.identity_id, 'identity')),
  ];
  for (const group of groupChain(items, host, hostId)) {
    layers.push({ username: nonEmpty(group.username) });
    layers.push(identityLayer(lookupAs(items, group.identity_id, 'identity')));
  }

  const username = layers.find((l) => l.username !== undefined)?.username;
  if (username === undefined) {
    throw new ResolveError('no_username', `No username for host "${host.label}"`, hostId);
  }

  let key: SshKeyPayload | undefined;
  let keyId: string | undefined;
  for (const layer of layers) {
    key = lookupAs(items, layer.keyId, 'ssh_key');
    if (key) {
      keyId = layer.keyId;
      break;
    }
  }

  const hop: HopSettings = {
    hostId,
    label: host.label,
    address: host.address,
    // A host always has a port (the payload defaults it to 22), so it is never inherited. A
    // group's `port` is only the default the UI offers when creating a host in that group.
    port: host.port,
    username,
  };
  const password = layers.find((l) => l.password !== undefined)?.password;
  if (password !== undefined) hop.password = password;
  if (key && keyId) {
    hop.key = { id: keyId, label: key.label, privateKey: key.private_key };
    const passphrase = nonEmpty(key.passphrase);
    if (passphrase !== undefined) hop.key.passphrase = passphrase;
  }
  return hop;
}

function jumpChain(items: ItemLookup, hostId: string, host: HostPayload): HopSettings[] {
  const hops: HopSettings[] = [];
  const seen = [hostId];
  let nextId = host.jump_host_id;
  while (nextId !== undefined) {
    const jump = lookupAs(items, nextId, 'host');
    if (!jump) break;
    if (seen.includes(nextId)) {
      throw new ResolveError('jump_cycle', `Jump hosts loop back to ${nextId}`, hostId, [
        ...seen,
        nextId,
      ]);
    }
    seen.push(nextId);
    if (hops.length >= MAX_JUMP_DEPTH) {
      throw new ResolveError('jump_depth', `More than ${MAX_JUMP_DEPTH} jump hosts`, hostId, seen);
    }
    hops.unshift(resolveHop(items, nextId, jump));
    nextId = jump.jump_host_id;
  }
  return hops;
}

/** Port forwards that belong to `hostId`, ordered by label then ID. */
export function portForwardsFor(items: ItemLookup, hostId: string): PortForwardSpec[] {
  const specs: PortForwardSpec[] = [];
  for (const [id, item] of items) {
    if (item.type !== 'port_forward' || item.host_id !== hostId) continue;
    const spec: PortForwardSpec = {
      id,
      label: item.label,
      kind: item.kind,
      bindAddress: item.bind_address,
      bindPort: item.bind_port,
    };
    if (item.dest_host !== undefined) spec.destHost = item.dest_host;
    if (item.dest_port !== undefined) spec.destPort = item.dest_port;
    specs.push(spec);
  }
  return specs.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * Resolve a host item into everything needed to connect: effective credentials, the jump-host
 * chain and the host's port forwards. Dangling references are treated as unset.
 */
export function resolveConnection(items: ItemLookup, hostId: string): ResolvedConnection {
  const host = lookupAs(items, hostId, 'host');
  if (!host) throw new ResolveError('host_not_found', `Host ${hostId} not found`, hostId);

  const resolved: ResolvedConnection = {
    ...resolveHop(items, hostId, host),
    agentForwarding: host.agent_forwarding,
    jumpChain: jumpChain(items, hostId, host),
    portForwards: portForwardsFor(items, hostId),
  };
  if (host.keepalive_interval !== undefined) resolved.keepaliveInterval = host.keepalive_interval;
  const snippet = lookupAs(items, host.startup_snippet_id, 'snippet');
  if (snippet) resolved.startupScript = snippet.script;
  return resolved;
}
