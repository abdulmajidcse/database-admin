/**
 * Canonical schema diff (PLAN §12 M8 "Schema compare": introspect two scopes →
 * canonical diff → generated migration DDL).
 *
 * Pure functions over `SchemaModel` — no DB access, no I/O, no engine clients.
 * Per §4 the canonical model is the only input ("everything downstream — tree,
 * autocomplete, ER diagram, schema diff, DDL generation — reads only this
 * model"), so two models introspected from *different engines* diff with the
 * same code path as two models from the same engine.
 *
 * Direction (fixed, and the whole file depends on it):
 *
 *   `source` is the REFERENCE schema (dev, the one you like).
 *   `target` is the schema that would be CHANGED to match it (prod).
 *
 * so `added` means "in source, missing from target → the migration creates it"
 * and `removed` means "in target, absent from source → the migration would drop
 * it". `migration.ts` generates DDL that runs against the *target*.
 *
 * Matching is BY NAME at every level, which is the honest reading of a
 * name-keyed model — the same choice `sql/ddl-common.ts#diffTables` makes: a
 * renamed index is a drop plus a create, and that is exactly what the engine
 * does anyway. Column renames are therefore reported as a drop plus an add;
 * `migration.ts` emits a warning saying so rather than guessing and silently
 * destroying a column's data. The one exception is `ignoreIndexNames`, where
 * indexes are matched on their column signature instead.
 *
 * Statistics (`rowEstimate`, `sizeBytes`, `lastValue`, `fetchedAt`) are never
 * compared: they are runtime state, not schema shape, and would make every
 * dev-vs-prod comparison report differences that no DDL can fix.
 */

import type {
  CheckModel,
  ColumnModel,
  EngineKind,
  EnumTypeModel,
  ForeignKeyModel,
  IndexModel,
  RoutineModel,
  SchemaModel,
  SchemaNamespace,
  SequenceModel,
  TableKind,
  TableModel,
  TriggerModel,
  TypeDescriptor,
} from '../../../lib/schema-model';
import { columnAspects, orderedColumns, type ColumnAspect } from '../sql/ddl-common';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type DiffStatus = 'added' | 'removed' | 'changed' | 'same';

export type DiffObjectKind =
  | 'namespace'
  | 'table'
  | 'view'
  | 'column'
  | 'index'
  | 'foreignKey'
  | 'check'
  | 'routine'
  | 'sequence'
  | 'enum'
  | 'trigger';

/** One field-level difference, rendered as display strings for the review UI. */
export interface FieldDiff {
  /** `type`, `nullable`, `default`, `collation`, `columns`, `definition`, … */
  field: string;
  source: string | null;
  target: string | null;
}

export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
}

export interface ObjectDiff<T> {
  kind: DiffObjectKind;
  /** Display name: the source's spelling when it exists, else the target's. */
  name: string;
  status: DiffStatus;
  source: T | null;
  target: T | null;
  /** Empty for `added`/`removed`/`same`. */
  fields: FieldDiff[];
}

export type ColumnDiff = ObjectDiff<ColumnModel>;
export type IndexDiff = ObjectDiff<IndexModel>;
export type ForeignKeyDiff = ObjectDiff<ForeignKeyModel>;
export type CheckDiff = ObjectDiff<CheckModel>;
export type RoutineDiff = ObjectDiff<RoutineModel>;
export type SequenceDiff = ObjectDiff<SequenceModel>;
export type EnumDiff = ObjectDiff<EnumTypeModel>;
export type TriggerDiff = ObjectDiff<TriggerModel>;

/**
 * A table or view, with its children.
 *
 * Named `…Entry` on purpose: `sql/ddl-common.ts` already exports a `TableDiff`
 * describing a *single* table's ALTER plan, and two same-named types in one
 * package is a footgun for whoever wires the API route.
 */
