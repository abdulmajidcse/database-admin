/**
 * Changeset → SQL (PLAN §6 "Grid editing").
 *
 * The grid accumulates edits into a `Changeset`; "Preview" renders the exact
 * SQL; "Apply" runs it in one transaction with an affected-rows sanity check.
 * This module is the single place where that translation happens for every SQL
 * engine, so the three connectors cannot drift apart on the parts that must be
 * identical — NULL key handling, parameterization and the expected-row counts.
 *
 * ---------------------------------------------------------------------------
 * THE AFFECTED-ROWS CONTRACT — read this before writing an apply path
 * ---------------------------------------------------------------------------
 * Every UPDATE and DELETE produced here is built from a row key that is
 * supposed to identify EXACTLY ONE row, so `expected` is always 1. That is a
 * promise about intent, not about reality: a stale key, a duplicated row in a
 * keyless table, or a key column that was edited by someone else between the
 * SELECT and the apply can all make the same WHERE clause match zero rows or a
 * hundred. Silently updating a hundred rows because the WHERE was weaker than
 * we thought is the worst possible outcome for a database client.
 *
 * Therefore each connector's `applyChangeset` MUST:
 *
 *   1. BEGIN a transaction on a *pinned* connection (never a pool checkout —
 *      §6 "Sessions vs pools").
 *   2. Execute `PreparedStatement.sql` with `PreparedStatement.params`, in the
 *      order returned here, one statement at a time.
 *   3. Compare the driver's affected/changed row count against
 *      `PreparedStatement.expected` IMMEDIATELY, inside the transaction.
 *   4. On any mismatch: ROLLBACK the whole transaction and surface
 *      `AffectedRowsMismatchError`. Do not continue, do not partially commit,
 *      do not "fix up" the count.
 *   5. COMMIT only when every statement matched.
 *
 * Engine notes for step 3, because the naive reading of each driver is wrong:
 *   - MySQL reports *changed* rows by default, so `UPDATE … SET x = x` returns
 *     0 and a correct apply would look like a mismatch. The pool must connect
 *     with `CLIENT_FOUND_ROWS` so `affectedRows` counts *matched* rows.
 *   - Postgres uses `result.rowCount`, which already counts matched rows.
 *   - SQLite uses `db.changes` / `RunResult.changes`, also matched-row based
 *     for UPDATE (a no-op SET still counts the row).
 *
 * `checkAffected()` below is that comparison; use it rather than re-deriving
 * the rule per connector.
 *
 * ---------------------------------------------------------------------------
 * Quoting and parameterization (PLAN §9)
 * ---------------------------------------------------------------------------
 * Identifiers WE build go through the injected `QuoteFns` — never string
 * concatenation. Values the user typed are bound as parameters; the inlined
 * `display` form exists only so the preview pane can show what will run, and is
 * never executed. Both forms are produced in a single pass so preview and apply
 * can never disagree.
 */

import { Buffer } from 'node:buffer';

import type { ChangePreview, Changeset, RowKey } from '../../../lib/results';
import type { ColumnModel, EngineKind } from '../../../lib/schema-model';
import type { Cell } from '../../../lib/wire';
import type { ParamStyle } from './filters';
import type { QuoteFns } from './quote';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One statement, in both the executable and the human-readable form. */
export interface PreparedStatement {
  op: 'insert' | 'update' | 'delete';
  /** Parameterized SQL. THIS is what runs. */
  sql: string;
  /** Bound values, in placeholder order. */
  params: unknown[];
  /** Literals inlined — preview pane only, never executed. */
  display: string;
  /** Rows this statement must touch; a mismatch aborts the apply (see header). */
  expected: number;
}

export interface ChangesetPlan {
  statements: PreparedStatement[];
  warnings: string[];
}

export interface ChangesetOptions {
  /**
   * Column metadata for the target table. Optional — without it the SQL is
   * identical, but the generated-column and truncation warnings cannot be
   * produced because nothing else knows the column shapes.
   */
  columns?: ColumnModel[];
  /** Placeholder style. Defaults to the engine's native one. */
  paramStyle?: ParamStyle;
}

/** A value that cannot be written back at all (e.g. an `unsupported` cell). */
export class UnwritableCellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnwritableCellError';
  }
}

/** Thrown by the apply path when a statement touched the wrong number of rows. */
export class AffectedRowsMismatchError extends Error {
  constructor(
    readonly statementIndex: number,
    readonly expected: number,
    readonly actual: number,
    readonly statement: string,
  ) {
    super(
      `Statement ${statementIndex + 1} affected ${actual} row(s) but exactly ${expected} was expected; ` +
        `the change was rolled back. The row may have been modified or deleted by someone else. ` +
        `SQL: ${statement}`,
    );
    this.name = 'AffectedRowsMismatchError';
  }
}

