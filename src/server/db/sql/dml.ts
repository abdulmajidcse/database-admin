/**
 * DML rendering (docs/roadmap.md M10).
 *
 * Two features need the same thing from opposite ends. The grid's "copy as
 * INSERT" has values but no schema; the object tree's "generate SQL" has a
 * schema but no values. Writing them separately would mean two literal
 * renderers, and the second one would be the one with the bigint bug — so both
 * live here and both go through `decodeCellForSql`, which is the same path the
 * changeset builder already uses (§6).
 *
 * Nothing here executes. Every function returns text, which is why templates
 * may safely contain placeholders the caller is expected to fill in.
 *
 * Server-side module with no React and no Next imports, so the grid and the
 * tree can both import it directly — the same arrangement `lexer.ts` and
 * `ddl-common.ts` already rely on (PLAN §11).
 */

import type { EngineKind, TableModel } from '../../../lib/schema-model';
import type { Cell, Row } from '../../../lib/wire';
import { decodeCellForSql } from './changeset';
import { quoteIdent, quoteQualified, quoterFor } from './quote';

/** Where a statement is aimed. `schema` is optional because SQLite has none. */
export interface DmlTarget {
  schema?: string;
  table: string;
}

/** Rows returned by a template SELECT, unless the caller overrides it. */
const DEFAULT_LIMIT = 100;

/**
 * A placeholder name is only usable if the lexer will scan it back as one
 * token. Column names are not constrained to that — "order date" and "from"
 * are both legal columns — so anything outside this set falls back to
 * positional `?`, which every engine accepts and which `findPlaceholders`
 * reads without ambiguity.
 */
const SAFE_PLACEHOLDER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function placeholderFor(column: string): string {
  return SAFE_PLACEHOLDER.test(column) ? `:${column}` : '?';
}

function qualify(target: DmlTarget, engine: EngineKind): string {
  return quoteQualified([target.schema, target.table], engine);
}

/** The same, for a canonical table — whose name field is `name`, not `table`. */
function qualifyTable(t: TableModel, engine: EngineKind): string {
  return quoteQualified([t.schema, t.name], engine);
}

/**
 * Columns a caller can supply a value for. Auto-increment and generated columns
 * are excluded: an INSERT naming a generated column is rejected outright by
 * Postgres and MySQL, so including it would produce a template that cannot run.
 */
function insertableColumns(t: TableModel): string[] {
  return t.columns.filter((c) => !c.autoIncrement && !c.generated).map((c) => c.name);
}

function requirePrimaryKey(t: TableModel, what: string): string[] {
  if (t.primaryKey.length === 0) {
    throw new Error(
      `Cannot generate ${what} for "${t.name}": it has no primary key, and an unkeyed ` +
        `${what} would match every row. Add a WHERE clause by hand.`,
    );
  }
  return t.primaryKey;
}

// ---------------------------------------------------------------------------
// Templates — schema in, placeholders out
// ---------------------------------------------------------------------------

export function renderSelectTemplate(
  t: TableModel,
  engine: EngineKind,
  opts: { limit?: number } = {},
): string {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // Naming every column rather than `*` keeps the statement stable when someone
  // adds a column later, and makes it a starting point you edit down.
  const cols = t.columns.map((c) => quoteIdent(c.name, engine)).join(', ');
  return `SELECT ${cols}\nFROM ${qualifyTable(t, engine)}\nLIMIT ${limit};`;
}

export function renderInsertTemplate(t: TableModel, engine: EngineKind): string {
  const cols = insertableColumns(t);
  if (cols.length === 0) {
    throw new Error(`Cannot generate INSERT for "${t.name}": every column is generated.`);
  }
  const names = cols.map((c) => quoteIdent(c, engine)).join(', ');
  const values = cols.map(placeholderFor).join(', ');
  return `INSERT INTO ${qualifyTable(t, engine)} (${names})\nVALUES (${values});`;
}

