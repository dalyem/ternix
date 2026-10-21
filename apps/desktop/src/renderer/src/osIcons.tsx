import type { HostOs } from '@ternix/core/items';
import { Server } from 'lucide-react';
import { osLook } from './osLooks.js';

export { glyphColorOn, type OsLook, osLook } from './osLooks.js';

/** The mark of an operating system in the current text colour, at `size` pixels. */
export function OsGlyph({ os, size, className }: { os: HostOs; size: number; className?: string }) {
  const look = osLook(os);
  // A value this version does not know: the generic server glyph.
  if (!look) return <Server size={size} className={className} aria-hidden />;
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