/** `?` for mysql2/better-sqlite3, `$n` for pg. */
export function paramStyleFor(engine: EngineKind): ParamStyle {
  return engine === 'postgres' ? 'dollar' : 'qmark';
}

/**
 * Step 3/4 of the apply contract. Call it right after each statement, still
 * inside the transaction; throwing here is what triggers the ROLLBACK.
 */
export function checkAffected(actual: number, statement: PreparedStatement, index: number): void {
  if (actual === statement.expected) return;
  throw new AffectedRowsMismatchError(index, statement.expected, actual, statement.display);
}

// ---------------------------------------------------------------------------
// Cell → SQL
// ---------------------------------------------------------------------------

/**
 * A decoded wire cell: the literal text for rendering, and the value to bind.
 *
 * The two are NOT interchangeable. `param` is what executes; `sql` exists for
 * the preview pane, generated DDL and dump files.
 */
export interface DecodedCell {
  /** SQL literal text for this value. */
  sql: string;
  /** Value to bind. Never a JS number for bigint/decimal — always the string. */
  param: unknown;
}

/**
 * A bare numeric literal is safe to inline only when the lossless text really
 * is a number; anything else (leading `+`, hex, `Infinity`, a locale comma) is
 * quoted so the engine's own input function decides what it means.
 */
const NUMERIC_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/** ANSI fallback used when no engine-specific quoter was supplied. */
function ansiLiteral(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

function literalText(
  value: string | number | boolean | null,
  quote: QuoteFns | undefined,
): string {
  if (value === null) return 'NULL';
  if (quote) return quote.literal(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  return ansiLiteral(value);
}

/**
 * `bytea` uses the hex input format, which contains a backslash and therefore
 * has to go through the literal quoter so the `standard_conforming_strings`
 * question is answered in exactly one place (see quote.ts). Every other engine
 * takes the ANSI `X'…'` blob literal.
 */
function bytesLiteral(bytes: Buffer, engine: EngineKind | undefined, quote?: QuoteFns): string {
  const hex = bytes.toString('hex');
  if (engine === 'postgres') return quote ? quote.literal(`\\x${hex}`) : `'\\x${hex}'`;
  return `X'${hex}'`;
}

/** Postgres array output syntax, for the preview only. */
function pgArrayText(items: unknown[]): string {
  const parts = items.map((item) => {
    if (item === null || item === undefined) return 'NULL';
    if (Array.isArray(item)) return pgArrayText(item);
    const text =
      typeof item === 'object' && item !== null && '$t' in (item as Record<string, unknown>)
        ? String((item as { v: string }).v)
        : String(item);
    return `"${text.split('\\').join('\\\\').split('"').join('\\"')}"`;
  });
  return `{${parts.join(',')}}`;
}

function decodeCell(cell: Cell, engine: EngineKind | undefined, quote?: QuoteFns): DecodedCell {
  // `typeof` rather than `=== undefined` because `Cell` has no undefined member;
  // the guard exists for values that reached us from untyped JSON.
  if (cell === null || typeof cell === 'undefined') return { sql: 'NULL', param: null };

  if (typeof cell === 'boolean') {
    // better-sqlite3 refuses to bind a JS boolean (it binds numbers, strings,
    // bigints, buffers and null only), so SQLite gets 1/0 — the same thing it
    // stores anyway, since it has no boolean type.
    return { sql: literalText(cell, quote), param: engine === 'sqlite' ? (cell ? 1 : 0) : cell };
  }

  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) {
      throw new UnwritableCellError(`${String(cell)} has no portable SQL representation`);
    }
    return { sql: String(cell), param: cell };
  }

  if (typeof cell === 'string') return { sql: literalText(cell, quote), param: cell };

  switch (cell.$t) {
    case 'unsupported':
      // The read path could not represent this value losslessly, so writing it
      // back would corrupt it. Refuse rather than guess (§6 type fidelity).
      throw new UnwritableCellError(
        `a value of type "${cell.of ?? 'unknown'}" was not decoded losslessly and cannot be written back`,
      );

    case 'bytes': {
      const buf = Buffer.from(cell.v, 'base64');
      // Buffer (a Uint8Array) is what pg, mysql2 and better-sqlite3 all accept.
      return { sql: bytesLiteral(buf, engine, quote), param: buf };
    }

    case 'bigint':
    case 'decimal':
    case 'decimal128': {
      // NEVER Number(cell.v): that is exactly the precision loss the wire
      // format exists to prevent (§6). The lossless string is bound as-is and
      // every engine applies the target column's type to it.
      const text = cell.v.trim();
      return { sql: NUMERIC_TEXT.test(text) ? text : literalText(cell.v, quote), param: cell.v };
    }

    case 'array': {
      // `v` is JSON text (see the connectors' array encoding). node-postgres
      // builds a correct `{…}` literal from a real JS array, including nesting
      // and embedded quotes; other engines have no array type, so the text form
      // is the only sensible parameter.
      if (engine === 'postgres') {
        let items: unknown[] | null = null;
        try {
          const parsed: unknown = JSON.parse(cell.v);
          if (Array.isArray(parsed)) items = parsed;
        } catch {
          items = null;
        }
        if (items) {
          return {
            sql: literalText(pgArrayText(items), quote),
            param: items.map((item) => decodeCell(item as Cell, engine, quote).param),
          };
        }
      }
      return { sql: literalText(cell.v, quote), param: cell.v };
    }

    default:
      // date / time / timestamp / timestamptz / interval / json / uuid / bit /
      // geo / objectid / regex / document: the lossless text is bound and the
      // engine coerces it using the target column's input function. An untyped
      // literal does the same thing in the rendered form, so no cast is needed
      // — and an explicit one would be wrong as often as it was right (jsonb vs
      // json, timestamptz vs timestamp).
      return { sql: literalText(cell.v, quote), param: cell.v };
  }
}

