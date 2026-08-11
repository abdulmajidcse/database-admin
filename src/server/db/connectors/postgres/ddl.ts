/**
 * Postgres DDL rendering and changeset → SQL (PLAN §6 "Grid editing", §9).
 *
 * Two jobs live here:
 *   1. Turning a canonical `TableModel` back into DDL — for the object viewer,
 *      for schema export, and for the table designer's migration script.
 *   2. Turning a `Changeset` into the exact statements the apply will run, with
 *      a parameterized form for execution and an inlined form for the preview.
 *
 * Every identifier goes through `quoteIdent`. Nothing here concatenates a name
 * the user typed straight into SQL.
 */

import type {
  CheckModel,
  ColumnModel,
  ForeignKeyModel,
  IndexModel,
  SequenceModel,
  TableModel,
} from '../../../../lib/schema-model';
import type { Cell } from '../../../../lib/wire';
import type { Changeset, RowKey } from '../../../../lib/results';
import { cellToPgParam, cellToSqlLiteral, qualify, quoteIdent, quoteLiteral } from './types';

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderColumnDefinition(c: ColumnModel): string {
  const parts = [quoteIdent(c.name), c.type.raw];
  if (c.collation && c.collation !== 'default') parts.push(`COLLATE ${quoteIdent(c.collation)}`);
  if (c.generated === 'stored' && c.generatedExpression) {
    parts.push(`GENERATED ALWAYS AS (${c.generatedExpression}) STORED`);
  } else if (c.defaultValue !== null && c.defaultValue !== undefined) {
    parts.push(`DEFAULT ${c.defaultValue}`);
  }
  if (!c.nullable) parts.push('NOT NULL');
  return parts.join(' ');
}

function renderForeignKey(fk: ForeignKeyModel): string {
  const parts = [
    `CONSTRAINT ${quoteIdent(fk.name)} FOREIGN KEY (${fk.columns.map(quoteIdent).join(', ')})`,
    `REFERENCES ${qualify(fk.refSchema, fk.refTable)} (${fk.refColumns.map(quoteIdent).join(', ')})`,
  ];
  if (fk.onUpdate && fk.onUpdate !== 'no action') parts.push(`ON UPDATE ${fk.onUpdate.toUpperCase()}`);
  if (fk.onDelete && fk.onDelete !== 'no action') parts.push(`ON DELETE ${fk.onDelete.toUpperCase()}`);
  if (fk.deferrable) parts.push('DEFERRABLE INITIALLY DEFERRED');
  return parts.join(' ');
}

function renderCheck(chk: CheckModel): string {
  const expr = chk.expression.trim();
  const wrapped = expr.startsWith('(') && expr.endsWith(')') ? expr : `(${expr})`;
  return `CONSTRAINT ${quoteIdent(chk.name)} CHECK ${wrapped}`;
}

function renderIndexPart(part: IndexModel['columns'][number]): string {
  const base = part.expression ? `(${part.expression})` : quoteIdent(part.name ?? '');
  const bits = [base];
  if (part.order === 'desc') bits.push('DESC');
  // Postgres defaults are NULLS LAST for ASC and NULLS FIRST for DESC; only
  // emit the clause when the index actually deviates from that.
  const implied = part.order === 'desc' ? 'first' : 'last';
  if (part.nulls && part.nulls !== implied) bits.push(`NULLS ${part.nulls.toUpperCase()}`);
  return bits.join(' ');
}

export function renderCreateIndex(table: TableModel, idx: IndexModel): string {
  const cols = idx.columns.map(renderIndexPart).join(', ');
  const method = idx.method && idx.method !== 'btree' ? ` USING ${idx.method}` : '';
  const where = idx.predicate ? ` WHERE ${idx.predicate}` : '';
  return (
    `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(idx.name)} ` +
    `ON ${qualify(table.schema, table.name)}${method} (${cols})${where};`
  );
}

function commentStatement(target: string, comment: string | undefined | null): string | null {
  if (comment === undefined || comment === null || comment === '') return null;
  return `COMMENT ON ${target} IS ${quoteLiteral(comment)};`;
}

/**
 * The `CREATE TABLE` statement alone. Secondary indexes and comments are
 * separate statements — see `renderTableDdl` for the full script.
 */
