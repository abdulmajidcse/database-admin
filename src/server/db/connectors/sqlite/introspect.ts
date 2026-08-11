/**
 * SQLite introspection → canonical `SchemaModel` (PLAN §4, §6).
 *
 * SQLite has no `information_schema`, so this is a genuinely separate code path
 * from MySQL/Postgres: `sqlite_master` plus the PRAGMA family
 * (`table_xinfo`, `foreign_key_list`, `index_list`, `index_xinfo`).
 *
 * §8.3 says introspection must take a FIXED number of statements regardless of
 * table count. SQLite exposes the pragmas as table-valued functions
 * (`pragma_table_xinfo(name, schema)`), so every pragma is joined against
 * `sqlite_master` in a single statement. Older builds without table-valued
 * pragmas fall back to a per-table loop — correct, just chattier; harmless here
 * because the "link" is a local file, never a network.
 *
 * Runs INSIDE the worker thread: it needs the synchronous better-sqlite3 handle.
 */

import type Database from 'better-sqlite3';
import type { BaseType } from '../../../../lib/wire';
import type {
  CheckModel,
  ColumnModel,
  ForeignKeyModel,
  IndexColumn,
  IndexModel,
  IntrospectScope,
  ReferentialAction,
  SchemaModel,
  SchemaNamespace,
  SequenceModel,
  TableKind,
  TableModel,
  TriggerModel,
  TypeDescriptor,
} from '../../../../lib/schema-model';
import { quoteIdent, quoteLiteral } from './ddl';

type Db = Database.Database;

/** Counts statements actually issued, reported as `SchemaModel.roundTrips` (§8.3). */
export interface StatementCounter {
  n: number;
}

function all<T>(db: Db, sql: string, counter?: StatementCounter): T[] {
  if (counter) counter.n++;
  const stmt = db.prepare(sql);
  stmt.safeIntegers(false); // catalog rows are small; plain numbers keep the mapping simple
  return stmt.all() as T[];
}

/**
 * The worker enables safe integers globally (§6 type fidelity), which makes
 * `db.pragma()` hand back BigInts for every numeric catalog field. Catalog
 * numbers are tiny, so normalize them back to plain numbers here — otherwise
 * every `row.pk === 1` comparison in this file would silently be false.
 */
function normalizeRow<T>(row: T): T {
  if (row === null || typeof row !== 'object') return row;
  const out = row as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'bigint') out[k] = Number(out[k] as bigint);
  }
  return row;
}

function pragmaRows<T>(db: Db, schema: string, pragma: string, counter?: StatementCounter): T[] {
  if (counter) counter.n++;
  const rows = db.pragma(`${quoteIdent(schema)}.${pragma}`) as T[];
  return rows.map(normalizeRow);
}

// ---------------------------------------------------------------------------
// Type affinity → BaseType
// ---------------------------------------------------------------------------

export type Affinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC';

/** SQLite's five affinity rules, applied in the documented order. */
export function affinityOf(declared: string): Affinity {
  const t = declared.toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t === '' || t.includes('BLOB')) return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

/**
 * Declared type → `TypeDescriptor`. We check the well-known spellings *before*
 * the affinity rules on purpose: `POINT` contains "INT" and would otherwise be
 * reported as an integer, and `DATETIME` would fall through to NUMERIC. The
 * true affinity is still available via `affinityOf()` for anything that needs
 * SQLite's real storage semantics.
 */
