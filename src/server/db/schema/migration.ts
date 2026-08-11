/**
 * Migration DDL from a canonical diff (PLAN §12 M8: "Introspect two scopes →
 * canonical diff → generated migration DDL with review UI").
 *
 * Input is the engine-neutral `SchemaDiff`; output is an ordered list of
 * statements for ONE target engine. The script always runs against the diff's
 * *target* — `added` means "create it in the target", `removed` means "the
 * target has something the source does not".
 *
 * ORDER IS THE WHOLE POINT. A migration that is right but ordered wrong fails
 * halfway and leaves a half-migrated database, so the sections below are fixed:
 *
 *   drop triggers → drop views → drop foreign keys → drop indexes →
 *   drop constraints → create schemas → types → sequences → create tables →
 *   alter tables → create indexes → create constraints → create foreign keys →
 *   create views → routines → create triggers → comments
 *
 * Two consequences of that order worth spelling out:
 *   - Foreign keys are STRIPPED from `CREATE TABLE` and added afterwards as
 *     `ALTER TABLE … ADD CONSTRAINT`, so a new table can never reference a
 *     table that does not exist yet. SQLite is the exception — it has no
 *     `ALTER TABLE … ADD CONSTRAINT` at all — so there FKs stay inline and the
 *     creates are topologically sorted, parents first.
 *   - Everything the safe section drops, it also puts back. Drops that cannot
 *     be undone by this script (DROP TABLE, DROP COLUMN, DROP SCHEMA, DROP
 *     MATERIALIZED VIEW, DROP SEQUENCE, plus the foreign keys that only exist
 *     to make those possible) go to `destructive`, which the review UI gates
 *     behind an explicit opt-in.
 *
 * §9: every identifier goes through the per-engine quoting functions. Catalog
 * expressions — defaults, generated expressions, check bodies, index
 * predicates, view and routine bodies — are emitted verbatim, because they are
 * already the engine's own SQL and re-quoting them would corrupt them.
 */

import type {
  ColumnModel,
  EngineKind,
  EnumTypeModel,
  ForeignKeyModel,
  IndexModel,
  RoutineModel,
  SequenceModel,
  TableModel,
  TriggerModel,
} from '../../../lib/schema-model';
import { SQL_ENGINES } from '../../../lib/schema-model';
import {
  isConstraintIndex,
  orderedColumns,
  renderCheckDefinition,
  renderColumnDefinition,
  renderCreateIndex,
  renderCreateTable,
  renderForeignKeyDefinition,
  renderInlineIndex,
  renderTypeSql,
} from '../sql/ddl-common';
import { quoterFor, type QuoteFns } from '../sql/quote';
import {
  normalizeBody,
  normalizeSpace,
  type NamespaceDiff,
  type SchemaDiff,
  type TableDiffEntry,
} from './differ';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type MigrationSectionId =
  | 'drop-triggers'
  | 'drop-views'
  | 'drop-foreign-keys'
  | 'drop-indexes'
  | 'drop-constraints'
  | 'create-namespaces'
  | 'types'
  | 'sequences'
  | 'create-tables'
  | 'alter-tables'
  | 'create-indexes'
  | 'create-constraints'
  | 'create-foreign-keys'
  | 'create-views'
  | 'routines'
  | 'create-triggers'
  | 'comments'
  | 'destructive-foreign-keys'
  | 'destructive-columns'
  | 'destructive-tables'
  | 'destructive-objects';

export interface MigrationSection {
  id: MigrationSectionId;
  title: string;
  /** True when the review UI must require an explicit opt-in to run it. */
  destructive: boolean;
  statements: string[];
}

export interface MigrationOptions {
  /** Emit `IF EXISTS` / `IF NOT EXISTS` where the engine supports it. */
  guards?: boolean;
  /**
   * Emit statements that drop objects the target has and the source does not.
   * Default true. Turning it off produces an additive-only script — useful when
   * the target legitimately has more than the reference schema.
   */
  includeDrops?: boolean;
  /** Emit `COMMENT ON …` for engines where comments are separate DDL. */
  includeComments?: boolean;
  /** The caller intends to wrap the script in a transaction. */
  transactional?: boolean;
}

export interface MigrationScript {
  engine: EngineKind;
  /** Safe, ordered, runnable. No comments, no trailing semicolons. */
  statements: string[];
  /** Data-destroying statements, gated behind an explicit opt-in. */
  destructive: string[];
  warnings: string[];
  /** The same statements, grouped and labelled for the review UI. */
  sections: MigrationSection[];
  /** Whether the caller asked for (and the engine supports) a transaction. */
  transactional: boolean;
}

const SECTION_ORDER: { id: MigrationSectionId; title: string; destructive: boolean }[] = [
  { id: 'drop-triggers', title: 'Drop triggers', destructive: false },
  { id: 'drop-views', title: 'Drop views', destructive: false },
  { id: 'drop-foreign-keys', title: 'Drop foreign keys', destructive: false },
  { id: 'drop-indexes', title: 'Drop indexes', destructive: false },
  { id: 'drop-constraints', title: 'Drop constraints', destructive: false },
  { id: 'create-namespaces', title: 'Create schemas', destructive: false },
  { id: 'types', title: 'Types and enums', destructive: false },
  { id: 'sequences', title: 'Sequences', destructive: false },
  { id: 'create-tables', title: 'Create tables', destructive: false },
  { id: 'alter-tables', title: 'Alter tables', destructive: false },
  { id: 'create-indexes', title: 'Create indexes', destructive: false },
  { id: 'create-constraints', title: 'Create constraints', destructive: false },
  { id: 'create-foreign-keys', title: 'Create foreign keys', destructive: false },
  { id: 'create-views', title: 'Create views', destructive: false },
  { id: 'routines', title: 'Routines', destructive: false },
  { id: 'create-triggers', title: 'Create triggers', destructive: false },
  { id: 'comments', title: 'Comments', destructive: false },
  {
    id: 'destructive-foreign-keys',
    title: 'DESTRUCTIVE — foreign keys blocking the drops below',
    destructive: true,
  },
  { id: 'destructive-columns', title: 'DESTRUCTIVE — drop columns', destructive: true },
  { id: 'destructive-tables', title: 'DESTRUCTIVE — drop tables', destructive: true },
  { id: 'destructive-objects', title: 'DESTRUCTIVE — drop sequences and schemas', destructive: true },
];

