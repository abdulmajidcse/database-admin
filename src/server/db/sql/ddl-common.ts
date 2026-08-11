/**
 * Engine-neutral DDL rendering and table diffing (PLAN §4, §6, milestone M3).
 *
 * The canonical `TableModel` is the only input: "everything downstream — tree,
 * autocomplete, ER diagram, schema diff, DDL generation — reads only this
 * model" (§4). This module turns that model back into SQL and diffs two of
 * them, so the three SQL connectors share one definition of "what changed"
 * instead of three subtly different ones.
 *
 * Where dialects genuinely diverge — MySQL keeps indexes inside CREATE TABLE,
 * Postgres and SQLite do not; MySQL reports defaults unquoted, the others report
 * expressions — the divergence is handled here, in one switch, rather than by
 * forking the whole file per engine.
 *
 * `diffTables` deliberately produces MORE detail than any single engine needs:
 *   - MySQL/Postgres consume the added/dropped/altered lists directly as ALTER
 *     TABLE clauses;
 *   - SQLite consumes `requiresRebuild` to decide between its three legal ALTER
 *     forms and the 12-step rebuild (§6 "SQLite's four traps", trap 3), and
 *     needs `renamedColumns`, `addedColumnsAtEnd` and `reordered` to know
 *     whether the cheap path is even expressible.
 *
 * PLAN §9: every identifier goes through the injected `QuoteFns`. Expressions
 * that came out of the catalog (defaults, generated expressions, check bodies,
 * index predicates) are emitted verbatim — they are already the engine's own
 * SQL, and re-quoting them would corrupt them.
 */

import type {
  CheckModel,
  ColumnModel,
  EngineKind,
  ForeignKeyModel,
  IndexColumn,
  IndexModel,
  TableModel,
  TypeDescriptor,
} from '../../../lib/schema-model';
import type { QuoteFns } from './quote';

// ---------------------------------------------------------------------------
// Small dialect predicates, named so the switches below read as intent
// ---------------------------------------------------------------------------

function isMysqlFamily(engine: EngineKind): boolean {
  return engine === 'mysql' || engine === 'mariadb';
}

/**
 * SQLite creates an internal index for every UNIQUE/PRIMARY KEY constraint and
 * reports it through `PRAGMA index_list`. Those cannot be recreated with
 * CREATE INDEX (the `sqlite_` name prefix is reserved), so they belong in the
 * table body as constraints. The introspector tags them `method: 'auto'`.
 */
export function isConstraintIndex(idx: IndexModel): boolean {
  return idx.method === 'auto' || idx.name.toLowerCase().startsWith('sqlite_autoindex');
}

/** Columns in declaration order; `position` is authoritative, array order is not. */
export function orderedColumns(t: TableModel): ColumnModel[] {
  return [...t.columns].sort((a, b) => a.position - b.position);
}

function qualifyTable(t: Pick<TableModel, 'name' | 'schema'>, quote: QuoteFns): string {
  return quote.qualified([t.schema, t.name]);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `raw` is the engine's own spelling (`varchar(255)`, `int unsigned`,
 * `numeric(10,2)`) and is always preferred: it round-trips exactly. Synthesis
 * only happens for models built by hand — the table designer — where `raw` is
 * empty and only the normalized descriptor exists.
 */
export function renderTypeSql(type: TypeDescriptor, engine: EngineKind, quote: QuoteFns): string {
  const raw = (type.raw ?? '').trim();
  if (raw !== '') return raw;

  if (isMysqlFamily(engine)) return mysqlType(type, quote);
  if (engine === 'postgres') return postgresType(type, quote);
  if (engine === 'sqlite') return sqliteType(type);
  throw new Error(`renderTypeSql: engine "${engine}" has no SQL type syntax`);
}

function mysqlType(type: TypeDescriptor, quote: QuoteFns): string {
  const u = type.unsigned ? ' unsigned' : '';
  switch (type.base) {
    case 'boolean':
      return 'tinyint(1)';
    case 'integer':
      return `int${u}`;
    case 'bigint':
      return `bigint${u}`;
    case 'decimal':
      return `decimal(${type.precision ?? 10},${type.scale ?? 0})${u}`;
    case 'float':
      return 'double';
    case 'string':
      return `varchar(${type.length ?? 255})`;
    case 'text':
    case 'xml':
      return 'text';
    case 'binary':
      return type.length ? `varbinary(${type.length})` : 'blob';
    case 'date':
      return 'date';
    case 'time':
      return type.precision ? `time(${type.precision})` : 'time';
    case 'timestamp':
      // MySQL's `timestamp` is the UTC-normalizing one; `datetime` is the naive
      // one, which is the honest mapping for a value without a zone.
      return type.withTimezone
        ? `timestamp${type.precision ? `(${type.precision})` : ''}`
        : `datetime${type.precision ? `(${type.precision})` : ''}`;
    case 'json':
    case 'document':
      return 'json';
    case 'uuid':
      return 'char(36)';
    case 'enum':
      return `enum(${(type.values ?? []).map((v) => quote.literal(v)).join(',')})`;
    case 'set':
      return `set(${(type.values ?? []).map((v) => quote.literal(v)).join(',')})`;
    case 'bit':
      return `bit(${type.length ?? 1})`;
    case 'geometry':
      return 'geometry';
    default:
      return 'text';
  }
}

