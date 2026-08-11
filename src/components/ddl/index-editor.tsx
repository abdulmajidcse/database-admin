'use client';

/**
 * Index editor for the table designer (PLAN M3).
 *
 * The model is `IndexModel[]` straight out of the canonical schema, so what is
 * edited here is exactly what `renderCreateIndex` / `renderInlineIndex` emit —
 * no second representation to drift.
 *
 * Only what an engine can actually express is offered: the access-method list
 * differs per engine, prefix lengths are MySQL-only syntax (`renderIndexPart`
 * drops them elsewhere), `NULLS FIRST/LAST` is Postgres, and a partial-index
 * predicate exists on Postgres and SQLite but not MySQL. Offering a control
 * whose value the generator silently discards would be a lie.
 *
 * Primary keys and the internal indexes SQLite creates for UNIQUE constraints
 * are listed but not editable: the first is owned by the Columns tab, and the
 * second cannot be recreated with CREATE INDEX at all (the `sqlite_` prefix is
 * reserved), which is why `isConstraintIndex` exists on the server.
 */

import * as React from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { ColumnModel, EngineKind, IndexColumn, IndexModel } from '@/lib/schema-model';
import { isConstraintIndex } from '@/server/db/sql/ddl-common';
import { Badge, Button, Checkbox, Input, Select, cn } from '@/components/ui/primitives';

const EXPRESSION_PART = ' expression ';

function isMysqlFamily(engine: EngineKind): boolean {
  return engine === 'mysql' || engine === 'mariadb';
}

/** Access methods each engine understands. Empty means "the engine has one". */
export function indexMethods(engine: EngineKind): string[] {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return ['btree', 'hash', 'fulltext', 'spatial'];
    case 'postgres':
      return ['btree', 'hash', 'gin', 'gist', 'spgist', 'brin'];
    default:
      return [];
  }
}

export function supportsPartialIndex(engine: EngineKind): boolean {
  return engine === 'postgres' || engine === 'sqlite';
}

function defaultIndexName(table: string, columns: IndexColumn[], taken: Set<string>): string {
  const stem = ['idx', table, ...columns.map((c) => c.name ?? 'expr')]
    .join('_')
    .replace(/[^\w]+/g, '_')
    .slice(0, 60);
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 100; n++) {
    const candidate = `${stem}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}_${Date.now()}`;
}

export interface IndexEditorProps {
  engine: EngineKind;
  tableName: string;
  indexes: IndexModel[];
  columns: ColumnModel[];
  onChange: (indexes: IndexModel[]) => void;
  readOnly?: boolean;
}