// ---------------------------------------------------------------------------
// Engine predicates
// ---------------------------------------------------------------------------

function isMysqlFamily(engine: EngineKind): boolean {
  return engine === 'mysql' || engine === 'mariadb';
}

/** MySQL keeps secondary indexes inside CREATE TABLE; the others do not. */
function indexesInlineInCreate(engine: EngineKind): boolean {
  return isMysqlFamily(engine);
}

/**
 * SQLite has no `ALTER TABLE … ADD/DROP CONSTRAINT` in any form: adding a
 * foreign key, a check or a unique constraint to an existing table means the
 * 12-step rebuild in the SQLite connector's DDL module
 * (`src/server/db/connectors/sqlite/ddl.ts`, `planRebuild()` — referenced, not
 * imported: the rebuild needs a live `RebuildContext` of dependent objects that
 * only the connector can introspect).
 */
function supportsAlterConstraints(engine: EngineKind): boolean {
  return engine !== 'sqlite';
}

function transactionalDdl(engine: EngineKind): boolean {
  // MySQL/MariaDB commit implicitly on every DDL statement, so a failed script
  // cannot be rolled back — the warning matters more than the BEGIN.
  return engine === 'postgres' || engine === 'sqlite';
}

// ---------------------------------------------------------------------------
// Script builder
// ---------------------------------------------------------------------------

interface TableRef {
  schema?: string;
  name: string;
}

class ScriptBuilder {
  private readonly bySection = new Map<MigrationSectionId, string[]>();
  private readonly warnings: string[] = [];

  add(section: MigrationSectionId, statement: string): void {
    const list = this.bySection.get(section);
    if (list) list.push(statement);
    else this.bySection.set(section, [statement]);
  }

  /** Warnings are deduped: one "SQLite cannot do X" line, not one per table. */
  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  build(engine: EngineKind, transactional: boolean): MigrationScript {
    const sections: MigrationSection[] = [];
    for (const spec of SECTION_ORDER) {
      const statements = this.bySection.get(spec.id);
      if (!statements || statements.length === 0) continue;
      sections.push({ ...spec, statements });
    }
    return {
      engine,
      statements: sections.filter((s) => !s.destructive).flatMap((s) => s.statements),
      destructive: sections.filter((s) => s.destructive).flatMap((s) => s.statements),
      warnings: this.warnings,
      sections,
      transactional,
    };
  }
}

// ---------------------------------------------------------------------------
// Small renderers
// ---------------------------------------------------------------------------

function qual(ref: TableRef, quote: QuoteFns): string {
  return quote.qualified([ref.schema, ref.name]);
}

function alterTable(ref: TableRef, quote: QuoteFns): string {
  return `ALTER TABLE ${qual(ref, quote)}`;
}

function refOf(table: TableModel): TableRef {
  return { schema: table.schema, name: table.name };
}

/** Identity used to match a foreign key's target against a table. */
function tableKey(schema: string | undefined, name: string): string {
  return `${(schema ?? '').toLowerCase()}.${name.toLowerCase()}`;
}

/**
 * Rewrite a source-side object so it lands in the target's namespace: comparing
 * `app_dev` against `app` must generate `CREATE TABLE app.users`, not
 * `app_dev.users`. Foreign-key targets are remapped too.
 */
function retargetTable(table: TableModel, remap: (schema: string | undefined) => string | undefined): TableModel {
  return {
    ...table,
    schema: remap(table.schema),
    foreignKeys: table.foreignKeys.map((fk) => ({ ...fk, refSchema: remap(fk.refSchema) })),
  };
}

function dropIndexStatement(
  ref: TableRef,
  idx: IndexModel,
  engine: EngineKind,
  quote: QuoteFns,
  guards: boolean,
): string {
  if (isMysqlFamily(engine)) {
    const ifExists = guards && engine === 'mariadb' ? 'IF EXISTS ' : '';
    return `${alterTable(ref, quote)} DROP INDEX ${ifExists}${quote.ident(idx.name)}`;
  }
  // Postgres and SQLite own indexes at schema level, not under the table.
  const ifExists = guards ? 'IF EXISTS ' : '';
  return `DROP INDEX ${ifExists}${quote.qualified([ref.schema, idx.name])}`;
}

function createIndexStatement(
  ref: TableRef,
  idx: IndexModel,
  engine: EngineKind,
  quote: QuoteFns,
  guards: boolean,
): string {
  if (isMysqlFamily(engine)) {
    // `renderInlineIndex` is the form that keeps FULLTEXT/SPATIAL/USING HASH
    // correct; `CREATE INDEX … USING FULLTEXT` is not valid MySQL.
    return `${alterTable(ref, quote)} ADD ${renderInlineIndex(idx, engine, quote)}`;
  }
  const sql = renderCreateIndex(ref, idx, engine, quote);
  return guards ? sql.replace(/^CREATE (UNIQUE )?INDEX /, (m) => `${m}IF NOT EXISTS `) : sql;
}

function dropConstraintStatement(
  ref: TableRef,
  name: string,
  kind: 'foreign-key' | 'check' | 'constraint',
  engine: EngineKind,
  quote: QuoteFns,
  guards: boolean,
): string {
  if (isMysqlFamily(engine)) {
    const ifExists = guards && engine === 'mariadb' ? 'IF EXISTS ' : '';
    const clause = kind === 'foreign-key' ? 'DROP FOREIGN KEY' : kind === 'check' ? 'DROP CHECK' : 'DROP CONSTRAINT';
    return `${alterTable(ref, quote)} ${clause} ${ifExists}${quote.ident(name)}`;
  }
  const ifExists = guards ? 'IF EXISTS ' : '';
  return `${alterTable(ref, quote)} DROP CONSTRAINT ${ifExists}${quote.ident(name)}`;
}

