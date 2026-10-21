import type { HostOs } from '@ternix/core/items';

/**
 * Operating system detection from what a server sends: its identification string, and the output
 * of one read-only command (`OS_PROBE_COMMAND`). Everything parsed here comes from the remote host
 * and is untrusted: lines are matched against fixed patterns and nothing else is interpreted.
 */

/** The only command detection runs: the kernel name, then the os-release file. */
export const OS_PROBE_COMMAND = 'uname -s 2>/dev/null; cat /etc/os-release 2>/dev/null';
/** Output past this is not read; an os-release file is a few hundred bytes. */
export const OS_PROBE_MAX_BYTES = 16 * 1024;
export const OS_PROBE_TIMEOUT_MS = 5_000;

const MAX_IDENT_LENGTH = 255;
const MAX_LINE_LENGTH = 512;

/**
 * What the server's identification string (`SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5`) says.
 * Distribution packagers append their name; plain upstream OpenSSH says nothing.
 */
export function osFromIdent(ident: string | undefined): HostOs | undefined {
  if (!ident) return undefined;
  const text = ident.trim().slice(0, MAX_IDENT_LENGTH);
  const match = /^SSH-[\d.]+-(\S+)(?:\s+(.*))?$/.exec(text);
  if (!match) return undefined;
  const software = match[1] ?? '';
  const comments = match[2] ?? '';
  if (/^OpenSSH_for_Windows/i.test(software)) return 'windows';
  if (/^NetBSD_Secure_Shell/i.test(software)) return 'netbsd';
  // Most specific first: Raspbian's packages are Debian's, renamed.
  const fromComments: [RegExp, HostOs][] = [
    [/\bRaspbian\b/i, 'raspbian'],
    [/\bUbuntu\b/i, 'ubuntu'],
    [/\bDebian\b/i, 'debian'],
    [/\bFreeBSD\b/i, 'freebsd'],
  ];
  for (const [pattern, os] of fromComments) if (pattern.test(comments)) return os;
  return undefined;
}

/** os-release `ID` (and `ID_LIKE` entries) to the operating systems the protocol names. */
const RELEASE_IDS: Record<string, HostOs> = {
  ubuntu: 'ubuntu',
  debian: 'debian',
  fedora: 'fedora',
  centos: 'centos',
  rhel: 'rhel',
  rocky: 'rocky',
  almalinux: 'alma',
  arch: 'arch',
  archarm: 'arch',
  alpine: 'alpine',
  opensuse: 'opensuse',
  'opensuse-leap': 'opensuse',
  'opensuse-tumbleweed': 'opensuse',
  'opensuse-microos': 'opensuse',
  suse: 'opensuse',
  sles: 'opensuse',
  nixos: 'nixos',
  raspbian: 'raspbian',
  amzn: 'amazon',
  ol: 'oracle',
  gentoo: 'gentoo',
  manjaro: 'manjaro',
  'manjaro-arm': 'manjaro',
  linuxmint: 'mint',
  kali: 'kali',
  freebsd: 'freebsd',
  openbsd: 'openbsd',
  netbsd: 'netbsd',
};

/** `uname -s` output, exactly; anything else on a line is not a kernel name. */
function osFromKernel(line: string): HostOs | 'Linux' | undefined {
  if (line === 'Linux') return 'Linux';
  if (line === 'Darwin') return 'macos';
  if (line === 'FreeBSD') return 'freebsd';
  if (line === 'OpenBSD') return 'openbsd';
  if (line === 'NetBSD') return 'netbsd';
  if (/^(CYGWIN|MINGW(?:32|64)?|MSYS)_NT-[\d.]+(?:-[\w.]+)*$/.test(line)) return 'windows';
  return undefined;
}

const RELEASE_LINE = /^([A-Z][A-Z0-9_]{0,63})=(.{0,256})$/;
const RELEASE_TOKEN = /^[a-z0-9._-]{1,64}$/;

/** An os-release value: bare, or in matching single or double quotes, with no other quoting. */
function releaseValue(raw: string): string | undefined {
  const quoted = /^"([^"\\`$]*)"$/.exec(raw) ?? /^'([^']*)'$/.exec(raw);
  if (quoted) return quoted[1];
  return /^[^\s"'\\`$]*$/.test(raw) ? raw : undefined;
}

/** `ID` and `ID_LIKE` of an os-release file, lowercased; the first assignment of each wins. */
export function parseOsRelease(text: string): { id?: string; idLike: string[] } {
  let id: string | undefined;
  let idLike: string[] | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length > MAX_LINE_LENGTH) continue;
    const match = RELEASE_LINE.exec(line);
    if (!match) continue;
    const value = releaseValue(match[2] ?? '');
    if (value === undefined) continue;
    if (match[1] === 'ID' && id === undefined) {
      const token = value.toLowerCase();
      if (RELEASE_TOKEN.test(token)) id = token;
    } else if (match[1] === 'ID_LIKE' && idLike === undefined) {
      idLike = value
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => RELEASE_TOKEN.test(t))
        .slice(0, 16);
    }
  }
  return { ...(id !== undefined ? { id } : {}), idLike: idLike ?? [] };
}

/**
 * The operating system in the output of `OS_PROBE_COMMAND`: the kernel name decides macOS, the
 * BSDs and Windows (Cygwin, MSYS); on Linux the os-release `ID`, then `ID_LIKE` in order, else
 * plain `linux`. Undefined when the output says nothing recognisable.
 */
export function osFromProbe(output: string): HostOs | undefined {
  const lines = output.split('\n').map((l) => l.replace(/\r$/, ''));
  let kernel: HostOs | 'Linux' | undefined;
  for (const line of lines) {
    kernel = osFromKernel(line);
    if (kernel) break;
  }
  if (kernel && kernel !== 'Linux') return kernel;
  const release = parseOsRelease(output);
  for (const token of [release.id, ...release.idLike]) {
    const os = token !== undefined ? RELEASE_IDS[token] : undefined;
    if (os) return os;
  }
  return kernel === 'Linux' ? 'linux' : undefined;
}
