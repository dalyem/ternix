import type { HostOs } from '@ternix/core/items';
import { AppWindow, type LucideIcon } from 'lucide-react';
// Only the icons named here end up in the bundle (simple-icons is side-effect free).
import {
  siAlmalinux,
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siManjaro,
  siNetbsd,
  siNixos,
  siOpenbsd,
  siOpensuse,
  siRaspberrypi,
  siRedhat,
  siRockylinux,
  siUbuntu,
} from 'simple-icons';

/**
 * How a host's operating system looks on its tile. Brand marks come from simple-icons (CC0 as a
 * collection; see apps/desktop/README.md for the marks with their own terms), drawn unmodified
 * except for the single fill colour, only to say which system a host runs. Systems without a mark
 * there use a neutral glyph (Windows) or the Linux penguin (Amazon Linux, Oracle Linux). Tile
 * colours follow Termius's host palette where it has one, else the brand's own colour.
 */
export interface OsLook {
  /** Shown as the tile's tooltip. */
  title: string;
  color: string;
  /** A 24×24 simple-icons path, or a Lucide glyph. */
  path?: string;
  glyph?: LucideIcon;
}

const mark = (icon: { path: string }, title: string, color: string): OsLook => ({
  title,
  color,
  path: icon.path,
});

export const OS_LOOKS: Record<HostOs, OsLook> = {
  ubuntu: mark(siUbuntu, 'Ubuntu', '#E95420'),
  debian: mark(siDebian, 'Debian', '#CE0056'),
  fedora: mark(siFedora, 'Fedora', '#3C6EB4'),
  centos: mark(siCentos, 'CentOS', '#EFA720'),
  rhel: mark(siRedhat, 'Red Hat Enterprise Linux', '#EE0000'),
  rocky: mark(siRockylinux, 'Rocky Linux', '#34D399'),
  alma: mark(siAlmalinux, 'AlmaLinux', '#00245E'),
  arch: mark(siArchlinux, 'Arch Linux', '#1793D1'),
  alpine: mark(siAlpinelinux, 'Alpine Linux', '#0D597F'),
  opensuse: mark(siOpensuse, 'openSUSE', '#30BA78'),
  nixos: mark(siNixos, 'NixOS', '#5277C3'),
  raspbian: mark(siRaspberrypi, 'Raspberry Pi OS', '#BE3956'),
  amazon: mark(siLinux, 'Amazon Linux', '#FF9900'),
  oracle: mark(siLinux, 'Oracle Linux', '#C74634'),
  gentoo: mark(siGentoo, 'Gentoo', '#54487A'),
  manjaro: mark(siManjaro, 'Manjaro', '#35BFA4'),
  mint: mark(siLinuxmint, 'Linux Mint', '#86BE43'),
  kali: mark(siKalilinux, 'Kali Linux', '#557C94'),
  freebsd: mark(siFreebsd, 'FreeBSD', '#F60006'),
  openbsd: mark(siOpenbsd, 'OpenBSD', '#F2CA30'),
  netbsd: mark(siNetbsd, 'NetBSD', '#F26711'),
  macos: mark(siApple, 'macOS', '#49A3F2'),
  windows: { title: 'Windows', color: '#00A1F1', glyph: AppWindow },
  linux: mark(siLinux, 'Linux', '#FFCC33'),
};

/**
 * Relative luminance (WCAG) of a `#rrggbb` colour; undefined for anything else (named colours,
 * which the tile then draws with its default white glyph).
 */
function luminance(color: string): number | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (!m) return undefined;
  const [r, g, b] = [m[1], m[2], m[3]].map((hex) => {
    const c = parseInt(hex!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White, except on the few tile colours too light for it (the Linux and OpenBSD yellows). */
export function glyphColorOn(background: string): string {
  return (luminance(background) ?? 0) > 0.55 ? '#141729' : '#ffffff';
}

/** The mark of an operating system in the current text colour, at `size` pixels. */
export function OsGlyph({ os, size, className }: { os: HostOs; size: number; className?: string }) {
  const look = OS_LOOKS[os];
  if (look.glyph) {
    const Glyph = look.glyph;
    return <Glyph size={size} className={className} aria-hidden />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d={look.path} />
    </svg>
  );
}
