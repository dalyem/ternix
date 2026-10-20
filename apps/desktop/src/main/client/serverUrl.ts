import { z } from 'zod';
import { PROTOCOL_VERSION, routes, serverInfoSchema } from '@ternix/core/protocol';
import type { ServerInfoDto } from '../../shared/types.js';
import { InvalidServerUrlError, TernixError } from './errors.js';
import { type FetchLike, Http } from './http.js';

/**
 * Server addresses. The canonical form is an origin plus an optional path prefix (for a
 * reverse proxy at `/ternix`), no trailing slash, query or fragment. Bare hosts default
 * to `https://`. Plain `http://` is accepted only for loopback (this computer). Tailnet
 * names and addresses need https too: 100.64.0.0/10 is also carrier-grade NAT space, so an
 * address in it does not prove the traffic stays inside WireGuard, and `tailscale serve`
 * provides certificates for `*.ts.net` names.
 */

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

const INSECURE_HTTP_MESSAGE =
  'Plain http:// is only allowed for this computer (localhost, 127.0.0.1, ::1). Anywhere ' +
  'else your login credential would cross the network unencrypted. Use https://.';

const TAILNET_HTTP_MESSAGE =
  'Plain http:// is only allowed for this computer (localhost, 127.0.0.1, ::1); a Tailscale ' +
  'address is no exception, or your login credential could cross the network unencrypted. ' +
  'Serve Ternix with Tailscale serve and enter https://<machine>.<tailnet>.ts.net.';

/** Strip IPv6 brackets and a trailing dot; lowercase. */
function bareHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets as [number, number, number, number];
}

/** Expand an IPv6 address to 8 hextets, or null. Embedded IPv4 tails are not needed here. */
function parseIPv6(host: string): number[] | null {
  if (!/^[0-9a-f:]+$/.test(host) || !host.includes(':')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => g.length === 0 || g.length > 4)) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** `localhost`, 127.0.0.0/8 or ::1. */
export function isLoopbackHost(host: string): boolean {
  const h = bareHost(host);
  if (h === 'localhost') return true;
  const v4 = parseIPv4(h);
  if (v4) return v4[0] === 127;
  const v6 = parseIPv6(h);
  return v6 !== null && v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1;
}

/**
 * A host that looks like a tailnet address: a `*.ts.net` MagicDNS name, an IPv4 address in
 * Tailscale's range (100.64.0.0/10, shared with carrier-grade NAT) or a Tailscale IPv6
 * address (fd7a:115c:a1e0::/48). For UI hints only; it grants no exception from https.
 */
export function isTailnetHost(host: string): boolean {
  const h = bareHost(host);
  if (h.endsWith('.ts.net') && h.length > '.ts.net'.length) return true;
  const v4 = parseIPv4(h);
  if (v4) return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
  const v6 = parseIPv6(h);
  return v6 !== null && v6[0] === 0xfd7a && v6[1] === 0x115c && v6[2] === 0xa1e0;
}

/**
 * Canonical base URL for what a user typed, or `InvalidServerUrlError` with a message
 * fit to show them.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new InvalidServerUrlError('Enter the address of your server.');
  const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidServerUrlError(`"${trimmed}" is not a valid server address.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InvalidServerUrlError(
      `Unsupported address type "${url.protocol.replace(/:$/, '')}"; use https://.`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidServerUrlError(
      'The address must not contain a user name or password; log in with your Ternix account instead.',
    );
  }
  if (url.hostname === '') throw new InvalidServerUrlError('The address has no host name.');
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new InvalidServerUrlError(
      isTailnetHost(url.hostname) ? TAILNET_HTTP_MESSAGE : INSECURE_HTTP_MESSAGE,
    );
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** WebSocket URL for a canonical base URL: https→wss, http→ws, plus `/api/v1/ws`. */
export function wsUrlFor(baseUrl: string): string {
  const url = new URL(baseUrl);
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${url.host}${url.pathname.replace(/\/+$/, '')}${routes.ws.path}`;
}

const protocolOnlySchema = z.object({ protocol: z.number() });

/**
 * `GET /api/v1/server` on a normalized (or raw) address. Throws `InvalidServerUrlError`,
 * `OfflineError`, `UnexpectedRedirectError`, or `TernixError('unsupported_server')` for
 * anything that is not a Ternix server speaking protocol 1.
 */
export async function probeServer(input: string, fetch: FetchLike): Promise<ServerInfoDto> {
  const serverUrl = normalizeServerUrl(input);
  const http = new Http({ baseUrl: serverUrl, fetch, timeoutMs: 10_000 });
  let raw: unknown;
  try {
    raw = await http.request(routes.server, { auth: false, schema: z.unknown() });
  } catch (err) {
    if (
      err instanceof TernixError &&
      err.code !== 'offline' &&
      err.code !== 'unexpected_redirect'
    ) {
      throw new TernixError(
        'unsupported_server',
        'This address does not look like a Ternix server',
        {
          cause: err,
        },
      );
    }
    throw err;
  }
  const version = protocolOnlySchema.safeParse(raw);
  if (version.success && version.data.protocol !== PROTOCOL_VERSION) {
    throw new TernixError(
      'unsupported_server',
      `The server speaks Ternix protocol ${version.data.protocol}; this app needs protocol ${PROTOCOL_VERSION}.`,
    );
  }
  const info = serverInfoSchema.safeParse(raw);
  if (!info.success) {
    throw new TernixError('unsupported_server', 'This address does not look like a Ternix server');
  }
  return { serverUrl, ...info.data };
}
