import type { HostOs } from '@ternix/core/items';
import { type LucideIcon, Server } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { tileColor } from './items.js';
import { glyphColorOn, OS_LOOKS, OsGlyph } from './osIcons.js';

/** The 40px coloured square at the start of a card; a glyph, or a letter for port forwards. */
export function Tile({
  color,
  icon: Icon,
  letter,
  small,
}: {
  color?: string;
  icon?: LucideIcon;
  letter?: string;
  small?: boolean;
}) {
  return (
    <span
      className={`tile ${small ? 'tile-sm' : ''} ${letter ? 'tile-letter' : ''}`}
      style={color ? { background: color } : undefined}
      aria-hidden
    >
      {Icon ? <Icon size={small ? 18 : 20} /> : letter}
    </span>
  );
}

/**
 * A host's tile: its operating system's mark when known, else the server glyph. The colour is the
 * one the user chose, else the system's, else a stable pick from the label.
 */
export function HostTile({
  label,
  color,
  os,
  small,
}: {
  label: string;
  color?: string | undefined;
  os?: HostOs | undefined;
  small?: boolean;
}) {
  const look = os ? OS_LOOKS[os] : undefined;
  const background = color || look?.color || tileColor(label);
  const size = small ? 18 : 20;
  return (
    <span
      className={`tile ${small ? 'tile-sm' : ''}`}
      style={{ background, color: glyphColorOn(background) }}
      data-os={os ?? ''}
      title={look?.title}
      aria-hidden
    >
      {os ? <OsGlyph os={os} size={size} /> : <Server size={size} />}
    </span>
  );
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

/**
 * One item of a grid: tile, title over subtitle, and actions that appear on hover or focus.
 * A click selects (and usually opens the editor); double click or Enter opens it.
 */
export function EntityCard({
  tile,
  title,
  sub,
  meta,
  actions,
  selected,
  onSelect,
  onOpen,
  testId,
  mono,
}: {
  tile: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
  onOpen?: () => void;
  testId?: string;
  mono?: boolean;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      (onOpen ?? onSelect)?.();
    } else if (e.key === ' ') {
      e.preventDefault();
      onSelect?.();
    }
  };
  return (
    <div
      className={`entity-card ${selected ? 'selected' : ''}`}
      tabIndex={0}
      data-testid={testId}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={onKeyDown}
    >
      {tile}
      <div className="entity-main">
        <div className={`entity-title ellipsis ${mono ? 'mono' : ''}`}>{title}</div>
        {sub ? <div className="entity-sub ellipsis">{sub}</div> : null}
      </div>
      {meta ? <div className="entity-meta">{meta}</div> : null}
      {actions ? (
        <div
          className="entity-actions"
          onClick={stop}
          onDoubleClick={stop}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
