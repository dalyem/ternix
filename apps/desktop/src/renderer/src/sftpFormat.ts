import type { SftpEntryDto } from '../../shared/app.js';

/** Helpers for the SFTP browser: remote POSIX paths, sizes, modes, sorting. No DOM. */

/** Collapse `.`, `..` and repeated slashes of an absolute POSIX path. */
export function normalizeRemote(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** What the user typed in the path bar, as an absolute path: `~` is the login directory. */
export function resolveRemoteInput(input: string, current: string, home: string): string {
  const typed = input.trim();
  if (typed === '') return current;
  let path = typed;
  if (path === '~') path = home;
  else if (path.startsWith('~/')) path = `${home}/${path.slice(2)}`;
  else if (!path.startsWith('/')) path = `${current}/${path}`;
  return normalizeRemote(path);
}

export function joinRemote(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  const normalized = normalizeRemote(path);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

/** The path as breadcrumbs: `/`, then one entry per directory. */
export function crumbsOf(path: string): { label: string; path: string }[] {
  const crumbs = [{ label: '/', path: '/' }];
  let current = '';
  for (const part of normalizeRemote(path).split('/').filter(Boolean)) {
    current += `/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** `drwxr-xr-x`, as `ls -l` shows it. */
export function formatMode(mode: number, type: SftpEntryDto['type']): string {
  const kind = type === 'directory' ? 'd' : type === 'symlink' ? 'l' : type === 'file' ? '-' : '?';
  const bits = ['r', 'w', 'x'];
  let out = kind;
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let i = 0; i < 3; i++) out += mode & (1 << (shift + 2 - i)) ? bits[i] : '-';
  }
  if (mode & 0o4000) out = `${out.slice(0, 3)}${out[3] === 'x' ? 's' : 'S'}${out.slice(4)}`;
  if (mode & 0o2000) out = `${out.slice(0, 6)}${out[6] === 'x' ? 's' : 'S'}${out.slice(7)}`;
  if (mode & 0o1000) out = `${out.slice(0, 9)}${out[9] === 'x' ? 't' : 'T'}`;
  return out;
}

/** Whether double-clicking opens it as a folder. */
export const opensAsFolder = (e: SftpEntryDto): boolean =>
  e.type === 'directory' || (e.type === 'symlink' && e.targetType === 'directory');

export type SortKey = 'name' | 'size' | 'mtime' | 'mode';

/** Folders first, then by `key`; names compare naturally (`file2` before `file10`). */
export function sortEntries(
  entries: SftpEntryDto[],
  key: SortKey,
  direction: 1 | -1,
): SftpEntryDto[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    const folders = Number(opensAsFolder(b)) - Number(opensAsFolder(a));
    if (folders !== 0) return folders;
    let order = 0;
    if (key === 'size') order = a.size - b.size;
    else if (key === 'mtime') order = a.mtime - b.mtime;
    else if (key === 'mode') order = (a.mode & 0o7777) - (b.mode & 0o7777);
    if (order === 0) order = collator.compare(a.name, b.name);
    return order * direction;
  });
}
