'use client';

/**
 * The tree's filter box (PLAN §1 Navigation).
 *
 * Two searches in one control, because they answer different questions:
 *
 *  1. **Filter** — instant, client-side, over the levels already loaded. Typing
 *     narrows what is on screen without a single request.
 *  2. **Search everywhere** — opt-in, and the only thing here that costs a round
 *     trip. It reads the canonical SchemaModel (/api/schema) and matches
 *     `allTables()` and their columns, so an object in a schema nobody has
 *     expanded yet is still findable. Picking a hit reveals it in the tree.
 *
 * Everything-everywhere is deliberately not automatic: introspecting a 500-table
 * database because someone typed one letter is exactly the behaviour §8.3 calls
 * out.
 */

import * as React from 'react';
import { Search, Telescope, X } from 'lucide-react';
import { allTables, qualifiedName, type ColumnModel, type SchemaModel, type TableModel } from '@/lib/schema-model';
import { Button, Input, Spinner, cn } from '@/components/ui/primitives';
import { useSchema } from '@/hooks/use-schema';
import { TreeNodeIcon } from './tree-node';

export interface SearchHit {
  id: string;
  kind: 'table' | 'column';
  table: TableModel;
  column?: ColumnModel;
  /** Qualified label shown in the list. */
  label: string;
  detail: string;
  score: number;
}

const MAX_HITS = 200;

/**
 * Rank: exact name, then prefix, then substring; tables before their columns so
 * a table never sinks below its own column list.
 */
function scoreOf(name: string, needle: string, isTable: boolean): number | null {
  const lower = name.toLowerCase();
  if (lower === needle) return isTable ? 0 : 4;
  if (lower.startsWith(needle)) return isTable ? 1 : 5;
  if (lower.includes(needle)) return isTable ? 2 : 6;
  return null;
}

export function searchModel(model: SchemaModel, query: string, limit = MAX_HITS): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const hits: SearchHit[] = [];

  for (const table of allTables(model)) {
    const tableScore = scoreOf(table.name, needle, true);
    if (tableScore !== null) {
      hits.push({
        id: `t:${qualifiedName(table)}`,
        kind: 'table',
        table,
        label: qualifiedName(table),
        detail:
          table.kind === 'table'
            ? table.rowEstimate !== undefined
              ? `~${table.rowEstimate.toLocaleString()} rows`
              : 'table'
            : table.kind.replace('_', ' '),
        score: tableScore,
      });
    }
    for (const column of table.columns) {
      const columnScore = scoreOf(column.name, needle, false);
      if (columnScore === null) continue;
      hits.push({
        id: `c:${qualifiedName(table)}.${column.name}`,
        kind: 'column',
        table,
        column,
        label: `${qualifiedName(table)}.${column.name}`,
        detail: column.type.raw,
        score: columnScore,
      });
    }
  }

  hits.sort((a, b) => a.score - b.score || a.label.length - b.label.length || a.label.localeCompare(b.label));
  return hits.slice(0, limit);
}

/**
 * Best-effort translation from the canonical model to a connector tree path, so
 * a hit can be revealed in the tree. The shapes are the ones the connectors
 * build in `listNodes` (see each connector's tree section); when an engine has
 * no path for the object — Redis has no tables at all — reveal is skipped and
 * the hit still opens its data tab.
 */
export function treePathForTable(model: SchemaModel, table: TableModel): string[] | null {
  const isView = table.kind === 'view' || table.kind === 'materialized_view';
  const namespace = table.schema ?? model.database;

  switch (model.engine) {
    case 'postgres': {
      if (!model.database || !namespace) return null;
      return [
        `db:${model.database}`,
        `schema:${namespace}`,
        isView ? 'view-folder:views' : 'table-folder:tables',
        // Postgres names both branches `table:`; the node kind carries the rest.
        `table:${table.name}`,
      ];
    }
    case 'mysql':
    case 'mariadb': {
      if (!namespace) return null;
      return [
        `db:${namespace}`,
        isView ? 'view-folder:views' : 'table-folder:tables',
        `${isView ? 'view' : 'table'}:${table.name}`,
      ];
    }
    case 'sqlite': {
      // SQLite's folder segments carry no name (`db:main/table-folder/...`).
      return [`db:${namespace ?? 'main'}`, isView ? 'view-folder' : 'table-folder', `${isView ? 'view' : 'table'}:${table.name}`];
    }
    case 'mongodb': {
      if (!namespace) return null;
      return [`db:${namespace}`, `collection:${table.name}`];
    }
    default:
      return null;
  }
}

