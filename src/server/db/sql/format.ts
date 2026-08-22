/**
 * SQL formatting (docs/roadmap.md M10).
 *
 * The formatting itself is `sql-formatter`'s job. This module exists for the
 * boundary around it, which is not incidental:
 *
 *   - Our `SqlDialect` is mapped to its language here and nowhere else, so
 *     adding an engine touches one line rather than every call site.
 *   - **Every format is verified before it is returned.** The output is fed
 *     back through our own `splitStatements` and `classifyStatement`, and if
 *     the statement count or any statement's kind changed, the format is
 *     refused and the caller keeps the original text.
 *
 * That last part is the reason a wrapper exists at all. Formatting is a
 * cosmetic operation the user invokes on a buffer they have not finished
 * writing, often against production. A formatter bug that drops a WHERE clause
 * or splits a statement is not a cosmetic failure — and a parser disagreement
 * is exactly the kind of bug a formatter has. Checking with the lexer this app
 * already trusts for statement splitting costs one extra parse and converts a
 * silent corruption into a visible refusal.
 *
 * The check is deliberately coarse. Comparing token streams would reject
 * legitimate reflows; comparing statement count and kind catches the failures
 * that matter and ignores the whitespace and keyword-case changes that are the
 * entire point of formatting.
 */

import { format as sqlFormatterFormat, type FormatOptionsWithLanguage } from 'sql-formatter';

import { classifyStatement, splitStatements, type SqlDialect } from './lexer';

export interface FormatOptions {
  /** Spaces per indent level. */
  indent?: number;
  keywordCase?: 'upper' | 'lower' | 'preserve';
}

/**
 * MySQL's DELIMITER is a client command, not SQL, and sql-formatter does not
 * know it — it reads the `;` inside a routine body as a terminator and reflows
 * the body around boundaries that are not there. The count/kind guard cannot
 * catch that, because a mangled body can re-lex to the same shape.
 *
 * Exported because the caller has to test the WHOLE buffer, not the fragment
 * being formatted: formatting a selection from inside a routine body would
 * otherwise slip past a check that only ever saw the selection.
 */
export function hasDelimiterCommand(sql: string, dialect: SqlDialect): boolean {
  return dialect === 'mysql' && /^[ \t]*delimiter[ \t]+\S/im.test(sql);
}

/** Thrown when the formatted output failed verification. The buffer is untouched. */
export class FormatRefusedError extends Error {
  constructor(reason: string) {
    super(`${reason} The SQL was left unchanged.`);
    this.name = 'FormatRefusedError';
  }
}

/** Our dialects to sql-formatter's languages. The only place this mapping lives. */
const LANGUAGE: Record<SqlDialect, FormatOptionsWithLanguage['language']> = {
  mysql: 'mysql',
  postgres: 'postgresql',
  sqlite: 'sqlite',
};

/** What a statement is, for comparison. Order matters; count matters. */
function shapeOf(sql: string, dialect: SqlDialect): string[] {
  return splitStatements(sql, dialect).map((s) => classifyStatement(s.text, dialect));
}

/**
 * Format `sql`, or throw `FormatRefusedError` if the result cannot be trusted.
 *
 * `formatter` is injectable so the guard itself can be tested against a
 * deliberately broken formatter — there is no other way to prove the check
 * fires, and a guard that has never been seen to fire is not a guard.
 */
export function formatSql(
  sql: string,
  dialect: SqlDialect,
  opts: FormatOptions = {},
  formatter?: (sql: string) => string,
): string {
  // Nothing to do, and sql-formatter is entitled to its own opinion about what
  // an empty buffer formats to. Returning the input keeps the editor stable.
  if (sql.trim() === '') return sql;

  // See hasDelimiterCommand. Callers formatting a fragment must test the whole
  // buffer themselves; this catches the whole-buffer case.
  if (hasDelimiterCommand(sql, dialect)) return sql;

  const before = shapeOf(sql, dialect);

  let formatted: string;
  try {
    formatted =
      formatter?.(sql) ??
      sqlFormatterFormat(sql, {
        language: LANGUAGE[dialect],
        tabWidth: opts.indent ?? 2,
        keywordCase: opts.keywordCase ?? 'upper',
      });
  } catch (err) {
    throw new FormatRefusedError(
      `The formatter failed on this SQL (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  const after = shapeOf(formatted, dialect);

  if (after.length !== before.length) {
    throw new FormatRefusedError(
      `Formatting changed the script from ${before.length} statement(s) to ${after.length}.`,
    );
  }
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      throw new FormatRefusedError(
        `Formatting changed statement ${i + 1} from ${before[i]} to ${after[i]}.`,
      );
    }
  }

  return formatted;
}
