'use client';

/**
 * The table designer (PLAN M3: "create a table without writing SQL").
 *
 * It edits a DRAFT `TableModel` in local state. `current` is the shape the
 * server last reported — null when creating — and is never mutated: every edit
 * produces a new draft, and the pair `{ current, desired }` is exactly what
 * /api/ddl/plan consumes. That means the designer has no private notion of
 * "what changed"; the server's differ is the only one, so the script in the
 * preview cannot disagree with the script that runs.
 *
 * Renames and drops made in the Columns tab are followed through into the
 * indexes and foreign keys that name those columns. Skipping that would produce
 * a plan referring to a column that no longer exists — valid-looking SQL that
 * fails halfway through a rebuild, which is the worst possible moment.
 */

import * as React from 'react';
import { Plus, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import type {
  CheckModel,
  ColumnModel,
  EngineKind,
  ForeignKeyModel,
  IndexModel,
  SchemaModel,
  TableModel,
} from '@/lib/schema-model';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Tabs,
  Textarea,
  cn,
} from '@/components/ui/primitives';
import { ColumnEditor, newColumn, renumber, type ColumnEffect } from './column-editor';
import { IndexEditor } from './index-editor';
import { ForeignKeyEditor } from './foreign-key-editor';
import { DdlPreview, type DdlExecuteResult } from './ddl-preview';

// ---------------------------------------------------------------------------
// Draft construction
// ---------------------------------------------------------------------------

function isMysqlFamily(engine: EngineKind): boolean {
  return engine === 'mysql' || engine === 'mariadb';
}

/** MySQL storage engines worth offering; anything else can be typed. */
const MYSQL_ENGINES = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV'];

/** A new table starts with the key it will need, spelled the engine's way. */
export function emptyTable(engine: EngineKind, schema?: string): TableModel {
  const id: ColumnModel = {
    ...newColumn(engine, 1, 'id'),
    nullable: false,
    autoIncrement: true,
  };
  return {
    name: 'new_table',
    schema,
    kind: 'table',
    columns: [id],
    indexes: [],
    foreignKeys: [],
    checks: [],
    primaryKey: ['id'],
    ...(isMysqlFamily(engine) ? { engine: 'InnoDB' } : {}),
  };
}

/** A deep copy: the draft must not write through to the cached schema model. */
function cloneTable(table: TableModel): TableModel {
  return JSON.parse(JSON.stringify(table)) as TableModel;
}

// ---------------------------------------------------------------------------
// Validation — what the server would reject, said earlier and in English
// ---------------------------------------------------------------------------

export function validateTable(draft: TableModel): string[] {
  const problems: string[] = [];

  if (draft.name.trim() === '') problems.push('The table needs a name.');
  if (draft.columns.length === 0) problems.push('A table needs at least one column.');

  const seen = new Set<string>();
  for (const column of draft.columns) {
    const name = column.name.trim();
    if (name === '') {
      problems.push('Every column needs a name.');
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) problems.push(`Two columns are called "${name}".`);
    seen.add(key);
    if ((column.type.raw ?? '').trim() === '') problems.push(`Column "${name}" has no type.`);
    if (column.generated && (column.generatedExpression ?? '').trim() === '') {
      problems.push(`Generated column "${name}" has no expression.`);
    }
  }

  const columnNames = new Set(draft.columns.map((c) => c.name));
  for (const key of draft.primaryKey) {
    if (!columnNames.has(key)) problems.push(`The primary key names "${key}", which is not a column.`);
  }

  const indexNames = new Set<string>();
  for (const index of draft.indexes) {
    if (index.primary) continue;
    if (index.name.trim() === '') problems.push('Every index needs a name.');
    else if (indexNames.has(index.name)) problems.push(`Two indexes are called "${index.name}".`);
    indexNames.add(index.name);
    if (index.columns.length === 0) problems.push(`Index "${index.name}" has no columns.`);
    for (const part of index.columns) {
      if (part.expression !== undefined) {
        if (part.expression.trim() === '') problems.push(`Index "${index.name}" has an empty expression.`);
        continue;
      }
      if (!part.name || !columnNames.has(part.name)) {
        problems.push(`Index "${index.name}" names "${part.name ?? ''}", which is not a column.`);
      }
    }
  }

  for (const fk of draft.foreignKeys) {
    const label = fk.name.trim() === '' ? 'A foreign key' : `Foreign key "${fk.name}"`;
    if (fk.refTable.trim() === '') problems.push(`${label} has no referenced table.`);
    if (fk.columns.length !== fk.refColumns.length) {
      problems.push(`${label} pairs ${fk.columns.length} columns with ${fk.refColumns.length}.`);
    }
    for (const column of fk.columns) {
      if (!columnNames.has(column)) problems.push(`${label} names "${column}", which is not a column.`);
    }
    if (fk.refColumns.some((c) => c.trim() === '')) problems.push(`${label} has an empty referenced column.`);
  }

  for (const check of draft.checks) {
    if (check.expression.trim() === '') {
      problems.push(`Check "${check.name || '(unnamed)'}" has no expression.`);
    }
  }

  return problems;
}

