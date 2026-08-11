/**
 * Per-engine identifier and literal quoting (PLAN §9).
 *
 * "Identifiers built by *us* (DDL, changesets) go through a per-engine quoting
 * function, never string concatenation." This module is that function. Nothing
 * else in the codebase may assemble an identifier by hand — DDL generation, the
 * changeset writer, table reads, exports and the differ all come through here,
 * which is why it is tiny, dependency-free and heavily tested.
 *
 * Values the *user* did not type are parameterized instead; `quoteLiteral`
 * exists for the places where a parameter is impossible (rendered DDL, dump
 * files, the "preview the exact SQL" pane) and for nothing else.
 */

import type { EngineKind } from '../../../lib/schema-model';

/** What `quoteLiteral` accepts. Binary and structured values use parameters. */
export type LiteralValue = string | number | bigint | boolean | null | undefined;

/** The three functions bundled for a single engine, for injection into connectors. */
export interface QuoteFns {
  readonly engine: EngineKind;
  /** `users` -> `` `users` `` (MySQL) or `"users"` (Postgres/SQLite). */
  ident(name: string): string;
  /** A SQL literal, quotes included. `null`/`undefined` become `NULL`. */
  literal(value: LiteralValue): string;
  /** `['public','users']` -> `"public"."users"`; empty parts are dropped. */
  qualified(parts: (string | null | undefined)[]): string;
}

type QuoteStyle = 'backtick' | 'double';

function styleFor(engine: EngineKind): QuoteStyle {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return 'backtick';
    case 'postgres':
    case 'sqlite':
      return 'double';
    default:
      // Redis and Mongo have no SQL identifier syntax; reaching here is a bug
      // in the caller, not a case to paper over with a guessed quote character.
      throw new Error(`quoteIdent: engine "${engine}" has no SQL identifier syntax`);
  }
}

/**
 * Quote an identifier. Escaping is by doubling the quote character in every
 * supported engine — MySQL doubles backticks, Postgres and SQLite double
 * double-quotes — which is also why a backslash needs no special handling here.
 */
export function quoteIdent(name: string, engine: EngineKind): string {
  const style = styleFor(engine);
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('quoteIdent: identifier must be a non-empty string');
  }
  if (name.includes('\u0000')) {
    throw new Error('quoteIdent: identifiers cannot contain NUL bytes');
  }
  const q = style === 'backtick' ? '`' : '"';
  return q + name.split(q).join(q + q) + q;
}

/**
 * Quote a literal for embedding in generated SQL.
 *
 * MySQL treats `\` as an escape inside string literals by default, so it must
 * be doubled. Postgres with standard_conforming_strings=on does not — but a
 * server with it off would, so a value containing a backslash is emitted as an
 * `E'…'` escape string with doubled backslashes, which is unambiguous under
 * either setting (this mirrors node-postgres' own `escapeLiteral`).
 */
export function quoteLiteral(value: LiteralValue, engine: EngineKind): string {
  if (value === null || value === undefined) return 'NULL';

  if (typeof value === 'boolean') {
    // SQLite has no boolean type; 1/0 is what it stores and compares against.
    if (engine === 'sqlite') return value ? '1' : '0';
    return value ? 'TRUE' : 'FALSE';
  }

  if (typeof value === 'bigint') return value.toString();

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`quoteLiteral: ${String(value)} has no portable SQL literal`);
    }
    return String(value);
  }

  if (typeof value !== 'string') {
    throw new Error('quoteLiteral: expected a string, number, bigint, boolean or null');
  }

  if (value.includes('\u0000')) {
    // No engine accepts an embedded NUL in a text literal; pass it as a bound
    // parameter (or as bytes) instead of trying to escape it.
    throw new Error('quoteLiteral: value contains a NUL byte; use a bound parameter');
  }

  const escapedQuotes = value.split("'").join("''");

  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return "'" + escapedQuotes.split('\\').join('\\\\') + "'";
    case 'postgres':
      return value.includes('\\')
        ? "E'" + escapedQuotes.split('\\').join('\\\\') + "'"
        : "'" + escapedQuotes + "'";
    case 'sqlite':
      return "'" + escapedQuotes + "'";
    default:
      throw new Error(`quoteLiteral: engine "${engine}" has no SQL literal syntax`);
  }
}

/**
 * Join and quote a dotted name. Undefined/null/empty parts are dropped, so
 * `quoteQualified([table.schema, table.name], engine)` works whether or not the
 * engine has schemas (§4: the canonical model leaves `schema` optional).
 */
export function quoteQualified(parts: (string | null | undefined)[], engine: EngineKind): string {
  const present = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (present.length === 0) {
    throw new Error('quoteQualified: no name parts given');
  }
  return present.map((p) => quoteIdent(p, engine)).join('.');
}

/** Bind the three functions to one engine — what connectors keep as a field. */
export function quoterFor(engine: EngineKind): QuoteFns {
  styleFor(engine); // fail fast on a non-SQL engine rather than at first use
  return {
    engine,
    ident: (name) => quoteIdent(name, engine),
    literal: (value) => quoteLiteral(value, engine),
    qualified: (parts) => quoteQualified(parts, engine),
  };
}
