/**
 * Hand-rolled SQL lexer — statement splitting (PLAN §6 "Statement splitting").
 *
 * `sql.split(';')` breaks on the first string literal, so this walks the text
 * exactly once and knows about every construct that can legally contain a
 * semicolon: quoted strings, quoted identifiers, line/block comments, Postgres
 * dollar-quoting, and MySQL's client-side `DELIMITER` command.
 *
 * It is deliberately NOT a parser: no AST, no grammar, and it never throws. An
 * editor buffer is usually half-typed, so an unterminated string or comment
 * simply runs to end-of-input and the caller still gets a usable statement list.
 *
 * The same machinery powers "run statement under cursor" (§6, M2) and the
 * destructive-statement confirm dialog (§9).
 *
 * No React, no Next: this file lives under src/server (§11) but is pure and has
 * no Node dependencies either, so the editor can reuse it client-side.
 */

import type { EngineKind } from '../../../lib/schema-model';

export type SqlDialect = 'mysql' | 'postgres' | 'sqlite';

export interface SqlStatement {
  /**
   * The text to send to the server: the statement with surrounding whitespace
   * and the trailing delimiter removed. Leading comments are KEPT, because
   * MySQL's version-gated executable comments (bang comments) are real
   * statements, and optimizer hints must survive too.
   */
  text: string;
  /** Offset of the first character of `text` in the source. */
  start: number;
  /** Offset one past the last character of `text`. `sql.slice(start,end) === text`. */
  end: number;
  /** 1-based line number of `start`. */
  line: number;
  /** The terminator in force for this statement (`;` unless MySQL DELIMITER changed it). */
  delimiter: string;
}

export type StatementKind =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'ddl'
  | 'transaction'
  | 'explain'
  | 'other';

/** MariaDB is MySQL for lexing purposes; the non-SQL engines never reach here. */
export function dialectForEngine(engine: EngineKind): SqlDialect {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return 'mysql';
    case 'postgres':
      return 'postgres';
    case 'sqlite':
      return 'sqlite';
    default:
      throw new Error(`No SQL dialect for engine: ${engine}`);
  }
}

// ---------------------------------------------------------------------------
// Dialect rules
// ---------------------------------------------------------------------------

interface DialectRules {
  /** `\'` escapes inside ordinary '…' strings — MySQL default (NO_BACKSLASH_ESCAPES off). */
  backslashEscapes: boolean;
  /** Postgres `E'…'` / `e'…'` escape strings honour backslashes even though plain ones do not. */
  escapeStringPrefix: boolean;
  /** Postgres `$tag$ … $tag$`, including the empty tag `$$`. */
  dollarQuoting: boolean;
  /** Postgres nests block comments; MySQL and SQLite close at the first terminator. */
  nestedBlockComments: boolean;
  /** MySQL `#` line comments. In Postgres `#` is an operator character. */
  hashComments: boolean;
  /** MySQL backtick identifiers, escaped by doubling. SQLite accepts them too. */
  backtickIdent: boolean;
  /** SQLite `[ident]`. Never for Postgres/MySQL, where `[` is an array subscript. */
  bracketIdent: boolean;
  /** MySQL's client-side `DELIMITER //` command. */
  delimiterCommand: boolean;
  /** MySQL needs whitespace after `--`; `1--2` there is `1 - (-2)`. */
  dashDashNeedsSpace: boolean;
  /** Without ANSI_QUOTES a MySQL "…" is a string, so backslash escapes apply inside it. */
  doubleQuoteIsString: boolean;
  /** A MySQL bang comment holds executable SQL, so it counts as statement content. */
  executableComments: boolean;
}

