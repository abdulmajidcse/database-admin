'use client';

/**
 * The grid's filter bar (PLAN §6 "grid + filter bar").
 *
 * Two ways to narrow a table, both server-side through /api/table/read:
 *
 *  - Structured chips. The user picks a column, an operator and types a VALUE;
 *    the server builds the predicate and binds the value as a parameter
 *    (src/server/db/sql/filters.ts). Nothing typed here reaches the SQL text.
 *  - A raw WHERE box, for the things chips will never express. That one IS the
 *    user writing SQL, so it is a separate control that looks like one.
 *
 * Filtering (and sorting) never happens in the browser: the grid only ever
 * holds a page, so a client-side filter would filter the page and lie about the
 * rest of the table.
 */

import * as React from 'react';
import { Funnel, Plus, X } from 'lucide-react';
import type { ColumnMeta } from '../../lib/results';
// Type-only: this is the exact union the /api/table/read validator accepts, so
// a new operator on the server is a compile error here rather than a 400 later.
// `import type` is erased at build time — no server code enters the bundle.
import type { ColumnFilter, FilterOperator } from '../../server/db/types';
import { Badge, Button, Input, Select, cn } from '../ui/primitives';

export interface GridFilterState {
  filters: ColumnFilter[];
  /** Raw WHERE text, without the `WHERE` keyword. */
  where: string;
}

export const EMPTY_FILTER_STATE: GridFilterState = { filters: [], where: '' };

export function isFilterStateEmpty(s: GridFilterState): boolean {
  return s.filters.length === 0 && s.where.trim() === '';
}

type Arity = 'none' | 'one' | 'two' | 'list';

interface OperatorSpec {
  op: FilterOperator;
  label: string;
  symbol: string;
  arity: Arity;
}

export const FILTER_OPERATORS: OperatorSpec[] = [
  { op: 'eq', label: '=', symbol: '=', arity: 'one' },
  { op: 'ne', label: '≠', symbol: '≠', arity: 'one' },
  { op: 'lt', label: '<', symbol: '<', arity: 'one' },
  { op: 'lte', label: '≤', symbol: '≤', arity: 'one' },
  { op: 'gt', label: '>', symbol: '>', arity: 'one' },
  { op: 'gte', label: '≥', symbol: '≥', arity: 'one' },
  { op: 'contains', label: 'contains', symbol: '⊃', arity: 'one' },
  { op: 'startsWith', label: 'starts with', symbol: '^', arity: 'one' },
  { op: 'endsWith', label: 'ends with', symbol: '$', arity: 'one' },
  { op: 'in', label: 'in list', symbol: '∈', arity: 'list' },
  { op: 'between', label: 'between', symbol: '↔', arity: 'two' },
  { op: 'isNull', label: 'is null', symbol: 'IS NULL', arity: 'none' },
  { op: 'isNotNull', label: 'is not null', symbol: 'IS NOT NULL', arity: 'none' },
];

const ARITY = new Map<FilterOperator, Arity>(FILTER_OPERATORS.map((o) => [o.op, o.arity]));

function arityOf(op: FilterOperator): Arity {
  return ARITY.get(op) ?? 'one';
}

/** The server rejects an incomplete filter with a 400 — catch it here instead. */
export function filterIsComplete(f: ColumnFilter): boolean {
  switch (arityOf(f.op)) {
    case 'none':
      return true;
    case 'two':
      return (f.value ?? '') !== '' && (f.value2 ?? '') !== '';
    case 'list':
      return (f.values ?? []).length > 0;
    default:
      return f.value !== undefined;
  }
}

export function describeFilter(f: ColumnFilter): string {
  const spec = FILTER_OPERATORS.find((o) => o.op === f.op);
  const symbol = spec?.symbol ?? f.op;
  switch (arityOf(f.op)) {
    case 'none':
      return `${f.column} ${symbol}`;
    case 'two':
      return `${f.column} ${f.value ?? ''} ↔ ${f.value2 ?? ''}`;
    case 'list':
      return `${f.column} ∈ (${(f.values ?? []).join(', ')})`;
    default:
      return `${f.column} ${symbol} ${f.value ?? ''}`;
  }
}

export interface FilterBarProps {
  columns: ColumnMeta[];
  /** The state currently reflected by the rows on screen. */
  value: GridFilterState;
  onApply: (next: GridFilterState) => void;
  busy?: boolean;
  className?: string;
}