export interface TreeSearchProps {
  connectionId: string | null;
  value: string;
  onChange: (next: string) => void;
  /** Rows left after the client-side filter, for the "12 of 340" hint. */
  matched: number;
  total: number;
  onPick: (hit: SearchHit, model: SchemaModel) => void;
  /** Escape with an empty box hands focus back to the tree. */
  onEscape?: () => void;
}

export function TreeSearch({ connectionId, value, onChange, matched, total, onPick, onEscape }: TreeSearchProps) {
  const [everywhere, setEverywhere] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const schema = useSchema(connectionId, { enabled: everywhere && !!connectionId });
  const model = schema.model;

  const hits = React.useMemo(
    () => (everywhere && model && value.trim() !== '' ? searchModel(model, value) : []),
    [everywhere, model, value],
  );

  React.useEffect(() => setActive(0), [value, everywhere]);
  // A connection switch invalidates a global search that was aimed at the old one.
  React.useEffect(() => setEverywhere(false), [connectionId]);

  const showPanel = everywhere && value.trim() !== '';

  function pick(hit: SearchHit): void {
    if (!model) return;
    onPick(hit, model);
    setEverywhere(false);
  }

  return (
    <div className="relative border-b border-[var(--border)] px-2 py-1.5">
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            ref={inputRef}
            className="pl-6 pr-6"
            placeholder={everywhere ? 'Search everywhere…' : 'Filter loaded objects'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                if (value === '') onEscape?.();
                else onChange('');
                return;
              }
              if (!showPanel || hits.length === 0) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => (i + 1) % hits.length);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => (i - 1 + hits.length) % hits.length);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const hit = hits[active];
                if (hit) pick(hit);
              }
            }}
          />
          {value !== '' && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => {
                onChange('');
                inputRef.current?.focus();
              }}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--fg-subtle)] hover:bg-[var(--bg-active)] hover:text-[var(--fg)]"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <Button
          size="xs"
          variant={everywhere ? 'primary' : 'ghost'}
          title="Search everywhere — reads the full schema so unexpanded objects are findable"
          aria-pressed={everywhere}
          disabled={!connectionId}
          onClick={() => {
            setEverywhere((v) => !v);
            inputRef.current?.focus();
          }}
        >
          <Telescope className="size-3.5" />
        </Button>
      </div>

      {value !== '' && !everywhere && (
        <p className="pt-1 text-[10px] text-[var(--fg-subtle)]">
          {matched} of {total} loaded objects
        </p>
      )}

      {showPanel && (
        <div className="absolute left-2 right-2 top-full z-40 max-h-72 overflow-y-auto border border-[var(--border)] bg-[var(--bg-panel)] shadow-[var(--shadow)]">
          {schema.isPending && (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--fg-muted)]">
              <Spinner className="size-3" /> Reading the schema…
            </div>
          )}
          {schema.error && (
            <p className="px-2 py-2 text-xs text-[var(--danger)]">{schema.error.message}</p>
          )}
          {!schema.isPending && !schema.error && hits.length === 0 && (
            <p className="px-2 py-2 text-xs text-[var(--fg-subtle)]">Nothing in the schema matches.</p>
          )}
          {hits.map((hit, index) => (
            <button
              key={hit.id}
              type="button"
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(hit)}
              className={cn(
                'flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px]',
                active === index ? 'bg-[var(--selection)]' : 'hover:bg-[var(--bg-hover)]',
              )}
            >
              <TreeNodeIcon
                kind={
                  hit.kind === 'column'
                    ? 'column'
                    : hit.table.kind === 'view'
                      ? 'view'
                      : hit.table.kind === 'materialized_view'
                        ? 'materialized-view'
                        : 'table'
                }
              />
              <span className="truncate">{hit.label}</span>
              <span className="ml-auto shrink-0 pl-2 text-[11px] text-[var(--fg-subtle)]">{hit.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
