import { afterEach, describe, expect, it } from 'vitest';
import type { HostOs } from '@ternix/core/items';
import {
  OS_PROBE_COMMAND,
  OS_PROBE_MAX_BYTES,
  SshSession,
  osFromIdent,
  osFromProbe,
  parseOsRelease,
} from '../src/index.js';
import type { SessionHooks } from '../src/index.js';
import { TestSshServer, connection, waitFor } from './helpers.js';
import type { TestServerOptions } from './helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const trustAll: SessionHooks = { verifyHostKey: async () => true };

async function connected(options: Omit<TestServerOptions, 'users'>) {
  const server = await TestSshServer.start({ users: { alice: { password: 'pw' } }, ...options });
  cleanup.push(() => server.stop());
  const session = new SshSession();
  cleanup.push(() => session.close());
  await session.connect(connection({ port: server.port }), trustAll);
  return { server, session };
}

const probeOutput = (kernel: string, release: string) => `${kernel}\n${release}`;

describe('osFromIdent', () => {
  const cases: [string, HostOs | undefined][] = [
    ['SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5', 'ubuntu'],
    ['SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3', 'debian'],
    ['SSH-2.0-OpenSSH_7.9p1 Raspbian-10+deb10u2+rpt1', 'raspbian'],
    ['SSH-2.0-OpenSSH_9.7 FreeBSD-20240318', 'freebsd'],
    ['SSH-2.0-OpenSSH_for_Windows_9.5', 'windows'],
    ['SSH-2.0-OpenSSH_for_Windows_8.1', 'windows'],
    ['SSH-2.0-NetBSD_Secure_Shell-20230518-hpn13v14-lpk', 'netbsd'],
    ['SSH-2.0-OpenSSH_9.8', undefined],
    ['SSH-2.0-OpenSSH_9.6', undefined],
    ['SSH-2.0-dropbear_2022.83', undefined],
    ['SSH-2.0-ssh2js1.17.0', undefined],
    // Only the comments count: a software name that merely contains a distro does not.
    ['SSH-2.0-UbuntuSSH_1.0', undefined],
    ['not an ident Ubuntu', undefined],
    ['', undefined],
  ];
  it.each(cases)('%s', (ident, os) => {
    expect(osFromIdent(ident)).toBe(os);
  });

  it('treats a missing ident as unknown', () => {
    expect(osFromIdent(undefined)).toBeUndefined();
  });
});

