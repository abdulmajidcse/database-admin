'use client';

/**
 * One row as a vertical key/value form (PLAN §6).
 *
 * A 40-column row is unreadable sideways. This is the same data turned 90°,
 * with the full value per field, the column's engine type next to it, and the
 * same edit semantics as the grid — including the NULL toggle, because an empty
 * text box and a NULL are different things and the form has to let you say
 * which one you mean.
 */

import * as React from 'react';
import { ChevronLeft, ChevronRight, CircleSlash2, KeyRound, Maximize2 } from 'lucide-react';
import type { ColumnMeta } from '../../lib/results';
import { isTagged, type Cell } from '../../lib/wire';
import { Button, Dialog, cn } from '../ui/primitives';
import { cellsEqual, cellToEditText } from './edit-state';
import { cellToneClass, displayLine } from './cell';
import { CellViewer } from './cell-viewer';

export interface RowDetailProps {
  open: boolean;
  onClose: () => void;
  columns: ColumnMeta[];
  /** Current values, edits included. */
  values: Cell[];
  /** Server values, used only to mark fields the user changed. */
  originals?: Cell[];
  title?: React.ReactNode;
  editable?: boolean;
  /** `null` means "set this field to NULL"; a string is parsed by the grid. */
  onChange?: (columnIndex: number, text: string | null) => void;
  onNavigate?: (delta: number) => void;
  position?: { index: number; total: number };
}

/** Long or multi-line values get a textarea instead of a one-line input. */
function isLong(cell: Cell): boolean {
  if (typeof cell === 'string') return cell.length > 80 || /\n/.test(cell);
  if (cell !== null && isTagged(cell)) return cell.v.length > 80 || /\n/.test(cell.v);
  return false;
}

function FieldEditor({
  cell,
  onCommit,
}: {
  cell: Cell;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = React.useState(() => cellToEditText(cell));
  // Re-sync when the grid changes the value under us (undo, apply, navigation).
  const [seen, setSeen] = React.useState<Cell>(cell);
  if (seen !== cell) {
    setSeen(cell);
    setText(cellToEditText(cell));
  }

  const common = {
    value: text,
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: () => {
      if (text !== cellToEditText(cell)) onCommit(text);
    },
    className: cn(
      'mono w-full rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[var(--fg)] focus-ring',
      cell === null && 'placeholder:italic',
    ),
  };

  if (isLong(cell)) {
    return <textarea {...common} rows={Math.min(10, cellToEditText(cell).split('\n').length + 1)} />;
  }
  return (
    <input
      {...common}
      placeholder={cell === null ? 'NULL' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function RowDetail({
  open,
  onClose,
  columns,
  values,
  originals,
  title,
  editable,
  onChange,
  onNavigate,
  position,
}: RowDetailProps) {
  const [expanded, setExpanded] = React.useState<number | null>(null);

  if (!open) return null;

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        width="lg"
        title={
          <span className="flex items-center gap-2">
            {title ?? 'Row'}
            {position && (
              <span className="text-[11px] font-normal text-[var(--fg-subtle)]">
                {position.index + 1} of {position.total}
              </span>
            )}
          </span>
        }
        footer={
          <>
            {onNavigate && (
              <div className="mr-auto flex items-center gap-1">
                <Button
                  size="xs"
                  icon={<ChevronLeft className="size-3.5" />}
                  onClick={() => onNavigate(-1)}
                  disabled={position ? position.index === 0 : false}
                >
                  Previous
                </Button>
                <Button
                  size="xs"
                  icon={<ChevronRight className="size-3.5" />}
                  onClick={() => onNavigate(1)}
                  disabled={position ? position.index >= position.total - 1 : false}
                >
                  Next
                </Button>
              </div>
            )}
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        <div className="flex flex-col divide-y divide-[var(--border)] border border-[var(--border)]">
          {columns.map((col, i) => {
            const cell = values[i] ?? null;
            const dirty = originals !== undefined && !cellsEqual(originals[i] ?? null, cell);
            return (
              <div
                key={`${col.name}-${i}`}
                className={cn('flex items-start gap-2 px-2 py-1', dirty && 'bg-[var(--warn-bg)]')}
              >
                <div className="flex w-52 shrink-0 flex-col pt-0.5">
                  <span className="flex items-center gap-1 truncate text-[13px] font-medium" title={col.name}>
                    {col.isKey && <KeyRound className="size-3 shrink-0 text-[var(--warn)]" />}
                    {col.name}
                  </span>
                  <span className="truncate text-[11px] text-[var(--fg-subtle)]" title={col.typeName}>
                    {col.typeName}
                    {col.nullable === false ? ' · not null' : ''}
                  </span>
                </div>

                <div className="flex min-w-0 flex-1 items-start gap-1">
                  {editable && onChange ? (
                    <FieldEditor cell={cell} onCommit={(text) => onChange(i, text)} />
                  ) : (
                    <div className={cn('mono min-w-0 flex-1 truncate py-0.5', cellToneClass(cell))}>
                      {displayLine(cell)}
                    </div>
                  )}
                  {editable && onChange && (
                    <Button
                      size="xs"
                      variant="ghost"
                      title="Set NULL"
                      onClick={() => onChange(i, null)}
                      disabled={cell === null}
                    >
                      <CircleSlash2 className="size-3.5" />
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" title="Expand" onClick={() => setExpanded(i)}>
                    <Maximize2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
          {columns.length === 0 && (
            <div className="p-3 text-[var(--fg-muted)]">This result has no columns.</div>
          )}
        </div>
      </Dialog>

      {expanded !== null && columns[expanded] && (
        <CellViewer
          open
          onClose={() => setExpanded(null)}
          cell={values[expanded] ?? null}
          column={columns[expanded]}
          title={columns[expanded].name}
          editable={editable && !!onChange}
          onSave={(text) => onChange?.(expanded, text)}
        />
      )}
    </>
  );
}