function createSchemaStatement(name: string, engine: EngineKind, quote: QuoteFns, guards: boolean): string {
  const guard = guards ? 'IF NOT EXISTS ' : '';
  if (isMysqlFamily(engine)) return `CREATE DATABASE ${guard}${quote.ident(name)}`;
  return `CREATE SCHEMA ${guard}${quote.ident(name)}`;
}

function dropSchemaStatement(name: string, engine: EngineKind, quote: QuoteFns, guards: boolean): string {
  const guard = guards ? 'IF EXISTS ' : '';
  if (isMysqlFamily(engine)) return `DROP DATABASE ${guard}${quote.ident(name)}`;
  return `DROP SCHEMA ${guard}${quote.ident(name)}`;
}

function createSequenceStatement(seq: SequenceModel, schema: string | undefined, quote: QuoteFns): string {
  const parts = [`CREATE SEQUENCE ${quote.qualified([schema, seq.name])}`];
  if (seq.increment) parts.push(`INCREMENT BY ${seq.increment}`);
  if (seq.minValue) parts.push(`MINVALUE ${seq.minValue}`);
  if (seq.maxValue) parts.push(`MAXVALUE ${seq.maxValue}`);
  if (seq.start) parts.push(`START WITH ${seq.start}`);
  parts.push(seq.cycle ? 'CYCLE' : 'NO CYCLE');
  if (seq.ownedBy) parts.push(`OWNED BY ${seq.ownedBy}`);
  return parts.join(' ');
}

function alterSequenceStatement(seq: SequenceModel, schema: string | undefined, quote: QuoteFns): string {
  const parts = [`ALTER SEQUENCE ${quote.qualified([schema, seq.name])}`];
  if (seq.increment) parts.push(`INCREMENT BY ${seq.increment}`);
  if (seq.minValue) parts.push(`MINVALUE ${seq.minValue}`);
  if (seq.maxValue) parts.push(`MAXVALUE ${seq.maxValue}`);
  parts.push(seq.cycle ? 'CYCLE' : 'NO CYCLE');
  // `RESTART WITH` is deliberately absent: the current value is runtime state,
  // and resetting a live prod sequence hands out duplicate keys.
  return parts.join(' ');
}

function createEnumStatement(e: EnumTypeModel, schema: string | undefined, quote: QuoteFns): string {
  const values = e.values.map((v) => quote.literal(v)).join(', ');
  return `CREATE TYPE ${quote.qualified([schema, e.name])} AS ENUM (${values})`;
}

/** The view body without its `CREATE … AS` wrapper, ready to be re-wrapped. */
function viewBody(table: TableModel): string | null {
  return normalizeBody(table.definition);
}

function createViewStatement(
  table: TableModel,
  ref: TableRef,
  engine: EngineKind,
  quote: QuoteFns,
  orReplace: boolean,
): string | null {
  const body = viewBody(table);
  if (body === null) return null;
  if (table.kind === 'materialized_view') {
    return `CREATE MATERIALIZED VIEW ${qual(ref, quote)} AS ${body}`;
  }
  // SQLite has no CREATE OR REPLACE VIEW; the caller emits a DROP first.
  const replace = orReplace && engine !== 'sqlite' ? 'OR REPLACE ' : '';
  return `CREATE ${replace}VIEW ${qual(ref, quote)} AS ${body}`;
}

function dropViewStatement(
  table: TableModel,
  ref: TableRef,
  quote: QuoteFns,
  guards: boolean,
): string {
  const guard = guards ? 'IF EXISTS ' : '';
  const what = table.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : 'VIEW';
  return `DROP ${what} ${guard}${qual(ref, quote)}`;
}

function routineWord(r: RoutineModel): string {
  return r.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
}

function dropRoutineStatement(
  r: RoutineModel,
  schema: string | undefined,
  engine: EngineKind,
  quote: QuoteFns,
): string {
  const name = quote.qualified([schema, r.name]);
  // Postgres identifies an overload by its argument list; MySQL by name alone.
  const args = engine === 'postgres' ? (r.arguments ?? '()') : '';
  return `DROP ${routineWord(r)} IF EXISTS ${name}${args}`;
}

function createRoutineStatement(
  r: RoutineModel,
  schema: string | undefined,
  engine: EngineKind,
  quote: QuoteFns,
): string | null {
  const def = (r.definition ?? '').trim();
  if (def === '') return null;
  // `pg_get_functiondef` and SHOW CREATE PROCEDURE already return a complete
  // statement; anything else is a bare body that has to be wrapped.
  if (/^create\s+(or\s+replace\s+)?(function|procedure)\b/i.test(def)) return def;

  const name = quote.qualified([schema, r.name]);
  const args = r.arguments ?? '()';
  if (engine === 'postgres') {
    const returns = r.returnType ? ` RETURNS ${r.returnType}` : '';
    const lang = r.language ?? 'sql';
    return `CREATE OR REPLACE ${routineWord(r)} ${name}${args}${returns}\nLANGUAGE ${lang}\nAS $$\n${def}\n$$`;
  }
  const returns = r.kind === 'function' && r.returnType ? ` RETURNS ${r.returnType}` : '';
  const deterministic = r.deterministic ? ' DETERMINISTIC' : '';
  return `CREATE ${routineWord(r)} ${name}${args}${returns}${deterministic}\n${def}`;
}

function createTriggerStatement(
  t: TriggerModel,
  schema: string | undefined,
  engine: EngineKind,
  quote: QuoteFns,
): string | null {
  const body = (t.statement ?? '').trim();
  if (body === '') return null;
  if (/^create\s+(or\s+replace\s+)?trigger\b/i.test(body)) return body;

  const events = t.events.map((e) => e.toUpperCase()).join(' OR ');
  const name = engine === 'postgres' ? quote.ident(t.name) : quote.qualified([schema, t.name]);
  const table = quote.qualified([schema, t.table]);
  const parts = [`CREATE TRIGGER ${name}`, t.timing.toUpperCase(), events, `ON ${table}`];
  if (t.orientation !== 'statement') parts.push('FOR EACH ROW');
  if (t.condition) parts.push(`WHEN (${t.condition})`);
  parts.push(body);
  return parts.join(' ');
}