function postgresType(type: TypeDescriptor, quote: QuoteFns): string {
  switch (type.base) {
    case 'boolean':
      return 'boolean';
    case 'integer':
      return 'integer';
    case 'bigint':
      return 'bigint';
    case 'decimal':
      return type.precision ? `numeric(${type.precision},${type.scale ?? 0})` : 'numeric';
    case 'float':
      return 'double precision';
    case 'string':
      return type.length ? `varchar(${type.length})` : 'text';
    case 'text':
      return 'text';
    case 'binary':
      return 'bytea';
    case 'date':
      return 'date';
    case 'time':
      return type.withTimezone ? 'timetz' : 'time';
    case 'timestamp':
      return type.withTimezone ? 'timestamptz' : 'timestamp';
    case 'interval':
      return 'interval';
    case 'json':
    case 'document':
      return 'jsonb';
    case 'uuid':
      return 'uuid';
    case 'network':
      return 'inet';
    case 'xml':
      return 'xml';
    case 'money':
      return 'money';
    case 'bit':
      return type.length ? `bit(${type.length})` : 'bit';
    case 'geometry':
      return 'geometry';
    case 'array': {
      const element = type.elementType
        ? postgresType(type.elementType, quote)
        : 'text';
      return `${element}${'[]'.repeat(Math.max(type.dimensions ?? 1, 1))}`;
    }
    case 'enum':
      // A Postgres enum is a named user type; without that name the only
      // lossless fallback is text plus a CHECK, which the designer must add.
      return 'text';
    default:
      return 'text';
  }
}