export function FilterBar({ columns, value, onApply, busy, className }: FilterBarProps) {
  const [draft, setDraft] = React.useState<GridFilterState>(value);
  const [editing, setEditing] = React.useState<number | null>(null);

  // The owner re-applies filters from its own state (a restored tab, a reset
  // button); the draft follows whenever that changes underneath us.
  const [seen, setSeen] = React.useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
    setEditing(null);
  }

  const dirty =
    draft.where !== value.where || JSON.stringify(draft.filters) !== JSON.stringify(value.filters);

  const apply = (next: GridFilterState) => {
    setDraft(next);
    // An incomplete chip is still being typed — it must not reach the server.
    onApply({ filters: next.filters.filter(filterIsComplete), where: next.where });
  };

  const addFilter = () => {
    const column = columns[0]?.name ?? '';
    setDraft((d) => ({ ...d, filters: [...d.filters, { column, op: 'eq', value: '' }] }));
    setEditing(draft.filters.length);
  };

  const patchFilter = (index: number, patch: Partial<ColumnFilter>) => {
    setDraft((d) => ({
      ...d,
      filters: d.filters.map((f, i) => (i === index ? normalize({ ...f, ...patch }) : f)),
    }));
  };

  const removeFilter = (index: number) => {
    const next = { ...draft, filters: draft.filters.filter((_, i) => i !== index) };
    setEditing(null);
    apply(next);
  };

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1',
        className,
      )}
    >
      <Funnel className="size-3.5 shrink-0 text-[var(--fg-muted)]" />

      {draft.filters.map((f, i) =>
        editing === i ? (
          <FilterEditor
            key={i}
            columns={columns}
            filter={f}
            onChange={(patch) => patchFilter(i, patch)}
            onDone={() => {
              setEditing(null);
              if (filterIsComplete(f)) apply(draft);
            }}
            onRemove={() => removeFilter(i)}
          />
        ) : (
          <span
            key={i}
            className={cn(
              'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]',
              filterIsComplete(f)
                ? 'border-[var(--border)] bg-[var(--bg-panel)] text-[var(--fg)]'
                : 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn)]',
            )}
          >
            <button type="button" className="mono hover:underline" onClick={() => setEditing(i)}>
              {describeFilter(f)}
            </button>
            <button type="button" onClick={() => removeFilter(i)} aria-label="Remove filter">
              <X className="size-3 text-[var(--fg-subtle)] hover:text-[var(--danger)]" />
            </button>
          </span>
        ),
      )}

      <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={addFilter} disabled={columns.length === 0}>
        Filter
      </Button>

      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-[11px] text-[var(--fg-subtle)]">WHERE</span>
        <Input
          value={draft.where}
          spellCheck={false}
          placeholder="raw SQL condition, e.g. created_at > now() - interval '7 days'"
          onChange={(e) => setDraft((d) => ({ ...d, where: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply(draft);
          }}
          className="mono h-6 w-[26rem] max-w-[40vw]"
        />
        {dirty && (
          <Button size="xs" variant="primary" onClick={() => apply(draft)} loading={busy}>
            Apply
          </Button>
        )}
        {!isFilterStateEmpty(value) && !dirty && (
          <>
            <Badge tone="accent">{value.filters.length + (value.where.trim() ? 1 : 0)} active</Badge>
            <Button size="xs" variant="ghost" onClick={() => apply(EMPTY_FILTER_STATE)}>
              Clear
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Drop the fields the chosen operator does not use, so the request stays valid. */
function normalize(f: ColumnFilter): ColumnFilter {
  const next: ColumnFilter = { column: f.column, op: f.op };
  switch (arityOf(f.op)) {
    case 'none':
      return next;
    case 'two':
      return { ...next, value: f.value ?? '', value2: f.value2 ?? '' };
    case 'list':
      return { ...next, values: f.values ?? [] };
    default:
      return { ...next, value: f.value ?? '' };
  }
}

function FilterEditor({
  columns,
  filter,
  onChange,
  onDone,
  onRemove,
}: {
  columns: ColumnMeta[];
  filter: ColumnFilter;
  onChange: (patch: Partial<ColumnFilter>) => void;
  onDone: () => void;
  onRemove: () => void;
}) {
  const arity = arityOf(filter.op);
  const commitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onDone();
    if (e.key === 'Escape') onRemove();
  };

  return (
    <span className="inline-flex items-center gap-1 rounded border border-[var(--accent)] bg-[var(--bg-panel)] px-1 py-0.5">
      <Select
        value={filter.column}
        onChange={(e) => onChange({ column: e.target.value })}
        className="h-6 w-36 text-[11px]"
      >
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select
        value={filter.op}
        onChange={(e) => onChange({ op: e.target.value as FilterOperator })}
        className="h-6 w-28 text-[11px]"
      >
        {FILTER_OPERATORS.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </Select>

      {arity === 'one' && (
        <Input
          autoFocus
          value={filter.value ?? ''}
          onChange={(e) => onChange({ value: e.target.value })}
          onKeyDown={commitOnEnter}
          className="mono h-6 w-40"
        />
      )}
      {arity === 'two' && (
        <>
          <Input
            autoFocus
            value={filter.value ?? ''}
            onChange={(e) => onChange({ value: e.target.value })}
            onKeyDown={commitOnEnter}
            className="mono h-6 w-24"
          />
          <span className="text-[11px] text-[var(--fg-subtle)]">and</span>
          <Input
            value={filter.value2 ?? ''}
            onChange={(e) => onChange({ value2: e.target.value })}
            onKeyDown={commitOnEnter}
            className="mono h-6 w-24"
          />
        </>
      )}
      {arity === 'list' && (
        <Input
          autoFocus
          value={(filter.values ?? []).join(', ')}
          placeholder="a, b, c"
          onChange={(e) =>
            onChange({
              values: e.target.value
                .split(',')
                .map((v) => v.trim())
                .filter((v) => v !== ''),
            })
          }
          onKeyDown={commitOnEnter}
          className="mono h-6 w-56"
        />
      )}

      <Button size="xs" variant="ghost" onClick={onDone} title="Apply filter">
        OK
      </Button>
      <button type="button" onClick={onRemove} aria-label="Remove filter">
        <X className="size-3 text-[var(--fg-subtle)] hover:text-[var(--danger)]" />
      </button>
    </span>
  );
}