describe('osFromProbe', () => {
  const releases: [string, string, HostOs][] = [
    ['ubuntu', 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n', 'ubuntu'],
    ['debian', 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n', 'debian'],
    ['fedora', 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=40\n', 'fedora'],
    ['centos', 'NAME="CentOS Stream"\nID="centos"\nID_LIKE="rhel fedora"\n', 'centos'],
    ['rhel', 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nID_LIKE="fedora"\n', 'rhel'],
    ['rocky', 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n', 'rocky'],
    ['alma', 'NAME="AlmaLinux"\nID="almalinux"\nID_LIKE="rhel centos fedora"\n', 'alma'],
    ['arch', 'NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n', 'arch'],
    ['alpine', 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3\n', 'alpine'],
    ['opensuse', 'NAME="openSUSE Leap"\nID="opensuse-leap"\nID_LIKE="suse opensuse"\n', 'opensuse'],
    ['sles', 'NAME="SLES"\nID="sles"\nID_LIKE="suse"\n', 'opensuse'],
    ['nixos', 'NAME=NixOS\nID=nixos\nVERSION_ID="24.05"\n', 'nixos'],
    ['raspbian', 'NAME="Raspbian GNU/Linux"\nID=raspbian\nID_LIKE=debian\n', 'raspbian'],
    ['amazon', 'NAME="Amazon Linux"\nID="amzn"\nID_LIKE="fedora"\n', 'amazon'],
    ['oracle', 'NAME="Oracle Linux Server"\nID="ol"\nID_LIKE="fedora"\n', 'oracle'],
    ['gentoo', 'NAME=Gentoo\nID=gentoo\n', 'gentoo'],
    ['manjaro', 'NAME="Manjaro Linux"\nID=manjaro\nID_LIKE=arch\n', 'manjaro'],
    ['mint', 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n', 'mint'],
    ['kali', 'NAME="Kali GNU/Linux"\nID=kali\nID_LIKE=debian\n', 'kali'],
    // Derivatives this version does not name fall back to their ID_LIKE, in order.
    ['pop', 'NAME="Pop!_OS"\nID=pop\nID_LIKE="ubuntu debian"\n', 'ubuntu'],
    ['endeavouros', 'NAME="EndeavourOS"\nID="endeavouros"\nID_LIKE="arch"\n', 'arch'],
    ['unknown distro', 'NAME="Something"\nID=something\n', 'linux'],
    ['no os-release', '', 'linux'],
  ];
  it.each(releases)('Linux, %s', (_name, release, os) => {
    expect(osFromProbe(probeOutput('Linux', release))).toBe(os);
  });

  const kernels: [string, string, HostOs][] = [
    ['Darwin', '', 'macos'],
    ['FreeBSD', 'NAME=FreeBSD\nID=freebsd\n', 'freebsd'],
    ['OpenBSD', '', 'openbsd'],
    ['NetBSD', '', 'netbsd'],
    ['CYGWIN_NT-10.0-19045', '', 'windows'],
    ['MINGW64_NT-10.0-22631', '', 'windows'],
    ['MSYS_NT-10.0-22631', '', 'windows'],
  ];
  it.each(kernels)('%s', (kernel, release, os) => {
    expect(osFromProbe(probeOutput(kernel, release))).toBe(os);
  });

  it('reads CRLF output', () => {
    expect(osFromProbe('Linux\r\nNAME="Fedora"\r\nID=fedora\r\n')).toBe('fedora');
  });

  it('skips lines a login script printed before the kernel name', () => {
    expect(osFromProbe('Welcome to the box!\nLinux\nID=debian\n')).toBe('debian');
  });

  it('says nothing for output without a kernel name or os-release', () => {
    expect(osFromProbe('')).toBeUndefined();
    expect(osFromProbe("'uname' is not recognized as an internal or external command")).toBe(
      undefined,
    );
    expect(osFromProbe('linux\n')).toBeUndefined();
  });

  it('accepts only exact os-release assignments', () => {
    const hostile = [
      'Linux',
      'ID=$(rm -rf /)',
      'ID=`reboot`',
      ' ID=ubuntu',
      'ID = ubuntu',
      'export ID=ubuntu',
      'ID="ubuntu',
      'ID="ubu"ntu"',
      `ID=${'a'.repeat(300)}`,
      'id=ubuntu',
    ].join('\n');
    expect(osFromProbe(hostile)).toBe('linux');
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'an ID of %s names nothing (no prototype lookups)',
    (token) => {
      expect(osFromProbe(`Linux\nID=${token}\n`)).toBe('linux');
      expect(osFromProbe(`ID=${token}\nID_LIKE="${token} debian"\n`)).toBe('debian');
      expect(osFromProbe(`ID=${token}\nID_LIKE=${token}\n`)).toBeUndefined();
    },
  );

  it('keeps the first ID and ignores tokens with odd characters in ID_LIKE', () => {
    expect(parseOsRelease('ID=alpine\nID=ubuntu\n')).toEqual({ id: 'alpine', idLike: [] });
    expect(parseOsRelease('ID_LIKE="Ubuntu ../etc debian"\n')).toEqual({
      idLike: ['ubuntu', 'debian'],
    });
    expect(parseOsRelease("ID='nixos'\n")).toEqual({ id: 'nixos', idLike: [] });
  });
});

describe('SshSession.detectOs', () => {
  it('keeps the identification line of the target', async () => {
    const { session } = await connected({ ident: 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5' });
    expect(session.serverIdent).toBe('SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5');
  });

  it('runs the one probe command on an exec channel without a PTY, stdin closed', async () => {
    const { server, session } = await connected({
      ident: 'OpenSSH_9.8',
      exec: () => 'hang',
    });
    const detecting = session.detectOs({ timeoutMs: 400 });
    await waitFor(() => server.execStdinEnded === 1, 'the probe to close its stdin');
    expect(await detecting).toBeUndefined();
    expect(server.execs).toEqual([{ command: OS_PROBE_COMMAND, pty: false }]);
    await waitFor(() => server.execClosed === 1, 'the timed out probe channel to close');
  });

  it('reads the os-release the probe prints', async () => {
    const { session } = await connected({
      ident: 'OpenSSH_9.8',
      exec: () => ({ stdout: probeOutput('Linux', 'NAME="Rocky Linux"\nID="rocky"\n') }),
    });
    expect(await session.detectOs()).toBe('rocky');
  });

  it('lets the probe refine the identification line', async () => {
    const { session } = await connected({
      ident: 'OpenSSH_8.9p1 Ubuntu-3ubuntu0.10',
      exec: () => ({ stdout: probeOutput('Linux', 'ID=linuxmint\nID_LIKE="ubuntu debian"\n') }),
    });
    expect(await session.detectOs()).toBe('mint');
  });

  it('prefers the distribution in the identification line to a bare Linux', async () => {
    const { session } = await connected({
      ident: 'OpenSSH_9.2p1 Debian-2+deb12u3',
      exec: () => ({ stdout: 'Linux\n' }),
    });
    expect(await session.detectOs()).toBe('debian');
  });

  it('falls back to the identification line when exec is refused', async () => {
    const { server, session } = await connected({ ident: 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5' });
    expect(await session.detectOs()).toBe('ubuntu');
    expect(server.execs).toHaveLength(1);
  });

  it('is unknown when exec is refused and the identification line says nothing', async () => {
    const { session } = await connected({});
    expect(await session.detectOs()).toBeUndefined();
  });

  it('falls back to the identification line on timeout', async () => {
    const { session } = await connected({
      ident: 'OpenSSH_9.2p1 Debian-2+deb12u3',
      exec: () => 'hang',
    });
    const started = Date.now();
    expect(await session.detectOs({ timeoutMs: 300 })).toBe('debian');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('runs nothing on a Windows server', async () => {
    const { server, session } = await connected({ ident: 'OpenSSH_for_Windows_9.5' });
    expect(await session.detectOs()).toBe('windows');
    expect(server.execs).toEqual([]);
  });

  it('reads at most 16 KiB of output and then closes the channel', async () => {
    // A login script floods stdout; the os-release that would follow it is never read.
    const flood = Buffer.from(`Linux\n${'x'.repeat(OS_PROBE_MAX_BYTES * 4)}\nID=fedora\n`);
    const { server, session } = await connected({ exec: () => ({ stdout: flood }) });
    expect(await session.detectOs()).toBe('linux');
    await waitFor(() => server.execClosed === 1, 'the probe channel to close');
  });

  it('still reads an os-release that fits within the limit', async () => {
    const release = `${'# comment\n'.repeat(100)}ID=gentoo\n`;
    const { session } = await connected({
      exec: () => ({ stdout: probeOutput('Linux', release) }),
    });
    expect(await session.detectOs()).toBe('gentoo');
  });

  it('ignores stderr and a non-zero exit status', async () => {
    const { session } = await connected({
      exec: () => ({ stdout: 'Darwin\n', stderr: 'cat: /etc/os-release: No such file', code: 1 }),
    });
    expect(await session.detectOs()).toBe('macos');
  });

  it('closes a probe channel the server accepts only after the timeout', async () => {
    const { server, session } = await connected({ ident: 'OpenSSH_9.8', exec: () => 'hold' });
    expect(await session.detectOs({ timeoutMs: 200 })).toBeUndefined();
    await waitFor(() => server.heldExecs.length === 1, 'the held exec request');
    server.releaseExecs();
    await waitFor(() => server.execClosed === 1, 'the late probe channel to close', 2_000);
    // The connection is unharmed: a shell still opens and echoes.
    const shell = await session.openShell({ cols: 80, rows: 24 });
    shell.write('still here\n');
    await waitFor(() => server.shellInput.includes('still here'), 'the shell to be live');
  });

  it('is unknown, without throwing, on a session that is not connected', async () => {
    const session = new SshSession();
    expect(await session.detectOs()).toBeUndefined();
    await session.close();
    expect(await session.detectOs()).toBeUndefined();
  });
});
