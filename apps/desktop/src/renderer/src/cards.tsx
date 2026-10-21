import type { LucideIcon } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';

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
