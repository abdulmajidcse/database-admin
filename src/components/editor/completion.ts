/**
 * SQL language services for the editor (PLAN M2 "schema-aware autocomplete").
 *
 * Two layers, because neither alone is enough:
 *
 *  1. `@codemirror/lang-sql` accepts a schema object natively, so the canonical
 *     `SchemaModel` (§4) is projected into an `SQLNamespace`. That gives
 *     `schema.` → tables and `table.` → columns for free, with the right dialect
 *     lexer behind it.
 *  2. lang-sql knows nothing about ALIASES, and nobody writes
 *     `SELECT users.email FROM users` — they write `FROM users u` and then `u.`.
 *     So a second completion source scans the statement under the cursor for
 *     `FROM/JOIN/UPDATE/INTO <table> [AS] <alias>` bindings and resolves them.
 *
 * The statement the alias scanner reads is the one the SERVER's lexer picks
 * (`statementAtOffset`), which is a pure, dependency-free module deliberately
 * written to be reused in the browser — see the header of
 * `server/db/sql/lexer.ts`. Nothing about statement splitting is re-implemented
 * here; aliases are scoped to whatever that function returns, so a `u` bound in
 * statement 3 never leaks into statement 4.
 */

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import {
  MariaSQL,
  MySQL,
  PostgreSQL,
  SQLite,
  StandardSQL,
  sql,
  type SQLDialect,
  type SQLNamespace,
} from '@codemirror/lang-sql';
import type { Extension } from '@codemirror/state';

import type { ColumnModel, EngineKind, SchemaModel, TableModel } from '@/lib/schema-model';
import { qualifiedName } from '@/lib/schema-model';
import { dialectForEngine, statementAtOffset, type SqlDialect } from '@/server/db/sql/lexer';

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

/** CodeMirror's dialect for an engine. Redis/Mongo never reach the SQL editor. */
export function codeMirrorDialect(engine: EngineKind | null | undefined): SQLDialect {
  switch (engine) {
    case 'mysql':
      return MySQL;
    case 'mariadb':
      return MariaSQL;
    case 'postgres':
      return PostgreSQL;
    case 'sqlite':
      return SQLite;
    default:
      return StandardSQL;
  }
}

/** The server lexer's dialect, with a safe default for a not-yet-known engine. */
export function lexerDialect(engine: EngineKind | null | undefined): SqlDialect {
  if (engine === 'mysql' || engine === 'mariadb' || engine === 'postgres' || engine === 'sqlite') {
    return dialectForEngine(engine);
  }
  return 'postgres';
}

// ---------------------------------------------------------------------------
// SchemaModel → SQLNamespace
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<TableModel['kind'], string> = {
  table: 'table',
  view: 'view',
  materialized_view: 'materialized view',
  foreign_table: 'foreign table',
  system: 'system table',
};

function columnCompletion(table: TableModel, column: ColumnModel): Completion {
  const flags: string[] = [column.type.raw];
  if (table.primaryKey.includes(column.name)) flags.push('PK');
  if (!column.nullable) flags.push('not null');
  return {
    label: column.name,
    type: table.primaryKey.includes(column.name) ? 'constant' : 'property',
    detail: flags.join(' · '),
    info: column.comment || undefined,
    // Primary keys and the leading columns sort first; a 60-column table is
    // otherwise an alphabetical wall.
    boost: table.primaryKey.includes(column.name) ? 2 : 0,
  };
}

function tableNamespace(table: TableModel): SQLNamespace {
  const rows = table.rowEstimate !== undefined ? `~${table.rowEstimate.toLocaleString()} rows` : undefined;
  return {
    self: {
      label: table.name,
      type: table.kind === 'table' ? 'class' : 'interface',
      detail: [KIND_LABEL[table.kind], rows].filter(Boolean).join(' · '),
      info: table.comment || undefined,
    },
    children: table.columns.map((c) => columnCompletion(table, c)),
  };
}

/**
 * The nested completion namespace lang-sql wants.
 *
 * Tables are emitted in the `{self, children}` form so the popup can show the
 * kind and row estimate; a namespace whose own name is literally `self` would
 * be misread by that format, which is why only tables use it.
 */
export function buildSqlNamespace(model: SchemaModel): SQLNamespace {
  const out: Record<string, SQLNamespace> = {};
  for (const ns of model.namespaces) {
    const tables: Record<string, SQLNamespace> = {};
    for (const t of ns.tables) tables[t.name] = tableNamespace(t);
    out[ns.name] = tables;
  }
  return out;
}

/**
 * The namespace whose tables can be typed unqualified. Postgres/MySQL report a
 * current database or search path; otherwise the model's only namespace wins,
 * which is the SQLite and single-schema case.
 */
