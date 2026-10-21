import { useSyncExternalStore } from 'react';

/**
 * The look of the window. This is a display preference only, so it lives in the page's own
 * storage rather than the main-owned settings; only the three known values are ever read back.
 * Dark is the default; `system` follows the operating system.
 */
export type ThemePref = 'system' | 'dark' | 'light';

const KEY = 'ternix.theme';
const listeners = new Set<() => void>();

function isThemePref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'dark' || value === 'light';
}

export function readThemePref(): ThemePref {
  try {
    const value = window.localStorage.getItem(KEY);
    return isThemePref(value) ? value : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyThemePref(pref: ThemePref): void {
  document.documentElement.dataset['theme'] = pref;
}

export function setThemePref(pref: ThemePref): void {
  try {
    window.localStorage.setItem(KEY, pref);
  } catch {
    // The choice still applies until the window closes.
  }
  applyThemePref(pref);
  for (const listener of [...listeners]) listener();
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, readThemePref);
}

/** `macos`, `windows` or `linux`, from the user agent (main reports the same in `app.info`). */
export function guessPlatform(): 'macos' | 'windows' | 'linux' {
  const ua = navigator.userAgent;
  return ua.includes('Mac') ? 'macos' : ua.includes('Windows') ? 'windows' : 'linux';
}