export function renderCreateTable(table: TableModel): string {
  const target = qualify(table.schema, table.name);
  const body: string[] = table.columns
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(renderColumnDefinition);

  if (table.primaryKey.length > 0) {
    const name = table.primaryKeyName ? `CONSTRAINT ${quoteIdent(table.primaryKeyName)} ` : '';
    body.push(`${name}PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(', ')})`);
  }
  for (const chk of table.checks) body.push(renderCheck(chk));
  for (const fk of table.foreignKeys) body.push(renderForeignKey(fk));

  const partition = table.partitioning && !table.partitioning.startsWith('PARTITION ')
    ? `\nPARTITION BY ${table.partitioning}`
    : '';
  const using = table.engine && table.engine !== 'heap' ? `\nUSING ${table.engine}` : '';
  return `CREATE TABLE ${target} (\n  ${body.join(',\n  ')}\n)${using}${partition};`;
}

/** Full DDL script for one relation: table/view + indexes + comments. */
export function renderTableDdl(table: TableModel): string {
  const out: string[] = [];
  const target = qualify(table.schema, table.name);

  if (table.kind === 'view' || table.kind === 'materialized_view') {
    const keyword = table.kind === 'view' ? 'VIEW' : 'MATERIALIZED VIEW';
    const body = (table.definition ?? '').trim().replace(/;$/, '');
    out.push(`CREATE ${keyword} ${target} AS\n${body};`);
  } else {
    out.push(renderCreateTable(table));
    // A unique constraint is indistinguishable from a unique index in the
    // canonical model, so it is emitted here rather than inside CREATE TABLE.
    for (const idx of table.indexes) {
      if (idx.primary) continue;
      out.push(renderCreateIndex(table, idx));
    }
  }

  const objectKind =
    table.kind === 'view' ? 'VIEW' : table.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : 'TABLE';
  const tableComment = commentStatement(`${objectKind} ${target}`, table.comment);
  if (tableComment) out.push(tableComment);
  for (const c of table.columns) {
    const s = commentStatement(`COLUMN ${target}.${quoteIdent(c.name)}`, c.comment);
    if (s) out.push(s);
  }
  return out.join('\n\n');
}

export function renderCreateSequence(seq: SequenceModel): string {
  const parts = [`CREATE SEQUENCE ${qualify(seq.schema, seq.name)}`];
  if (seq.increment) parts.push(`  INCREMENT BY ${seq.increment}`);
  if (seq.minValue) parts.push(`  MINVALUE ${seq.minValue}`);
  if (seq.maxValue) parts.push(`  MAXVALUE ${seq.maxValue}`);
  if (seq.start) parts.push(`  START WITH ${seq.start}`);
  parts.push(`  ${seq.cycle ? 'CYCLE' : 'NO CYCLE'}`);
  if (seq.ownedBy) parts.push(`  OWNED BY ${seq.ownedBy}`);
  return `${parts.join('\n')};`;
}

// ---------------------------------------------------------------------------
// Migration planning (table designer → DDL)
// ---------------------------------------------------------------------------

function sameIndex(a: IndexModel, b: IndexModel): boolean {
  return (
    a.unique === b.unique &&
    (a.method ?? 'btree') === (b.method ?? 'btree') &&
    (a.predicate ?? '') === (b.predicate ?? '') &&
    a.columns.length === b.columns.length &&
    a.columns.every((c, i) => {
      const o = b.columns[i];
      return c.name === o.name && (c.expression ?? '') === (o.expression ?? '') && c.order === o.order;
    })
  );
}

function sameFk(a: ForeignKeyModel, b: ForeignKeyModel): boolean {
  return (
    a.columns.join(',') === b.columns.join(',') &&
    a.refTable === b.refTable &&
    (a.refSchema ?? '') === (b.refSchema ?? '') &&
    a.refColumns.join(',') === b.refColumns.join(',') &&
    (a.onUpdate ?? 'no action') === (b.onUpdate ?? 'no action') &&
    (a.onDelete ?? 'no action') === (b.onDelete ?? 'no action')
  );
}

/**
 * Diff two table shapes into runnable DDL. Objects are matched **by name** —
 * a rename is therefore a drop plus an add unless the caller renames the table
 * itself, which is the honest reading of a name-keyed model.
 */