export function defaultNamespaceFor(model: SchemaModel, preferred?: string): string | undefined {
  const names = model.namespaces.map((n) => n.name);
  if (preferred && names.includes(preferred)) return preferred;
  if (model.engine === 'postgres' && names.includes('public')) return 'public';
  if (model.database && names.includes(model.database)) return model.database;
  return names.length === 1 ? names[0] : undefined;
}

// ---------------------------------------------------------------------------
// Table index — the lookup the alias resolver needs
// ---------------------------------------------------------------------------

export interface TableIndex {
  engine: EngineKind;
  tables: TableModel[];
  /** Lower-cased `table` and `schema.table` → the model. */
  byName: Map<string, TableModel>;
}

export function buildTableIndex(model: SchemaModel): TableIndex {
  const byName = new Map<string, TableModel>();
  const tables: TableModel[] = [];
  for (const ns of model.namespaces) {
    for (const t of ns.tables) {
      tables.push(t);
      byName.set(`${ns.name}.${t.name}`.toLowerCase(), t);
      // An unqualified name resolves to the first namespace that has it, which
      // matches how the engine's own search path behaves in practice.
      if (!byName.has(t.name.toLowerCase())) byName.set(t.name.toLowerCase(), t);
    }
  }
  return { engine: model.engine, tables, byName };
}

// ---------------------------------------------------------------------------
// Alias scanning
// ---------------------------------------------------------------------------

/** Words that follow a table name but are never an alias. */
const NOT_AN_ALIAS = new Set([
  'as', 'on', 'using', 'where', 'group', 'order', 'having', 'limit', 'offset', 'set', 'values',
  'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'outer', 'lateral', 'union',
  'intersect', 'except', 'select', 'from', 'into', 'returning', 'window', 'for', 'fetch', 'with',
  'and', 'or', 'not', 'straight_join', 'partition', 'tablesample', 'force', 'use', 'ignore',
]);

const REFERENCE_RE =
  /\b(?:from|join|update|into)\s+((?:[`"[]?[\w$]+[`"\]]?\s*\.\s*)?[`"[]?[\w$]+[`"\]]?)(?:\s+(?:as\s+)?([`"[]?[A-Za-z_][\w$]*[`"\]]?))?/gi;

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length < 2) return t;
  const first = t.charAt(0);
  const last = t.charAt(t.length - 1);
  if ((first === '`' && last === '`') || (first === '"' && last === '"')) return t.slice(1, -1);
  if (first === '[' && last === ']') return t.slice(1, -1);
  return t;
}

function normalizeRef(raw: string): string {
  return raw
    .split('.')
    .map((part) => unquote(part))
    .join('.');
}

export interface StatementScope {
  /** Lower-cased alias → table. */
  aliases: Map<string, TableModel>;
  /** Every table the statement mentions, in the order it mentions them. */
  tables: TableModel[];
  /** Display name for each table in scope, keyed by table identity. */
  labelFor: Map<TableModel, string>;
}

/**
 * Bindings introduced by the statement text: `FROM users u`, `JOIN orders AS o`,
 * `UPDATE public.accounts a`. Deliberately regex-driven rather than a parser —
 * a half-typed statement must still produce completions, and a wrong guess here
 * costs a stale suggestion, never a wrong query.
 */
export function scanStatementScope(text: string, index: TableIndex): StatementScope {
  const aliases = new Map<string, TableModel>();
  const tables: TableModel[] = [];
  const labelFor = new Map<TableModel, string>();

  REFERENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE_RE.exec(text)) !== null) {
    const ref = normalizeRef(match[1] ?? '');
    if (!ref) continue;
    const table = index.byName.get(ref.toLowerCase()) ?? index.byName.get(ref.split('.').pop()!.toLowerCase());
    if (!table) continue;
    if (!tables.includes(table)) tables.push(table);
    if (!labelFor.has(table)) labelFor.set(table, ref);

    const rawAlias = match[2] ? unquote(match[2]) : '';
    if (rawAlias && !NOT_AN_ALIAS.has(rawAlias.toLowerCase())) {
      aliases.set(rawAlias.toLowerCase(), table);
      labelFor.set(table, rawAlias);
    }
  }
  return { aliases, tables, labelFor };
}

// ---------------------------------------------------------------------------
// Completion source
// ---------------------------------------------------------------------------

/**
 * Multi-word forms lang-sql's single-token keyword list cannot offer. Kept short
 * on purpose: duplicating the built-in keyword source would show every keyword
 * twice.
 */
