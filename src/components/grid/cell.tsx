'use client';

/**
 * One grid cell.
 *
 * Rendering goes through `cellToDisplay()` from src/lib/wire.ts and nothing
 * else — NULL is the italic dimmed `.null-cell`, a tagged cell shows its
 * lossless text, and bytes show "[N bytes] hex preview". An empty string and a
 * NULL must never look the same.
 *
 * PLAN §6 / SQLite trap 2: when `ColumnMeta.dynamicType` is set the type
 * styling is decided PER CELL from the runtime value, because one SQLite column
 * really can hold an integer in one row and a string in the next. For every
 * other engine the decision is per column, so a numeric column keeps its right
 * alignment even on the rows where the value is NULL.
 */

import * as React from 'react';
import type { ColumnMeta } from '../../lib/results';
import { cellToDisplay, isTagged, type Cell } from '../../lib/wire';
import { cn } from '../ui/primitives';

export type CellKind = 'null' | 'number' | 'boolean' | 'binary' | 'temporal' | 'structured' | 'text' | 'unsupported';

/** The kind of the value actually present, ignoring what the column claims. */
export function cellKindOf(cell: Cell): CellKind {
  if (cell === null) return 'null';
  if (typeof cell === 'boolean') return 'boolean';
  if (typeof cell === 'number') return 'number';
  if (typeof cell === 'string') return 'text';
  switch (cell.$t) {
    case 'bigint':
    case 'decimal':
    case 'decimal128':
      return 'number';
    case 'bytes':
      return 'binary';
    case 'date':
    case 'time':
    case 'timestamp':
    case 'timestamptz':
    case 'interval':
      return 'temporal';
    case 'json':
    case 'array':
    case 'document':
    case 'geo':
      return 'structured';
    case 'unsupported':
      return 'unsupported';
    default:
      return 'text';
  }
}

const NUMERIC_BASES = new Set<ColumnMeta['base']>(['integer', 'bigint', 'decimal', 'float', 'money']);

/**
 * Right alignment is a *column* property everywhere except SQLite-style dynamic
 * columns, where a column has no single type to align by.
 */
export function alignsRight(column: ColumnMeta, cell: Cell): boolean {
  if (column.dynamicType) return cellKindOf(cell) === 'number';
  return NUMERIC_BASES.has(column.base);
}

const TONES: Record<CellKind, string> = {
  null: 'null-cell',
  number: 'text-[var(--fg)]',
  boolean: 'text-[var(--accent)]',
  binary: 'text-[var(--fg-subtle)]',
  temporal: 'text-[var(--fg-muted)]',
  structured: 'text-[var(--fg-muted)]',
  text: 'text-[var(--fg)]',
  unsupported: 'text-[var(--danger)] italic',
};

export function cellToneClass(cell: Cell): string {
  return TONES[cellKindOf(cell)];
}

/** Multi-line text would break the row grid, so it is flattened for the cell. */
export function displayLine(cell: Cell): string {
  const text = cellToDisplay(cell);
  if (typeof cell === 'string' && /[\n\r\t]/.test(text)) {
    return text.replace(/\r?\n/g, '⏎').replace(/\t/g, '  ');
  }
  return text;
}

/** True when the value deserves the expanded viewer rather than a one-line cell. */
export function isExpandable(cell: Cell): boolean {
  if (cell === null) return false;
  if (typeof cell === 'string') return cell.length > 64 || /[\n\r]/.test(cell);
  if (isTagged(cell)) return cell.$t === 'bytes' || cell.$t === 'json' || cell.$t === 'array' || cell.$t === 'document' || cell.v.length > 64;
  return false;
}

export interface GridCellProps {
  cell: Cell;
  column: ColumnMeta;
  left: number;
  width: number;
  selected: boolean;
  focused: boolean;
  dirty: boolean;
  striped: boolean;
  /** Visual row / column position. Mouse handling is delegated to the grid,
   *  which reads these back off the DOM — no per-cell closures, so the memo
   *  actually holds across a scroll. */
  rowIndex: number;
  colIndex: number;
}

function GridCellImpl({
  cell,
  column,
  left,
  width,
  selected,
  focused,
  dirty,
  striped,
  rowIndex,
  colIndex,
}: GridCellProps) {
  const text = displayLine(cell);
  return (
    <div
      role="gridcell"
      data-cell=""
      data-r={rowIndex}
      data-c={colIndex}
      style={{ left, width }}
      title={text.length > 24 ? cellToDisplay(cell) : undefined}
      className={cn(
        'absolute top-0 h-full overflow-hidden whitespace-nowrap border-r border-[var(--border)] px-1.5',
        'flex items-center',
        alignsRight(column, cell) ? 'justify-end' : 'justify-start',
        cellToneClass(cell),
        // Dirty beats striping beats selection background, so an edited cell is
        // still obvious inside a selected range.
        dirty
          ? 'bg-[var(--warn-bg)]'
          : selected
            ? 'bg-[var(--selection)]'
            : striped
              ? 'bg-[var(--row-alt)]'
              : '',
        focused && 'shadow-[inset_0_0_0_2px_var(--accent)]',
      )}
    >
      <span className="truncate">{text}</span>
    </div>
  );
}

export const GridCell = React.memo(GridCellImpl);

// ---------------------------------------------------------------------------
// Inline editor
// ---------------------------------------------------------------------------

export interface CellEditorProps {
  initial: string;
  left: number;
  width: number;
  align: 'left' | 'right';
  /** `move` lets Tab/Enter commit and step in one keystroke, like a spreadsheet. */
  onCommit: (text: string, move: 'none' | 'right' | 'down') => void;
  onCancel: () => void;
}

export function CellEditor({ initial, left, width, align, onCommit, onCancel }: CellEditorProps) {
  const ref = React.useRef<HTMLInputElement>(null);
  const committed = React.useRef(false);
  const [text, setText] = React.useState(initial);

  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = (move: 'none' | 'right' | 'down') => {
    if (committed.current) return;
    committed.current = true;
    onCommit(text, move);
  };

  return (
    <input
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      // Blur commits: clicking another cell should keep what you typed, which is
      // what every grid in this class does.
      onBlur={() => commit('none')}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit('down');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commit('right');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committed.current = true;
          onCancel();
        }
      }}
      style={{ left, width }}
      className={cn(
        // Above the pinned row-number gutter (z-20), below the header (z-30).
        'mono absolute top-0 z-25 h-full border-none bg-[var(--bg)] px-1.5 text-[var(--fg)]',
        'outline-2 -outline-offset-1 outline-[var(--accent)]',
        align === 'right' && 'text-right',
      )}
    />
  );
}