function commentStatement(
  what: string,
  name: string,
  value: string | null | undefined,
  quote: QuoteFns,
): string {
  const literal = value === null || value === undefined || value === '' ? 'NULL' : quote.literal(value);
  return `COMMENT ON ${what} ${name} IS ${literal}`;
}

// ---------------------------------------------------------------------------
// Dependency ordering
// ---------------------------------------------------------------------------

/**
 * Parents first: a table comes after every table it references. Used for the
 * SQLite create order (where foreign keys must stay inline) and, reversed, for
 * the order tables are dropped in. Cycles — self-references and mutual FKs —
 * keep their input order rather than deadlocking the sort.
 */
export function orderByDependency(tables: TableModel[]): TableModel[] {
  const keyed = new Map<string, TableModel>();
  for (const t of tables) keyed.set(tableKey(t.schema, t.name), t);

  const state = new Map<string, 'visiting' | 'done'>();
  const out: TableModel[] = [];

  const visit = (t: TableModel): void => {
    const key = tableKey(t.schema, t.name);
    if (state.get(key) === 'done' || state.get(key) === 'visiting') return;
    state.set(key, 'visiting');
    for (const fk of t.foreignKeys) {
      const parent = keyed.get(tableKey(fk.refSchema ?? t.schema, fk.refTable));
      if (parent && parent !== t) visit(parent);
    }
    state.set(key, 'done');
    out.push(t);
  };

  for (const t of tables) visit(t);
  return out;
}

// ---------------------------------------------------------------------------
// Column ALTER rendering
// ---------------------------------------------------------------------------

/** MySQL can insert a column at a position; the others always append. */
function mysqlPositionClause(source: TableModel, col: ColumnModel, quote: QuoteFns): string {
  const cols = orderedColumns(source);
  const idx = cols.findIndex((c) => c.name === col.name);
  if (idx < 0 || idx === cols.length - 1) return '';
  if (idx === 0) return ' FIRST';
  return ` AFTER ${quote.ident(cols[idx - 1].name)}`;
}

/**
 * Postgres alters one aspect per statement; MySQL restates the whole column.
 * Returns the statements plus the destructive ones (a generated expression can
 * only be changed by dropping and re-adding the column — which is safe, since
 * a generated column's data is derived, but it still says DROP COLUMN).
 */