/**
 * Follow a column rename or drop through the objects that name it. A
 * self-referencing key has the same column on both sides, so its referenced
 * list is rewritten too — but only when the target really is this table.
 */
function applyColumnEffect(draft: TableModel, effect: ColumnEffect): TableModel {
  const selfReferencing = (fk: ForeignKeyModel): boolean =>
    fk.refTable === draft.name && (fk.refSchema ?? draft.schema) === draft.schema;

  if (effect.type === 'rename') {
    const { from, to } = effect;
    const swap = (name: string): string => (name === from ? to : name);
    return {
      ...draft,
      indexes: draft.indexes.map((index) => ({
        ...index,
        columns: index.columns.map((part) => (part.name === from ? { ...part, name: to } : part)),
      })),
      foreignKeys: draft.foreignKeys.map((fk) => ({
        ...fk,
        columns: fk.columns.map(swap),
        refColumns: selfReferencing(fk) ? fk.refColumns.map(swap) : fk.refColumns,
      })),
    };
  }

  const { name } = effect;
  return {
    ...draft,
    // An index or key left with no columns has no meaning, so it goes with them.
    indexes: draft.indexes
      .map((index) => ({ ...index, columns: index.columns.filter((part) => part.name !== name) }))
      .filter((index) => index.columns.length > 0),
    foreignKeys: draft.foreignKeys
      .map((fk) => {
        // Both sides are dropped together: the arrays pair up positionally, so
        // removing one entry from the local list without its partner would
        // re-map the whole key onto the wrong columns.
        const keep: number[] = [];
        fk.columns.forEach((column, i) => {
          if (column !== name) keep.push(i);
        });
        return {
          ...fk,
          columns: keep.map((i) => fk.columns[i]),
          refColumns: keep.map((i) => fk.refColumns[i] ?? ''),
        };
      })
      .filter((fk) => fk.columns.length > 0),
  };
}

// ---------------------------------------------------------------------------
// TableEditor
// ---------------------------------------------------------------------------

type EditorTab = 'columns' | 'indexes' | 'foreign-keys' | 'checks' | 'options';

export interface TableEditorProps {
  connectionId: string;
  /** Typed back to the server before anything destructive runs (§9). */
  connectionName: string;
  engine: EngineKind;
  /** The table as the server reports it; null creates a new one. */
  current: TableModel | null;
  /** Populates the foreign-key target pickers. */
  model?: SchemaModel | null;
  /** Namespace for a table being created. */
  defaultSchema?: string;
  readOnly?: boolean;
  /** Fired once the script has run without error. */
  onApplied?: (desired: TableModel, result: DdlExecuteResult) => void;
  className?: string;
}