/**
 * Public entry point (PLAN §6). Pass the engine's quoter to get engine-exact
 * literal text; without it the literals are plain ANSI, which is enough for
 * logging but not for a preview pane.
 */
export function decodeCellForSql(cell: Cell, quote?: QuoteFns): DecodedCell {
  return decodeCell(cell, quote?.engine, quote);
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

class Placeholders {
  private n = 0;
  constructor(private readonly style: ParamStyle) {}
  next(): string {
    this.n += 1;
    return this.style === 'dollar' ? `$${this.n}` : '?';
  }
}

// ---------------------------------------------------------------------------
// Warnings (PLAN §6: the preview has to tell the user what will go wrong)
// ---------------------------------------------------------------------------

class Warnings {
  private readonly seen = new Set<string>();
  readonly list: string[] = [];
  /** Deduplicated: 200 edited rows must not produce 200 identical lines. */
  add(message: string): void {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.list.push(message);
  }
}

function textLengthOf(cell: Cell): number | null {
  if (typeof cell === 'string') return [...cell].length;
  if (typeof cell === 'object' && cell !== null && '$t' in cell) {
    if (cell.$t === 'bytes') return null;
    return [...cell.v].length;
  }
  return null;
}

/**
 * Values the engine will silently shorten or round. MySQL in non-strict mode
 * truncates without an error, Postgres errors, SQLite ignores declared lengths
 * entirely — so this is a warning, not a rejection, and it is skipped for
 * SQLite where the length carries no meaning (§6 "Dynamic typing").
 */
function truncationWarning(col: ColumnModel, cell: Cell, engine: EngineKind): string | null {
  if (cell === null || engine === 'sqlite') return null;
  const t = col.type;

  if (typeof cell === 'object' && cell.$t === 'bytes') {
    if (t.length && t.length > 0) {
      const size = Buffer.from(cell.v, 'base64').length;
      if (size > t.length) {
        return `Value for "${col.name}" is ${size} bytes but the column holds ${t.length}; it will be truncated or rejected.`;
      }
    }
    return null;
  }

  if ((t.base === 'string' || t.base === 'text') && t.length && t.length > 0) {
    const len = textLengthOf(cell);
    if (len !== null && len > t.length) {
      return `Value for "${col.name}" is ${len} characters but ${t.raw || t.base} holds ${t.length}; it will be truncated or rejected.`;
    }
  }

  if (t.base === 'decimal' && (t.precision ?? 0) > 0) {
    const text =
      typeof cell === 'number'
        ? String(cell)
        : typeof cell === 'string'
          ? cell
          : typeof cell === 'object' && '$t' in cell
            ? cell.v
            : null;
    if (text && NUMERIC_TEXT.test(text.trim())) {
      const [intPart = '', fracPart = ''] = text.trim().replace(/^-/, '').split('.');
      const scale = t.scale ?? 0;
      if (fracPart.length > scale) {
        return `Value for "${col.name}" has ${fracPart.length} decimal places but ${t.raw || 'the column'} keeps ${scale}; it will be rounded.`;
      }
      const digitsBefore = intPart.replace(/^0+(?=\d)/, '').length;
      if (digitsBefore > (t.precision ?? 0) - scale) {
        return `Value for "${col.name}" needs ${digitsBefore} digits before the decimal point but ${t.raw || 'the column'} allows ${(t.precision ?? 0) - scale}; it will be rejected.`;
      }
    }
  }

  return null;
}

/**
 * Filters the written columns: a generated column is computed by the engine and
 * every SQL engine rejects a write to one, so it is dropped from the statement
 * and reported instead of turning the whole apply into an error.
 */
function writableColumns(
  values: Record<string, Cell>,
  byName: Map<string, ColumnModel>,
  engine: EngineKind,
  warnings: Warnings,
): string[] {
  const out: string[] = [];
  for (const name of Object.keys(values)) {
    const col = byName.get(name);
    if (col?.generated) {
      warnings.add(
        `Column "${name}" is a ${col.generated} generated column; the engine computes it, so it was left out of the statement.`,
      );
      continue;
    }
    if (col) {
      const t = truncationWarning(col, values[name], engine);
      if (t) warnings.add(t);
    }
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// WHERE from the row key
// ---------------------------------------------------------------------------

interface KeyWhere {
  sql: string;
  display: string;
  params: unknown[];
}

/**
 * An UPDATE or DELETE with an empty WHERE rewrites the entire table. It cannot
 * happen while `keyColumns` is non-empty, which the caller checks — so this is
 * an assertion, and the one failure mode worth being paranoid about.
 */
function assertBounded(where: KeyWhere, op: string, table: string): void {
  if (where.sql === '') {
    throw new Error(`Refusing to build an unbounded ${op} on "${table}": the WHERE clause is empty`);
  }
}

/**
 * `col = ?` for values and `col IS NULL` for nulls — `= NULL` is UNKNOWN in
 * three-valued logic and matches nothing, which would turn an intended update
 * into a silent no-op (and then trip the affected-rows check). This is the
 * single most important detail in the file.
 */
function buildKeyWhere(
  key: RowKey,
  keyColumns: string[],
  engine: EngineKind,
  quote: QuoteFns,
  holes: Placeholders,
): KeyWhere {
  const terms: string[] = [];
  const displayTerms: string[] = [];
  const params: unknown[] = [];

  for (const col of keyColumns) {
    const ident = quote.ident(col);
    // A member the row never carried is treated as NULL here, which NARROWS the
    // clause; callers still refuse such a change outright (see planChangeset).
    const value: Cell = Object.prototype.hasOwnProperty.call(key, col) ? key[col] : null;
    if (value === null || typeof value === 'undefined') {
      terms.push(`${ident} IS NULL`);
      displayTerms.push(`${ident} IS NULL`);
      continue;
    }
    const decoded = decodeCell(value, engine, quote);
    terms.push(`${ident} = ${holes.next()}`);
    displayTerms.push(`${ident} = ${decoded.sql}`);
    params.push(decoded.param);
  }

  return { sql: terms.join(' AND '), display: displayTerms.join(' AND '), params };
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/**
 * Turn a changeset into ordered statements. Changes are emitted in the order
 * the grid recorded them: the user's own sequencing is the only one that
 * respects their intent (an insert followed by an update of the same row), and
 * the surrounding transaction makes the whole batch atomic anyway.
 */
export function planChangeset(
  cs: Changeset,
  engine: EngineKind,
  quote: QuoteFns,
  opts: ChangesetOptions = {},
): ChangesetPlan {
  const paramStyle = opts.paramStyle ?? paramStyleFor(engine);
  const target = quote.qualified([cs.schema, cs.table]);
  const byName = new Map((opts.columns ?? []).map((c) => [c.name, c]));
  const warnings = new Warnings();
  const statements: PreparedStatement[] = [];

  const needsKey = cs.changes.some((c) => c.op !== 'insert');
  if (needsKey && cs.keyColumns.length === 0) {
    // PLAN §6: "Require a detectable unique key (PK or unique index) —
    // otherwise the grid is read-only, and the UI says why." We still build the
    // statements from whatever the row carried, because the affected-rows check
    // makes a too-broad WHERE abort rather than corrupt data.
    warnings.add(
      `"${cs.table}" has no primary key or non-nullable unique index, so rows cannot be addressed reliably. ` +
        `Each change is matched on the values the grid loaded; if a statement matches more than one row the whole apply is rolled back.`,
    );
  }

  for (const change of cs.changes) {
    const holes = new Placeholders(paramStyle);

    try {
      if (change.op === 'insert') {
        const columns = writableColumns(change.values, byName, engine, warnings);
        if (columns.length === 0) {
          // "A row of nothing but defaults" has two spellings: Postgres and
          // SQLite accept DEFAULT VALUES, MySQL only accepts empty lists.
          const sql =
            engine === 'mysql' || engine === 'mariadb'
              ? `INSERT INTO ${target} () VALUES ()`
              : `INSERT INTO ${target} DEFAULT VALUES`;
          statements.push({ op: 'insert', sql, params: [], display: sql, expected: 1 });
          continue;
        }
        const decoded = columns.map((c) => decodeCell(change.values[c], engine, quote));
        const idents = columns.map((c) => quote.ident(c)).join(', ');
        const placeholders = decoded.map(() => holes.next()).join(', ');
        const literals = decoded.map((d) => d.sql).join(', ');
        statements.push({
          op: 'insert',
          sql: `INSERT INTO ${target} (${idents}) VALUES (${placeholders})`,
          params: decoded.map((d) => d.param),
          display: `INSERT INTO ${target} (${idents}) VALUES (${literals})`,
          expected: 1,
        });
        continue;
      }

      // Both UPDATE and DELETE address a row, so they share the key rules.
      const keyColumns = cs.keyColumns.length > 0 ? cs.keyColumns : Object.keys(change.key);
      const missing = keyColumns.filter((c) => !Object.prototype.hasOwnProperty.call(change.key, c));
      if (keyColumns.length === 0 || missing.length > 0) {
        // A missing key member would drop a term from the WHERE and widen it,
        // which is the direction that destroys data. Skip the change instead.
        warnings.add(
          keyColumns.length === 0
            ? `A ${change.op} was skipped: the row carried no key values at all.`
            : `A ${change.op} was skipped: the row key is missing ${missing.join(', ')}.`,
        );
        continue;
      }

      if (change.op === 'update') {
        const columns = writableColumns(change.values, byName, engine, warnings);
        // Nothing left to write (e.g. the only edited column was generated).
        if (columns.length === 0) continue;
        const decoded = columns.map((c) => decodeCell(change.values[c], engine, quote));
        const sets = columns.map((c) => `${quote.ident(c)} = ${holes.next()}`).join(', ');
        const setDisplay = columns.map((c, i) => `${quote.ident(c)} = ${decoded[i].sql}`).join(', ');
        // SET placeholders are numbered before the WHERE ones, which is why the
        // same `holes` counter is threaded through both.
        const where = buildKeyWhere(change.key, keyColumns, engine, quote, holes);
        assertBounded(where, 'UPDATE', cs.table);
        statements.push({
          op: 'update',
          sql: `UPDATE ${target} SET ${sets} WHERE ${where.sql}`,
          params: [...decoded.map((d) => d.param), ...where.params],
          display: `UPDATE ${target} SET ${setDisplay} WHERE ${where.display}`,
          expected: 1,
        });
        continue;
      }

      const where = buildKeyWhere(change.key, keyColumns, engine, quote, holes);
      assertBounded(where, 'DELETE', cs.table);
      statements.push({
        op: 'delete',
        sql: `DELETE FROM ${target} WHERE ${where.sql}`,
        params: where.params,
        display: `DELETE FROM ${target} WHERE ${where.display}`,
        expected: 1,
      });
    } catch (err) {
      if (!(err instanceof UnwritableCellError)) throw err;
      // One undecodable value must not take the other 199 edits down with it.
      warnings.add(`A ${change.op} on "${cs.table}" was skipped: ${err.message}`);
    }
  }

  return { statements, warnings: warnings.list };
}

/**
 * The preview the UI shows (PLAN §6 "'Preview' renders the exact SQL").
 *
 * `statements` carries the literal-inlined rendering, which is the form a human
 * can read and copy into a console; the parameterized form that actually
 * executes comes from `planChangeset()`. They are generated in one pass, so the
 * preview is never a different statement from the one that runs.
 */
export function buildChangesetSql(
  cs: Changeset,
  engine: EngineKind,
  quote: QuoteFns,
  opts: ChangesetOptions = {},
): ChangePreview {
  const plan = planChangeset(cs, engine, quote, opts);
  return {
    statements: plan.statements.map((s) => s.display),
    expectedAffected: plan.statements.map((s) => s.expected),
    warnings: plan.warnings,
  };
}