const PHRASES: string[] = [
  'SELECT * FROM',
  'INSERT INTO',
  'DELETE FROM',
  'GROUP BY',
  'ORDER BY',
  'LEFT JOIN',
  'RIGHT JOIN',
  'INNER JOIN',
  'FULL OUTER JOIN',
  'CROSS JOIN',
  'IS NULL',
  'IS NOT NULL',
  'NOT EXISTS',
  'ON CONFLICT',
  'DISTINCT ON',
  'PARTITION BY',
  'CREATE TABLE',
  'CREATE INDEX',
  'ALTER TABLE',
  'DROP TABLE',
  'UNION ALL',
  'LIMIT 100',
];

const PHRASE_OPTIONS: Completion[] = PHRASES.map((label) => ({ label, type: 'keyword', boost: -20 }));

/** `alias.` / `table.` immediately left of the cursor. */
const QUALIFIER_RE = /([`"[]?[\w$]+[`"\]]?)\s*\.\s*([\w$]*)$/;
const WORD_RE = /[\w$]*$/;

export interface CompletionSourceOptions {
  /** Re-read on every keystroke so a schema refresh takes effect immediately. */
  getIndex: () => TableIndex | null;
  getDialect: () => SqlDialect;
}

export function aliasCompletionSource(opts: CompletionSourceOptions): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const index = opts.getIndex();
    if (!index) return null;

    const doc = context.state.doc.toString();
    // Scope aliases to the statement the caret is in — the SERVER's lexer draws
    // that boundary, so the editor and the executor always agree on it.
    const statement = statementAtOffset(doc, context.pos, opts.getDialect());
    const from = statement ? Math.min(statement.start, context.pos) : 0;
    const text = doc.slice(from, context.pos);
    const scope = scanStatementScope(text, index);

    const qualified = QUALIFIER_RE.exec(text);
    if (qualified) {
      const qualifier = unquote(qualified[1]).toLowerCase();
      const partial = qualified[2] ?? '';
      const table = scope.aliases.get(qualifier) ?? index.byName.get(qualifier);
      // Unknown qualifier: it is probably a schema name, which lang-sql's own
      // source already handles — stay quiet rather than fight it.
      if (!table) return null;
      return {
        from: context.pos - partial.length,
        options: table.columns.map((c) => columnCompletion(table, c)),
        validFor: /^[\w$]*$/,
      };
    }

    const word = WORD_RE.exec(text);
    const wordFrom = context.pos - (word ? word[0].length : 0);
    if (wordFrom === context.pos && !context.explicit) return null;

    const options: Completion[] = [];
    for (const [alias, table] of scope.aliases) {
      options.push({
        label: alias,
        type: 'variable',
        detail: `alias of ${qualifiedName(table)}`,
        boost: 3,
      });
    }
    // Columns of the tables already in the statement: the whole point of
    // schema-aware completion is not having to type the table name first.
    for (const table of scope.tables) {
      const label = scope.labelFor.get(table) ?? table.name;
      for (const column of table.columns) {
        const completion = columnCompletion(table, column);
        options.push({
          ...completion,
          detail: `${label} · ${completion.detail ?? ''}`.trim(),
          boost: (completion.boost ?? 0) + 1,
        });
      }
    }
    options.push(...PHRASE_OPTIONS);
    if (options.length === 0) return null;

    return { from: wordFrom, options, validFor: /^[\w$]*$/ };
  };
}

// ---------------------------------------------------------------------------
// The assembled extension
// ---------------------------------------------------------------------------

export interface SqlLanguageOptions {
  engine: EngineKind | null;
  model: SchemaModel | null;
  /** Namespace whose tables complete unqualified — the editor's current schema. */
  defaultSchema?: string;
  upperCaseKeywords?: boolean;
}

/**
 * The language extension the editor mounts. Rebuild it (a new array identity)
 * whenever the engine or the schema model changes — CodeMirror reconfigures
 * from the new extensions and completion becomes accurate immediately (§6
 * "Schema cache freshness").
 */
export function sqlLanguageExtension(options: SqlLanguageOptions): Extension {
  const dialect = codeMirrorDialect(options.engine);
  const namespace = options.model ? buildSqlNamespace(options.model) : undefined;
  const defaultSchema = options.model ? defaultNamespaceFor(options.model, options.defaultSchema) : undefined;
  const index = options.model ? buildTableIndex(options.model) : null;
  const lexer = lexerDialect(options.engine);

  const support = sql({
    dialect,
    schema: namespace,
    defaultSchema,
    upperCaseKeywords: options.upperCaseKeywords ?? true,
  });

  return [
    support,
    support.language.data.of({
      autocomplete: aliasCompletionSource({ getIndex: () => index, getDialect: () => lexer }),
    }),
  ];
}