const RULES: Record<SqlDialect, DialectRules> = {
  mysql: {
    backslashEscapes: true,
    escapeStringPrefix: false,
    dollarQuoting: false,
    nestedBlockComments: false,
    hashComments: true,
    backtickIdent: true,
    bracketIdent: false,
    delimiterCommand: true,
    dashDashNeedsSpace: true,
    doubleQuoteIsString: true,
    executableComments: true,
  },
  postgres: {
    // standard_conforming_strings has been on by default since 9.1, so a lone
    // backslash in '…' is data, not an escape.
    backslashEscapes: false,
    escapeStringPrefix: true,
    dollarQuoting: true,
    nestedBlockComments: true,
    hashComments: false,
    backtickIdent: false,
    bracketIdent: false,
    delimiterCommand: false,
    dashDashNeedsSpace: false,
    doubleQuoteIsString: false,
    executableComments: false,
  },
  sqlite: {
    backslashEscapes: false,
    escapeStringPrefix: false,
    dollarQuoting: false,
    nestedBlockComments: false,
    hashComments: false,
    // SQLite accepts MySQL backticks and MSSQL brackets as identifier quotes.
    backtickIdent: true,
    bracketIdent: true,
    delimiterCommand: false,
    dashDashNeedsSpace: false,
    doubleQuoteIsString: false,
    executableComments: false,
  },
};

/**
 * Ruleset for the dialect-less analysers (`classifyStatement`, `isDestructive`).
 * It is a permissive union: recognising a comment or quote form that the real
 * dialect lacks costs us nothing, but *failing* to recognise one could let text
 * inside a comment be read as a `WHERE` clause and silence a destructive-
 * statement warning (§9). Nested block comments are the one exception — the
 * non-nesting reading can never swallow the rest of the script.
 */
const ANY_RULES: DialectRules = {
  backslashEscapes: false,
  escapeStringPrefix: true,
  dollarQuoting: true,
  nestedBlockComments: false,
  hashComments: true,
  backtickIdent: true,
  bracketIdent: true,
  delimiterCommand: false,
  dashDashNeedsSpace: false,
  doubleQuoteIsString: false,
  executableComments: true,
};

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

const CH_A = 65, CH_Z = 90, CH_a = 97, CH_z = 122, CH_0 = 48, CH_9 = 57;
const CH_UNDERSCORE = 95, CH_DOLLAR = 36, CH_HIGH = 128;

/**
 * Unquoted identifiers. Every engine accepts any code point above ASCII, so
 * this tests code points rather than enumerating letters.
 */
function isIdentStart(c: string): boolean {
  if (c === '') return false;
  const n = c.charCodeAt(0);
  return (n >= CH_A && n <= CH_Z) || (n >= CH_a && n <= CH_z) || n === CH_UNDERSCORE || n >= CH_HIGH;
}

function isIdentPart(c: string): boolean {
  if (c === '') return false;
  const n = c.charCodeAt(0);
  return isIdentStart(c) || (n >= CH_0 && n <= CH_9) || n === CH_DOLLAR;
}

/** A dollar-quote tag follows identifier rules but may not contain `$`. */
function isTagStart(c: string): boolean {
  return isIdentStart(c);
}

function isTagPart(c: string): boolean {
  if (c === '') return false;
  const n = c.charCodeAt(0);
  return isIdentStart(c) || (n >= CH_0 && n <= CH_9);
}

/** Bounds-safe character access; out of range yields '' which matches nothing. */
function at(s: string, i: number): string {
  return i >= 0 && i < s.length ? s.charAt(i) : '';
}

