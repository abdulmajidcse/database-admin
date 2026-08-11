/**
 * MySQL / MariaDB DDL and changeset SQL (PLAN §6 "Grid editing", §9).
 *
 * Two jobs:
 *   1. Turn a desired `TableModel` into migration DDL (create or alter).
 *   2. Turn a `Changeset` into parameterized statements plus the exact SQL text
 *      the preview pane shows.
 *
 * Rule from PLAN §9: identifiers WE build always go through the per-engine
 * quoting function — never string concatenation — and every value the user did
 * not type is bound, not interpolated. The preview renders literals only so the
 * user can read what will run; the apply path uses the parameters.
 */

import type { Changeset, ChangePreview } from '../../../../lib/results';
import type {
  CheckModel,
  ColumnModel,
  ForeignKeyModel,
  IndexModel,
  TableModel,
  TypeDescriptor,
} from '../../../../lib/schema-model';
import type { Cell } from '../../../../lib/wire';
import { cellToParam } from './types';
import type { FlavorInfo } from './types';
import type { QuoteFns } from '../../sql/quote';

export interface PreparedStatement {
  sql: string;
  params: unknown[];
  /** Rows this statement must touch; a mismatch aborts the apply (PLAN §6). */
  expected: number;
}

export function qualify(q: QuoteFns, schema: string | undefined, name: string): string {
  return q.qualified([schema, name]);
}

// ---------------------------------------------------------------------------
// Literal rendering (preview only)
// ---------------------------------------------------------------------------

export function renderLiteral(q: QuoteFns, value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) {
    let hex = '';
    for (const b of value) hex += b.toString(16).padStart(2, '0');
    return `X'${hex}'`;
  }
  return q.literal(String(value));
}

