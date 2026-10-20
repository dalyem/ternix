import { AppError } from '../app/errors.js';

export interface QuickTarget {
  username: string;
  host: string;
  port: number;
}

/**
 * `user@host`, `user@host:port` or `user@[ipv6]:port`. A user name is required: unlike
 * saved hosts there is no identity or group to take it from.
 */
export function parseQuickTarget(input: string): QuickTarget {
  const text = input.trim();
  const at = text.lastIndexOf('@');
  if (at <= 0) {
    throw new AppError('invalid_input', 'Enter the target as user@host or user@host:port.');
  }
  const username = text.slice(0, at);
  let rest = text.slice(at + 1);
  let port = 22;
  let host: string;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracket) {
    host = bracket[1] ?? '';
    if (bracket[2]) port = Number(bracket[2]);
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon !== -1 && rest.indexOf(':') === colon) {
      port = Number(rest.slice(colon + 1));
      rest = rest.slice(0, colon);
    }
    host = rest;
  }
  if (
    host.length === 0 ||
    /\s/.test(host) ||
    /\s/.test(username) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new AppError('invalid_input', `"${text}" is not a valid user@host[:port].`);
  }
  return { username, host, port };
}