export function planPostgresTableDdl(current: TableModel | null, desired: TableModel): string[] {
  if (!current) return renderTableDdl(desired).split('\n\n');

  const out: string[] = [];
  let schema = current.schema;
  let name = current.name;

  if ((desired.schema ?? '') !== (current.schema ?? '')) {
    out.push(`ALTER TABLE ${qualify(schema, name)} SET SCHEMA ${quoteIdent(desired.schema ?? 'public')};`);
    schema = desired.schema;
  }
  if (desired.name !== current.name) {
    out.push(`ALTER TABLE ${qualify(schema, name)} RENAME TO ${quoteIdent(desired.name)};`);
    name = desired.name;
  }
  const target = qualify(schema, name);
  const alter = (clause: string): void => void out.push(`ALTER TABLE ${target} ${clause};`);

  const currentCols = new Map(current.columns.map((c) => [c.name, c]));
  const desiredCols = new Map(desired.columns.map((c) => [c.name, c]));

  for (const c of desired.columns) {
    const before = currentCols.get(c.name);
    if (!before) {
      alter(`ADD COLUMN ${renderColumnDefinition(c)}`);
      continue;
    }
    if (before.type.raw !== c.type.raw) {
      // USING keeps the statement valid for the casts Postgres will not do implicitly.
      alter(`ALTER COLUMN ${quoteIdent(c.name)} TYPE ${c.type.raw} USING ${quoteIdent(c.name)}::${c.type.raw}`);
    }
    if (before.nullable !== c.nullable) {
      alter(`ALTER COLUMN ${quoteIdent(c.name)} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
    }
    if ((before.defaultValue ?? null) !== (c.defaultValue ?? null)) {
      alter(
        c.defaultValue
          ? `ALTER COLUMN ${quoteIdent(c.name)} SET DEFAULT ${c.defaultValue}`
          : `ALTER COLUMN ${quoteIdent(c.name)} DROP DEFAULT`,
      );
    }
    if ((before.comment ?? '') !== (c.comment ?? '')) {
      out.push(`COMMENT ON COLUMN ${target}.${quoteIdent(c.name)} IS ${c.comment ? quoteLiteral(c.comment) : 'NULL'};`);
    }
  }
  for (const c of current.columns) {
    if (!desiredCols.has(c.name)) alter(`DROP COLUMN ${quoteIdent(c.name)}`);
  }

  if (current.primaryKey.join(',') !== desired.primaryKey.join(',')) {
    if (current.primaryKey.length > 0 && current.primaryKeyName) {
      alter(`DROP CONSTRAINT ${quoteIdent(current.primaryKeyName)}`);
    }
    if (desired.primaryKey.length > 0) {
      const pkName = desired.primaryKeyName ? `CONSTRAINT ${quoteIdent(desired.primaryKeyName)} ` : '';
      alter(`ADD ${pkName}PRIMARY KEY (${desired.primaryKey.map(quoteIdent).join(', ')})`);
    }
  }

  const currentChecks = new Map(current.checks.map((c) => [c.name, c]));
  for (const chk of desired.checks) {
    const before = currentChecks.get(chk.name);
    if (before && before.expression.replace(/\s+/g, '') === chk.expression.replace(/\s+/g, '')) continue;
    if (before) alter(`DROP CONSTRAINT ${quoteIdent(chk.name)}`);
    alter(`ADD ${renderCheck(chk)}`);
  }
  const desiredCheckNames = new Set(desired.checks.map((c) => c.name));
  for (const chk of current.checks) {
    if (!desiredCheckNames.has(chk.name)) alter(`DROP CONSTRAINT ${quoteIdent(chk.name)}`);
  }

  const currentFks = new Map(current.foreignKeys.map((f) => [f.name, f]));
  for (const fk of desired.foreignKeys) {
    const before = currentFks.get(fk.name);
    if (before && sameFk(before, fk)) continue;
    if (before) alter(`DROP CONSTRAINT ${quoteIdent(fk.name)}`);
    alter(`ADD ${renderForeignKey(fk)}`);
  }
  const desiredFkNames = new Set(desired.foreignKeys.map((f) => f.name));
  for (const fk of current.foreignKeys) {
    if (!desiredFkNames.has(fk.name)) alter(`DROP CONSTRAINT ${quoteIdent(fk.name)}`);
  }

  const currentIdx = new Map(current.indexes.filter((i) => !i.primary).map((i) => [i.name, i]));
  const desiredIdx = new Map(desired.indexes.filter((i) => !i.primary).map((i) => [i.name, i]));
  const renamed = { ...desired, schema, name };
  for (const [idxName, idx] of desiredIdx) {
    const before = currentIdx.get(idxName);
    if (before && sameIndex(before, idx)) continue;
    if (before) out.push(`DROP INDEX ${qualify(schema, idxName)};`);
    out.push(renderCreateIndex(renamed, idx));
  }
  for (const idxName of currentIdx.keys()) {
    if (!desiredIdx.has(idxName)) out.push(`DROP INDEX ${qualify(schema, idxName)};`);
  }

  if ((current.comment ?? '') !== (desired.comment ?? '')) {
    out.push(`COMMENT ON TABLE ${target} IS ${desired.comment ? quoteLiteral(desired.comment) : 'NULL'};`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Changesets
// ---------------------------------------------------------------------------

export interface PgChangeStatement {
  /** Parameterized form — this is what actually executes. */
  text: string;
  params: unknown[];
  /** Literals inlined, for the preview pane (never executed). */
  display: string;
  /** Rows this statement must touch; a mismatch aborts the apply (§6). */
  expected: number;
}

interface WhereBuild {
  clause: string;
  displayClause: string;
  params: unknown[];
}

function buildKeyWhere(key: RowKey, keyColumns: string[], start: number): WhereBuild {
  const terms: string[] = [];
  const displayTerms: string[] = [];
  const params: unknown[] = [];
  let n = start;
  const columns = keyColumns.length > 0 ? keyColumns : Object.keys(key);
  for (const col of columns) {
    const value = key[col];
    const ident = quoteIdent(col);
    if (value === null || value === undefined) {
      // `= NULL` never matches; a NULL key member has to become IS NULL.
      terms.push(`${ident} IS NULL`);
      displayTerms.push(`${ident} IS NULL`);
      continue;
    }
    terms.push(`${ident} = $${n++}`);
    displayTerms.push(`${ident} = ${cellToSqlLiteral(value)}`);
    params.push(cellToPgParam(value));
  }
  return { clause: terms.join(' AND '), displayClause: displayTerms.join(' AND '), params };
}

/**
 * Renders a changeset into ordered statements. Both forms are produced in one
 * pass so "Preview" and "Apply" can never drift apart.
 */
export function buildPgChangeStatements(cs: Changeset): {
  statements: PgChangeStatement[];
  warnings: string[];
} {
  const target = qualify(cs.schema, cs.table);
  const statements: PgChangeStatement[] = [];
  const warnings: string[] = [];

  if (cs.keyColumns.length === 0) {
    warnings.push(
      'This result has no primary key or non-nullable unique index, so updates and deletes cannot be targeted safely.',
    );
  }

  for (const change of cs.changes) {
    if (change.op === 'insert') {
      const entries = Object.entries(change.values) as [string, Cell][];
      if (entries.length === 0) {
        statements.push({
          text: `INSERT INTO ${target} DEFAULT VALUES`,
          params: [],
          display: `INSERT INTO ${target} DEFAULT VALUES;`,
          expected: 1,
        });
        continue;
      }
      const cols = entries.map(([c]) => quoteIdent(c)).join(', ');
      const holes = entries.map((_, i) => `$${i + 1}`).join(', ');
      const literals = entries.map(([, v]) => cellToSqlLiteral(v)).join(', ');
      statements.push({
        text: `INSERT INTO ${target} (${cols}) VALUES (${holes})`,
        params: entries.map(([, v]) => cellToPgParam(v)),
        display: `INSERT INTO ${target} (${cols}) VALUES (${literals});`,
        expected: 1,
      });
      continue;
    }

    if (change.op === 'update') {
      const entries = Object.entries(change.values) as [string, Cell][];
      if (entries.length === 0) {
        warnings.push(`Skipped an update with no changed columns on ${cs.table}.`);
        continue;
      }
      const sets = entries.map(([c], i) => `${quoteIdent(c)} = $${i + 1}`).join(', ');
      const setDisplay = entries.map(([c, v]) => `${quoteIdent(c)} = ${cellToSqlLiteral(v)}`).join(', ');
      const where = buildKeyWhere(change.key, cs.keyColumns, entries.length + 1);
      if (!where.clause) {
        warnings.push(`Skipped an update on ${cs.table}: the row key is empty.`);
        continue;
      }
      statements.push({
        text: `UPDATE ${target} SET ${sets} WHERE ${where.clause}`,
        params: [...entries.map(([, v]) => cellToPgParam(v)), ...where.params],
        display: `UPDATE ${target} SET ${setDisplay} WHERE ${where.displayClause};`,
        expected: 1,
      });
      continue;
    }

    const where = buildKeyWhere(change.key, cs.keyColumns, 1);
    if (!where.clause) {
      warnings.push(`Skipped a delete on ${cs.table}: the row key is empty.`);
      continue;
    }
    statements.push({
      text: `DELETE FROM ${target} WHERE ${where.clause}`,
      params: where.params,
      display: `DELETE FROM ${target} WHERE ${where.displayClause};`,
      expected: 1,
    });
  }

  return { statements, warnings };
}
