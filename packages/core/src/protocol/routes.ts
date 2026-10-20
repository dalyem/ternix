/**
 * Every HTTP endpoint of the protocol. Paths use `:param` placeholders; fill them
 * with `buildPath`. Request/response schemas for each route are in the sibling modules
 * (docs/protocol.md has the per-route table).
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Route {
  readonly method: HttpMethod;
  readonly path: string;
}

export const API_PREFIX = '/api/v1';

export const routes = {
  // Server and auth
  server: { method: 'GET', path: '/api/v1/server' },
  prelogin: { method: 'POST', path: '/api/v1/auth/prelogin' },
  register: { method: 'POST', path: '/api/v1/auth/register' },
  login: { method: 'POST', path: '/api/v1/auth/login' },
  logout: { method: 'POST', path: '/api/v1/auth/logout' },
  me: { method: 'GET', path: '/api/v1/me' },
  changePassword: { method: 'POST', path: '/api/v1/me/password' },
  listDevices: { method: 'GET', path: '/api/v1/devices' },
  revokeDevice: { method: 'DELETE', path: '/api/v1/devices/:id' },
  lookupUser: { method: 'GET', path: '/api/v1/users/lookup' },

  // Admin
  createInvite: { method: 'POST', path: '/api/v1/admin/invites' },
  listInvites: { method: 'GET', path: '/api/v1/admin/invites' },
  deleteInvite: { method: 'DELETE', path: '/api/v1/admin/invites/:code' },
  listUsers: { method: 'GET', path: '/api/v1/admin/users' },
  deleteUser: { method: 'DELETE', path: '/api/v1/admin/users/:id' },

  // Vaults and members
  listVaults: { method: 'GET', path: '/api/v1/vaults' },
  createVault: { method: 'POST', path: '/api/v1/vaults' },
  updateVault: { method: 'PATCH', path: '/api/v1/vaults/:id' },
  deleteVault: { method: 'DELETE', path: '/api/v1/vaults/:id' },
  listMembers: { method: 'GET', path: '/api/v1/vaults/:id/members' },
  addMember: { method: 'POST', path: '/api/v1/vaults/:id/members' },
  updateMember: { method: 'PATCH', path: '/api/v1/vaults/:id/members/:user_id' },
  removeMember: { method: 'DELETE', path: '/api/v1/vaults/:id/members/:user_id' },
  rotateVault: { method: 'POST', path: '/api/v1/vaults/:id/rotate' },

  // Items and sync
  listItems: { method: 'GET', path: '/api/v1/vaults/:id/items' },
  putItem: { method: 'PUT', path: '/api/v1/vaults/:id/items/:item_id' },
  deleteItem: { method: 'DELETE', path: '/api/v1/vaults/:id/items/:item_id' },
  batchItems: { method: 'POST', path: '/api/v1/vaults/:id/items/batch' },

  // Realtime (WebSocket upgrade)
  ws: { method: 'GET', path: '/api/v1/ws' },
} as const satisfies Record<string, Route>;

export type RouteName = keyof typeof routes;

type PathParams<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParams<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

/**
 * Substitute `:param` placeholders (URL-encoded) and append an optional query string.
 * `undefined` query values are omitted.
 */
export function buildPath<P extends string>(
  path: P,
  params?: Record<PathParams<P>, string>,
  query?: Record<string, string | number | undefined>,
): string {
  const values = (params ?? {}) as Record<string, string>;
  const filled = path.replace(/:([a-z_]+)/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`missing path parameter: ${name}`);
    return encodeURIComponent(value);
  });
  if (!query) return filled;
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  const qs = pairs.join('&');
  return qs ? `${filled}?${qs}` : filled;
}