export function typeDescriptor(declared: string | null | undefined): TypeDescriptor {
  const raw = (declared ?? '').trim();
  if (raw === '') {
    // No declared type at all: the column is purely dynamic (§6 trap 2).
    return { raw: '', base: 'unknown' };
  }
  const upper = raw.toUpperCase();
  const args = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(raw);
  const n1 = args ? Number.parseInt(args[1], 10) : undefined;
  const n2 = args && args[2] !== undefined ? Number.parseInt(args[2], 10) : undefined;

  const d: TypeDescriptor = { raw, base: 'unknown' };
  if (/\bUNSIGNED\b/.test(upper)) d.unsigned = true;

  const named = (): BaseType | null => {
    if (upper.includes('BOOL')) return 'boolean';
    if (upper.includes('JSON')) return 'json';
    if (upper.includes('UUID') || upper.includes('GUID')) return 'uuid';
    if (upper.includes('XML')) return 'xml';
    if (upper.includes('BLOB') || upper.includes('BINARY')) return 'binary';
    if (upper.includes('DATETIME') || upper.includes('TIMESTAMP')) return 'timestamp';
    if (upper.includes('DATE')) return 'date';
    if (upper.includes('TIME')) return 'time';
    if (upper.includes('MONEY')) return 'money';
    if (upper.includes('BIGINT') || upper.includes('INT8') || upper.includes('BIG INT')) return 'bigint';
    return null;
  };

  const base = named();
  if (base) {
    d.base = base;
    if (base === 'money' && n1 !== undefined) {
      d.precision = n1;
      d.scale = n2;
    }
    return d;
  }

  switch (affinityOf(upper)) {
    case 'INTEGER':
      d.base = 'integer';
      break;
    case 'TEXT':
      d.base = n1 !== undefined ? 'string' : 'text';
      if (n1 !== undefined) d.length = n1;
      break;
    case 'BLOB':
      d.base = 'binary';
      break;
    case 'REAL':
      d.base = 'float';
      if (n1 !== undefined) {
        d.precision = n1;
        d.scale = n2;
      }
      break;
    case 'NUMERIC':
      d.base = 'decimal';
      if (n1 !== undefined) {
        d.precision = n1;
        d.scale = n2;
      }
      break;
  }
  return d;
}

