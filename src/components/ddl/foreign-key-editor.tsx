'use client';

/**
 * Foreign-key editor for the table designer (PLAN M3).
 *
 * The referenced side is picked from the canonical `SchemaModel` rather than
 * typed, so a key can only point at a table and columns that actually exist —
 * and picking a table pre-fills its primary key, which is what the reference
 * almost always is.
 *
 * Local and referenced columns are edited as PAIRS. `ForeignKeyModel` holds two
 * parallel arrays and the generator zips them positionally, so a UI with two
 * independent lists could silently produce `FOREIGN KEY (a, b) REFERENCES t (x)`
 * — which the engine rejects at best and mis-maps at worst.
 *
 * The type check under each pair is not decoration: a referencing column whose
 * type does not match the referenced one is the single most common cause of
 * MySQL's errno 150, and the message it gives back names nothing useful.
 */

import * as React from 'react';
import { Plus, Trash2, TriangleAlert } from 'lucide-react';
import type {
  ColumnModel,
  EngineKind,
  ForeignKeyModel,
  ReferentialAction,
  SchemaModel,
  TableModel,
} from '@/lib/schema-model';
import { Button, Checkbox, Input, Select, cn } from '@/components/ui/primitives';

const ACTIONS: ReferentialAction[] = ['no action', 'restrict', 'cascade', 'set null', 'set default'];

function isMysqlFamily(engine: EngineKind): boolean {
  return engine === 'mysql' || engine === 'mariadb';
}

/** SQLite has no cross-schema references, so the target namespace is fixed. */
function supportsRefSchema(engine: EngineKind): boolean {
  return engine !== 'sqlite';
}

function defaultFkName(table: string, columns: string[], taken: Set<string>): string {
  const stem = ['fk', table, ...columns].join('_').replace(/[^\w]+/g, '_').slice(0, 60);
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 100; n++) {
    if (!taken.has(`${stem}_${n}`)) return `${stem}_${n}`;
  }
  return `${stem}_${Date.now()}`;
}

export interface ForeignKeyEditorProps {
  engine: EngineKind;
  tableName: string;
  /** Namespace of the table being edited — the default target namespace too. */
  schema?: string;
  foreignKeys: ForeignKeyModel[];
  columns: ColumnModel[];
  /** Populates the target pickers. Null while the schema has not been read. */
  model: SchemaModel | null;
  onChange: (foreignKeys: ForeignKeyModel[]) => void;
  readOnly?: boolean;
}