function isSpace(c: string): boolean {
  return c !== '' && (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v');
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

// ---------------------------------------------------------------------------
// Scanners — each returns the offset just past the construct it consumed.
// ---------------------------------------------------------------------------

/** '…' / "…" / `…` — `doubling` handles '' and "" and ``, `backslash` handles \'. */
function scanQuoted(sql: string, i: number, quote: string, doubling: boolean, backslash: boolean): number {
  let j = i + 1;
  while (j < sql.length) {
    const c = sql.charAt(j);
    if (backslash && c === '\\') {
      j += 2; // the escaped character can itself be the quote
      continue;
    }
    if (c === quote) {
      if (doubling && at(sql, j + 1) === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return sql.length; // unterminated — half-typed buffers are normal, never throw
}

/** SQLite `[ident]` has no escape form: the first `]` closes it. */
function scanBracket(sql: string, i: number): number {
  const idx = sql.indexOf(']', i + 1);
  return idx === -1 ? sql.length : idx + 1;
}

/** Stops *at* the newline so the newline is handled as ordinary whitespace. */
function scanLineComment(sql: string, i: number): number {
  const idx = sql.indexOf('\n', i);
  return idx === -1 ? sql.length : idx;
}

function scanBlockComment(sql: string, i: number, nested: boolean): number {
  let depth = 1;
  let j = i + 2;
  while (j < sql.length) {
    if (nested && sql.charAt(j) === '/' && at(sql, j + 1) === '*') {
      depth++;
      j += 2;
      continue;
    }
    if (sql.charAt(j) === '*' && at(sql, j + 1) === '/') {
      depth--;
      j += 2;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  return sql.length;
}

/**
 * The `$tag$` opener at `i`, or null when this `$` is something else — a
 * parameter placeholder (`$1`), an identifier character, or a bare operator.
 * The tag may be empty (`$$`) and may never start with a digit, which is
 * exactly what keeps `$1` from being mistaken for a quote.
 */
function dollarTagAt(sql: string, i: number): string | null {
  let j = i + 1;
  if (isTagStart(at(sql, j))) {
    j++;
    while (j < sql.length && isTagPart(sql.charAt(j))) j++;
  }
  if (at(sql, j) !== '$') return null;
  return sql.slice(i, j + 1);
}

function scanDollarQuoted(sql: string, i: number, tag: string): number {
  const idx = sql.indexOf(tag, i + tag.length);
  return idx === -1 ? sql.length : idx + tag.length;
}

/** True when only spaces/tabs separate `i` from the start of its line. */
function atLineStart(sql: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0) {
    const c = sql.charAt(j);
    if (c === ' ' || c === '\t') {
      j--;
      continue;
    }
    return c === '\n' || c === '\r';
  }
  return true;
}

const DELIMITER_KEYWORD = 'delimiter';

/**
 * MySQL's `DELIMITER x` is a *client* command — the server would reject it — so
 * it is consumed here and never emitted as a statement. Like the mysql CLI, the
 * argument is the first whitespace-delimited token on the line.
 */
function delimiterCommandAt(sql: string, i: number): { delimiter: string; next: number } | null {
  if (sql.slice(i, i + DELIMITER_KEYWORD.length).toLowerCase() !== DELIMITER_KEYWORD) return null;
  let j = i + DELIMITER_KEYWORD.length;
  const sep = at(sql, j);
  if (sep !== ' ' && sep !== '\t') return null;
  while (at(sql, j) === ' ' || at(sql, j) === '\t') j++;
  const tokenStart = j;
  while (j < sql.length && !isSpace(sql.charAt(j))) j++;
  let token = sql.slice(tokenStart, j);
  // `DELIMITER ';'` is accepted by the CLI too.
  if (token.length >= 2) {
    const q = token.charAt(0);
    if ((q === "'" || q === '"' || q === '`') && token.charAt(token.length - 1) === q) {
      token = token.slice(1, -1);
    }
  }
  if (token === '') return null; // malformed; leave the delimiter alone
  let next = j;
  while (next < sql.length && sql.charAt(next) !== '\n') next++;
  if (next < sql.length) next++; // swallow the newline so it never joins the next statement
  return { delimiter: token, next };
}

// ---------------------------------------------------------------------------
// Line index
// ---------------------------------------------------------------------------

function lineStarts(sql: string): number[] {
  const starts = [0];
  for (let i = 0; i < sql.length; i++) {
    if (sql.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---------------------------------------------------------------------------
// splitStatements
// ---------------------------------------------------------------------------

/**
 * Split a script into executable statements. Chunks that hold nothing but
 * whitespace and comments are dropped — there is nothing to run — except for
 * MySQL bang comments, which mysqldump emits as real statements.
 */
export function splitStatements(sql: string, dialect: SqlDialect): SqlStatement[] {
  const rules = RULES[dialect];
  const starts = lineStarts(sql);
  const out: SqlStatement[] = [];

  let i = 0;
  let chunkStart = 0;
  let delimiter = ';';
  let sawContent = false;

  const flush = (endOffset: number): void => {
    if (!sawContent) return;
    let s = chunkStart;
    while (s < endOffset && isSpace(sql.charAt(s))) s++;
    let e = endOffset;
    while (e > s && isSpace(sql.charAt(e - 1))) e--;
    if (e <= s) return;
    out.push({ text: sql.slice(s, e), start: s, end: e, line: lineAt(starts, s), delimiter });
  };

  while (i < sql.length) {
    const c = sql.charAt(i);

    if (isSpace(c)) {
      i++;
      continue;
    }

    // MySQL DELIMITER, only where a statement could start.
    if (rules.delimiterCommand && !sawContent && (c === 'd' || c === 'D') && atLineStart(sql, i)) {
      const cmd = delimiterCommandAt(sql, i);
      if (cmd) {
        delimiter = cmd.delimiter;
        i = cmd.next;
        chunkStart = i;
        continue;
      }
    }

    // Comments.
    if (c === '-' && at(sql, i + 1) === '-') {
      const after = at(sql, i + 2);
      if (!rules.dashDashNeedsSpace || after === '' || isSpace(after)) {
        i = scanLineComment(sql, i);
        continue;
      }
    }
    if (rules.hashComments && c === '#') {
      i = scanLineComment(sql, i);
      continue;
    }
    if (c === '/' && at(sql, i + 1) === '*') {
      if (rules.executableComments && at(sql, i + 2) === '!') sawContent = true;
      i = scanBlockComment(sql, i, rules.nestedBlockComments);
      continue;
    }

    // Postgres E'…' — backslash escapes even though plain strings have none.
    // The preceding character must not be identifier text, or this is the tail
    // of a name (`someE'x'` is the identifier `someE` then a string).
    if (
      rules.escapeStringPrefix &&
      (c === 'E' || c === 'e') &&
      at(sql, i + 1) === "'" &&
      !isIdentPart(at(sql, i - 1))
    ) {
      i = scanQuoted(sql, i + 1, "'", true, true);
      sawContent = true;
      continue;
    }

    if (c === "'") {
      i = scanQuoted(sql, i, "'", true, rules.backslashEscapes);
      sawContent = true;
      continue;
    }
    if (c === '"') {
      i = scanQuoted(sql, i, '"', true, rules.doubleQuoteIsString && rules.backslashEscapes);
      sawContent = true;
      continue;
    }
    if (rules.backtickIdent && c === '`') {
      i = scanQuoted(sql, i, '`', true, false);
      sawContent = true;
      continue;
    }
    if (rules.bracketIdent && c === '[') {
      i = scanBracket(sql, i);
      sawContent = true;
      continue;
    }
    if (rules.dollarQuoting && c === '$') {
      const tag = dollarTagAt(sql, i);
      if (tag) {
        i = scanDollarQuoted(sql, i, tag);
        sawContent = true;
        continue;
      }
    }

    // Terminator. Checked after every quote/comment form, so a `;` inside any
    // of them can never reach here.
    if (sql.startsWith(delimiter, i)) {
      flush(i);
      i += delimiter.length;
      chunkStart = i;
      sawContent = false;
      continue;
    }

    i++;
    sawContent = true;
  }

  flush(sql.length);
  return out;
}

/**
 * The statement the caret sits in — "run statement under cursor" (§6).
 *
 * Inside a statement wins. In the gap between two statements the caret sticks
 * to the statement it shares a line with (you just typed the `;`), otherwise it
 * moves forward to the next one, which is what pressing Enter then Run means.
 * Returns null only when the script holds no runnable statement at all.
 */
export function statementAtOffset(sql: string, offset: number, dialect: SqlDialect): SqlStatement | null {
  const stmts = splitStatements(sql, dialect);
  if (stmts.length === 0) return null;
  const pos = Math.max(0, Math.min(offset, sql.length));

  let prev: SqlStatement | null = null;
  let next: SqlStatement | null = null;
  for (const s of stmts) {
    if (pos >= s.start && pos <= s.end) return s;
    if (s.end < pos) prev = s;
    else if (next === null && s.start > pos) next = s;
  }
  if (!prev) return next;
  if (!next) return prev;
  return sql.slice(prev.end, pos).includes('\n') ? next : prev;
}

// ---------------------------------------------------------------------------
// Tokens — just enough structure for classification, still not a parser.
// ---------------------------------------------------------------------------

interface SqlToken {
  kind: 'word' | 'quoted' | 'string' | 'number' | 'punct';
  /** Raw source text, quotes included. */
  text: string;
  /** Upper-cased text for words, '' otherwise. */
  upper: string;
  start: number;
  /** Parenthesis depth the token sits in; `(` and `)` report the outer depth. */
  depth: number;
}

function tokenize(sql: string, rules: DialectRules): SqlToken[] {
  const out: SqlToken[] = [];
  let i = 0;
  let depth = 0;

  const push = (kind: SqlToken['kind'], start: number, end: number, d: number): void => {
    const text = sql.slice(start, end);
    out.push({ kind, text, upper: kind === 'word' ? text.toUpperCase() : '', start, depth: d });
  };

  while (i < sql.length) {
    const c = sql.charAt(i);

    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === '-' && at(sql, i + 1) === '-') {
      const after = at(sql, i + 2);
      if (!rules.dashDashNeedsSpace || after === '' || isSpace(after)) {
        i = scanLineComment(sql, i);
        continue;
      }
    }
    if (rules.hashComments && c === '#') {
      i = scanLineComment(sql, i);
      continue;
    }
    if (c === '/' && at(sql, i + 1) === '*') {
      i = scanBlockComment(sql, i, rules.nestedBlockComments);
      continue;
    }
    if (
      rules.escapeStringPrefix &&
      (c === 'E' || c === 'e') &&
      at(sql, i + 1) === "'" &&
      !isIdentPart(at(sql, i - 1))
    ) {
      const j = scanQuoted(sql, i + 1, "'", true, true);
      push('string', i, j, depth);
      i = j;
      continue;
    }
    if (c === "'") {
      const j = scanQuoted(sql, i, "'", true, rules.backslashEscapes);
      push('string', i, j, depth);
      i = j;
      continue;
    }
    if (c === '"') {
      const j = scanQuoted(sql, i, '"', true, rules.doubleQuoteIsString && rules.backslashEscapes);
      push('quoted', i, j, depth);
      i = j;
      continue;
    }
    if (rules.backtickIdent && c === '`') {
      const j = scanQuoted(sql, i, '`', true, false);
      push('quoted', i, j, depth);
      i = j;
      continue;
    }
    if (rules.bracketIdent && c === '[') {
      const j = scanBracket(sql, i);
      push('quoted', i, j, depth);
      i = j;
      continue;
    }
    if (rules.dollarQuoting && c === '$') {
      const tag = dollarTagAt(sql, i);
      if (tag) {
        const j = scanDollarQuoted(sql, i, tag);
        push('string', i, j, depth);
        i = j;
        continue;
      }
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < sql.length && isIdentPart(sql.charAt(j))) j++;
      push('word', i, j, depth);
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql.charAt(j))) j++;
      push('number', i, j, depth);
      i = j;
      continue;
    }
    if (c === '(') {
      push('punct', i, i + 1, depth);
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      push('punct', i, i + 1, depth);
      i++;
      continue;
    }
    push('punct', i, i + 1, depth);
    i++;
  }
  return out;
}

/** Identifier text without its quotes, for messages shown to the user. */
function identText(tok: SqlToken): string {
  if (tok.kind !== 'quoted') return tok.text;
  const q = tok.text.charAt(0);
  if (q === '[') return tok.text.slice(1, tok.text.endsWith(']') ? -1 : undefined);
  const body = tok.text.slice(1, tok.text.endsWith(q) && tok.text.length > 1 ? -1 : undefined);
  return body.split(q + q).join(q);
}

function isIdentToken(tok: SqlToken | undefined): boolean {
  return !!tok && (tok.kind === 'word' || tok.kind === 'quoted');
}

/** Reads `a.b.c` starting at `idx`; returns the display form and the next index. */
function readQualifiedName(tokens: SqlToken[], idx: number): { name: string; next: number } {
  const parts: string[] = [];
  let i = idx;
  while (isIdentToken(tokens[i])) {
    parts.push(identText(tokens[i]));
    i++;
    if (tokens[i]?.text === '.' && isIdentToken(tokens[i + 1])) {
      i++;
      continue;
    }
    break;
  }
  return { name: parts.join('.'), next: i };
}

// ---------------------------------------------------------------------------
// classifyStatement
// ---------------------------------------------------------------------------

const DDL_VERBS = new Set([
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT', 'GRANT', 'REVOKE',
  'REINDEX', 'VACUUM', 'ANALYZE', 'CLUSTER', 'REFRESH', 'ATTACH', 'DETACH',
]);
const TX_VERBS = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END']);
/** Statements that hand back a result set, so the UI opens a grid tab. */
const SELECTISH = new Set(['SELECT', 'TABLE', 'VALUES', 'SHOW', 'DESCRIBE', 'DESC']);
const CTE_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES']);

function kindForVerb(upper: string): StatementKind | null {
  if (SELECTISH.has(upper)) return 'select';
  if (upper === 'INSERT' || upper === 'REPLACE' || upper === 'UPSERT') return 'insert';
  if (upper === 'UPDATE' || upper === 'MERGE') return 'update';
  if (upper === 'DELETE') return 'delete';
  if (upper === 'EXPLAIN') return 'explain';
  if (TX_VERBS.has(upper)) return 'transaction';
  if (DDL_VERBS.has(upper)) return 'ddl';
  return null;
}

/**
 * Bucket one statement (§6/§9: result-tab labels, confirm dialogs, and whether
 * a DDL run should invalidate the schema cache). Pass the dialect when known;
 * the default union ruleset is only about skipping comments and quotes safely.
 */
export function classifyStatement(sql: string, dialect?: SqlDialect): StatementKind {
  const tokens = tokenize(sql, dialect ? RULES[dialect] : ANY_RULES);
  let idx = 0;
  while (tokens[idx]?.text === '(') idx++; // `(SELECT …) UNION (SELECT …)`
  const first = tokens[idx];
  if (!first || first.kind !== 'word') return 'other';

  // `WITH … AS (…) DELETE` is a delete, not a select: the real verb is the
  // first DML keyword at paren depth 0 after the CTE list.
  if (first.upper === 'WITH') {
    for (let i = idx + 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.depth !== 0 || t.kind !== 'word') continue;
      if (CTE_VERBS.has(t.upper)) return kindForVerb(t.upper) ?? 'select';
    }
    return 'select';
  }

  // `SET TRANSACTION …` / `SET CONSTRAINTS …` are transaction control; plain
  // `SET x = 1` is a session command.
  if (first.upper === 'SET') {
    const next = tokens[idx + 1];
    if (next?.kind === 'word' && (next.upper === 'TRANSACTION' || next.upper === 'CONSTRAINTS')) {
      return 'transaction';
    }
    return 'other';
  }
  if (first.upper === 'START') {
    return tokens[idx + 1]?.upper === 'TRANSACTION' ? 'transaction' : 'other';
  }

  return kindForVerb(first.upper) ?? 'other';
}

// ---------------------------------------------------------------------------
// isDestructive
// ---------------------------------------------------------------------------

export interface DestructiveVerdict {
  destructive: boolean;
  /** Human-readable target, shown verbatim in the confirm dialog (§9). */
  reason?: string;
  /** True for UPDATE/DELETE with no WHERE — "every row" needs a louder warning. */
  unqualified?: boolean;
}

/** Things `ALTER … DROP <x>` can drop that are not user data. */
const NON_DATA_DROP = new Set([
  'CONSTRAINT', 'INDEX', 'KEY', 'FOREIGN', 'PRIMARY', 'UNIQUE', 'CHECK', 'DEFAULT',
  'NOT', 'PARTITION', 'EXPRESSION', 'IDENTITY',
]);

const DROP_OBJECTS = new Set([
  'TABLE', 'VIEW', 'INDEX', 'DATABASE', 'SCHEMA', 'FUNCTION', 'PROCEDURE', 'TRIGGER',
  'SEQUENCE', 'TYPE', 'DOMAIN', 'MATERIALIZED', 'TABLESPACE', 'ROLE', 'USER', 'EXTENSION',
  'COLUMN', 'CONSTRAINT', 'SERVER', 'PUBLICATION', 'SUBSCRIPTION', 'EVENT', 'TEMPORARY',
]);

/**
 * Does this need the confirm dialog from §9? Exactly the four cases the plan
 * names — DROP, TRUNCATE, and UPDATE/DELETE with no WHERE — plus `ALTER …
 * DROP COLUMN`, which is a data-losing DROP wearing a different hat.
 *
 * A whole script may be passed: every statement is checked and the first
 * destructive one is reported, so a `DROP` on line 40 cannot slip through.
 */
export function isDestructive(sql: string, dialect?: SqlDialect): DestructiveVerdict {
  const stmts = splitStatements(sql, dialect ?? 'postgres');
  const texts = stmts.length > 0 ? stmts.map((s) => s.text) : [sql];
  for (const text of texts) {
    const verdict = destructiveStatement(text, dialect);
    if (verdict.destructive) return verdict;
  }
  return { destructive: false };
}

function destructiveStatement(sql: string, dialect?: SqlDialect): DestructiveVerdict {
  const tokens = tokenize(sql, dialect ? RULES[dialect] : ANY_RULES);
  const first = tokens[0];
  if (!first || first.kind !== 'word') return { destructive: false };

  switch (first.upper) {
    case 'DROP': {
      let i = 1;
      const objectWords: string[] = [];
      while (tokens[i]?.kind === 'word' && DROP_OBJECTS.has(tokens[i].upper)) {
        // Stop before the last word: `DROP TABLE event` must keep `event` as
        // the target name, not read it as a second object keyword. Multi-word
        // objects (`MATERIALIZED VIEW`) still work because a name follows them.
        if (objectWords.length > 0 && !isIdentToken(tokens[i + 1])) break;
        objectWords.push(tokens[i].upper);
        i++;
      }
      if (tokens[i]?.upper === 'IF' && tokens[i + 1]?.upper === 'EXISTS') i += 2;
      const { name } = readQualifiedName(tokens, i);
      const object = objectWords.length > 0 ? objectWords.join(' ') : 'OBJECT';
      return {
        destructive: true,
        reason: `DROP ${object}${name ? ` ${name}` : ''}`,
      };
    }
    case 'TRUNCATE': {
      let i = 1;
      if (tokens[i]?.upper === 'TABLE') i++;
      if (tokens[i]?.upper === 'ONLY') i++;
      const { name } = readQualifiedName(tokens, i);
      return { destructive: true, reason: `TRUNCATE TABLE${name ? ` ${name}` : ''}` };
    }
    case 'DELETE': {
      if (hasTopLevelWord(tokens, 'WHERE')) return { destructive: false };
      const name = nameAfterWord(tokens, 'FROM') ?? '';
      return {
        destructive: true,
        unqualified: true,
        reason: `DELETE FROM ${name || 'the table'} with no WHERE clause — every row is removed`,
      };
    }
    case 'UPDATE': {
      if (hasTopLevelWord(tokens, 'WHERE')) return { destructive: false };
      const { name } = readQualifiedName(tokens, 1);
      return {
        destructive: true,
        unqualified: true,
        reason: `UPDATE ${name || 'the table'} with no WHERE clause — every row is rewritten`,
      };
    }
    case 'ALTER': {
      // `ALTER TABLE t DROP c` loses the column's data; dropping a constraint
      // or index does not.
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.depth !== 0 || t.kind !== 'word' || t.upper !== 'DROP') continue;
        let j = i + 1;
        if (tokens[j]?.upper === 'COLUMN') j++;
        else if (tokens[j]?.kind === 'word' && NON_DATA_DROP.has(tokens[j].upper)) continue;
        if (tokens[j]?.upper === 'IF' && tokens[j + 1]?.upper === 'EXISTS') j += 2;
        const { name } = readQualifiedName(tokens, j);
        const target = nameAfterWord(tokens, 'TABLE') ?? '';
        return {
          destructive: true,
          reason: `ALTER TABLE${target ? ` ${target}` : ''} DROP COLUMN${name ? ` ${name}` : ''}`,
        };
      }
      return { destructive: false };
    }
    default:
      return { destructive: false };
  }
}

/** A keyword outside every parenthesis — a WHERE in a subquery does not count. */
function hasTopLevelWord(tokens: SqlToken[], upper: string): boolean {
  return tokens.some((t) => t.depth === 0 && t.kind === 'word' && t.upper === upper);
}

function nameAfterWord(tokens: SqlToken[], upper: string): string | null {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].depth === 0 && tokens[i].kind === 'word' && tokens[i].upper === upper) {
      let j = i + 1;
      if (tokens[j]?.upper === 'ONLY') j++;
      const { name } = readQualifiedName(tokens, j);
      return name || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bind parameters (docs/roadmap.md M10)
// ---------------------------------------------------------------------------

/** One placeholder found in a statement, located so the caller can rewrite it. */
export interface SqlPlaceholder {
  /** `:name` style. Undefined for `?` and `$n`, which carry no name. */
  name?: string;
  /** 1-based position. For `$n` this is n as written, not the position found. */
  ordinal: number;
  start: number;
  end: number;
  style: 'named' | 'qmark' | 'dollar';
}

/**
 * Locate bind placeholders, skipping every region where one would be data
 * rather than a parameter — string literals, all four identifier quotings,
 * line and block comments, and Postgres dollar-quoted bodies.
 *
 * This reuses the scanners `splitStatements` uses rather than re-deriving them.
 * That matters: if this function and the splitter disagreed about where a
 * string ends, the UI would offer to bind something inside a literal and the
 * rewrite would corrupt the statement.
 *
 * Two near-misses are deliberately excluded. Postgres `::` is a cast, not a
 * placeholder called `:int`. MySQL `:=` is assignment. Both appear in ordinary
 * SQL and both would otherwise be reported.
 */
export function findPlaceholders(sql: string, dialect: SqlDialect): SqlPlaceholder[] {
  const rules = RULES[dialect];
  const out: SqlPlaceholder[] = [];
  let i = 0;
  let positional = 0;

  while (i < sql.length) {
    const c = sql.charAt(i);

    if (c === '-' && at(sql, i + 1) === '-') {
      const after = at(sql, i + 2);
      if (!rules.dashDashNeedsSpace || after === '' || isSpace(after)) {
        i = scanLineComment(sql, i);
        continue;
      }
    }
    if (rules.hashComments && c === '#') {
      i = scanLineComment(sql, i);
      continue;
    }
    if (c === '/' && at(sql, i + 1) === '*') {
      i = scanBlockComment(sql, i, rules.nestedBlockComments);
      continue;
    }
    if (
      rules.escapeStringPrefix &&
      (c === 'E' || c === 'e') &&
      at(sql, i + 1) === "'" &&
      !isIdentPart(at(sql, i - 1))
    ) {
      i = scanQuoted(sql, i + 1, "'", true, true);
      continue;
    }
    if (c === "'") {
      i = scanQuoted(sql, i, "'", true, rules.backslashEscapes);
      continue;
    }
    if (c === '"') {
      i = scanQuoted(sql, i, '"', true, rules.doubleQuoteIsString && rules.backslashEscapes);
      continue;
    }
    if (rules.backtickIdent && c === '`') {
      i = scanQuoted(sql, i, '`', true, false);
      continue;
    }
    if (rules.bracketIdent && c === '[') {
      i = scanBracket(sql, i);
      continue;
    }
    if (rules.dollarQuoting && c === '$') {
      const tag = dollarTagAt(sql, i);
      if (tag !== null) {
        i = scanDollarQuoted(sql, i, tag);
        continue;
      }
      // Not a tag, so `$` followed by digits is a numbered placeholder.
      let j = i + 1;
      while (isDigit(at(sql, j))) j++;
      if (j > i + 1) {
        out.push({
          ordinal: Number(sql.slice(i + 1, j)),
          start: i,
          end: j,
          style: 'dollar',
        });
        i = j;
        continue;
      }
      i++;
      continue;
    }

    if (c === '?') {
      positional += 1;
      out.push({ ordinal: positional, start: i, end: i + 1, style: 'qmark' });
      i++;
      continue;
    }

    if (c === ':') {
      // `::` is a Postgres cast and `:=` is a MySQL assignment; neither binds.
      if (at(sql, i + 1) === ':') {
        i += 2;
        continue;
      }
      if (at(sql, i + 1) === '=') {
        i += 2;
        continue;
      }
      let j = i + 1;
      if (isIdentStart(at(sql, j))) {
        j++;
        while (isIdentPart(at(sql, j))) j++;
        positional += 1;
        out.push({
          name: sql.slice(i + 1, j),
          ordinal: positional,
          start: i,
          end: j,
          style: 'named',
        });
        i = j;
        continue;
      }
      i++;
      continue;
    }

    i++;
  }

  return out;
}