/** Substitutes `?` placeholders for the preview pane. Never used to execute. */
export function renderWithParams(q: QuoteFns, sql: string, params: unknown[]): string {
  let i = 0;
  let out = '';
  let inString: string | null = null;
  for (let p = 0; p < sql.length; p++) {
    const ch = sql[p];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        p++;
        if (p < sql.length) out += sql[p];
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === '?') {
      out += renderLiteral(q, params[i++]);
      continue;
    }
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Type / column rendering
// ---------------------------------------------------------------------------

/**
 * `raw` is information_schema's COLUMN_TYPE, which is already exactly the DDL
 * spelling (`int unsigned`, `enum('a','b')`, `decimal(10,2)`), so prefer it and
 * only synthesize a type when the model was built by hand (the DDL editor).
 */
export function renderTypeSql(q: QuoteFns, type: TypeDescriptor): string {
  if (type.raw && type.raw.trim() !== '') return type.raw;
  switch (type.base) {
    case 'boolean':
      return 'tinyint(1)';
    case 'integer':
      return `int${type.unsigned ? ' unsigned' : ''}`;
    case 'bigint':
      return `bigint${type.unsigned ? ' unsigned' : ''}`;
    case 'decimal':
      return `decimal(${type.precision ?? 10},${type.scale ?? 0})${type.unsigned ? ' unsigned' : ''}`;
    case 'float':
      return 'double';
    case 'string':
      return `varchar(${type.length ?? 255})`;
    case 'text':
      return 'text';
    case 'binary':
      return type.length ? `varbinary(${type.length})` : 'blob';
    case 'date':
      return 'date';
    case 'time':
      return type.precision ? `time(${type.precision})` : 'time';
    case 'timestamp':
      return type.withTimezone
        ? `timestamp${type.precision ? `(${type.precision})` : ''}`
        : `datetime${type.precision ? `(${type.precision})` : ''}`;
    case 'json':
      return 'json';
    case 'uuid':
      return 'char(36)';
    case 'enum':
      return `enum(${(type.values ?? []).map((v) => q.literal(v)).join(',')})`;
    case 'set':
      return `set(${(type.values ?? []).map((v) => q.literal(v)).join(',')})`;
    case 'bit':
      return `bit(${type.length ?? 1})`;
    case 'geometry':
      return 'geometry';
    default:
      return 'text';
  }
}

/**
 * COLUMN_DEFAULT is reported unquoted for literals and as an expression for
 * `DEFAULT (expr)` / CURRENT_TIMESTAMP, with nothing to tell them apart. Treat
 * numbers, NULL, function calls and parenthesized expressions as expressions and
 * quote everything else — the same heuristic every MySQL tool uses.
 */
export function renderDefault(q: QuoteFns, column: ColumnModel): string | null {
  const d = column.defaultValue;
  if (d === null || d === undefined) return null;
  const trimmed = d.trim();
  if (trimmed === '') return `DEFAULT ${q.literal('')}`;
  // A parenthesized default is always an expression, whatever the column type.
  if (trimmed.startsWith('(')) return `DEFAULT ${trimmed}`;
  const looksLikeExpression =
    /^-?\d+(\.\d+)?$/.test(trimmed) ||
    /^(NULL|TRUE|FALSE)$/i.test(trimmed) ||
    /^CURRENT_TIMESTAMP(\(\d*\))?$/i.test(trimmed) ||
    /^(CURRENT_DATE|CURRENT_TIME|NOW\(\)|UUID\(\))$/i.test(trimmed);
  const base = column.type.base;
  const textual = base === 'string' || base === 'text' || base === 'enum' || base === 'set';
  if (looksLikeExpression && !textual) return `DEFAULT ${trimmed}`;
  return `DEFAULT ${q.literal(trimmed)}`;
}

export function renderColumnDefinition(q: QuoteFns, column: ColumnModel): string {
  const parts: string[] = [q.ident(column.name), renderTypeSql(q, column.type)];
  if (column.charset) parts.push(`CHARACTER SET ${column.charset}`);
  if (column.collation) parts.push(`COLLATE ${column.collation}`);

  if (column.generated) {
    parts.push(`GENERATED ALWAYS AS (${column.generatedExpression ?? 'NULL'})`);
    parts.push(column.generated === 'stored' ? 'STORED' : 'VIRTUAL');
    if (!column.nullable) parts.push('NOT NULL');
  } else {
    parts.push(column.nullable ? 'NULL' : 'NOT NULL');
    const def = renderDefault(q, column);
    if (def) parts.push(def);
    if (column.autoIncrement) parts.push('AUTO_INCREMENT');
  }
  if (column.comment) parts.push(`COMMENT ${q.literal(column.comment)}`);
  return parts.join(' ');
}

function renderIndexColumns(q: QuoteFns, index: IndexModel): string {
  return index.columns
    .filter((c) => c.expression || c.name)
    .map((c) => {
      // A functional index part has an expression instead of a column name.
      if (c.expression) return `(${c.expression})`;
      const name = q.ident(c.name as string);
      const prefix = c.length ? `(${c.length})` : '';
      const order = c.order === 'desc' ? ' DESC' : '';
      return `${name}${prefix}${order}`;
    })
    .join(', ');
}

function indexKindPrefix(index: IndexModel): string {
  const method = (index.method ?? '').toUpperCase();
  if (method === 'FULLTEXT') return 'FULLTEXT ';
  if (method === 'SPATIAL') return 'SPATIAL ';
  return index.unique ? 'UNIQUE ' : '';
}

function indexUsing(index: IndexModel): string {
  const method = (index.method ?? '').toUpperCase();
  // BTREE is the default; FULLTEXT/SPATIAL are expressed by the prefix instead.
  return method === 'HASH' ? ' USING HASH' : '';
}

export function renderIndexDefinition(q: QuoteFns, index: IndexModel): string {
  if (index.primary) return `PRIMARY KEY (${renderIndexColumns(q, index)})`;
  const comment = index.comment ? ` COMMENT ${q.literal(index.comment)}` : '';
  return `${indexKindPrefix(index)}KEY ${q.ident(index.name)} (${renderIndexColumns(q, index)})${indexUsing(index)}${comment}`;
}

export function renderForeignKeyDefinition(q: QuoteFns, fk: ForeignKeyModel): string {
  const cols = fk.columns.map((c) => q.ident(c)).join(', ');
  const refCols = fk.refColumns.map((c) => q.ident(c)).join(', ');
  const ref = qualify(q, fk.refSchema, fk.refTable);
  const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete.toUpperCase()}` : '';
  const onUpdate = fk.onUpdate ? ` ON UPDATE ${fk.onUpdate.toUpperCase()}` : '';
  return `CONSTRAINT ${q.ident(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${ref} (${refCols})${onDelete}${onUpdate}`;
}

export function renderCheckDefinition(q: QuoteFns, check: CheckModel): string {
  return `CONSTRAINT ${q.ident(check.name)} CHECK (${check.expression})`;
}

export function renderCreateTable(q: QuoteFns, table: TableModel): string {
  const body: string[] = [];
  for (const c of [...table.columns].sort((a, b) => a.position - b.position)) {
    body.push(`  ${renderColumnDefinition(q, c)}`);
  }
  const pk = table.indexes.find((i) => i.primary);
  if (pk) body.push(`  ${renderIndexDefinition(q, pk)}`);
  else if (table.primaryKey.length > 0) {
    body.push(`  PRIMARY KEY (${table.primaryKey.map((c) => q.ident(c)).join(', ')})`);
  }
  for (const idx of table.indexes) {
    if (idx.primary) continue;
    body.push(`  ${renderIndexDefinition(q, idx)}`);
  }
  for (const fk of table.foreignKeys) body.push(`  ${renderForeignKeyDefinition(q, fk)}`);
  for (const ck of table.checks) body.push(`  ${renderCheckDefinition(q, ck)}`);

  const options: string[] = [];
  if (table.engine) options.push(`ENGINE=${table.engine}`);
  if (table.collation) options.push(`COLLATE=${table.collation}`);
  if (table.comment) options.push(`COMMENT=${q.literal(table.comment)}`);

  return (
    `CREATE TABLE ${qualify(q, table.schema, table.name)} (\n${body.join(',\n')}\n)` +
    (options.length ? ` ${options.join(' ')}` : '')
  );
}

// ---------------------------------------------------------------------------
// current → desired migration (PLAN §6: the DDL editor shows this before running)
// ---------------------------------------------------------------------------

function sameType(a: ColumnModel, b: ColumnModel): boolean {
  return (
    a.type.raw.toLowerCase() === b.type.raw.toLowerCase() &&
    a.nullable === b.nullable &&
    (a.defaultValue ?? null) === (b.defaultValue ?? null) &&
    !!a.autoIncrement === !!b.autoIncrement &&
    (a.comment ?? '') === (b.comment ?? '') &&
    (a.collation ?? '') === (b.collation ?? '') &&
    (a.generated ?? '') === (b.generated ?? '') &&
    (a.generatedExpression ?? '') === (b.generatedExpression ?? '')
  );
}

function indexSignature(q: QuoteFns, index: IndexModel): string {
  return `${index.unique}|${index.primary}|${(index.method ?? '').toUpperCase()}|${renderIndexColumns(q, index)}`;
}

function fkSignature(q: QuoteFns, fk: ForeignKeyModel): string {
  return renderForeignKeyDefinition(q, fk).replace(/^CONSTRAINT\s+\S+\s+/, '');
}

export function planMysqlTableDdl(
  q: QuoteFns,
  flavor: FlavorInfo,
  current: TableModel | null,
  desired: TableModel,
): string[] {
  if (!current) return [renderCreateTable(q, desired)];

  const statements: string[] = [];
  const table = qualify(q, current.schema ?? desired.schema, current.name);

  const currentColumns = new Map(current.columns.map((c) => [c.name, c]));
  const desiredColumns = new Map(desired.columns.map((c) => [c.name, c]));

  // Columns are matched by name only: a rename is indistinguishable from a
  // drop + add without stable ids, and guessing would silently destroy data.
  const ordered = [...desired.columns].sort((a, b) => a.position - b.position);
  for (let i = 0; i < ordered.length; i++) {
    const col = ordered[i];
    const before = currentColumns.get(col.name);
    if (!before) {
      const prev = i === 0 ? null : ordered[i - 1];
      const position = prev ? ` AFTER ${q.ident(prev.name)}` : ' FIRST';
      statements.push(`ALTER TABLE ${table} ADD COLUMN ${renderColumnDefinition(q, col)}${position}`);
    } else if (!sameType(before, col)) {
      statements.push(`ALTER TABLE ${table} MODIFY COLUMN ${renderColumnDefinition(q, col)}`);
    }
  }
  for (const col of current.columns) {
    if (!desiredColumns.has(col.name)) {
      statements.push(`ALTER TABLE ${table} DROP COLUMN ${q.ident(col.name)}`);
    }
  }

  const currentPk = current.primaryKey.join(',');
  const desiredPk = desired.primaryKey.join(',');
  if (currentPk !== desiredPk) {
    if (currentPk) statements.push(`ALTER TABLE ${table} DROP PRIMARY KEY`);
    if (desiredPk) {
      statements.push(
        `ALTER TABLE ${table} ADD PRIMARY KEY (${desired.primaryKey.map((c) => q.ident(c)).join(', ')})`,
      );
    }
  }

  const currentIndexes = new Map(current.indexes.filter((i) => !i.primary).map((i) => [i.name, i]));
  const desiredIndexes = new Map(desired.indexes.filter((i) => !i.primary).map((i) => [i.name, i]));
  for (const [name, idx] of currentIndexes) {
    const next = desiredIndexes.get(name);
    if (!next || indexSignature(q, next) !== indexSignature(q, idx)) {
      statements.push(`ALTER TABLE ${table} DROP INDEX ${q.ident(name)}`);
    }
  }
  for (const [name, idx] of desiredIndexes) {
    const before = currentIndexes.get(name);
    if (!before || indexSignature(q, before) !== indexSignature(q, idx)) {
      statements.push(`ALTER TABLE ${table} ADD ${renderIndexDefinition(q, idx)}`);
    }
  }

  const currentFks = new Map(current.foreignKeys.map((f) => [f.name, f]));
  const desiredFks = new Map(desired.foreignKeys.map((f) => [f.name, f]));
  for (const [name, fk] of currentFks) {
    const next = desiredFks.get(name);
    if (!next || fkSignature(q, next) !== fkSignature(q, fk)) {
      statements.push(`ALTER TABLE ${table} DROP FOREIGN KEY ${q.ident(name)}`);
    }
  }
  for (const [name, fk] of desiredFks) {
    const before = currentFks.get(name);
    if (!before || fkSignature(q, before) !== fkSignature(q, fk)) {
      statements.push(`ALTER TABLE ${table} ADD ${renderForeignKeyDefinition(q, fk)}`);
    }
  }

  const currentChecks = new Map(current.checks.map((c) => [c.name, c]));
  const desiredChecks = new Map(desired.checks.map((c) => [c.name, c]));
  // MySQL 8 spells it DROP CHECK; MariaDB spells it DROP CONSTRAINT.
  const dropCheck = flavor.flavor === 'mariadb' ? 'DROP CONSTRAINT' : 'DROP CHECK';
  for (const [name, ck] of currentChecks) {
    const next = desiredChecks.get(name);
    if (!next || next.expression !== ck.expression) {
      statements.push(`ALTER TABLE ${table} ${dropCheck} ${q.ident(name)}`);
    }
  }
  for (const [name, ck] of desiredChecks) {
    const before = currentChecks.get(name);
    if (!before || before.expression !== ck.expression) {
      statements.push(`ALTER TABLE ${table} ADD ${renderCheckDefinition(q, ck)}`);
    }
  }

  if (desired.engine && desired.engine !== current.engine) {
    statements.push(`ALTER TABLE ${table} ENGINE=${desired.engine}`);
  }
  if (desired.collation && desired.collation !== current.collation) {
    statements.push(`ALTER TABLE ${table} COLLATE=${desired.collation}`);
  }
  if ((desired.comment ?? '') !== (current.comment ?? '')) {
    statements.push(`ALTER TABLE ${table} COMMENT=${q.literal(desired.comment ?? '')}`);
  }
  if (desired.name !== current.name) {
    statements.push(`ALTER TABLE ${table} RENAME TO ${qualify(q, desired.schema, desired.name)}`);
  }

  return statements;
}

// ---------------------------------------------------------------------------
// Changesets (PLAN §6 "Grid editing")
// ---------------------------------------------------------------------------

/** `col = ?` for values, `col IS NULL` for nulls — `= NULL` never matches. */
function whereForKey(q: QuoteFns, key: Record<string, Cell>, keyColumns: string[]): {
  sql: string;
  params: unknown[];
} {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const col of keyColumns) {
    const value = key[col];
    if (value === null || value === undefined) {
      parts.push(`${q.ident(col)} IS NULL`);
      continue;
    }
    parts.push(`${q.ident(col)} = ?`);
    params.push(cellToParam(value));
  }
  return { sql: parts.join(' AND '), params };
}

export function buildChangesetStatements(q: QuoteFns, cs: Changeset): PreparedStatement[] {
  const target = qualify(q, cs.schema, cs.table);
  const out: PreparedStatement[] = [];

  for (const change of cs.changes) {
    switch (change.op) {
      case 'insert': {
        const columns = Object.keys(change.values);
        if (columns.length === 0) {
          out.push({ sql: `INSERT INTO ${target} () VALUES ()`, params: [], expected: 1 });
          break;
        }
        const cols = columns.map((c) => q.ident(c)).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        out.push({
          sql: `INSERT INTO ${target} (${cols}) VALUES (${placeholders})`,
          params: columns.map((c) => cellToParam(change.values[c])),
          expected: 1,
        });
        break;
      }
      case 'update': {
        const columns = Object.keys(change.values);
        if (columns.length === 0) break;
        const sets = columns.map((c) => `${q.ident(c)} = ?`).join(', ');
        const where = whereForKey(q, change.key, cs.keyColumns);
        out.push({
          sql: `UPDATE ${target} SET ${sets} WHERE ${where.sql}`,
          params: [...columns.map((c) => cellToParam(change.values[c])), ...where.params],
          // The pool sets CLIENT_FOUND_ROWS, so affectedRows counts *matched*
          // rows — a no-op edit still reports 1 and the check stays meaningful.
          expected: 1,
        });
        break;
      }
      case 'delete': {
        const where = whereForKey(q, change.key, cs.keyColumns);
        out.push({
          sql: `DELETE FROM ${target} WHERE ${where.sql}`,
          params: where.params,
          expected: 1,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Drops changes we cannot address safely and explains why. Preview and apply
 * both run this so the SQL shown is exactly the SQL executed (PLAN §6).
 */
export function selectApplicableChanges(cs: Changeset): { changeset: Changeset; warnings: string[] } {
  const warnings: string[] = [];
  const keep: Changeset['changes'] = [];

  const needsKey = cs.changes.some((c) => c.op !== 'insert');
  if (needsKey && cs.keyColumns.length === 0) {
    warnings.push(
      'This result has no primary or unique key, so rows cannot be addressed safely. Edits are refused.',
    );
    return { changeset: { ...cs, changes: [] }, warnings };
  }

  for (const change of cs.changes) {
    if (change.op === 'insert') {
      if (Object.keys(change.values).length === 0) {
        warnings.push('An empty inserted row was skipped.');
        continue;
      }
      keep.push(change);
      continue;
    }
    const missing = cs.keyColumns.filter((c) => !(c in change.key));
    if (missing.length > 0) {
      warnings.push(`Row key is missing ${missing.join(', ')}; that change was skipped.`);
      continue;
    }
    if (change.op === 'update' && Object.keys(change.values).length === 0) continue;
    keep.push(change);
  }

  return { changeset: { ...cs, changes: keep }, warnings };
}

export function previewChangesetSql(q: QuoteFns, cs: Changeset): ChangePreview {
  const { changeset, warnings } = selectApplicableChanges(cs);
  const prepared = buildChangesetStatements(q, changeset);
  return {
    statements: prepared.map((p) => renderWithParams(q, p.sql, p.params)),
    expectedAffected: prepared.map((p) => p.expected),
    warnings,
  };
}
