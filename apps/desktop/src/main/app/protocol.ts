import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { APP_HOST, APP_SCHEME } from './security.js';

/**
 * The renderer is served from `ternix://app/`, not `file://`: a real, secure origin without
 * the extra privileges Chromium gives file pages (the `grantFileProtocolExtraPrivileges`
 * fuse is off), and a stable origin for storage. Call before the app is ready.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** Serve files under `root` for `ternix://app/<path>`; nothing outside `root` is reachable. */
export function handleAppScheme(root: string): void {
  const base = resolve(root);
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const file = resolve(join(base, path === '/' ? 'index.html' : path));
    const rel = relative(base, file);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}