/** SQLite has five affinities; anything else is just a declared name. */
function sqliteType(type: TypeDescriptor): string {
  switch (type.base) {
    case 'boolean':
    case 'integer':
    case 'bigint':
      return 'INTEGER';
    case 'float':
      return 'REAL';
    case 'decimal':
    case 'money':
      return 'NUMERIC';
    case 'binary':
      return 'BLOB';
    default:
      return 'TEXT';
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Defaults every engine reports as a bare keyword rather than a literal. */
const KEYWORD_DEFAULT =
  /^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP(\(\d*\))?|CURRENT_DATE|CURRENT_TIME|NOW\(\)|UUID\(\)|LOCALTIME|LOCALTIMESTAMP)$/i;

/**
 * `DEFAULT …`, or null when the column has none.
 *
 * Postgres and SQLite report `COLUMN_DEFAULT` as a ready-to-paste *expression*
 * (`'x'::text`, `nextval('s')`, `0`), so it is emitted verbatim. MySQL reports
 * a literal default *unquoted* and an expression default also unquoted, with
 * nothing distinguishing them — so it needs the same heuristic every MySQL tool
 * uses: numbers, keywords and parenthesized expressions are expressions, and
 * anything else in a textual column is a string literal.
 */
export function renderDefaultClause(
  col: ColumnModel,
  engine: EngineKind,
  quote: QuoteFns,
): string | null {
  const d = col.defaultValue;
  if (d === null || typeof d === 'undefined') return null;

  if (!isMysqlFamily(engine)) {
    const expr = d.trim();
    return expr === '' ? null : `DEFAULT ${expr}`;
  }

  const trimmed = d.trim();
  if (trimmed === '') return `DEFAULT ${quote.literal('')}`;
  if (trimmed.startsWith('(')) return `DEFAULT ${trimmed}`;
  const base = col.type.base;
  const textual = base === 'string' || base === 'text' || base === 'enum' || base === 'set';
  const expression = /^-?\d+(\.\d+)?$/.test(trimmed) || KEYWORD_DEFAULT.test(trimmed);
  if (expression && !textual) return `DEFAULT ${trimmed}`;
  return `DEFAULT ${quote.literal(trimmed)}`;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface ColumnRenderOptions {
  /**
   * SQLite only: emit `PRIMARY KEY [AUTOINCREMENT]` inline. An INTEGER PRIMARY
   * KEY AUTOINCREMENT column is illegal as a table constraint, so the caller
   * that knows the table shape sets this.
   */
  inlinePrimaryKey?: boolean;
}

/**
 * One column's definition, as it appears inside CREATE TABLE (and, unchanged,
 * after `ADD COLUMN` / `MODIFY COLUMN`).
 */
export function renderColumnDefinition(
  col: ColumnModel,
  engine: EngineKind,
  quote: QuoteFns,
  opts: ColumnRenderOptions = {},
): string {
  const parts: string[] = [quote.ident(col.name), renderTypeSql(col.type, engine, quote)];

  if (isMysqlFamily(engine)) {
    if (col.charset) parts.push(`CHARACTER SET ${col.charset}`);
    if (col.collation) parts.push(`COLLATE ${col.collation}`);
    if (col.generated) {
      parts.push(`GENERATED ALWAYS AS (${col.generatedExpression ?? 'NULL'})`);
      parts.push(col.generated === 'stored' ? 'STORED' : 'VIRTUAL');
      if (!col.nullable) parts.push('NOT NULL');
    } else {
      // MySQL wants nullability before the default, and AUTO_INCREMENT last.
      parts.push(col.nullable ? 'NULL' : 'NOT NULL');
      const def = renderDefaultClause(col, engine, quote);
      if (def) parts.push(def);
      if (col.autoIncrement) parts.push('AUTO_INCREMENT');
    }
    if (col.comment) parts.push(`COMMENT ${quote.literal(col.comment)}`);
    return parts.join(' ');
  }

  if (engine === 'postgres') {
    if (col.collation && col.collation !== 'default') parts.push(`COLLATE ${quote.ident(col.collation)}`);
    if (col.generated) {
      // VIRTUAL exists from PG 18; STORED everywhere since 12.
      parts.push(
        `GENERATED ALWAYS AS (${col.generatedExpression ?? 'NULL'}) ${
          col.generated === 'virtual' ? 'VIRTUAL' : 'STORED'
        }`,
      );
    } else if (col.autoIncrement && col.defaultValue === null) {
      // A serial column introspects as a `nextval(...)` default, which is kept
      // as-is; an identity column has no default and is spelled out instead.
      parts.push('GENERATED BY DEFAULT AS IDENTITY');
    } else {
      const def = renderDefaultClause(col, engine, quote);
      if (def) parts.push(def);
    }
    if (!col.nullable) parts.push('NOT NULL');
    // Column comments are a separate COMMENT ON statement in Postgres.
    return parts.join(' ');
  }

  // SQLite
  if (opts.inlinePrimaryKey) {
    parts.push('PRIMARY KEY');
    if (col.autoIncrement) parts.push('AUTOINCREMENT');
  }
  if (!col.nullable) parts.push('NOT NULL');
  if (col.collation) parts.push(`COLLATE ${col.collation}`);
  if (col.generated) {
    parts.push(
      `GENERATED ALWAYS AS (${col.generatedExpression ?? 'NULL'}) ${
        col.generated === 'stored' ? 'STORED' : 'VIRTUAL'
      }`,
    );
  } else {
    const def = renderDefaultClause(col, engine, quote);
    if (def) parts.push(def);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Indexes, foreign keys, checks
// ---------------------------------------------------------------------------

function renderIndexPart(part: IndexColumn, engine: EngineKind, quote: QuoteFns): string {
  const name = part.expression ? `(${part.expression})` : quote.ident(part.name ?? '');
  // A prefix length is MySQL-only syntax.
  const base = part.length && isMysqlFamily(engine) ? `${name}(${part.length})` : name;
  const bits = [base];
  if (part.order === 'desc') bits.push('DESC');
  if (part.nulls && engine === 'postgres') {
    // Postgres implies NULLS LAST for ASC and NULLS FIRST for DESC; only spell
    // it out when the index actually deviates.
    const implied = part.order === 'desc' ? 'first' : 'last';
    if (part.nulls !== implied) bits.push(`NULLS ${part.nulls.toUpperCase()}`);
  }
  return bits.join(' ');
}

export function renderIndexColumns(idx: IndexModel, engine: EngineKind, quote: QuoteFns): string {
  return idx.columns.map((c) => renderIndexPart(c, engine, quote)).join(', ');
}

/** MySQL keeps its secondary indexes inside CREATE TABLE; this is that form. */
export function renderInlineIndex(idx: IndexModel, engine: EngineKind, quote: QuoteFns): string {
  const cols = renderIndexColumns(idx, engine, quote);
  if (idx.primary) return `PRIMARY KEY (${cols})`;
  const method = (idx.method ?? '').toUpperCase();
  const prefix = method === 'FULLTEXT' ? 'FULLTEXT ' : method === 'SPATIAL' ? 'SPATIAL ' : idx.unique ? 'UNIQUE ' : '';
  const using = method === 'HASH' ? ' USING HASH' : '';
  const comment = idx.comment ? ` COMMENT ${quote.literal(idx.comment)}` : '';
  return `${prefix}KEY ${quote.ident(idx.name)} (${cols})${using}${comment}`;
}

/** The standalone statement Postgres and SQLite need. */
export function renderCreateIndex(
  table: Pick<TableModel, 'name' | 'schema'>,
  idx: IndexModel,
  engine: EngineKind,
  quote: QuoteFns,
): string {
  const cols = renderIndexColumns(idx, engine, quote);
  const where = idx.predicate ? ` WHERE ${idx.predicate}` : '';
  const unique = idx.unique ? 'UNIQUE ' : '';
  if (engine === 'sqlite') {
    // The index lives in its table's schema, and SQLite rejects a qualified
    // name after ON.
    return `CREATE ${unique}INDEX ${quote.qualified([table.schema, idx.name])} ON ${quote.ident(
      table.name,
    )} (${cols})${where}`;
  }
  const method = idx.method && idx.method !== 'btree' ? ` USING ${idx.method}` : '';
  return `CREATE ${unique}INDEX ${quote.ident(idx.name)} ON ${qualifyTable(table, quote)}${method} (${cols})${where}`;
}

export function renderForeignKeyDefinition(
  fk: ForeignKeyModel,
  engine: EngineKind,
  quote: QuoteFns,
): string {
  const parts: string[] = [];
  if (fk.name) parts.push(`CONSTRAINT ${quote.ident(fk.name)}`);
  parts.push(`FOREIGN KEY (${fk.columns.map((c) => quote.ident(c)).join(', ')})`);
  // SQLite has no cross-schema references, so the target is always unqualified.
  const ref =
    engine === 'sqlite'
      ? quote.ident(fk.refTable)
      : quote.qualified([fk.refSchema, fk.refTable]);
  parts.push(`REFERENCES ${ref} (${fk.refColumns.map((c) => quote.ident(c)).join(', ')})`);
  if (fk.onUpdate && fk.onUpdate !== 'no action') parts.push(`ON UPDATE ${fk.onUpdate.toUpperCase()}`);
  if (fk.onDelete && fk.onDelete !== 'no action') parts.push(`ON DELETE ${fk.onDelete.toUpperCase()}`);
  if (fk.deferrable && engine !== 'mysql' && engine !== 'mariadb') {
    parts.push('DEFERRABLE INITIALLY DEFERRED');
  }
  return parts.join(' ');
}

/**
 * True only when the OUTERMOST parentheses wrap the whole expression.
 * `(a > 1) AND (b < 2)` starts with `(` and ends with `)` yet is not wrapped —
 * emitting `CHECK (a > 1) AND (b < 2)` would be a syntax error, so the naive
 * startsWith/endsWith test is not good enough. String literals are skipped so a
 * parenthesis inside `'…'` cannot unbalance the count.
 */
function isFullyParenthesized(expr: string): boolean {
  if (!expr.startsWith('(') || !expr.endsWith(')')) return false;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inString) {
      if (ch !== "'") continue;
      if (expr[i + 1] === "'") i += 1; // a doubled quote is an escaped quote
      else inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0 && i < expr.length - 1) return false; // closed before the end
    }
  }
  return depth === 0;
}

export function renderCheckDefinition(chk: CheckModel, quote: QuoteFns): string {
  const expr = chk.expression.trim();
  const wrapped = isFullyParenthesized(expr) ? expr : `(${expr})`;
  const name = chk.name ? `CONSTRAINT ${quote.ident(chk.name)} ` : '';
  return `${name}CHECK ${wrapped}`;
}

/** SQLite keeps `STRICT` / `WITHOUT ROWID` in `TableModel.engine`. */
function sqliteTableOptions(t: TableModel): string {
  const flags = (t.engine ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  if (flags.includes('without rowid')) out.push('WITHOUT ROWID');
  if (flags.includes('strict')) out.push('STRICT');
  return out.length ? ` ${out.join(', ')}` : '';
}

// ---------------------------------------------------------------------------
// CREATE TABLE
// ---------------------------------------------------------------------------

/**
 * The CREATE TABLE statement for one table.
 *
 * What lands inside the parentheses is dialect-dependent and getting it wrong
 * produces SQL that only fails at run time:
 *   - MySQL puts every index in the table body and has table options after it;
 *   - Postgres allows only constraints there — secondary indexes are separate
 *     CREATE INDEX statements (`renderCreateIndex`);
 *   - SQLite is like Postgres except that UNIQUE constraints MUST be inline,
 *     because their auto-created indexes cannot be recreated by name.
 */
export function renderCreateTable(t: TableModel, engine: EngineKind, quote: QuoteFns): string {
  const items: string[] = [];
  const mysql = isMysqlFamily(engine);

  // SQLite: an INTEGER PRIMARY KEY AUTOINCREMENT must be declared on the column.
  const inlinePk =
    engine === 'sqlite' &&
    t.primaryKey.length === 1 &&
    t.columns.some((c) => c.name === t.primaryKey[0] && c.autoIncrement);

  for (const c of orderedColumns(t)) {
    items.push(
      renderColumnDefinition(c, engine, quote, {
        inlinePrimaryKey: inlinePk && c.name === t.primaryKey[0],
      }),
    );
  }

  if (t.primaryKey.length > 0 && !inlinePk) {
    const cols = t.primaryKey.map((c) => quote.ident(c)).join(', ');
    // MySQL discards primary-key constraint names, so it never emits one.
    const named = t.primaryKeyName && !mysql ? `CONSTRAINT ${quote.ident(t.primaryKeyName)} ` : '';
    items.push(`${named}PRIMARY KEY (${cols})`);
  }

  if (mysql) {
    for (const idx of t.indexes) {
      if (idx.primary) continue;
      items.push(renderInlineIndex(idx, engine, quote));
    }
  } else if (engine === 'sqlite') {
    for (const idx of t.indexes) {
      if (idx.primary || !idx.unique || !isConstraintIndex(idx)) continue;
      const named =
        idx.name && !idx.name.toLowerCase().startsWith('sqlite_')
          ? `CONSTRAINT ${quote.ident(idx.name)} `
          : '';
      items.push(`${named}UNIQUE (${renderIndexColumns(idx, engine, quote)})`);
    }
  }

  for (const chk of t.checks) items.push(renderCheckDefinition(chk, quote));
  for (const fk of t.foreignKeys) items.push(renderForeignKeyDefinition(fk, engine, quote));

  const head = `CREATE TABLE ${qualifyTable(t, quote)}`;
  const body = `(\n  ${items.join(',\n  ')}\n)`;

  if (mysql) {
    const options: string[] = [];
    if (t.engine) options.push(`ENGINE=${t.engine}`);
    if (t.collation) options.push(`COLLATE=${t.collation}`);
    if (t.comment) options.push(`COMMENT=${quote.literal(t.comment)}`);
    return `${head} ${body}${options.length ? ` ${options.join(' ')}` : ''}`;
  }
  if (engine === 'sqlite') return `${head} ${body}${sqliteTableOptions(t)}`;

  const using = t.engine && t.engine !== 'heap' ? `\nUSING ${t.engine}` : '';
  const partition =
    t.partitioning && !t.partitioning.startsWith('PARTITION ') ? `\nPARTITION BY ${t.partitioning}` : '';
  return `${head} ${body}${using}${partition}`;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export type ColumnAspect =
  | 'type'
  | 'nullable'
  | 'default'
  | 'autoIncrement'
  | 'generated'
  | 'collation'
  | 'charset'
  | 'comment';

export type TableOptionAspect = 'engine' | 'collation' | 'comment' | 'partitioning';

export interface ColumnChange {
  /** The column's name in `desired`. */
  name: string;
  before: ColumnModel;
  after: ColumnModel;
  /** Exactly what differs — MySQL needs the whole column back, Postgres one ALTER per aspect. */
  aspects: ColumnAspect[];
}

export interface ColumnRename {
  from: string;
  to: string;
}

export interface IndexChange {
  name: string;
  before: IndexModel;
  after: IndexModel;
}

export interface ForeignKeyChange {
  name: string;
  before: ForeignKeyModel;
  after: ForeignKeyModel;
}

export interface CheckChange {
  name: string;
  before: CheckModel;
  after: CheckModel;
}

export interface TableDiff {
  /** `create` when there is no current table; every other field is then empty. */
  kind: 'create' | 'alter';
  current: TableModel | null;
  desired: TableModel;
  /** True when the two models are identical — the caller should emit nothing. */
  isEmpty: boolean;

  renamedTable: { from: string; to: string } | null;
  movedSchema: { from: string | undefined; to: string | undefined } | null;

  addedColumns: ColumnModel[];
  droppedColumns: ColumnModel[];
  alteredColumns: ColumnChange[];
  renamedColumns: ColumnRename[];
  /** True when the added columns form the tail of the desired list, in order. */
  addedColumnsAtEnd: boolean;
  /** True when the surviving columns changed relative order. */
  reordered: boolean;

  primaryKeyChange: { from: string[]; to: string[] } | null;

  addedIndexes: IndexModel[];
  droppedIndexes: IndexModel[];
  changedIndexes: IndexChange[];

  addedForeignKeys: ForeignKeyModel[];
  droppedForeignKeys: ForeignKeyModel[];
  changedForeignKeys: ForeignKeyChange[];

  addedChecks: CheckModel[];
  droppedChecks: CheckModel[];
  changedChecks: CheckChange[];

  changedOptions: TableOptionAspect[];

  /** PK, FK, CHECK or UNIQUE-constraint changes: the parts SQLite cannot ALTER. */
  constraintsChanged: boolean;
  /**
   * True when SQLite's real ALTER TABLE cannot express this change and the
   * 12-step rebuild is required (§6 trap 3). The SQLite planner layers its own
   * version and legality checks (DROP COLUMN needs 3.35, an indexed column
   * cannot be dropped, …) on top of this structural verdict.
   */
  requiresRebuild: boolean;
  /** Why, in the user's words — the DDL preview shows these above the script. */
  rebuildReasons: string[];
}

function normalizeExpression(v: string | null | undefined): string | null {
  if (v === null || typeof v === 'undefined') return null;
  const trimmed = v.trim().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed;
}

function sameDefault(a: ColumnModel, b: ColumnModel): boolean {
  const x = normalizeExpression(a.defaultValue);
  const y = normalizeExpression(b.defaultValue);
  if (x === y) return true;
  if (x === null || y === null) return false;
  // Keyword defaults are case-insensitive (`CURRENT_TIMESTAMP` vs
  // `current_timestamp()`); string literals are NOT, so only keywords fold.
  return KEYWORD_DEFAULT.test(x) && KEYWORD_DEFAULT.test(y) && x.toLowerCase() === y.toLowerCase();
}

function sameType(a: TypeDescriptor, b: TypeDescriptor): boolean {
  const ra = (a.raw ?? '').trim().toLowerCase();
  const rb = (b.raw ?? '').trim().toLowerCase();
  if (ra !== '' && rb !== '') return ra === rb;
  // A hand-built model has no `raw`; compare the normalized descriptor instead.
  return (
    a.base === b.base &&
    (a.length ?? null) === (b.length ?? null) &&
    (a.precision ?? null) === (b.precision ?? null) &&
    (a.scale ?? null) === (b.scale ?? null) &&
    !!a.unsigned === !!b.unsigned &&
    !!a.withTimezone === !!b.withTimezone &&
    (a.values ?? []).join(',') === (b.values ?? []).join(',')
  );
}

/** Every aspect in which `after` differs from `before`, ignoring the name. */
export function columnAspects(before: ColumnModel, after: ColumnModel): ColumnAspect[] {
  const out: ColumnAspect[] = [];
  if (!sameType(before.type, after.type)) out.push('type');
  if (before.nullable !== after.nullable) out.push('nullable');
  if (!sameDefault(before, after)) out.push('default');
  if (!!before.autoIncrement !== !!after.autoIncrement) out.push('autoIncrement');
  if (
    (before.generated ?? null) !== (after.generated ?? null) ||
    normalizeExpression(before.generatedExpression) !== normalizeExpression(after.generatedExpression)
  ) {
    out.push('generated');
  }
  if ((before.collation ?? null) !== (after.collation ?? null)) out.push('collation');
  if ((before.charset ?? null) !== (after.charset ?? null)) out.push('charset');
  if ((before.comment ?? '') !== (after.comment ?? '')) out.push('comment');
  return out;
}

function indexSignature(idx: IndexModel): string {
  return [
    idx.unique ? 'u' : '',
    idx.primary ? 'p' : '',
    (idx.method ?? '').toLowerCase(),
    idx.predicate ?? '',
    idx.columns
      .map((c) => `${c.name ?? c.expression ?? ''}:${c.order ?? 'asc'}:${c.length ?? ''}:${c.nulls ?? ''}`)
      .join(','),
  ].join('|');
}

function fkSignature(fk: ForeignKeyModel): string {
  return [
    fk.columns.join(','),
    fk.refSchema ?? '',
    fk.refTable,
    fk.refColumns.join(','),
    fk.onUpdate ?? 'no action',
    fk.onDelete ?? 'no action',
    fk.deferrable ? 'd' : '',
  ].join('|');
}

/**
 * `ColumnModel` has no stable id, so a rename is indistinguishable from a
 * drop + add by name alone — and guessing wrong silently destroys a column's
 * data. The only safe signal is position: when both tables have the same number
 * of columns and every positional pair has an identical body, a differing name
 * is a rename. Anything less certain is reported as drop + add.
 */
export function detectColumnRenames(current: TableModel, desired: TableModel): ColumnRename[] {
  const before = orderedColumns(current);
  const after = orderedColumns(desired);
  if (before.length !== after.length) return [];

  const renames: ColumnRename[] = [];
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if (a.name === b.name) continue;
    if (columnAspects(a, b).length > 0) return [];
    // Renaming onto a name that already exists is a reshuffle, not a rename.
    if (before.some((c) => c.name === b.name)) return [];
    renames.push({ from: a.name, to: b.name });
  }
  return renames;
}

function diffByName<T extends { name: string }, C>(
  currentItems: T[],
  desiredItems: T[],
  signature: (item: T) => string,
  makeChange: (name: string, before: T, after: T) => C,
): { added: T[]; dropped: T[]; changed: C[] } {
  const before = new Map(currentItems.map((i) => [i.name, i]));
  const after = new Map(desiredItems.map((i) => [i.name, i]));
  const added: T[] = [];
  const dropped: T[] = [];
  const changed: C[] = [];
  for (const [name, item] of after) {
    const prev = before.get(name);
    if (!prev) added.push(item);
    else if (signature(prev) !== signature(item)) changed.push(makeChange(name, prev, item));
  }
  for (const [name, item] of before) if (!after.has(name)) dropped.push(item);
  return { added, dropped, changed };
}

/** The list-valued half of `TableDiff`, so the create path can zero it in one go. */
type DiffLists = Pick<
  TableDiff,
  | 'addedColumns'
  | 'droppedColumns'
  | 'alteredColumns'
  | 'renamedColumns'
  | 'addedIndexes'
  | 'droppedIndexes'
  | 'changedIndexes'
  | 'addedForeignKeys'
  | 'droppedForeignKeys'
  | 'changedForeignKeys'
  | 'addedChecks'
  | 'droppedChecks'
  | 'changedChecks'
  | 'changedOptions'
>;

/** Fresh arrays per call — a shared literal would be mutated by callers. */
function emptyDiffLists(): DiffLists {
  return {
    addedColumns: [],
    droppedColumns: [],
    alteredColumns: [],
    renamedColumns: [],
    addedIndexes: [],
    droppedIndexes: [],
    changedIndexes: [],
    addedForeignKeys: [],
    droppedForeignKeys: [],
    changedForeignKeys: [],
    addedChecks: [],
    droppedChecks: [],
    changedChecks: [],
    changedOptions: [],
  };
}

/**
 * Diff two table shapes. Objects other than columns are matched **by name**,
 * which is the honest reading of a name-keyed model: a renamed index is a drop
 * plus a create, and that is exactly what the engine does anyway.
 */
export function diffTables(current: TableModel | null, desired: TableModel): TableDiff {
  if (!current) {
    return {
      kind: 'create',
      current: null,
      desired,
      isEmpty: false,
      renamedTable: null,
      movedSchema: null,
      ...emptyDiffLists(),
      addedColumnsAtEnd: true,
      reordered: false,
      primaryKeyChange: null,
      constraintsChanged: false,
      requiresRebuild: false,
      rebuildReasons: [],
    };
  }

  const renamedColumns = detectColumnRenames(current, desired);
  const renameMap = new Map(renamedColumns.map((r) => [r.from, r.to]));
  // Current columns, keyed by the name they will have in `desired`.
  const currentByFinalName = new Map<string, ColumnModel>();
  for (const c of orderedColumns(current)) currentByFinalName.set(renameMap.get(c.name) ?? c.name, c);

  const desiredOrder = orderedColumns(desired);
  const desiredNames = new Set(desiredOrder.map((c) => c.name));

  const addedColumns: ColumnModel[] = [];
  const alteredColumns: ColumnChange[] = [];
  for (const after of desiredOrder) {
    const before = currentByFinalName.get(after.name);
    if (!before) {
      addedColumns.push(after);
      continue;
    }
    const aspects = columnAspects(before, after);
    if (aspects.length > 0) alteredColumns.push({ name: after.name, before, after, aspects });
  }
  const droppedColumns = orderedColumns(current).filter(
    (c) => !desiredNames.has(renameMap.get(c.name) ?? c.name),
  );

  // Are the new columns simply appended? SQLite's ADD COLUMN can only append,
  // and MySQL only needs an `AFTER` clause when they are not.
  const addedNames = new Set(addedColumns.map((c) => c.name));
  const tail = desiredOrder.slice(desiredOrder.length - addedColumns.length);
  const addedColumnsAtEnd =
    addedColumns.length === 0 || tail.every((c, i) => c.name === addedColumns[i].name);

  const survivingBefore = orderedColumns(current)
    .filter((c) => desiredNames.has(renameMap.get(c.name) ?? c.name))
    .map((c) => renameMap.get(c.name) ?? c.name);
  const survivingAfter = desiredOrder.filter((c) => !addedNames.has(c.name)).map((c) => c.name);
  const reordered = survivingBefore.join(',') !== survivingAfter.join(',');

  const primaryKeyChanged = current.primaryKey.join(',') !== desired.primaryKey.join(',');

  const indexes = diffByName<IndexModel, IndexChange>(
    current.indexes.filter((i) => !i.primary),
    desired.indexes.filter((i) => !i.primary),
    indexSignature,
    (name, before, after) => ({ name, before, after }),
  );
  const foreignKeys = diffByName<ForeignKeyModel, ForeignKeyChange>(
    current.foreignKeys,
    desired.foreignKeys,
    fkSignature,
    (name, before, after) => ({ name, before, after }),
  );
  const checks = diffByName<CheckModel, CheckChange>(
    current.checks,
    desired.checks,
    (c) => normalizeExpression(c.expression) ?? '',
    (name, before, after) => ({ name, before, after }),
  );

  const changedOptions: TableOptionAspect[] = [];
  if ((current.engine ?? '') !== (desired.engine ?? '')) changedOptions.push('engine');
  if ((current.collation ?? '') !== (desired.collation ?? '')) changedOptions.push('collation');
  if ((current.comment ?? '') !== (desired.comment ?? '')) changedOptions.push('comment');
  if ((current.partitioning ?? '') !== (desired.partitioning ?? '')) changedOptions.push('partitioning');

  // A UNIQUE table constraint (SQLite's auto index) is a constraint, not an index.
  const uniqueConstraintChanged = [...indexes.added, ...indexes.dropped]
    .concat(indexes.changed.map((c) => c.after))
    .some((i) => i.unique && isConstraintIndex(i));

  const constraintsChanged =
    primaryKeyChanged ||
    foreignKeys.added.length > 0 ||
    foreignKeys.dropped.length > 0 ||
    foreignKeys.changed.length > 0 ||
    checks.added.length > 0 ||
    checks.dropped.length > 0 ||
    checks.changed.length > 0 ||
    uniqueConstraintChanged;

  const rebuildReasons: string[] = [];
  if (alteredColumns.length > 0) {
    rebuildReasons.push(
      `column definition changed (${alteredColumns.map((c) => c.name).join(', ')})`,
    );
  }
  if (primaryKeyChanged) rebuildReasons.push('the primary key changed');
  if (foreignKeys.added.length + foreignKeys.dropped.length + foreignKeys.changed.length > 0) {
    rebuildReasons.push('foreign keys changed');
  }
  if (checks.added.length + checks.dropped.length + checks.changed.length > 0) {
    rebuildReasons.push('check constraints changed');
  }
  if (uniqueConstraintChanged) rebuildReasons.push('a UNIQUE constraint changed');
  if (changedOptions.length > 0) rebuildReasons.push(`table options changed (${changedOptions.join(', ')})`);
  if (!addedColumnsAtEnd) rebuildReasons.push('a column was inserted before the end of the table');
  if (reordered) rebuildReasons.push('columns were reordered');

  const isEmpty =
    addedColumns.length === 0 &&
    droppedColumns.length === 0 &&
    alteredColumns.length === 0 &&
    renamedColumns.length === 0 &&
    !reordered &&
    !primaryKeyChanged &&
    indexes.added.length === 0 &&
    indexes.dropped.length === 0 &&
    indexes.changed.length === 0 &&
    foreignKeys.added.length === 0 &&
    foreignKeys.dropped.length === 0 &&
    foreignKeys.changed.length === 0 &&
    checks.added.length === 0 &&
    checks.dropped.length === 0 &&
    checks.changed.length === 0 &&
    changedOptions.length === 0 &&
    current.name === desired.name &&
    (current.schema ?? '') === (desired.schema ?? '');

  return {
    kind: 'alter',
    current,
    desired,
    isEmpty,
    renamedTable: current.name === desired.name ? null : { from: current.name, to: desired.name },
    movedSchema:
      (current.schema ?? '') === (desired.schema ?? '')
        ? null
        : { from: current.schema, to: desired.schema },
    addedColumns,
    droppedColumns,
    alteredColumns,
    renamedColumns,
    addedColumnsAtEnd,
    reordered,
    primaryKeyChange: primaryKeyChanged
      ? { from: current.primaryKey, to: desired.primaryKey }
      : null,
    addedIndexes: indexes.added,
    droppedIndexes: indexes.dropped,
    changedIndexes: indexes.changed,
    addedForeignKeys: foreignKeys.added,
    droppedForeignKeys: foreignKeys.dropped,
    changedForeignKeys: foreignKeys.changed,
    addedChecks: checks.added,
    droppedChecks: checks.dropped,
    changedChecks: checks.changed,
    changedOptions,
    constraintsChanged,
    requiresRebuild: rebuildReasons.length > 0,
    rebuildReasons,
  };
}