/** Per-CELL typing (§6 trap 2): the runtime JS value decides, not the column. */
export function baseTypeForValue(v: unknown): BaseType {
  if (v === null || v === undefined) return 'unknown';
  if (typeof v === 'bigint') return 'bigint';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'float';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'text';
  if (v instanceof Uint8Array) return 'binary';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Small SQL text scanner — SQLite keeps the original CREATE text in
// sqlite_master, and it is the only place CHECK constraints, generated-column
// expressions, COLLATE clauses and index predicates are recorded.
// ---------------------------------------------------------------------------

function skipQuoted(s: string, i: number, q: string): number {
  i++;
  while (i < s.length) {
    if (s[i] === q) {
      if (s[i + 1] === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

/** Index just past the token starting at `i`, or i+1 for ordinary characters. */
function skipToken(s: string, i: number): number {
  const ch = s[i];
  if (ch === "'" || ch === '"' || ch === '`') return skipQuoted(s, i, ch);
  if (ch === '[') {
    const j = s.indexOf(']', i);
    return j < 0 ? s.length : j + 1;
  }
  if (ch === '-' && s[i + 1] === '-') {
    const j = s.indexOf('\n', i);
    return j < 0 ? s.length : j + 1;
  }
  if (ch === '/' && s[i + 1] === '*') {
    const j = s.indexOf('*/', i);
    return j < 0 ? s.length : j + 2;
  }
  return i + 1;
}

/** The parenthesised body of a CREATE statement plus whatever follows it. */
function splitParens(sql: string): { body: string; tail: string } | null {
  let i = 0;
  while (i < sql.length && sql[i] !== '(') {
    const next = skipToken(sql, i);
    if (next > i + 1) {
      i = next;
      continue;
    }
    i++;
  }
  if (i >= sql.length) return null;
  const open = i;
  let depth = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = skipToken(sql, i);
    if (next > i + 1) {
      i = next;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { body: sql.slice(open + 1, i), tail: sql.slice(i + 1) };
    }
    i++;
  }
  return null;
}

/** Depth-0 comma-separated items of a CREATE body. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    const next = skipToken(body, i);
    if (next > i + 1) {
      i = next;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  if (body.slice(start).trim() !== '') out.push(body.slice(start));
  return out;
}

/** Balanced content of the parens that follow the keyword at `from`. */
function parenAfter(item: string, from: number): { expr: string; end: number } | null {
  let i = from;
  while (i < item.length && /\s/.test(item[i])) i++;
  if (item[i] !== '(') return null;
  let depth = 0;
  const open = i;
  while (i < item.length) {
    const ch = item[i];
    const next = skipToken(item, i);
    if (next > i + 1) {
      i = next;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { expr: item.slice(open + 1, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

function unquoteIdent(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    if (t[0] === '"' && t.at(-1) === '"') return t.slice(1, -1).replace(/""/g, '"');
    if (t[0] === '`' && t.at(-1) === '`') return t.slice(1, -1).replace(/``/g, '`');
    if (t[0] === '[' && t.at(-1) === ']') return t.slice(1, -1);
    if (t[0] === "'" && t.at(-1) === "'") return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** Leading identifier of a column-definition item, and where it ends. */
function leadingIdent(item: string): { name: string; end: number } {
  const lead = item.length - item.trimStart().length;
  const s = item.slice(lead);
  if (s[0] === '"' || s[0] === '`' || s[0] === '[') {
    const end = skipToken(s, 0);
    return { name: unquoteIdent(s.slice(0, end)), end: lead + end };
  }
  const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(s);
  return m ? { name: m[0], end: lead + m[0].length } : { name: '', end: lead };
}

const CONSTRAINT_KEYWORDS = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i;

interface ParsedTableSql {
  checks: CheckModel[];
  /** Column name → extras only recoverable from the DDL text. */
  extras: Map<string, { collation?: string; generatedExpression?: string; autoIncrement?: boolean }>;
  withoutRowid: boolean;
  strict: boolean;
}

export function parseCreateTable(sql: string | null): ParsedTableSql {
  const result: ParsedTableSql = { checks: [], extras: new Map(), withoutRowid: false, strict: false };
  if (!sql) return result;
  const split = splitParens(sql);
  if (!split) return result;

  const tailUpper = split.tail.toUpperCase();
  result.withoutRowid = /\bWITHOUT\s+ROWID\b/.test(tailUpper);
  result.strict = /\bSTRICT\b/.test(tailUpper);

  let anonymousChecks = 0;
  for (const item of splitTopLevel(split.body)) {
    const trimmed = item.trim();
    if (trimmed === '') continue;

    // A named constraint prefix can precede either a table constraint or a
    // column constraint, so strip it before deciding which this item is.
    let constraintName: string | undefined;
    let rest = trimmed;
    const named = /^CONSTRAINT\s+/i.exec(trimmed);
    if (named) {
      const after = trimmed.slice(named[0].length);
      const ident = leadingIdent(after);
      if (ident.name !== '') {
        constraintName = ident.name;
        rest = after.slice(ident.end).trimStart();
      }
    }

    const isTableConstraint = CONSTRAINT_KEYWORDS.test(rest);
    const columnName = isTableConstraint ? '' : leadingIdent(trimmed).name;

    // CHECK can appear at table level or inside a column definition.
    const checkAt = indexOfKeyword(item, 'CHECK');
    if (checkAt >= 0) {
      const p = parenAfter(item, checkAt + 5);
      if (p) {
        result.checks.push({
          name: constraintName ?? (columnName ? `${columnName}_check` : `check_${++anonymousChecks}`),
          expression: p.expr.trim(),
        });
      }
    }

    if (!columnName) continue;

    const extras: { collation?: string; generatedExpression?: string; autoIncrement?: boolean } = {};
    const collAt = indexOfKeyword(item, 'COLLATE');
    if (collAt >= 0) {
      const m = /^\s*([A-Za-z0-9_"[`]+)/.exec(item.slice(collAt + 7));
      if (m) extras.collation = unquoteIdent(m[1]);
    }
    const genAt = indexOfKeyword(item, 'GENERATED');
    const asAt = indexOfKeyword(item, 'AS');
    if (genAt >= 0 || asAt >= 0) {
      const kw = genAt >= 0 ? indexOfKeyword(item, 'AS', genAt) : asAt;
      if (kw >= 0) {
        const p = parenAfter(item, kw + 2);
        if (p) extras.generatedExpression = p.expr.trim();
      }
    }
    if (indexOfKeyword(item, 'AUTOINCREMENT') >= 0) extras.autoIncrement = true;
    if (Object.keys(extras).length > 0) result.extras.set(columnName, extras);
  }
  return result;
}

/** Case-insensitive keyword search that ignores quoted text and comments. */
function indexOfKeyword(s: string, keyword: string, from = 0): number {
  const kw = keyword.toUpperCase();
  let i = from;
  while (i < s.length) {
    const next = skipToken(s, i);
    if (next > i + 1) {
      i = next;
      continue;
    }
    if (s.slice(i, i + kw.length).toUpperCase() === kw) {
      const before = i === 0 ? ' ' : s[i - 1];
      const after = s[i + kw.length] ?? ' ';
      if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return i;
    }
    i++;
  }
  return -1;
}

/** Expression parts and WHERE predicate of a CREATE INDEX statement. */
export function parseCreateIndex(sql: string | null): { parts: string[]; predicate?: string } {
  if (!sql) return { parts: [] };
  const split = splitParens(sql);
  if (!split) return { parts: [] };
  const parts = splitTopLevel(split.body).map((p) => p.trim());
  const whereAt = indexOfKeyword(split.tail, 'WHERE');
  const predicate = whereAt >= 0 ? split.tail.slice(whereAt + 5).trim() : undefined;
  return { parts, predicate };
}

function parseTrigger(sql: string | null): Pick<TriggerModel, 'timing' | 'events' | 'condition' | 'orientation'> {
  const out: Pick<TriggerModel, 'timing' | 'events' | 'condition' | 'orientation'> = {
    timing: 'before',
    events: [],
    orientation: 'row', // SQLite triggers are always FOR EACH ROW
  };
  if (!sql) return out;
  const beginAt = indexOfKeyword(sql, 'BEGIN');
  const header = beginAt >= 0 ? sql.slice(0, beginAt) : sql;
  const onAt = indexOfKeyword(header, 'ON');
  const prefix = (onAt >= 0 ? header.slice(0, onAt) : header).toUpperCase();
  if (/\bINSTEAD\s+OF\b/.test(prefix)) out.timing = 'instead of';
  else if (/\bAFTER\b/.test(prefix)) out.timing = 'after';
  else out.timing = 'before';
  if (/\bINSERT\b/.test(prefix)) out.events.push('insert');
  if (/\bUPDATE\b/.test(prefix)) out.events.push('update');
  if (/\bDELETE\b/.test(prefix)) out.events.push('delete');
  const whenAt = indexOfKeyword(header, 'WHEN');
  if (whenAt >= 0) out.condition = header.slice(whenAt + 4).trim();
  return out;
}

function refAction(a: string | null): ReferentialAction {
  switch ((a ?? '').toUpperCase()) {
    case 'CASCADE':
      return 'cascade';
    case 'RESTRICT':
      return 'restrict';
    case 'SET NULL':
      return 'set null';
    case 'SET DEFAULT':
      return 'set default';
    default:
      return 'no action';
  }
}

// ---------------------------------------------------------------------------
// Raw catalog access (also used by the lazy tree, which must not introspect
// the whole database to expand one node)
// ---------------------------------------------------------------------------

export interface CatalogObject {
  schema: string;
  type: 'table' | 'view' | 'index' | 'trigger';
  name: string;
  tblName: string;
  sql: string | null;
}

export function listDatabases(db: Db, counter?: StatementCounter): { name: string; file: string }[] {
  if (counter) counter.n++;
  const rows = db.pragma('database_list') as { seq: number; name: string; file: string }[];
  return rows.map((r) => ({ name: String(r.name), file: String(r.file ?? '') }));
}

export function listObjects(
  db: Db,
  schema: string,
  types: CatalogObject['type'][],
  counter?: StatementCounter,
): CatalogObject[] {
  const filter = types.map((t) => quoteLiteral(t)).join(', ');
  const rows = all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    db,
    `SELECT type, name, tbl_name, sql FROM ${quoteIdent(schema)}.sqlite_master
      WHERE type IN (${filter}) AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      ORDER BY type, name`,
    counter,
  );
  return rows.map((r) => ({
    schema,
    type: r.type as CatalogObject['type'],
    name: r.name,
    tblName: r.tbl_name,
    sql: r.sql,
  }));
}

interface XInfoRow {
  tbl?: string;
  cid: number;
  name: string;
  type: string | null;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface FkRow {
  tbl?: string;
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string | null;
  on_delete: string | null;
}

interface IndexListRow {
  tbl?: string;
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexColRow {
  idx?: string;
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string | null;
  key: number;
}

/**
 * One statement for every table's columns. `pragma_table_xinfo(name, schema)`
 * is a table-valued function, so it joins straight onto sqlite_master (§8.3).
 * Falls back to a per-table PRAGMA loop on builds without table-valued pragmas.
 */
function columnRows(db: Db, schema: string, tables: string[], counter: StatementCounter): Map<string, XInfoRow[]> {
  const out = new Map<string, XInfoRow[]>();
  const lit = quoteLiteral(schema);
  try {
    const rows = all<XInfoRow>(
      db,
      `SELECT m.name AS tbl, p.cid, p.name, p.type, p."notnull", p.dflt_value, p.pk, p.hidden
         FROM ${quoteIdent(schema)}.sqlite_master m, pragma_table_xinfo(m.name, ${lit}) p
        WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        ORDER BY m.name, p.cid`,
      counter,
    );
    for (const r of rows) {
      const key = String(r.tbl);
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(r);
    }
    return out;
  } catch {
    for (const t of tables) {
      out.set(t, pragmaRows<XInfoRow>(db, schema, `table_xinfo(${quoteLiteral(t)})`, counter));
    }
    return out;
  }
}

function foreignKeyRows(db: Db, schema: string, tables: string[], counter: StatementCounter): Map<string, FkRow[]> {
  const out = new Map<string, FkRow[]>();
  const lit = quoteLiteral(schema);
  try {
    const rows = all<FkRow>(
      db,
      `SELECT m.name AS tbl, f.id, f.seq, f."table", f."from", f."to", f.on_update, f.on_delete
         FROM ${quoteIdent(schema)}.sqlite_master m, pragma_foreign_key_list(m.name, ${lit}) f
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        ORDER BY m.name, f.id, f.seq`,
      counter,
    );
    for (const r of rows) {
      const key = String(r.tbl);
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(r);
    }
    return out;
  } catch {
    for (const t of tables) {
      out.set(t, pragmaRows<FkRow>(db, schema, `foreign_key_list(${quoteLiteral(t)})`, counter));
    }
    return out;
  }
}

function indexRows(
  db: Db,
  schema: string,
  tables: string[],
  counter: StatementCounter,
): { lists: Map<string, IndexListRow[]>; cols: Map<string, IndexColRow[]> } {
  const lists = new Map<string, IndexListRow[]>();
  const cols = new Map<string, IndexColRow[]>();
  const lit = quoteLiteral(schema);
  try {
    const listRows = all<IndexListRow>(
      db,
      `SELECT m.name AS tbl, i.seq, i.name, i."unique", i.origin, i.partial
         FROM ${quoteIdent(schema)}.sqlite_master m, pragma_index_list(m.name, ${lit}) i
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        ORDER BY m.name, i.seq`,
      counter,
    );
    for (const r of listRows) {
      const key = String(r.tbl);
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key)!.push(r);
    }
    const colRows = all<IndexColRow>(
      db,
      `SELECT i.name AS idx, x.seqno, x.cid, x.name, x."desc", x.coll, x.key
         FROM ${quoteIdent(schema)}.sqlite_master m,
              pragma_index_list(m.name, ${lit}) i,
              pragma_index_xinfo(i.name, ${lit}) x
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND x.key = 1
        ORDER BY i.name, x.seqno`,
      counter,
    );
    for (const r of colRows) {
      const key = String(r.idx);
      if (!cols.has(key)) cols.set(key, []);
      cols.get(key)!.push(r);
    }
    return { lists, cols };
  } catch {
    for (const t of tables) {
      const list = pragmaRows<IndexListRow>(db, schema, `index_list(${quoteLiteral(t)})`, counter);
      lists.set(t, list);
      for (const i of list) {
        cols.set(
          i.name,
          pragmaRows<IndexColRow>(db, schema, `index_xinfo(${quoteLiteral(i.name)})`, counter).filter(
            (c) => c.key === 1,
          ),
        );
      }
    }
    return { lists, cols };
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function buildColumns(rows: XInfoRow[], parsed: ParsedTableSql): ColumnModel[] {
  const out: ColumnModel[] = [];
  let position = 0;
  for (const r of rows) {
    // hidden: 0 normal, 1 hidden virtual-table column, 2 VIRTUAL generated, 3 STORED generated
    if (r.hidden === 1) continue;
    const extras = parsed.extras.get(r.name);
    const col: ColumnModel = {
      name: r.name,
      position: position++,
      type: typeDescriptor(r.type),
      nullable: r.notnull === 0 && r.pk === 0,
      defaultValue: r.dflt_value ?? null,
    };
    if (r.hidden === 2) col.generated = 'virtual';
    if (r.hidden === 3) col.generated = 'stored';
    if (extras?.generatedExpression && col.generated) col.generatedExpression = extras.generatedExpression;
    if (extras?.collation) col.collation = extras.collation;
    if (extras?.autoIncrement) col.autoIncrement = true;
    out.push(col);
  }
  return out;
}

function buildIndexes(
  lists: IndexListRow[],
  colsByIndex: Map<string, IndexColRow[]>,
  indexSql: Map<string, string | null>,
): IndexModel[] {
  const out: IndexModel[] = [];
  for (const l of lists) {
    const parts = colsByIndex.get(l.name) ?? [];
    const parsed = parseCreateIndex(indexSql.get(l.name) ?? null);
    const columns: IndexColumn[] = parts.map((p, i) => {
      const col: IndexColumn = {};
      if (p.cid >= 0 && p.name) col.name = p.name;
      // cid -2 marks an expression; the text only exists in the CREATE INDEX sql.
      else col.expression = parsed.parts[i] ?? p.name ?? 'rowid';
      if (p.desc === 1) col.order = 'desc';
      return col;
    });
    out.push({
      name: l.name,
      columns,
      unique: l.unique === 1,
      primary: l.origin === 'pk',
      // `method` carries provenance for SQLite: 'auto' indexes come from a
      // PRIMARY KEY/UNIQUE constraint and must be rendered as table constraints.
      method: l.origin === 'c' ? 'btree' : 'auto',
      predicate: l.partial === 1 ? parsed.predicate : undefined,
    });
  }
  return out;
}

function buildForeignKeys(rows: FkRow[], tableName: string): ForeignKeyModel[] {
  const byId = new Map<number, FkRow[]>();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id)!.push(r);
  }
  const out: ForeignKeyModel[] = [];
  for (const [id, group] of byId) {
    group.sort((a, b) => a.seq - b.seq);
    out.push({
      // SQLite does not store FK constraint names in the catalog; synthesize a
      // stable one so the model has identity for diffing.
      name: `fk_auto_${tableName}_${id}`,
      columns: group.map((g) => g.from),
      refTable: group[0].table,
      refColumns: group.map((g) => g.to ?? ''),
      onUpdate: refAction(group[0].on_update),
      onDelete: refAction(group[0].on_delete),
    });
  }
  return out;
}

/**
 * Introspect one or more attached databases into the canonical model.
 * Each attached alias is a `SchemaNamespace`; `main` is the default (§4).
 */
export function introspect(db: Db, scope: IntrospectScope = {}): SchemaModel {
  const counter: StatementCounter = { n: 0 };
  const version = String(db.prepare('SELECT sqlite_version() AS v').pluck().get());
  counter.n++;

  const wanted = scope.namespaces && scope.namespaces.length > 0 ? new Set(scope.namespaces) : null;
  const databases = listDatabases(db, counter).filter((d) => (wanted ? wanted.has(d.name) : true));

  const namespaces: SchemaNamespace[] = [];
  for (const dbEntry of databases) {
    namespaces.push(introspectNamespace(db, dbEntry.name, scope, counter));
  }

  return {
    engine: 'sqlite',
    serverVersion: version,
    database: databases.find((d) => d.name === 'main')?.file || ':memory:',
    namespaces,
    fetchedAt: Date.now(),
    roundTrips: counter.n,
  };
}

export function introspectNamespace(
  db: Db,
  schema: string,
  scope: IntrospectScope,
  counter: StatementCounter,
): SchemaNamespace {
  const objects = listObjects(db, schema, ['table', 'view', 'index', 'trigger'], counter);
  const tableNames = objects.filter((o) => o.type === 'table').map((o) => o.name);
  const viewNames = objects.filter((o) => o.type === 'view').map((o) => o.name);
  const indexSql = new Map<string, string | null>(
    objects.filter((o) => o.type === 'index').map((o) => [o.name, o.sql]),
  );
  const sqlByName = new Map<string, string | null>(objects.map((o) => [`${o.type}:${o.name}`, o.sql]));

  const allNames = [...tableNames, ...viewNames];
  const columnsByTable = columnRows(db, schema, allNames, counter);
  const fksByTable =
    tableNames.length > 0 ? foreignKeyRows(db, schema, tableNames, counter) : new Map<string, FkRow[]>();
  const { lists, cols } = tableNames.length > 0
    ? indexRows(db, schema, tableNames, counter)
    : { lists: new Map<string, IndexListRow[]>(), cols: new Map<string, IndexColRow[]>() };

  // Row estimates come from ANALYZE's sqlite_stat1, never a COUNT(*) (§4).
  const rowEstimates = new Map<string, number>();
  if (!scope.shallow) {
    try {
      const stats = all<{ tbl: string; stat: string }>(
        db,
        `SELECT tbl, stat FROM ${quoteIdent(schema)}.sqlite_stat1`,
        counter,
      );
      for (const s of stats) {
        const n = Number.parseInt(String(s.stat).split(/\s+/)[0], 10);
        if (Number.isFinite(n) && !rowEstimates.has(s.tbl)) rowEstimates.set(s.tbl, n);
      }
    } catch {
      // sqlite_stat1 only exists after ANALYZE; absence is normal.
    }
  }

  const tables: TableModel[] = [];
  const buildTable = (name: string, kind: TableKind, sql: string | null): TableModel => {
    const parsed = parseCreateTable(sql);
    const colRows = columnsByTable.get(name) ?? [];
    const columns = buildColumns(colRows, parsed);
    const pkOrdered = colRows
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);
    const indexes = kind === 'table'
      ? buildIndexes(lists.get(name) ?? [], cols, indexSql)
      : [];
    const model: TableModel = {
      name,
      schema,
      kind,
      columns,
      indexes,
      foreignKeys: kind === 'table' ? buildForeignKeys(fksByTable.get(name) ?? [], name) : [],
      checks: parsed.checks,
      primaryKey: pkOrdered,
    };
    const flags: string[] = [];
    if (parsed.strict) flags.push('strict');
    if (parsed.withoutRowid) flags.push('without rowid');
    if (flags.length > 0) model.engine = flags.join(', ');
    if (kind === 'view') model.definition = sql ?? undefined;
    const est = rowEstimates.get(name);
    if (est !== undefined) model.rowEstimate = est;
    return model;
  };

  for (const t of tableNames) tables.push(buildTable(t, 'table', sqlByName.get(`table:${t}`) ?? null));
  for (const v of viewNames) tables.push(buildTable(v, 'view', sqlByName.get(`view:${v}`) ?? null));

  // A FK with a NULL `to` column targets the referenced table's primary key.
  const pkByTable = new Map(tables.map((t) => [t.name, t.primaryKey]));
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      if (fk.refColumns.every((c) => c !== '')) continue;
      const targetPk = pkByTable.get(fk.refTable) ?? [];
      fk.refColumns = fk.refColumns.map((c, i) => (c === '' ? targetPk[i] ?? 'rowid' : c));
    }
  }

  const triggers: TriggerModel[] = [];
  if (!scope.shallow) {
    for (const o of objects) {
      if (o.type !== 'trigger') continue;
      const parsed = parseTrigger(o.sql);
      triggers.push({
        name: o.name,
        schema,
        table: o.tblName,
        timing: parsed.timing,
        events: parsed.events,
        orientation: parsed.orientation,
        condition: parsed.condition,
        statement: o.sql ?? undefined,
      });
    }
  }

  // SQLite has no sequences, but AUTOINCREMENT state lives in sqlite_sequence —
  // the closest true equivalent, and useful to see.
  const sequences: SequenceModel[] = [];
  if (!scope.shallow) {
    try {
      const rows = all<{ name: string; seq: number }>(
        db,
        `SELECT name, seq FROM ${quoteIdent(schema)}.sqlite_sequence ORDER BY name`,
        counter,
      );
      for (const r of rows) {
        sequences.push({ name: r.name, schema, lastValue: String(r.seq), increment: '1', ownedBy: r.name });
      }
    } catch {
      // No AUTOINCREMENT column in this database.
    }
  }

  return {
    name: schema,
    tables,
    routines: [], // SQLite has no stored routines
    sequences,
    triggers,
    enums: [],
  };
}

// ---------------------------------------------------------------------------
// Targeted lookups for the lazy tree and for grid editability
// ---------------------------------------------------------------------------

export interface TableFacts {
  kind: TableKind | null;
  columns: ColumnModel[];
  indexes: IndexModel[];
  foreignKeys: ForeignKeyModel[];
  primaryKey: string[];
  /** False for WITHOUT ROWID tables and views: no implicit rowid key available. */
  hasRowid: boolean;
  sql: string | null;
}

/** One table, without walking the whole schema (used per tree expansion). */
export function tableFacts(db: Db, schema: string, table: string): TableFacts {
  const row = db
    .prepare(
      `SELECT type, sql FROM ${quoteIdent(schema)}.sqlite_master WHERE name = ? AND type IN ('table','view')`,
    )
    .get(table) as { type: string; sql: string | null } | undefined;
  if (!row) {
    return { kind: null, columns: [], indexes: [], foreignKeys: [], primaryKey: [], hasRowid: false, sql: null };
  }
  const counter: StatementCounter = { n: 0 };
  const parsed = parseCreateTable(row.sql);
  const colRows = pragmaRows<XInfoRow>(db, schema, `table_xinfo(${quoteLiteral(table)})`, counter);
  const columns = buildColumns(colRows, parsed);
  const primaryKey = colRows
    .filter((r) => r.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((r) => r.name);

  let indexes: IndexModel[] = [];
  let foreignKeys: ForeignKeyModel[] = [];
  if (row.type === 'table') {
    const lists = pragmaRows<IndexListRow>(db, schema, `index_list(${quoteLiteral(table)})`, counter);
    const cols = new Map<string, IndexColRow[]>();
    const indexSql = new Map<string, string | null>();
    for (const l of lists) {
      cols.set(
        l.name,
        pragmaRows<IndexColRow>(db, schema, `index_xinfo(${quoteLiteral(l.name)})`, counter).filter(
          (c) => c.key === 1,
        ),
      );
      const s = db
        .prepare(`SELECT sql FROM ${quoteIdent(schema)}.sqlite_master WHERE type='index' AND name = ?`)
        .pluck()
        .get(l.name) as string | null | undefined;
      indexSql.set(l.name, s ?? null);
    }
    indexes = buildIndexes(lists, cols, indexSql);
    foreignKeys = buildForeignKeys(
      pragmaRows<FkRow>(db, schema, `foreign_key_list(${quoteLiteral(table)})`, counter),
      table,
    );
  }

  return {
    kind: row.type === 'view' ? 'view' : 'table',
    columns,
    indexes,
    foreignKeys,
    primaryKey,
    hasRowid: row.type === 'table' && !parsed.withoutRowid,
    sql: row.sql,
  };
}

/**
 * Key columns the grid can edit through (§6 "Grid editing"): primary key, else
 * the first all-NOT-NULL unique index, else SQLite's implicit `rowid`.
 */
export function editKeyFor(facts: TableFacts): { columns: string[]; kind: 'pk' | 'unique' | 'rowid' } | null {
  if (facts.primaryKey.length > 0) return { columns: facts.primaryKey, kind: 'pk' };
  const nullable = new Set(facts.columns.filter((c) => c.nullable).map((c) => c.name));
  for (const idx of facts.indexes) {
    if (!idx.unique) continue;
    const names = idx.columns.map((c) => c.name).filter((n): n is string => !!n);
    if (names.length !== idx.columns.length) continue;
    if (names.some((n) => nullable.has(n))) continue;
    return { columns: names, kind: 'unique' };
  }
  if (facts.hasRowid) return { columns: ['rowid'], kind: 'rowid' };
  return null;
}