export function renderUpdateTemplate(t: TableModel, engine: EngineKind): string {
  const key = requirePrimaryKey(t, 'UPDATE');
  const sets = insertableColumns(t)
    .filter((c) => !key.includes(c))
    .map((c) => `${quoteIdent(c, engine)} = ${placeholderFor(c)}`);
  if (sets.length === 0) {
    throw new Error(`Cannot generate UPDATE for "${t.name}": every column is part of the key.`);
  }
  const where = key.map((c) => `${quoteIdent(c, engine)} = ${placeholderFor(c)}`).join(' AND ');
  return `UPDATE ${qualifyTable(t, engine)}\nSET ${sets.join(',\n    ')}\nWHERE ${where};`;
}

export function renderDeleteTemplate(t: TableModel, engine: EngineKind): string {
  const key = requirePrimaryKey(t, 'DELETE');
  const where = key.map((c) => `${quoteIdent(c, engine)} = ${placeholderFor(c)}`).join(' AND ');
  return `DELETE FROM ${qualifyTable(t, engine)}\nWHERE ${where};`;
}

// ---------------------------------------------------------------------------
// Rows — values in, literals out
// ---------------------------------------------------------------------------

function literal(cell: Cell, engine: EngineKind): string {
  // The same decoder the changeset builder uses, so a bigint copied out of the
  // grid is the digits the server sent and not the double they would round to.
  return decodeCellForSql(cell, quoterFor(engine)).sql;
}

function checkWidth(columns: string[], row: Row, index: number): void {
  if (row.length !== columns.length) {
    throw new Error(
      `Row ${index + 1} has ${row.length} values but there are ${columns.length} columns.`,
    );
  }
}

export function renderInsertRows(
  target: DmlTarget,
  columns: string[],
  rows: readonly Row[],
  engine: EngineKind,
): string {
  if (rows.length === 0) throw new Error('Cannot render an INSERT with no rows.');
  if (columns.length === 0) throw new Error('Cannot render an INSERT with no columns.');

  const names = columns.map((c) => quoteIdent(c, engine)).join(', ');
  const tuples = rows.map((row, i) => {
    checkWidth(columns, row, i);
    return `  (${row.map((cell) => literal(cell, engine)).join(', ')})`;
  });
  // One statement carrying every row: pasting 500 separate INSERTs into a
  // console is 500 round trips, and only the multi-row form is one transaction
  // by default.
  return `INSERT INTO ${qualify(target, engine)} (${names}) VALUES\n${tuples.join(',\n')};`;
}

export function renderUpdateRow(
  target: DmlTarget,
  columns: string[],
  row: Row,
  keyColumns: string[],
  engine: EngineKind,
): string {
  if (keyColumns.length === 0) {
    throw new Error('Cannot render an UPDATE with no key columns: it would match every row.');
  }
  checkWidth(columns, row, 0);

  const valueOf = (column: string): Cell => {
    const at = columns.indexOf(column);
    if (at === -1) throw new Error(`Key column "${column}" is not among the copied columns.`);
    return row[at];
  };

  const sets = columns
    .filter((c) => !keyColumns.includes(c))
    .map((c) => `${quoteIdent(c, engine)} = ${literal(valueOf(c), engine)}`);
  if (sets.length === 0) {
    throw new Error('Cannot render an UPDATE: every copied column is part of the key.');
  }

  const where = keyColumns
    .map((c) => {
      const cell = valueOf(c);
      // `= NULL` is never true. A key that is NULL has to be matched with IS
      // NULL or the statement silently updates nothing (§6).
      return cell === null
        ? `${quoteIdent(c, engine)} IS NULL`
        : `${quoteIdent(c, engine)} = ${literal(cell, engine)}`;
    })
    .join(' AND ');

  return `UPDATE ${qualify(target, engine)}\nSET ${sets.join(',\n    ')}\nWHERE ${where};`;
}