export function TableEditor({
  connectionId,
  connectionName,
  engine,
  current,
  model = null,
  defaultSchema,
  readOnly = false,
  onApplied,
  className,
}: TableEditorProps) {
  const initial = React.useMemo(
    () => (current ? cloneTable(current) : emptyTable(engine, defaultSchema)),
    [current, engine, defaultSchema],
  );
  const [draft, setDraft] = React.useState<TableModel>(initial);
  const [tab, setTab] = React.useState<EditorTab>('columns');

  const existingNames = React.useMemo(
    () => new Set((current?.columns ?? []).map((c) => c.name)),
    [current],
  );
  const problems = React.useMemo(() => validateTable(draft), [draft]);
  const dirty = React.useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  const namespaces = model?.namespaces.map((n) => n.name) ?? [];

  function onColumns(columns: ColumnModel[], primaryKey: string[], effect?: ColumnEffect): void {
    setDraft((previous) => {
      const next: TableModel = { ...previous, columns: renumber(columns), primaryKey };
      return effect ? applyColumnEffect(next, effect) : next;
    });
  }

  // A view has a body, not a shape: designing one is editing its SELECT, which
  // belongs in the SQL editor.
  if (current && current.kind !== 'table') {
    return (
      <div className={cn('flex h-full items-center justify-center p-6', className)}>
        <p className="max-w-md text-center text-[13px] text-[var(--fg-muted)]">
          <strong className="mono">{current.name}</strong> is a {current.kind.replace('_', ' ')}, not a table.
          Open its DDL and edit the definition in a SQL tab instead.
        </p>
      </div>
    );
  }

  const tabs = [
    { id: 'columns', label: 'Columns', detail: String(draft.columns.length) },
    { id: 'indexes', label: 'Indexes', detail: String(draft.indexes.filter((i) => !i.primary).length) },
    { id: 'foreign-keys', label: 'Foreign keys', detail: String(draft.foreignKeys.length) },
    { id: 'checks', label: 'Checks', detail: String(draft.checks.length) },
    { id: 'options', label: 'Options' },
  ];

  return (
    <div className={cn('flex h-full min-h-0 gap-2', className)}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[var(--border)]">
        <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1.5">
          <Field label="Table" className="w-56">
            <Input
              className="mono"
              value={draft.name}
              disabled={readOnly}
              spellCheck={false}
              onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
            />
          </Field>

          {(namespaces.length > 0 || draft.schema) && (
            <Field label={engine === 'postgres' ? 'Schema' : 'Database'} className="w-48">
              {namespaces.length > 0 ? (
                <Select
                  value={draft.schema ?? ''}
                  disabled={readOnly}
                  onChange={(e) => setDraft((p) => ({ ...p, schema: e.target.value || undefined }))}
                >
                  <option value="">(default)</option>
                  {namespaces.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  className="mono"
                  value={draft.schema ?? ''}
                  disabled={readOnly}
                  onChange={(e) => setDraft((p) => ({ ...p, schema: e.target.value || undefined }))}
                />
              )}
            </Field>
          )}

          <span className="flex items-center gap-1.5 pb-1">
            {current ? <Badge tone="neutral">altering</Badge> : <Badge tone="accent">new table</Badge>}
            {readOnly && <Badge tone="warn">read-only connection</Badge>}
            {dirty && <Badge tone="accent">unsaved draft</Badge>}
            {current && draft.name !== current.name && (
              <Badge tone="warn">rename from {current.name}</Badge>
            )}
          </span>

          <Button
            className="ml-auto mb-1"
            size="xs"
            variant="ghost"
            icon={<RotateCcw className="size-3.5" />}
            disabled={!dirty}
            onClick={() => setDraft(initial)}
            title="Discard every change in this draft"
          >
            Revert
          </Button>
        </div>

        <Tabs items={tabs} active={tab} onSelect={(id) => setTab(id as EditorTab)} className="shrink-0" />

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'columns' && (
            <ColumnEditor
              engine={engine}
              columns={draft.columns}
              primaryKey={draft.primaryKey}
              existingNames={existingNames}
              readOnly={readOnly}
              onChange={onColumns}
            />
          )}

          {tab === 'indexes' && (
            <IndexEditor
              engine={engine}
              tableName={draft.name}
              indexes={draft.indexes}
              columns={draft.columns}
              readOnly={readOnly}
              onChange={(indexes: IndexModel[]) => setDraft((p) => ({ ...p, indexes }))}
            />
          )}

          {tab === 'foreign-keys' && (
            <ForeignKeyEditor
              engine={engine}
              tableName={draft.name}
              schema={draft.schema}
              foreignKeys={draft.foreignKeys}
              columns={draft.columns}
              model={model}
              readOnly={readOnly}
              onChange={(foreignKeys: ForeignKeyModel[]) => setDraft((p) => ({ ...p, foreignKeys }))}
            />
          )}

          {tab === 'checks' && (
            <CheckEditor
              checks={draft.checks}
              tableName={draft.name}
              readOnly={readOnly}
              onChange={(checks: CheckModel[]) => setDraft((p) => ({ ...p, checks }))}
            />
          )}

          {tab === 'options' && (
            <OptionsEditor
              engine={engine}
              draft={draft}
              readOnly={readOnly}
              onChange={(changes) => setDraft((p) => ({ ...p, ...changes }))}
            />
          )}
        </div>
      </div>

      <DdlPreview
        className="w-[44%] shrink-0 rounded border border-[var(--border)]"
        connectionId={connectionId}
        connectionName={connectionName}
        engine={engine}
        current={current}
        desired={draft}
        problems={problems}
        readOnly={readOnly}
        onExecuted={(result) => {
          if (result.executed && result.statements.every((s) => s.status === 'ok')) {
            onApplied?.(draft, result);
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function CheckEditor({
  checks,
  tableName,
  readOnly,
  onChange,
}: {
  checks: CheckModel[];
  tableName: string;
  readOnly: boolean;
  onChange: (checks: CheckModel[]) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {checks.length === 0 && (
          <p className="px-1 py-4 text-center text-[13px] text-[var(--fg-subtle)]">
            No check constraints on this table.
          </p>
        )}
        {checks.map((check, i) => (
          <div key={i} className="rounded border border-[var(--border)] bg-[var(--bg-panel)] p-2">
            <div className="flex items-center gap-2">
              <Input
                className="mono w-56"
                value={check.name}
                disabled={readOnly}
                spellCheck={false}
                placeholder="constraint name"
                onChange={(e) =>
                  onChange(checks.map((c, n) => (n === i ? { ...c, name: e.target.value } : c)))
                }
              />
              <Button
                className="ml-auto"
                variant="ghost"
                size="xs"
                disabled={readOnly}
                onClick={() => onChange(checks.filter((_, n) => n !== i))}
                title="Drop this check"
              >
                <Trash2 className="size-3.5 text-[var(--danger)]" />
              </Button>
            </div>
            <Textarea
              className="mt-1.5"
              rows={2}
              value={check.expression}
              disabled={readOnly}
              spellCheck={false}
              placeholder="price >= 0"
              onChange={(e) =>
                onChange(checks.map((c, n) => (n === i ? { ...c, expression: e.target.value } : c)))
              }
            />
          </div>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-2 py-1.5">
        <Button
          size="xs"
          icon={<Plus className="size-3.5" />}
          disabled={readOnly}
          onClick={() =>
            onChange([
              ...checks,
              { name: `chk_${tableName}_${checks.length + 1}`.replace(/[^\w]+/g, '_'), expression: '' },
            ])
          }
        >
          Add check
        </Button>
        <span className="flex items-center gap-1 text-[11px] text-[var(--fg-subtle)]">
          <TriangleAlert className="size-3" />
          The expression is written into the DDL verbatim — it is your SQL, not ours.
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table options
// ---------------------------------------------------------------------------

function OptionsEditor({
  engine,
  draft,
  readOnly,
  onChange,
}: {
  engine: EngineKind;
  draft: TableModel;
  readOnly: boolean;
  onChange: (changes: Partial<TableModel>) => void;
}) {
  // SQLite has no table options of its own; `TableModel.engine` carries its
  // STRICT / WITHOUT ROWID flags as a comma-separated list (see ddl-common).
  const sqliteFlags = (draft.engine ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  function setFlag(flag: string, on: boolean): void {
    const next = on ? [...new Set([...sqliteFlags, flag])] : sqliteFlags.filter((f) => f !== flag);
    onChange({ engine: next.join(', ') || undefined });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      {isMysqlFamily(engine) && (
        <>
          <Field label="Storage engine" className="max-w-xs" hint="InnoDB is the only one with transactions and foreign keys.">
            <Select
              value={draft.engine ?? 'InnoDB'}
              disabled={readOnly}
              onChange={(e) => onChange({ engine: e.target.value })}
            >
              {[...new Set([...MYSQL_ENGINES, ...(draft.engine ? [draft.engine] : [])])].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Collation"
            className="max-w-xs"
            hint="Left empty, the table inherits the database's."
          >
            <Input
              className="mono"
              value={draft.collation ?? ''}
              disabled={readOnly}
              spellCheck={false}
              placeholder="utf8mb4_0900_ai_ci"
              onChange={(e) => onChange({ collation: e.target.value || undefined })}
            />
          </Field>
        </>
      )}

      {engine === 'postgres' && (
        <>
          <Field
            label="Access method"
            className="max-w-xs"
            hint="Emitted as USING; leave empty for the server default (heap)."
          >
            <Input
              className="mono"
              value={draft.engine ?? ''}
              disabled={readOnly}
              spellCheck={false}
              placeholder="heap"
              onChange={(e) => onChange({ engine: e.target.value || undefined })}
            />
          </Field>

          <Field
            label="Partition by"
            className="max-w-md"
            hint="RANGE (created_at), LIST (region), HASH (id) — partitions themselves are created separately."
          >
            <Input
              className="mono"
              value={draft.partitioning ?? ''}
              disabled={readOnly}
              spellCheck={false}
              onChange={(e) => onChange({ partitioning: e.target.value || undefined })}
            />
          </Field>
        </>
      )}

      {engine === 'sqlite' && (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)]">
            Table flags
          </span>
          <Checkbox
            label="STRICT — reject values whose type does not match the column"
            checked={sqliteFlags.includes('strict')}
            disabled={readOnly}
            onChange={(e) => setFlag('strict', e.target.checked)}
          />
          <Checkbox
            label="WITHOUT ROWID — store rows in the primary-key index"
            checked={sqliteFlags.includes('without rowid')}
            disabled={readOnly}
            onChange={(e) => setFlag('without rowid', e.target.checked)}
          />
          <p className="text-[11px] text-[var(--fg-subtle)]">
            Changing either flag on an existing table means recreating it — the preview will show the full
            rebuild.
          </p>
        </div>
      )}

      {engine !== 'sqlite' && (
        <Field
          label="Comment"
          className="max-w-xl"
          hint={
            engine === 'postgres'
              ? 'Emitted as a separate COMMENT ON TABLE statement.'
              : 'Stored in the table definition.'
          }
        >
          <Textarea
            rows={2}
            value={draft.comment ?? ''}
            disabled={readOnly}
            onChange={(e) => onChange({ comment: e.target.value || undefined })}
          />
        </Field>
      )}

      <div className="mt-auto flex flex-wrap gap-4 border-t border-[var(--border)] pt-2 text-[11px] text-[var(--fg-subtle)]">
        {typeof draft.rowEstimate === 'number' && <span>~{draft.rowEstimate.toLocaleString()} rows</span>}
        {typeof draft.sizeBytes === 'number' && (
          <span>{(draft.sizeBytes / 1024 / 1024).toFixed(1)} MB on disk</span>
        )}
        <span>Statistics come from the catalog and are never a COUNT(*).</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog wrapper
// ---------------------------------------------------------------------------

export interface TableEditorDialogProps extends TableEditorProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The designer in a modal. Keyed on the target so re-opening always starts from
 * a fresh draft rather than resurrecting the last one.
 */
export function TableEditorDialog({ open, onClose, ...props }: TableEditorDialogProps) {
  const title = props.current
    ? `Alter ${props.current.schema ? `${props.current.schema}.` : ''}${props.current.name}`
    : 'New table';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width="full"
      footer={
        <Button variant="default" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="h-[72vh] min-h-0">
        <TableEditor
          key={`${props.connectionId}:${props.current ? `${props.current.schema ?? ''}.${props.current.name}` : 'new'}`}
          {...props}
          onApplied={(desired, result) => {
            props.onApplied?.(desired, result);
            onClose();
          }}
        />
      </div>
    </Dialog>
  );
}