export function ForeignKeyEditor({
  engine,
  tableName,
  schema,
  foreignKeys,
  columns,
  model,
  onChange,
  readOnly = false,
}: ForeignKeyEditorProps) {
  const columnNames = columns.map((c) => c.name);
  const localByName = React.useMemo(() => new Map(columns.map((c) => [c.name, c])), [columns]);

  const namespaces = React.useMemo(() => (model ? model.namespaces.map((n) => n.name) : []), [model]);

  const tablesIn = React.useCallback(
    (namespace: string | undefined): TableModel[] => {
      if (!model) return [];
      const ns =
        model.namespaces.find((n) => n.name === namespace) ??
        (model.namespaces.length === 1 ? model.namespaces[0] : undefined);
      return (ns?.tables ?? []).filter((t) => t.kind === 'table');
    },
    [model],
  );

  const findRefTable = React.useCallback(
    (fk: ForeignKeyModel): TableModel | undefined =>
      tablesIn(fk.refSchema ?? schema).find((t) => t.name === fk.refTable),
    [schema, tablesIn],
  );

  function patch(index: number, changes: Partial<ForeignKeyModel>): void {
    onChange(foreignKeys.map((fk, i) => (i === index ? { ...fk, ...changes } : fk)));
  }

  function add(): void {
    const taken = new Set(foreignKeys.map((f) => f.name));
    const local = columnNames[0] ?? '';
    onChange([
      ...foreignKeys,
      {
        name: defaultFkName(tableName, [local], taken),
        columns: [local],
        refSchema: supportsRefSchema(engine) ? schema : undefined,
        refTable: '',
        refColumns: [''],
        onUpdate: 'no action',
        onDelete: 'no action',
      },
    ]);
  }

  /** Picking a target pre-fills its primary key, keeping the arity in step. */
  function retarget(index: number, refTable: string): void {
    const fk = foreignKeys[index];
    const target = tablesIn(fk.refSchema ?? schema).find((t) => t.name === refTable);
    const pk = target?.primaryKey ?? [];
    const refColumns =
      pk.length === fk.columns.length ? [...pk] : fk.columns.map((_, i) => pk[i] ?? '');
    patch(index, { refTable, refColumns });
  }

  function setPair(index: number, position: number, side: 'local' | 'ref', value: string): void {
    const fk = foreignKeys[index];
    if (side === 'local') {
      patch(index, { columns: fk.columns.map((c, i) => (i === position ? value : c)) });
    } else {
      patch(index, { refColumns: fk.refColumns.map((c, i) => (i === position ? value : c)) });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {foreignKeys.length === 0 && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--fg-subtle)]">
            No foreign keys on this table.
          </p>
        )}

        {foreignKeys.map((fk, i) => {
          const target = findRefTable(fk);
          const targetColumns = target?.columns.map((c) => c.name) ?? [];
          const arityMismatch = fk.columns.length !== fk.refColumns.length;

          return (
            <div key={i} className="rounded border border-[var(--border)] bg-[var(--bg-panel)]">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
                <Input
                  className="mono w-56"
                  value={fk.name}
                  disabled={readOnly}
                  spellCheck={false}
                  placeholder="constraint name"
                  onChange={(e) => patch(i, { name: e.target.value })}
                />

                <span className="text-[11px] text-[var(--fg-muted)]">references</span>

                {supportsRefSchema(engine) && namespaces.length > 0 && (
                  <Select
                    className="w-44"
                    value={fk.refSchema ?? schema ?? ''}
                    disabled={readOnly}
                    onChange={(e) => patch(i, { refSchema: e.target.value || undefined, refTable: '' })}
                  >
                    {namespaces.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                )}

                {model ? (
                  <Select
                    className="w-56"
                    value={fk.refTable}
                    disabled={readOnly}
                    onChange={(e) => retarget(i, e.target.value)}
                  >
                    <option value="">pick a table…</option>
                    {tablesIn(fk.refSchema ?? schema).map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                    {fk.refTable && !tablesIn(fk.refSchema ?? schema).some((t) => t.name === fk.refTable) ? (
                      <option value={fk.refTable}>{fk.refTable} (not in the cached schema)</option>
                    ) : null}
                  </Select>
                ) : (
                  <Input
                    className="mono w-56"
                    value={fk.refTable}
                    disabled={readOnly}
                    spellCheck={false}
                    placeholder="referenced table"
                    onChange={(e) => patch(i, { refTable: e.target.value })}
                  />
                )}

                <Button
                  className="ml-auto"
                  variant="ghost"
                  size="xs"
                  disabled={readOnly}
                  onClick={() => onChange(foreignKeys.filter((_, n) => n !== i))}
                  title="Drop this foreign key"
                >
                  <Trash2 className="size-3.5 text-[var(--danger)]" />
                </Button>
              </div>

              <div className="flex flex-col gap-1 px-2 py-1.5">
                {fk.columns.map((local, p) => {
                  const ref = fk.refColumns[p] ?? '';
                  const localColumn = localByName.get(local);
                  const refColumn = target?.columns.find((c) => c.name === ref);
                  const typeClash =
                    !!localColumn &&
                    !!refColumn &&
                    (localColumn.type.raw ?? '').trim().toLowerCase() !==
                      (refColumn.type.raw ?? '').trim().toLowerCase();

                  return (
                    <div key={p} className="flex flex-wrap items-center gap-1.5">
                      <Select
                        className="w-52"
                        value={local}
                        disabled={readOnly}
                        onChange={(e) => setPair(i, p, 'local', e.target.value)}
                      >
                        {columnNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                        {local && !localByName.has(local) ? (
                          <option value={local}>{local} (missing)</option>
                        ) : null}
                      </Select>

                      <span className="text-[var(--fg-subtle)]">→</span>

                      {targetColumns.length > 0 ? (
                        <Select
                          className={cn('w-52', typeClash && 'border-[var(--warn)]')}
                          value={ref}
                          disabled={readOnly}
                          onChange={(e) => setPair(i, p, 'ref', e.target.value)}
                        >
                          <option value="">pick a column…</option>
                          {targetColumns.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Input
                          className="mono w-52"
                          value={ref}
                          disabled={readOnly}
                          spellCheck={false}
                          placeholder="referenced column"
                          onChange={(e) => setPair(i, p, 'ref', e.target.value)}
                        />
                      )}

                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={readOnly || fk.columns.length === 1}
                        onClick={() =>
                          patch(i, {
                            columns: fk.columns.filter((_, n) => n !== p),
                            refColumns: fk.refColumns.filter((_, n) => n !== p),
                          })
                        }
                        title="Remove this pair"
                      >
                        <Trash2 className="size-3" />
                      </Button>

                      {typeClash && (
                        <span className="flex items-center gap-1 text-[11px] text-[var(--warn)]">
                          <TriangleAlert className="size-3" />
                          {localColumn?.type.raw} vs {refColumn?.type.raw} — the engine requires compatible
                          types on both sides.
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
                      patch(i, {
                        columns: [...fk.columns, columnNames[0] ?? ''],
                        refColumns: [...fk.refColumns, ''],
                      })
                    }
                  >
                    Add column pair
                  </Button>

                  <label className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
                    on update
                    <Select
                      className="w-32"
                      value={fk.onUpdate ?? 'no action'}
                      disabled={readOnly}
                      onChange={(e) => patch(i, { onUpdate: e.target.value as ReferentialAction })}
                    >
                      {ACTIONS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </Select>
                  </label>

                  <label className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
                    on delete
                    <Select
                      className="w-32"
                      value={fk.onDelete ?? 'no action'}
                      disabled={readOnly}
                      onChange={(e) => patch(i, { onDelete: e.target.value as ReferentialAction })}
                    >
                      {ACTIONS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </Select>
                  </label>

                  {!isMysqlFamily(engine) && (
                    <Checkbox
                      label={<span className="text-[11px]">deferrable</span>}
                      checked={!!fk.deferrable}
                      disabled={readOnly}
                      title="DEFERRABLE INITIALLY DEFERRED — checked at COMMIT instead of per statement"
                      onChange={(e) => patch(i, { deferrable: e.target.checked || undefined })}
                    />
                  )}
                </div>

                {arityMismatch && (
                  <p className="flex items-center gap-1 text-[11px] text-[var(--danger)]">
                    <TriangleAlert className="size-3" />
                    {fk.columns.length} local column(s) against {fk.refColumns.length} referenced — they must
                    pair up one to one.
                  </p>
                )}
                {(fk.onDelete === 'set null' || fk.onUpdate === 'set null') &&
                  fk.columns.some((c) => localByName.get(c)?.nullable === false) && (
                    <p className="flex items-center gap-1 text-[11px] text-[var(--warn)]">
                      <TriangleAlert className="size-3" />
                      SET NULL cannot fire on a NOT NULL column.
                    </p>
                  )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--border)] px-2 py-1.5">
        <Button size="xs" icon={<Plus className="size-3.5" />} disabled={readOnly} onClick={add}>
          Add foreign key
        </Button>
        <span className="text-[11px] text-[var(--fg-subtle)]">
          {isMysqlFamily(engine)
            ? 'MySQL indexes the referencing columns for you when no suitable index exists.'
            : engine === 'sqlite'
              ? 'SQLite only enforces these while PRAGMA foreign_keys is on — it is off by default per connection.'
              : 'The referenced columns need a unique constraint or primary key.'}
        </span>
        {!model && (
          <span className="text-[11px] text-[var(--warn)]">
            The schema has not been read, so targets are typed by hand.
          </span>
        )}
      </div>
    </div>
  );
}