function alterColumnStatements(
  ref: TableRef,
  source: ColumnModel,
  target: ColumnModel,
  aspects: string[],
  engine: EngineKind,
  quote: QuoteFns,
  script: ScriptBuilder,
): void {
  if (isMysqlFamily(engine)) {
    script.add('alter-tables', `${alterTable(ref, quote)} MODIFY COLUMN ${renderColumnDefinition(source, engine, quote)}`);
    return;
  }

  if (engine === 'sqlite') {
    // §6 trap 3: SQLite's real ALTER TABLE cannot change a column definition.
    script.warn(
      `SQLite: column "${target.name}" on ${ref.name} needs the 12-step rebuild — ` +
        'run it through planRebuild() in src/server/db/connectors/sqlite/ddl.ts',
    );
    return;
  }

  const col = quote.ident(target.name);
  const head = `${alterTable(ref, quote)} ALTER COLUMN ${col}`;

  if (aspects.includes('generated')) {
    script.add('destructive-columns', `${alterTable(ref, quote)} DROP COLUMN ${col}`);
    script.add(
      'destructive-columns',
      `${alterTable(ref, quote)} ADD COLUMN ${renderColumnDefinition(source, engine, quote)}`,
    );
    script.warn(
      `Postgres cannot alter a generated expression: "${target.name}" is dropped and re-added ` +
        '(the values are recomputed, but the column moves to the end of the table)',
    );
    return;
  }

  if (aspects.includes('type') || aspects.includes('collation')) {
    const typeSql = renderTypeSql(source.type, engine, quote);
    const collate =
      source.collation && source.collation !== 'default' ? ` COLLATE ${quote.ident(source.collation)}` : '';
    // An implicit cast only exists inside a type family; across families
    // Postgres refuses the ALTER without an explicit USING.
    const using = source.type.base !== target.type.base ? ` USING ${col}::${typeSql}` : '';
    if (using) {
      script.warn(
        `${ref.name}.${target.name} changes type family (${target.type.base} → ${source.type.base}); ` +
          'the generated USING cast may lose data or fail on existing rows',
      );
    }
    script.add('alter-tables', `${head} TYPE ${typeSql}${collate}${using}`);
  }
  if (aspects.includes('nullable')) {
    script.add('alter-tables', `${head} ${source.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
    if (!source.nullable) {
      script.warn(
        `${ref.name}.${target.name} becomes NOT NULL; the statement fails unless every existing row has a value`,
      );
    }
  }
  if (aspects.includes('default')) {
    script.add(
      'alter-tables',
      source.defaultValue === null ? `${head} DROP DEFAULT` : `${head} SET DEFAULT ${source.defaultValue}`,
    );
  }
  if (aspects.includes('autoIncrement')) {
    script.add(
      'alter-tables',
      source.autoIncrement ? `${head} ADD GENERATED BY DEFAULT AS IDENTITY` : `${head} DROP IDENTITY IF EXISTS`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function generateMigration(
  diff: SchemaDiff,
  engine: EngineKind,
  opts: MigrationOptions = {},
): MigrationScript {
  if (!SQL_ENGINES.includes(engine)) {
    throw new Error(`generateMigration: ${engine} has no DDL; schema compare is SQL-only (§12 M8)`);
  }
  const quote = quoterFor(engine);
  const guards = opts.guards ?? false;
  const includeDrops = opts.includeDrops ?? true;
  const includeComments = opts.includeComments ?? true;
  const wantsTransaction = opts.transactional ?? false;
  const script = new ScriptBuilder();

  for (const note of diff.notes) script.warn(note);
  if (diff.targetEngine !== engine) {
    script.warn(
      `the diff's target was introspected from ${diff.targetEngine} but the script is generated for ` +
        `${engine}; type names and expressions are not portable`,
    );
  }
  if (wantsTransaction && !transactionalDdl(engine)) {
    script.warn(
      `${engine} commits implicitly on every DDL statement: this script cannot run in a transaction, ` +
        'and a failure halfway leaves the database half-migrated',
    );
  }

  // Source namespace name → target namespace name, for retargeting new objects.
  const nsRemap = new Map<string, string>();
  for (const ns of diff.namespaces) {
    if (ns.sourceName !== null) nsRemap.set(ns.sourceName, ns.targetName ?? ns.sourceName);
  }
  const remap = (schema: string | undefined): string | undefined =>
    schema === undefined ? undefined : (nsRemap.get(schema) ?? schema);

  // Where a source-only object should be written.
  const targetNsName = (ns: NamespaceDiff): string | null => ns.targetName ?? ns.sourceName;

  // Newly created tables, collected across namespaces so the topological sort
  // (SQLite) and the deferred foreign keys see the whole set at once.
  const created: TableModel[] = [];
  // Foreign keys added after every table exists.
  const deferredForeignKeys: { ref: TableRef; fk: ForeignKeyModel }[] = [];
  // Tables the destructive section drops, and the target tables that survive.
  const droppedTables: TableModel[] = [];
  const survivingTargets: TableModel[] = [];

  for (const ns of diff.namespaces) {
    const nsName = targetNsName(ns);

    if (ns.status === 'added' && nsName !== null) {
      if (engine === 'sqlite') {
        script.warn(
          `SQLite attaches databases rather than creating schemas: "${nsName}" must be attached before this script runs`,
        );
      } else {
        script.add('create-namespaces', createSchemaStatement(nsName, engine, quote, guards));
      }
    }

    // --- enums -------------------------------------------------------------
    for (const e of ns.enums) {
      if (engine !== 'postgres') {
        if (e.status !== 'same') {
          script.warn(
            `${engine} has no standalone enum type: enum "${e.name}" is part of a column's type and is ` +
              'migrated with that column',
          );
        }
        continue;
      }
      if (e.status === 'added' && e.source) {
        script.add('types', createEnumStatement(e.source, nsName ?? undefined, quote));
      } else if (e.status === 'removed' && e.target) {
        script.add('types', `DROP TYPE ${guards ? 'IF EXISTS ' : ''}${quote.qualified([ns.targetName, e.target.name])}`);
      } else if (e.status === 'changed' && e.source && e.target) {
        const existing = new Set(e.target.values);
        const name = quote.qualified([ns.targetName, e.target.name]);
        const wanted = e.source.values;
        // Ascending source order, so `AFTER <previous>` always names a label
        // that already exists — either it was there or this loop just added it.
        // A new label at position 0 has no predecessor, so it anchors on the
        // first label the target already has.
        const firstExisting = wanted.find((v) => existing.has(v));
        for (let i = 0; i < wanted.length; i++) {
          const v = wanted[i];
          if (existing.has(v)) continue;
          let where = '';
          if (i > 0) where = ` AFTER ${quote.literal(wanted[i - 1])}`;
          else if (firstExisting !== undefined) where = ` BEFORE ${quote.literal(firstExisting)}`;
          script.add('types', `ALTER TYPE ${name} ADD VALUE ${quote.literal(v)}${where}`);
          existing.add(v);
        }
        const removedValues = e.target.values.filter((v) => !wanted.includes(v));
        if (removedValues.length > 0) {
          script.warn(
            `Postgres cannot remove enum values (${e.target.name}: ${removedValues.join(', ')}); ` +
              'recreate the type manually if that matters',
          );
        }
        script.warn(
          'ALTER TYPE … ADD VALUE cannot run inside a transaction block before PostgreSQL 12',
        );
      }
    }

    // --- sequences ---------------------------------------------------------
    for (const s of ns.sequences) {
      if (s.status === 'added' && s.source) {
        script.add('sequences', createSequenceStatement(s.source, nsName ?? undefined, quote));
      } else if (s.status === 'changed' && s.source) {
        script.add('sequences', alterSequenceStatement(s.source, ns.targetName ?? undefined, quote));
      } else if (s.status === 'removed' && s.target && includeDrops) {
        script.add(
          'destructive-objects',
          `DROP SEQUENCE ${guards ? 'IF EXISTS ' : ''}${quote.qualified([ns.targetName, s.target.name])}`,
        );
        script.warn(`dropping sequence "${s.target.name}" discards its current value permanently`);
      }
    }

    // --- tables ------------------------------------------------------------
    for (const entry of ns.tables) {
      if (entry.target) survivingTargets.push(entry.target);

      if (entry.status === 'added' && entry.source) {
        // `remap` covers cross-namespace foreign keys too, not just this table's
        // own schema — an added table in `app_dev` may point at `shared_dev`.
        created.push(retargetTable(entry.source, remap));
        continue;
      }
      if (entry.status === 'removed' && entry.target) {
        if (includeDrops) droppedTables.push(entry.target);
        continue;
      }
      if (entry.status !== 'changed' || !entry.source || !entry.target) continue;

      emitTableAlter(entry, engine, quote, guards, includeDrops, includeComments, script, deferredForeignKeys, remap);
    }

    // --- views -------------------------------------------------------------
    for (const entry of ns.views) {
      emitView(entry, engine, quote, guards, includeDrops, script, nsName);
    }

    // --- routines ----------------------------------------------------------
    for (const r of ns.routines) {
      if (r.status === 'same') continue;
      if (r.status === 'removed' && r.target) {
        if (includeDrops) {
          script.add('routines', dropRoutineStatement(r.target, ns.targetName ?? undefined, engine, quote));
          script.warn(`routine "${r.target.name}" is dropped; this script cannot recreate it`);
        }
        continue;
      }
      const source = r.source;
      if (!source) continue;
      const schema = r.status === 'added' ? (nsName ?? undefined) : (ns.targetName ?? undefined);
      // A changed argument list creates an overload instead of replacing the
      // routine, so the old signature is dropped explicitly first.
      const signatureChanged = r.fields.some((f) => f.field === 'arguments' || f.field === 'returnType');
      if (r.target && (signatureChanged || engine !== 'postgres')) {
        script.add('routines', dropRoutineStatement(r.target, schema, engine, quote));
      }
      const sql = createRoutineStatement(source, schema, engine, quote);
      if (sql === null) {
        script.warn(`routine "${source.name}" has no body in the source model and was skipped`);
      } else {
        script.add('routines', sql);
        if (isMysqlFamily(engine)) {
          script.warn(
            'MySQL routine bodies contain statement terminators: run them with a client-side DELIMITER or ' +
              'send each CREATE as a single statement',
          );
        }
      }
    }

    // --- triggers ----------------------------------------------------------
    for (const t of ns.triggers) {
      if (t.status === 'same') continue;
      const schema = t.status === 'added' ? (nsName ?? undefined) : (ns.targetName ?? undefined);
      if (t.target && (t.status === 'removed' || t.status === 'changed')) {
        if (t.status === 'removed' && !includeDrops) continue;
        const name =
          engine === 'postgres'
            ? `${quote.ident(t.target.name)} ON ${quote.qualified([schema, t.target.table])}`
            : quote.qualified([schema, t.target.name]);
        script.add('drop-triggers', `DROP TRIGGER ${guards ? 'IF EXISTS ' : ''}${name}`);
      }
      if (t.source) {
        const sql = createTriggerStatement(t.source, schema, engine, quote);
        if (sql === null) script.warn(`trigger "${t.source.name}" has no body in the source model and was skipped`);
        else script.add('create-triggers', sql);
      }
    }

    if (ns.status === 'removed' && ns.targetName !== null && includeDrops) {
      script.add('destructive-objects', dropSchemaStatement(ns.targetName, engine, quote, guards));
    }
  }

  // --- create tables -------------------------------------------------------
  // Foreign keys are stripped so a create can never reference a table that does
  // not exist yet; SQLite keeps them inline (no ALTER … ADD CONSTRAINT) and is
  // therefore sorted parents-first instead.
  const inlineFks = !supportsAlterConstraints(engine);
  const createOrder = inlineFks ? orderByDependency(created) : created;
  for (const table of createOrder) {
    const body = inlineFks ? table : { ...table, foreignKeys: [] };
    const sql = renderCreateTable(body, engine, quote);
    script.add('create-tables', guards ? sql.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ') : sql);

    if (!inlineFks) {
      for (const fk of table.foreignKeys) deferredForeignKeys.push({ ref: refOf(table), fk });
    }
    if (!indexesInlineInCreate(engine)) {
      for (const idx of table.indexes) {
        // The PK and (SQLite) the auto-indexes behind UNIQUE constraints are
        // already inside the CREATE TABLE body.
        if (idx.primary) continue;
        if (engine === 'sqlite' && idx.unique && isConstraintIndex(idx)) continue;
        script.add('create-indexes', createIndexStatement(refOf(table), idx, engine, quote, guards));
      }
    }
    if (includeComments && engine === 'postgres') {
      if (table.comment) {
        script.add('comments', commentStatement('TABLE', qual(refOf(table), quote), table.comment, quote));
      }
      for (const c of orderedColumns(table)) {
        if (!c.comment) continue;
        script.add(
          'comments',
          commentStatement('COLUMN', `${qual(refOf(table), quote)}.${quote.ident(c.name)}`, c.comment, quote),
        );
      }
    }
  }

  // --- deferred foreign keys ----------------------------------------------
  for (const { ref, fk } of deferredForeignKeys) {
    script.add('create-foreign-keys', `${alterTable(ref, quote)} ADD ${renderForeignKeyDefinition(fk, engine, quote)}`);
  }
  if (inlineFks && created.length > 1) {
    script.warn('SQLite: table creates are ordered parents-first because foreign keys must stay inline');
  }

  // --- destructive table drops --------------------------------------------
  if (droppedTables.length > 0) {
    const droppedKeys = new Set(droppedTables.map((d) => tableKey(d.schema, d.name)));
    // A surviving table pointing at a dropped one blocks the DROP, so that
    // foreign key is dropped first — inside the destructive section, because it
    // only makes sense together with the drop it enables.
    for (const survivor of survivingTargets) {
      if (droppedKeys.has(tableKey(survivor.schema, survivor.name))) continue;
      for (const fk of survivor.foreignKeys) {
        if (!droppedKeys.has(tableKey(fk.refSchema ?? survivor.schema, fk.refTable))) continue;
        if (!supportsAlterConstraints(engine)) {
          script.warn(
            `SQLite cannot drop foreign key "${fk.name}" on ${survivor.name}: rebuild that table (planRebuild() in ` +
              'src/server/db/connectors/sqlite/ddl.ts) or run the drops with PRAGMA foreign_keys = OFF',
          );
          continue;
        }
        script.add(
          'destructive-foreign-keys',
          dropConstraintStatement(refOf(survivor), fk.name, 'foreign-key', engine, quote, guards),
        );
      }
    }
    // Children before parents: the reverse of the create order.
    for (const table of orderByDependency(droppedTables).reverse()) {
      const what = table.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : 'TABLE';
      script.add(
        'destructive-tables',
        `DROP ${what} ${guards ? 'IF EXISTS ' : ''}${qual(refOf(table), quote)}`,
      );
    }
    script.warn(`${droppedTables.length} table(s) are dropped with all their data; review before running`);
  }

  return script.build(engine, wantsTransaction && transactionalDdl(engine));
}

// ---------------------------------------------------------------------------
// Per-table ALTER
// ---------------------------------------------------------------------------

function emitTableAlter(
  entry: TableDiffEntry,
  engine: EngineKind,
  quote: QuoteFns,
  guards: boolean,
  includeDrops: boolean,
  includeComments: boolean,
  script: ScriptBuilder,
  deferredForeignKeys: { ref: TableRef; fk: ForeignKeyModel }[],
  remap: (schema: string | undefined) => string | undefined,
): void {
  const source = entry.source!;
  const target = entry.target!;
  const ref = refOf(target);
  const sqlite = engine === 'sqlite';
  const rebuildReasons: string[] = [];

  // --- foreign keys: drop first, add last ---------------------------------
  for (const fk of entry.foreignKeys) {
    if (fk.status === 'same') continue;
    if (!supportsAlterConstraints(engine)) {
      rebuildReasons.push(`foreign key "${fk.name}" changed`);
      continue;
    }
    if ((fk.status === 'removed' || fk.status === 'changed') && fk.target) {
      if (fk.status === 'removed' && !includeDrops) continue;
      script.add('drop-foreign-keys', dropConstraintStatement(ref, fk.target.name, 'foreign-key', engine, quote, guards));
    }
    if (fk.source) {
      deferredForeignKeys.push({ ref, fk: { ...fk.source, refSchema: remap(fk.source.refSchema) } });
    }
  }

  // --- indexes -------------------------------------------------------------
  for (const idx of entry.indexes) {
    if (idx.status === 'same') continue;
    const isConstraint = sqlite && ((idx.target && idx.target.unique && isConstraintIndex(idx.target)) ||
      (idx.source && idx.source.unique && isConstraintIndex(idx.source)));
    if (isConstraint) {
      rebuildReasons.push(`UNIQUE constraint "${idx.name}" changed`);
      continue;
    }
    if ((idx.status === 'removed' || idx.status === 'changed') && idx.target) {
      if (idx.status === 'removed' && !includeDrops) continue;
      script.add('drop-indexes', dropIndexStatement(ref, idx.target, engine, quote, guards));
    }
    if (idx.source) script.add('create-indexes', createIndexStatement(ref, idx.source, engine, quote, guards));
  }

  // --- checks --------------------------------------------------------------
  for (const chk of entry.checks) {
    if (chk.status === 'same') continue;
    if (!supportsAlterConstraints(engine)) {
      rebuildReasons.push(`check constraint "${chk.name}" changed`);
      continue;
    }
    if ((chk.status === 'removed' || chk.status === 'changed') && chk.target) {
      if (chk.status === 'removed' && !includeDrops) continue;
      script.add('drop-constraints', dropConstraintStatement(ref, chk.target.name, 'check', engine, quote, guards));
    }
    if (chk.source) {
      script.add('create-constraints', `${alterTable(ref, quote)} ADD ${renderCheckDefinition(chk.source, quote)}`);
      if (isMysqlFamily(engine)) script.warn('CHECK constraints need MySQL 8.0.16+ or MariaDB 10.2+');
    }
  }

  // --- primary key ---------------------------------------------------------
  if (entry.primaryKey) {
    if (sqlite) {
      rebuildReasons.push('the primary key changed');
    } else {
      if (entry.primaryKey.target.length > 0) {
        if (isMysqlFamily(engine)) {
          script.add('drop-constraints', `${alterTable(ref, quote)} DROP PRIMARY KEY`);
        } else {
          // Postgres drops a primary key by its constraint name; the catalog
          // default is <table>_pkey when introspection did not report one.
          script.add(
            'drop-constraints',
            dropConstraintStatement(ref, target.primaryKeyName ?? `${target.name}_pkey`, 'constraint', engine, quote, guards),
          );
        }
      }
      if (entry.primaryKey.source.length > 0) {
        const cols = entry.primaryKey.source.map((c) => quote.ident(c)).join(', ');
        const named =
          !isMysqlFamily(engine) && source.primaryKeyName ? `CONSTRAINT ${quote.ident(source.primaryKeyName)} ` : '';
        script.add('create-constraints', `${alterTable(ref, quote)} ADD ${named}PRIMARY KEY (${cols})`);
      }
      script.warn(`changing the primary key of "${target.name}" rewrites the table and locks it`);
    }
  }

  // --- columns -------------------------------------------------------------
  for (const col of entry.columns) {
    if (col.status === 'same') continue;

    if (col.status === 'added' && col.source) {
      if (sqlite && !col.source.nullable && col.source.defaultValue === null) {
        rebuildReasons.push(`column "${col.name}" is NOT NULL without a default`);
        continue;
      }
      const position = isMysqlFamily(engine) ? mysqlPositionClause(source, col.source, quote) : '';
      script.add(
        'alter-tables',
        `${alterTable(ref, quote)} ADD COLUMN ${renderColumnDefinition(col.source, engine, quote)}${position}`,
      );
      if (!col.source.nullable && col.source.defaultValue === null && !col.source.generated) {
        script.warn(
          `${target.name}.${col.name} is added NOT NULL without a default; the statement fails on a non-empty table`,
        );
      }
      continue;
    }

    if (col.status === 'removed' && col.target) {
      if (!includeDrops) continue;
      script.add('destructive-columns', `${alterTable(ref, quote)} DROP COLUMN ${quote.ident(col.target.name)}`);
      if (sqlite) {
        script.warn(
          'SQLite DROP COLUMN needs 3.35+ and refuses indexed or referenced columns; the connector checks that at apply time',
        );
      }
      continue;
    }

    if (col.status === 'changed' && col.source && col.target) {
      alterColumnStatements(
        ref,
        col.source,
        col.target,
        col.fields.map((f) => f.field),
        engine,
        quote,
        script,
      );
      if (includeComments && engine === 'postgres' && col.fields.some((f) => f.field === 'comment')) {
        script.add(
          'comments',
          commentStatement('COLUMN', `${qual(ref, quote)}.${quote.ident(col.target.name)}`, col.source.comment, quote),
        );
      }
    }
  }

  // A drop plus an add of columns with the same shape is what a rename looks
  // like through a name-keyed model — say so instead of guessing (§4).
  const dropped = entry.columns.filter((c) => c.status === 'removed');
  const added = entry.columns.filter((c) => c.status === 'added');
  if (dropped.length > 0 && added.length > 0) {
    script.warn(
      `"${target.name}" drops ${dropped.map((c) => c.name).join(', ')} and adds ` +
        `${added.map((c) => c.name).join(', ')}; if any of those is a rename, replace the pair with a RENAME COLUMN`,
    );
  }

  // --- table options and comments ------------------------------------------
  for (const field of entry.fields) {
    if (field.field === 'primaryKey' || field.field === 'columnOrder') continue;
    if (field.field === 'comment') {
      if (!includeComments) continue;
      if (isMysqlFamily(engine)) {
        script.add('alter-tables', `${alterTable(ref, quote)} COMMENT = ${quote.literal(source.comment ?? '')}`);
      } else if (engine === 'postgres') {
        script.add('comments', commentStatement('TABLE', qual(ref, quote), source.comment, quote));
      }
      continue;
    }
    if (field.field === 'engine' && isMysqlFamily(engine) && source.engine) {
      script.add('alter-tables', `${alterTable(ref, quote)} ENGINE = ${source.engine}`);
      continue;
    }
    if (field.field === 'collation' && isMysqlFamily(engine) && source.collation) {
      script.add('alter-tables', `${alterTable(ref, quote)} COLLATE = ${source.collation}`);
      continue;
    }
    if (field.field === 'partitioning' || field.field === 'engine' || field.field === 'kind') {
      script.warn(
        `"${target.name}" differs in ${field.field} (${field.target ?? 'none'} → ${field.source ?? 'none'}); ` +
          'that cannot be altered in place and needs a manual rebuild',
      );
    }
  }

  if (entry.columnOrderChanged) {
    script.warn(
      `"${target.name}" has its columns in a different order; no engine reorders columns in place, so the ` +
        'script leaves the target order alone',
    );
  }

  if (rebuildReasons.length > 0) {
    // §6 "SQLite's four traps", trap 3: everything above that SQLite cannot
    // express goes through the connector's 12-step rebuild.
    script.warn(
      `SQLite: "${target.name}" needs the 12-step rebuild (${rebuildReasons.join('; ')}) — ` +
        'run it through planRebuild() in src/server/db/connectors/sqlite/ddl.ts, which copies the data, ' +
        'recreates the dependent indexes/triggers/views and checks foreign keys',
    );
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function emitView(
  entry: TableDiffEntry,
  engine: EngineKind,
  quote: QuoteFns,
  guards: boolean,
  includeDrops: boolean,
  script: ScriptBuilder,
  nsName: string | null,
): void {
  if (entry.status === 'same') return;

  if (entry.status === 'removed' && entry.target) {
    if (!includeDrops) return;
    const ref = refOf(entry.target);
    if (entry.target.kind === 'materialized_view') {
      // A materialized view holds rows, so its drop is gated with the others.
      script.add('destructive-tables', dropViewStatement(entry.target, ref, quote, guards));
    } else {
      script.add('drop-views', dropViewStatement(entry.target, ref, quote, guards));
      script.warn(`view "${entry.target.name}" is dropped; this script cannot recreate it`);
    }
    return;
  }

  const source = entry.source;
  if (!source) return;
  const ref: TableRef =
    entry.target !== null
      ? refOf(entry.target)
      : { schema: source.schema === undefined ? undefined : (nsName ?? source.schema), name: source.name };

  // `CREATE OR REPLACE VIEW` only works when the column list is unchanged, and
  // SQLite does not have it at all; otherwise drop and recreate.
  const columnsChanged = entry.columns.some((c) => c.status === 'added' || c.status === 'removed');
  const replaceable = engine !== 'sqlite' && source.kind !== 'materialized_view' && !columnsChanged;

  if (entry.status === 'changed' && entry.target && !replaceable) {
    script.add('drop-views', dropViewStatement(entry.target, ref, quote, guards));
  }
  const sql = createViewStatement(source, ref, engine, quote, replaceable);
  if (sql === null) {
    script.warn(`view "${source.name}" has no definition in the source model and was skipped`);
    return;
  }
  script.add('create-views', sql);
  if (source.kind === 'materialized_view' && entry.status === 'changed') {
    script.warn(`materialized view "${source.name}" is recreated, which recomputes it in full`);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The reviewable script: labelled sections, warnings on top, and the
 * destructive block commented out unless the reviewer opted in — so a copied
 * script is safe by default (§9 "destructive statements get a confirm").
 */
export function renderMigrationScript(
  script: MigrationScript,
  opts: { includeDestructive?: boolean } = {},
): string {
  const lines: string[] = [];
  lines.push(`-- Migration for ${script.engine}, generated from a canonical schema diff (PLAN M8).`);
  lines.push('-- Review every statement before running it.');
  if (script.warnings.length > 0) {
    lines.push('--');
    for (const w of script.warnings) lines.push(`-- WARNING: ${normalizeSpace(w)}`);
  }
  lines.push('');
  if (script.transactional) lines.push('BEGIN;', '');

  for (const section of script.sections) {
    if (section.destructive) continue;
    lines.push(`-- ${section.title}`);
    for (const s of section.statements) lines.push(`${s};`);
    lines.push('');
  }

  if (script.transactional) lines.push('COMMIT;', '');

  const destructive = script.sections.filter((s) => s.destructive);
  if (destructive.length > 0) {
    lines.push('-- ===========================================================');
    lines.push('-- DESTRUCTIVE — these statements destroy data and are not');
    lines.push('-- included unless you explicitly opt in.');
    lines.push('-- ===========================================================');
    for (const section of destructive) {
      lines.push(`-- ${section.title}`);
      for (const s of section.statements) {
        lines.push(opts.includeDestructive ? `${s};` : `-- ${s};`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
