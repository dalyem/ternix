export const APP_SCHEME = 'ternix';
export const APP_HOST = 'app';
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

export interface AppUrls {
  /** Vite dev server URL, development only. */
  devUrl: string | undefined;
}

/** Whether `url` is the app's own page (`ternix://app/`, or the dev server in development). */
export function isAppUrl(url: string, { devUrl }: AppUrls): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (devUrl) {
    try {
      if (parsed.origin === new URL(devUrl).origin) return true;
    } catch {
      return false;
    }
  }
  return (
    parsed.protocol === `${APP_SCHEME}:` &&
    parsed.host === APP_HOST &&
    (parsed.pathname === '/' || parsed.pathname === '/index.html')
  );
}