export interface TableDiffEntry extends ObjectDiff<TableModel> {
  kind: 'table' | 'view';
  /** The canonical kind, from whichever side exists (source wins). */
  tableKind: TableKind;
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  foreignKeys: ForeignKeyDiff[];
  checks: CheckDiff[];
  /** Set only when the PK membership differs. */
  primaryKey: { source: string[]; target: string[] } | null;
  /** The columns present on both sides are in a different relative order. */
  columnOrderChanged: boolean;
  /** Counts over the children above — not over the table itself. */
  counts: DiffCounts;
}

export interface NamespaceDiff {
  /** Display name: the source's, else the target's. */
  name: string;
  /** Name in the source model; null when the namespace exists only in target. */
  sourceName: string | null;
  /** Name in the target model — where the migration will write. */
  targetName: string | null;
  status: DiffStatus;
  fields: FieldDiff[];
  tables: TableDiffEntry[];
  views: TableDiffEntry[];
  routines: RoutineDiff[];
  sequences: SequenceDiff[];
  enums: EnumDiff[];
  triggers: TriggerDiff[];
  /** Counts over this namespace's direct objects (tables, views, routines, …). */
  counts: DiffCounts;
}

export interface DiffOptions {
  /** Fold identifier case when matching AND when comparing identifier values. */
  ignoreCase?: boolean;
  /** Skip column/table collation and charset. */
  ignoreCollation?: boolean;
  /** Skip every `comment` field. */
  ignoreComments?: boolean;
  /** Match indexes on their column signature, so a rename reads as `same`. */
  ignoreIndexNames?: boolean;
  /** Source namespace name → target namespace name, e.g. `{ app_dev: 'app' }`. */
  namespaceMap?: Record<string, string>;
}

export interface ResolvedDiffOptions {
  ignoreCase: boolean;
  ignoreCollation: boolean;
  ignoreComments: boolean;
  ignoreIndexNames: boolean;
  namespaceMap: Record<string, string>;
}

export interface SchemaDiff {
  /** Engine the reference model came from. */
  sourceEngine: EngineKind;
  /** Engine the migration will run against. */
  targetEngine: EngineKind;
  namespaces: NamespaceDiff[];
  summary: DiffCounts;
  /** How the two sides were paired — surfaced above the generated script. */
  notes: string[];
  options: ResolvedDiffOptions;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function resolveOptions(opts: DiffOptions | undefined): ResolvedDiffOptions {
  return {
    ignoreCase: opts?.ignoreCase ?? false,
    ignoreCollation: opts?.ignoreCollation ?? false,
    ignoreComments: opts?.ignoreComments ?? false,
    ignoreIndexNames: opts?.ignoreIndexNames ?? false,
    namespaceMap: { ...(opts?.namespaceMap ?? {}) },
  };
}

/** Identifier folding for matching and for comparing identifier-valued fields. */
function fold(name: string | null | undefined, o: ResolvedDiffOptions): string {
  const s = name ?? '';
  return o.ignoreCase ? s.toLowerCase() : s;
}

export function normalizeSpace(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** True when the whole string is wrapped in one matching pair of parentheses. */
function isFullyWrapped(s: string): boolean {
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      // Closing back to zero before the end means `(a) AND (b)`, not a wrapper.
      if (depth === 0 && i !== s.length - 1) return false;
    }
  }
  return depth === 0;
}

/**
 * Constraint bodies come back parenthesized by some engines and bare from
 * others (Postgres always wraps a CHECK, MySQL usually does not), so the outer
 * layer is peeled before comparing. The expression is otherwise left verbatim —
 * it is already the engine's own SQL.
 */
export function normalizeExpression(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  let t = normalizeSpace(s);
  while (isFullyWrapped(t)) t = normalizeSpace(t.slice(1, -1));
  return t === '' ? null : t;
}

const VIEW_WRAPPER = /^create\s+(or\s+replace\s+)?(temp(orary)?\s+)?(materialized\s+)?view\s+[\s\S]+?\s+as\s+/i;

/**
 * View and routine bodies: strip the `CREATE … AS` wrapper (Postgres returns a
 * bare SELECT, SQLite returns the whole statement, MySQL returns either) and
 * the trailing semicolon, so the same view does not read as changed purely
 * because two engines quote its definition differently.
 */