export function IndexEditor({
  engine,
  tableName,
  indexes,
  columns,
  onChange,
  readOnly = false,
}: IndexEditorProps) {
  const methods = indexMethods(engine);
  const columnNames = columns.map((c) => c.name);
  const byName = React.useMemo(() => new Map(columns.map((c) => [c.name, c])), [columns]);

  function patch(index: number, changes: Partial<IndexModel>): void {
    onChange(indexes.map((idx, i) => (i === index ? { ...idx, ...changes } : idx)));
  }

  function add(): void {
    const taken = new Set(indexes.map((i) => i.name));
    const first: IndexColumn = { name: columnNames[0] ?? '' };
    onChange([
      ...indexes,
      {
        name: defaultIndexName(tableName, [first], taken),
        columns: [first],
        unique: false,
        primary: false,
        method: methods[0],
      },
    ]);
  }

  function setPart(index: number, position: number, changes: Partial<IndexColumn>): void {
    const parts = indexes[index].columns.map((p, i) => (i === position ? { ...p, ...changes } : p));
    patch(index, { columns: parts });
  }

  function movePart(index: number, from: number, to: number): void {
    const parts = [...indexes[index].columns];
    if (to < 0 || to >= parts.length) return;
    const [moved] = parts.splice(from, 1);
    parts.splice(to, 0, moved);
    patch(index, { columns: parts });
  }

  const editable = indexes.filter((i) => !i.primary && !isConstraintIndex(i));
  const derived = indexes.filter((i) => i.primary || isConstraintIndex(i));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {editable.length === 0 && derived.length === 0 && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--fg-subtle)]">
            No indexes yet. A table with no index other than its primary key makes every filter a full scan.
          </p>
        )}

        {indexes.map((index, i) => {
          if (index.primary || isConstraintIndex(index)) return null;
          return (
            <div key={i} className="rounded border border-[var(--border)] bg-[var(--bg-panel)]">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
                <Input
                  className="mono w-56"
                  value={index.name}
                  disabled={readOnly}
                  spellCheck={false}
                  placeholder="index name"
                  onChange={(e) => patch(i, { name: e.target.value })}
                />
                <Checkbox
                  label={<span className="text-[11px]">unique</span>}
                  checked={index.unique}
                  disabled={readOnly}
                  onChange={(e) => patch(i, { unique: e.target.checked })}
                />
                {methods.length > 0 && (
                  <label className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
                    method
                    <Select
                      className="w-28"
                      value={index.method ?? methods[0]}
                      disabled={readOnly}
                      onChange={(e) => patch(i, { method: e.target.value })}
                    >
                      {methods.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                {isMysqlFamily(engine) && (
                  <Input
                    className="w-48"
                    value={index.comment ?? ''}
                    disabled={readOnly}
                    placeholder="comment"
                    onChange={(e) => patch(i, { comment: e.target.value || undefined })}
                  />
                )}
                <Button
                  className="ml-auto"
                  variant="ghost"
                  size="xs"
                  disabled={readOnly}
                  onClick={() => onChange(indexes.filter((_, n) => n !== i))}
                  title="Drop this index"
                >
                  <Trash2 className="size-3.5 text-[var(--danger)]" />
                </Button>
              </div>

              <div className="flex flex-col gap-1 px-2 py-1.5">
                {index.columns.map((part, p) => {
                  const column = part.name ? byName.get(part.name) : undefined;
                  // MySQL cannot index a BLOB/TEXT column without a prefix length.
                  const needsPrefix =
                    isMysqlFamily(engine) &&
                    !part.length &&
                    !!column &&
                    (column.type.base === 'text' || column.type.base === 'binary');

                  return (
                    <div key={p} className="flex flex-wrap items-center gap-1.5">
                      <span className="w-5 text-center text-[11px] text-[var(--fg-subtle)]">{p + 1}</span>
                      <Select
                        className="w-52"
                        value={part.expression !== undefined ? EXPRESSION_PART : (part.name ?? '')}
                        disabled={readOnly}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value === EXPRESSION_PART) {
                            setPart(i, p, { name: undefined, expression: part.expression ?? '' });
                          } else {
                            setPart(i, p, { name: value, expression: undefined });
                          }
                        }}
                      >
                        {columnNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                        {part.name && !byName.has(part.name) ? (
                          <option value={part.name}>{part.name} (missing)</option>
                        ) : null}
                        <option value={EXPRESSION_PART}>expression…</option>
                      </Select>

                      {part.expression !== undefined && (
                        <Input
                          className="mono min-w-[220px] flex-1"
                          value={part.expression}
                          disabled={readOnly}
                          spellCheck={false}
                          placeholder="lower(email)"
                          onChange={(e) => setPart(i, p, { expression: e.target.value })}
                        />
                      )}

                      <Select
                        className="w-20"
                        value={part.order ?? 'asc'}
                        disabled={readOnly}
                        onChange={(e) => setPart(i, p, { order: e.target.value as 'asc' | 'desc' })}
                      >
                        <option value="asc">asc</option>
                        <option value="desc">desc</option>
                      </Select>

                      {isMysqlFamily(engine) && (
                        <Input
                          className={cn('mono w-24', needsPrefix && 'border-[var(--warn)]')}
                          value={part.length ?? ''}
                          disabled={readOnly || part.expression !== undefined}
                          inputMode="numeric"
                          placeholder="prefix"
                          title={
                            needsPrefix
                              ? 'MySQL cannot index a TEXT or BLOB column without a prefix length'
                              : 'Prefix length (MySQL only)'
                          }
                          onChange={(e) => {
                            const n = Number.parseInt(e.target.value, 10);
                            setPart(i, p, { length: Number.isFinite(n) && n > 0 ? n : undefined });
                          }}
                        />
                      )}

                      {engine === 'postgres' && (
                        <Select
                          className="w-28"
                          value={part.nulls ?? ''}
                          disabled={readOnly}
                          title="NULLS FIRST / LAST — only emitted when it differs from the implied order"
                          onChange={(e) =>
                            setPart(i, p, { nulls: (e.target.value || undefined) as 'first' | 'last' | undefined })
                          }
                        >
                          <option value="">nulls default</option>
                          <option value="first">nulls first</option>
                          <option value="last">nulls last</option>
                        </Select>
                      )}

                      <span className="ml-auto flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={readOnly || p === 0}
                          onClick={() => movePart(i, p, p - 1)}
                          title="Move up"
                        >
                          <ArrowUp className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={readOnly || p === index.columns.length - 1}
                          onClick={() => movePart(i, p, p + 1)}
                          title="Move down"
                        >
                          <ArrowDown className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={readOnly || index.columns.length === 1}
                          onClick={() => patch(i, { columns: index.columns.filter((_, n) => n !== p) })}
                          title="Remove from the index"
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </span>

                      {needsPrefix && (
                        <span className="flex w-full items-center gap-1 pl-6 text-[11px] text-[var(--warn)]">
                          <TriangleAlert className="size-3" />
                          MySQL rejects an index on a {column?.type.base} column without a prefix length.
                        </span>
                      )}
                    </div>
                  );
                })}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    size="xs"
                    variant="subtle"
                    icon={<Plus className="size-3" />}
                    disabled={readOnly}
                    onClick={() =>
                      patch(i, { columns: [...index.columns, { name: columnNames[0] ?? '' }] })
                    }
                  >
                    Add column
                  </Button>

                  {supportsPartialIndex(engine) && (
                    <label className="flex flex-1 items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
                      WHERE
                      <Input
                        className="mono flex-1"
                        value={index.predicate ?? ''}
                        disabled={readOnly}
                        spellCheck={false}
                        placeholder="deleted_at IS NULL — partial index, optional"
                        onChange={(e) => patch(i, { predicate: e.target.value || undefined })}
                      />
                    </label>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {derived.length > 0 && (
          <div className="rounded border border-dashed border-[var(--border)] px-2 py-1.5">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">
              Constraint-owned indexes
            </p>
            {derived.map((index, i) => (
              <div key={i} className="flex items-center gap-2 py-0.5 text-[12px]">
                <Badge tone={index.primary ? 'warn' : 'neutral'}>{index.primary ? 'primary' : 'unique'}</Badge>
                <span className="mono">{index.name}</span>
                <span className="mono text-[var(--fg-muted)]">
                  ({index.columns.map((c) => c.name ?? c.expression ?? '?').join(', ')})
                </span>
                <span className="ml-auto text-[11px] text-[var(--fg-subtle)]">
                  {index.primary ? 'edit in the Columns tab' : 'owned by a UNIQUE constraint'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-2 py-1.5">
        <Button size="xs" icon={<Plus className="size-3.5" />} disabled={readOnly} onClick={add}>
          Add index
        </Button>
        <span className="text-[11px] text-[var(--fg-subtle)]">
          {editable.length} editable · {derived.length} owned by constraints
        </span>
      </div>
    </div>
  );
}