export function normalizeBody(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  let t = normalizeSpace(s).replace(/;+$/, '').trim();
  const m = VIEW_WRAPPER.exec(t);
  if (m) t = t.slice(m[0].length).trim();
  return t === '' ? null : t;
}

/** The type as a human sees it: the engine's own spelling when we have it. */
export function describeType(t: TypeDescriptor): string {
  const raw = (t.raw ?? '').trim();
  if (raw !== '') return raw;
  let out: string = t.base;
  if (t.length !== undefined) out += `(${t.length})`;
  else if (t.precision !== undefined) {
    out += t.scale !== undefined ? `(${t.precision},${t.scale})` : `(${t.precision})`;
  }
  if (t.unsigned) out += ' unsigned';
  if (t.withTimezone) out += ' with time zone';
  if (t.values && t.values.length > 0) out += `(${t.values.join(',')})`;
  if (t.base === 'array' && t.elementType) out = `${describeType(t.elementType)}[]`;
  return out;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

interface Pairing<T> {
  name: string;
  source: T | null;
  target: T | null;
}

/**
 * Pair two lists on a key. Source order is preserved (the review UI reads like
 * the reference schema) and target-only items are appended.
 *
 * A duplicate key on one side keeps the first occurrence: it only happens under
 * `ignoreIndexNames`, where two indexes with identical column signatures are
 * genuinely the same index declared twice.
 */
function pairByKey<T>(
  source: T[],
  target: T[],
  keyOf: (item: T) => string,
  nameOf: (item: T) => string,
): Pairing<T>[] {
  const targetByKey = new Map<string, T>();
  for (const t of target) {
    const k = keyOf(t);
    if (!targetByKey.has(k)) targetByKey.set(k, t);
  }
  const used = new Set<string>();
  const out: Pairing<T>[] = [];
  for (const s of source) {
    const k = keyOf(s);
    if (used.has(k)) continue;
    used.add(k);
    const t = targetByKey.get(k);
    out.push({ name: nameOf(s), source: s, target: t ?? null });
  }
  for (const t of target) {
    const k = keyOf(t);
    if (used.has(k)) continue;
    used.add(k);
    out.push({ name: nameOf(t), source: null, target: t });
  }
  return out;
}

function statusFor(source: unknown, target: unknown, changed: boolean): DiffStatus {
  if (source !== null && target !== null) return changed ? 'changed' : 'same';
  return source !== null ? 'added' : 'removed';
}

function push(out: FieldDiff[], field: string, source: string | null, target: string | null): void {
  if (source === target) return;
  out.push({ field, source, target });
}

function pushBool(out: FieldDiff[], field: string, source: boolean, target: boolean): void {
  if (source === target) return;
  out.push({ field, source: source ? 'yes' : 'no', target: target ? 'yes' : 'no' });
}

function text(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function countStatuses(entries: { status: DiffStatus }[]): DiffCounts {
  const counts: DiffCounts = { added: 0, removed: 0, changed: 0 };
  for (const e of entries) {
    if (e.status === 'added') counts.added++;
    else if (e.status === 'removed') counts.removed++;
    else if (e.status === 'changed') counts.changed++;
  }
  return counts;
}

function addCounts(a: DiffCounts, b: DiffCounts): DiffCounts {
  return { added: a.added + b.added, removed: a.removed + b.removed, changed: a.changed + b.changed };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function renderAspect(col: ColumnModel, aspect: ColumnAspect): string | null {
  switch (aspect) {
    case 'type':
      return describeType(col.type);
    case 'nullable':
      return col.nullable ? 'NULL' : 'NOT NULL';
    case 'default':
      return text(col.defaultValue);
    case 'autoIncrement':
      return col.autoIncrement ? 'yes' : 'no';
    case 'generated':
      return col.generated ? `${col.generated} AS (${col.generatedExpression ?? ''})` : null;
    case 'collation':
      return text(col.collation);
    case 'charset':
      return text(col.charset);
    case 'comment':
      return text(col.comment);
  }
}

/**
 * Column comparison delegates to `ddl-common#columnAspects` so the differ and
 * the per-engine ALTER planners share ONE definition of "what changed in a
 * column" (§4). Direction: the target is the current shape, the source is the
 * desired one, because the migration runs against the target.
 */
function columnFields(source: ColumnModel, target: ColumnModel, o: ResolvedDiffOptions): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const aspect of columnAspects(target, source)) {
    if (o.ignoreCollation && (aspect === 'collation' || aspect === 'charset')) continue;
    if (o.ignoreComments && aspect === 'comment') continue;
    out.push({ field: aspect, source: renderAspect(source, aspect), target: renderAspect(target, aspect) });
  }
  return out;
}

function diffColumns(
  source: TableModel | null,
  target: TableModel | null,
  o: ResolvedDiffOptions,
): ColumnDiff[] {
  const pairs = pairByKey(
    source ? orderedColumns(source) : [],
    target ? orderedColumns(target) : [],
    (c) => fold(c.name, o),
    (c) => c.name,
  );
  return pairs.map((p) => {
    const fields = p.source && p.target ? columnFields(p.source, p.target, o) : [];
    return {
      kind: 'column' as const,
      name: p.name,
      status: statusFor(p.source, p.target, fields.length > 0),
      source: p.source,
      target: p.target,
      fields,
    };
  });
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** An absent access method means "the engine default", which is btree everywhere. */
function indexMethod(idx: IndexModel): string {
  const m = (idx.method ?? '').toLowerCase();
  return m === '' ? 'btree' : m;
}

function renderIndexColumns(idx: IndexModel, o: ResolvedDiffOptions): string {
  return idx.columns
    .map((c) => {
      const base = c.expression ? `(${normalizeSpace(c.expression)})` : fold(c.name, o);
      const len = c.length ? `(${c.length})` : '';
      const order = c.order === 'desc' ? ' DESC' : '';
      const nulls = c.nulls ? ` NULLS ${c.nulls.toUpperCase()}` : '';
      return `${base}${len}${order}${nulls}`;
    })
    .join(', ');
}

function indexSignature(idx: IndexModel, o: ResolvedDiffOptions): string {
  return [
    idx.primary ? 'p' : '',
    idx.unique ? 'u' : '',
    indexMethod(idx),
    normalizeExpression(idx.predicate) ?? '',
    renderIndexColumns(idx, o),
  ].join('~');
}

function indexFields(source: IndexModel, target: IndexModel, o: ResolvedDiffOptions): FieldDiff[] {
  const out: FieldDiff[] = [];
  push(out, 'columns', renderIndexColumns(source, o), renderIndexColumns(target, o));
  pushBool(out, 'unique', source.unique, target.unique);
  push(out, 'method', indexMethod(source), indexMethod(target));
  push(out, 'predicate', normalizeExpression(source.predicate), normalizeExpression(target.predicate));
  if (!o.ignoreComments) push(out, 'comment', text(source.comment), text(target.comment));
  return out;
}

function diffIndexes(
  source: TableModel | null,
  target: TableModel | null,
  o: ResolvedDiffOptions,
): IndexDiff[] {
  // The primary key is modelled twice — as `primaryKey` and as an index with
  // `primary: true`. It is compared once, at the table level.
  const src = (source?.indexes ?? []).filter((i) => !i.primary);
  const tgt = (target?.indexes ?? []).filter((i) => !i.primary);
  const keyOf = (i: IndexModel) => (o.ignoreIndexNames ? indexSignature(i, o) : fold(i.name, o));
  return pairByKey(src, tgt, keyOf, (i) => i.name).map((p) => {
    const fields = p.source && p.target ? indexFields(p.source, p.target, o) : [];
    return {
      kind: 'index' as const,
      name: p.name,
      status: statusFor(p.source, p.target, fields.length > 0),
      source: p.source,
      target: p.target,
      fields,
    };
  });
}

// ---------------------------------------------------------------------------
// Foreign keys and checks
// ---------------------------------------------------------------------------

/**
 * `refSchema` is compared through the namespace map: comparing `app_dev.orders`
 * against `app.orders` must not report every foreign key as changed.
 */
function refTarget(fk: ForeignKeyModel, o: ResolvedDiffOptions, mapNamespace: (n: string) => string): string {
  const schema = fk.refSchema ? mapNamespace(fk.refSchema) : '';
  const cols = fk.refColumns.map((c) => fold(c, o)).join(', ');
  const table = fold(fk.refTable, o);
  return `${schema ? `${fold(schema, o)}.` : ''}${table} (${cols})`;
}

function foreignKeyFields(
  source: ForeignKeyModel,
  target: ForeignKeyModel,
  o: ResolvedDiffOptions,
  mapNamespace: (n: string) => string,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  push(out, 'columns', source.columns.map((c) => fold(c, o)).join(', '), target.columns.map((c) => fold(c, o)).join(', '));
  push(out, 'references', refTarget(source, o, mapNamespace), refTarget(target, o, (n) => n));
  push(out, 'onUpdate', source.onUpdate ?? 'no action', target.onUpdate ?? 'no action');
  push(out, 'onDelete', source.onDelete ?? 'no action', target.onDelete ?? 'no action');
  pushBool(out, 'deferrable', !!source.deferrable, !!target.deferrable);
  return out;
}

function diffForeignKeys(
  source: TableModel | null,
  target: TableModel | null,
  o: ResolvedDiffOptions,
  mapNamespace: (n: string) => string,
): ForeignKeyDiff[] {
  return pairByKey(
    source?.foreignKeys ?? [],
    target?.foreignKeys ?? [],
    (f) => fold(f.name, o),
    (f) => f.name,
  ).map((p) => {
    const fields = p.source && p.target ? foreignKeyFields(p.source, p.target, o, mapNamespace) : [];
    return {
      kind: 'foreignKey' as const,
      name: p.name,
      status: statusFor(p.source, p.target, fields.length > 0),
      source: p.source,
      target: p.target,
      fields,
    };
  });
}

function diffChecks(
  source: TableModel | null,
  target: TableModel | null,
  o: ResolvedDiffOptions,
): CheckDiff[] {
  return pairByKey(source?.checks ?? [], target?.checks ?? [], (c) => fold(c.name, o), (c) => c.name).map(
    (p) => {
      const fields: FieldDiff[] = [];
      if (p.source && p.target) {
        push(fields, 'expression', normalizeExpression(p.source.expression), normalizeExpression(p.target.expression));
      }
      return {
        kind: 'check' as const,
        name: p.name,
        status: statusFor(p.source, p.target, fields.length > 0),
        source: p.source,
        target: p.target,
        fields,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Tables and views
// ---------------------------------------------------------------------------

function isViewKind(kind: TableKind): boolean {
  return kind === 'view' || kind === 'materialized_view';
}

function tableFields(
  source: TableModel,
  target: TableModel,
  o: ResolvedDiffOptions,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  push(out, 'kind', source.kind, target.kind);
  if (!o.ignoreComments) push(out, 'comment', text(source.comment), text(target.comment));
  if (!o.ignoreCollation) push(out, 'collation', text(source.collation), text(target.collation));
  // MySQL storage engine / Postgres access method. `rowEstimate` and
  // `sizeBytes` are deliberately absent: statistics are not schema.
  push(out, 'engine', text(source.engine), text(target.engine));
  push(out, 'partitioning', text(source.partitioning), text(target.partitioning));
  if (isViewKind(source.kind) || isViewKind(target.kind)) {
    push(out, 'definition', normalizeBody(source.definition), normalizeBody(target.definition));
  }
  return out;
}

/** Do the columns present on BOTH sides appear in a different relative order? */
function columnOrderDiffers(source: TableModel, target: TableModel, o: ResolvedDiffOptions): boolean {
  const targetNames = new Set(orderedColumns(target).map((c) => fold(c.name, o)));
  const sourceNames = new Set(orderedColumns(source).map((c) => fold(c.name, o)));
  const a = orderedColumns(source)
    .map((c) => fold(c.name, o))
    .filter((n) => targetNames.has(n));
  const b = orderedColumns(target)
    .map((c) => fold(c.name, o))
    .filter((n) => sourceNames.has(n));
  return a.join(',') !== b.join(',');
}

function diffTableEntry(
  source: TableModel | null,
  target: TableModel | null,
  name: string,
  o: ResolvedDiffOptions,
  mapNamespace: (n: string) => string,
): TableDiffEntry {
  const tableKind: TableKind = source?.kind ?? target?.kind ?? 'table';
  const columns = diffColumns(source, target, o);
  const indexes = diffIndexes(source, target, o);
  const foreignKeys = diffForeignKeys(source, target, o, mapNamespace);
  const checks = diffChecks(source, target, o);

  const fields: FieldDiff[] = [];
  let primaryKey: TableDiffEntry['primaryKey'] = null;
  let columnOrderChanged = false;

  if (source && target) {
    fields.push(...tableFields(source, target, o));
    const spk = source.primaryKey.map((c) => fold(c, o)).join(', ');
    const tpk = target.primaryKey.map((c) => fold(c, o)).join(', ');
    if (spk !== tpk) {
      fields.push({ field: 'primaryKey', source: spk === '' ? null : spk, target: tpk === '' ? null : tpk });
      primaryKey = { source: source.primaryKey, target: target.primaryKey };
    }
    columnOrderChanged = columnOrderDiffers(source, target, o);
    if (columnOrderChanged) {
      fields.push({
        field: 'columnOrder',
        source: orderedColumns(source).map((c) => c.name).join(', '),
        target: orderedColumns(target).map((c) => c.name).join(', '),
      });
    }
  }

  const children = [...columns, ...indexes, ...foreignKeys, ...checks];
  const counts = countStatuses(children);
  const changed = fields.length > 0 || children.some((c) => c.status !== 'same');

  return {
    kind: isViewKind(tableKind) ? 'view' : 'table',
    tableKind,
    name,
    status: statusFor(source, target, changed),
    source,
    target,
    fields,
    columns,
    indexes,
    foreignKeys,
    checks,
    primaryKey,
    columnOrderChanged,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Namespace-level objects
// ---------------------------------------------------------------------------

function routineFields(source: RoutineModel, target: RoutineModel, o: ResolvedDiffOptions): FieldDiff[] {
  const out: FieldDiff[] = [];
  push(out, 'kind', source.kind, target.kind);
  push(out, 'language', text(source.language), text(target.language));
  push(out, 'returnType', text(source.returnType), text(target.returnType));
  push(out, 'arguments', normalizeSpace(source.arguments ?? ''), normalizeSpace(target.arguments ?? ''));
  push(out, 'definition', normalizeBody(source.definition), normalizeBody(target.definition));
  pushBool(out, 'deterministic', !!source.deterministic, !!target.deterministic);
  if (!o.ignoreComments) push(out, 'comment', text(source.comment), text(target.comment));
  return out;
}

function sequenceFields(source: SequenceModel, target: SequenceModel): FieldDiff[] {
  const out: FieldDiff[] = [];
  // `lastValue` is runtime state, not schema — comparing it would make every
  // dev-vs-prod comparison report a difference no DDL can fix.
  push(out, 'start', text(source.start), text(target.start));
  push(out, 'increment', text(source.increment), text(target.increment));
  push(out, 'minValue', text(source.minValue), text(target.minValue));
  push(out, 'maxValue', text(source.maxValue), text(target.maxValue));
  pushBool(out, 'cycle', !!source.cycle, !!target.cycle);
  push(out, 'ownedBy', text(source.ownedBy), text(target.ownedBy));
  return out;
}

function enumFields(source: EnumTypeModel, target: EnumTypeModel): FieldDiff[] {
  const out: FieldDiff[] = [];
  // Order is significant: a Postgres enum's declaration order IS its sort order.
  push(out, 'values', source.values.join(', '), target.values.join(', '));
  return out;
}

function triggerFields(source: TriggerModel, target: TriggerModel, o: ResolvedDiffOptions): FieldDiff[] {
  const out: FieldDiff[] = [];
  push(out, 'table', fold(source.table, o), fold(target.table, o));
  push(out, 'timing', source.timing, target.timing);
  push(out, 'events', [...source.events].sort().join(', '), [...target.events].sort().join(', '));
  push(out, 'orientation', source.orientation ?? 'row', target.orientation ?? 'row');
  push(out, 'condition', normalizeExpression(source.condition), normalizeExpression(target.condition));
  push(out, 'statement', normalizeBody(source.statement), normalizeBody(target.statement));
  return out;
}

function diffSimple<T extends { name: string }>(
  kind: DiffObjectKind,
  source: T[],
  target: T[],
  o: ResolvedDiffOptions,
  compare: (s: T, t: T) => FieldDiff[],
): ObjectDiff<T>[] {
  return pairByKey(source, target, (i) => fold(i.name, o), (i) => i.name).map((p) => {
    const fields = p.source && p.target ? compare(p.source, p.target) : [];
    return {
      kind,
      name: p.name,
      status: statusFor(p.source, p.target, fields.length > 0),
      source: p.source,
      target: p.target,
      fields,
    };
  });
}

function emptyNamespace(name: string): SchemaNamespace {
  return { name, tables: [], routines: [], sequences: [], triggers: [], enums: [] };
}

function diffNamespace(
  source: SchemaNamespace | null,
  target: SchemaNamespace | null,
  o: ResolvedDiffOptions,
  mapNamespace: (n: string) => string,
  /** Where a source-only namespace should be written, when `namespaceMap` says. */
  targetNameHint: string | null,
): NamespaceDiff {
  const s = source ?? emptyNamespace(target?.name ?? '');
  const t = target ?? emptyNamespace(source?.name ?? '');

  const entries = pairByKey(s.tables, t.tables, (x) => fold(x.name, o), (x) => x.name).map((p) =>
    diffTableEntry(p.source, p.target, p.name, o, mapNamespace),
  );

  // Bucket by the source's kind when it exists — a table replaced by a view of
  // the same name shows up under `tables` with a `kind` field difference.
  const tables: TableDiffEntry[] = [];
  const views: TableDiffEntry[] = [];
  for (const e of entries) (e.kind === 'view' ? views : tables).push(e);

  const routines = diffSimple('routine', s.routines, t.routines, o, (a, b) => routineFields(a, b, o));
  const sequences = diffSimple('sequence', s.sequences, t.sequences, o, sequenceFields);
  const enums = diffSimple('enum', s.enums, t.enums, o, enumFields);
  const triggers = diffSimple('trigger', s.triggers, t.triggers, o, (a, b) => triggerFields(a, b, o));

  const fields: FieldDiff[] = [];
  if (source && target && !o.ignoreComments) {
    push(fields, 'comment', text(source.comment), text(target.comment));
  }
  // `owner` is deliberately not compared: ownership is a per-server grant
  // concern, and dev/prod almost always run as different roles (§9).

  const objects = [...tables, ...views, ...routines, ...sequences, ...enums, ...triggers];
  const counts = countStatuses(objects);
  const changed = fields.length > 0 || objects.some((x) => x.status !== 'same');

  return {
    name: source?.name ?? t.name,
    sourceName: source?.name ?? null,
    targetName: target?.name ?? targetNameHint,
    status: statusFor(source, target, changed),
    fields,
    tables,
    views,
    routines,
    sequences,
    enums,
    triggers,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Diff two canonical models.
 *
 * `summary` counts NAMESPACE-LEVEL objects (tables, views, routines, sequences,
 * enums, triggers), one per changed object, plus one for each added/removed
 * namespace — "12 tables differ" is what a headline badge should say. Child
 * detail lives in `TableDiffEntry.counts` so the UI can drill in without the
 * top-line number exploding.
 */
export function diffSchemas(source: SchemaModel, target: SchemaModel, opts?: DiffOptions): SchemaDiff {
  const o = resolveOptions(opts);
  const notes: string[] = [];

  // Source namespace name → target namespace name.
  const explicit = new Map<string, string>();
  for (const [from, to] of Object.entries(o.namespaceMap)) explicit.set(fold(from, o), to);

  const targetByName = new Map<string, SchemaNamespace>();
  for (const ns of target.namespaces) targetByName.set(fold(ns.name, o), ns);

  interface Pair {
    source: SchemaNamespace;
    target: SchemaNamespace | null;
    /** Where this namespace lives (or should be created) on the target side. */
    targetName: string;
  }

  const pairs: Pair[] = [];
  const usedTargets = new Set<SchemaNamespace>();
  for (const ns of source.namespaces) {
    const wanted = explicit.get(fold(ns.name, o));
    const t = targetByName.get(fold(wanted ?? ns.name, o)) ?? null;
    if (wanted !== undefined && t === null) {
      notes.push(`namespaceMap sends "${ns.name}" to "${wanted}", which does not exist in the target — it will be created`);
    }
    if (t) usedTargets.add(t);
    pairs.push({ source: ns, target: t, targetName: t?.name ?? wanted ?? ns.name });
  }

  const unmatchedTargets = target.namespaces.filter((ns) => !usedTargets.has(ns));

  // A single-namespace model on each side with different names is the common
  // "compare database app_dev against app_prod" case; pair them rather than
  // reporting every table twice. Anything less obvious needs an explicit map.
  if (
    Object.keys(o.namespaceMap).length === 0 &&
    source.namespaces.length === 1 &&
    target.namespaces.length === 1 &&
    unmatchedTargets.length === 1 &&
    pairs.length === 1 &&
    pairs[0].target === null
  ) {
    const t = unmatchedTargets[0];
    pairs[0].target = t;
    pairs[0].targetName = t.name;
    usedTargets.add(t);
    unmatchedTargets.length = 0;
    notes.push(`paired the only namespace on each side: "${pairs[0].source.name}" → "${t.name}"`);
  }

  // Namespace remapping used when comparing foreign-key targets.
  const nameMap = new Map<string, string>();
  for (const p of pairs) nameMap.set(fold(p.source.name, o), p.targetName);
  const mapNamespace = (n: string): string => nameMap.get(fold(n, o)) ?? n;

  const namespaces: NamespaceDiff[] = [];
  for (const p of pairs) namespaces.push(diffNamespace(p.source, p.target, o, mapNamespace, p.targetName));
  for (const ns of unmatchedTargets) namespaces.push(diffNamespace(null, ns, o, mapNamespace, null));

  let summary: DiffCounts = { added: 0, removed: 0, changed: 0 };
  for (const ns of namespaces) {
    summary = addCounts(summary, ns.counts);
    if (ns.status === 'added') summary.added++;
    else if (ns.status === 'removed') summary.removed++;
  }

  if (source.engine !== target.engine) {
    notes.push(
      `cross-engine comparison (${source.engine} → ${target.engine}): type names, defaults and ` +
        'routine bodies are not portable and every generated statement needs review',
    );
  }

  return {
    sourceEngine: source.engine,
    targetEngine: target.engine,
    namespaces,
    summary,
    notes,
    options: o,
  };
}

export function hasChanges(diff: SchemaDiff): boolean {
  return diff.summary.added + diff.summary.removed + diff.summary.changed > 0;
}

/** Every table/view entry in the diff, flattened — used by the migration writer. */
export function allTableEntries(diff: SchemaDiff): { namespace: NamespaceDiff; entry: TableDiffEntry }[] {
  const out: { namespace: NamespaceDiff; entry: TableDiffEntry }[] = [];
  for (const ns of diff.namespaces) {
    for (const entry of [...ns.tables, ...ns.views]) out.push({ namespace: ns, entry });
  }
  return out;
}
