/**
 * The SQLite worker thread (PLAN §6 "SQLite's four traps", trap 1).
 *
 * `better-sqlite3` is synchronous. A user's `SELECT * FROM huge_table` executed
 * on the main thread would block the event loop and freeze the whole app — UI,
 * WebSockets and every other connection. So every USER SQLite connection gets
 * its own worker thread, and this file is that thread: it owns the database
 * handle, executes requests one at a time and posts results back. Blocking here
 * costs nothing but this connection's own responsiveness.
 *
 * The only interrupt better-sqlite3 offers is terminating the thread, which is
 * exactly what `cancel()` on the main thread does (see ./index.ts).
 *
 * Rules: no React, no Next (§11). Everything crossing `postMessage` is already
 * encoded into the §6 wire format, so the main thread never touches a Buffer or
 * a BigInt it did not ask for.
 */

import { parentPort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { base64ToBytes, bytesCell, tag, type Cell, type Row, type TaggedCell } from '../../../../lib/wire';
import type { IntrospectScope, SchemaModel } from '../../../../lib/schema-model';
import type {
  ApplyResult,
  ColumnMeta,
  ExplainNode,
  ExplainPlan,
  ResultChunk,
  ResultSet,
} from '../../../../lib/results';
import {
  baseTypeForValue,
  editKeyFor,
  introspect,
  listDatabases,
  listObjects,
  tableFacts,
  typeDescriptor,
  type CatalogObject,
  type TableFacts,
} from './introspect';
import { quoteIdent } from './ddl';

// ---------------------------------------------------------------------------
// Protocol (shared with ./index.ts through `import type`)
// ---------------------------------------------------------------------------

export interface OpenPayload {
  /** Absolute path, or `:memory:`. */
  file: string;
  memory: boolean;
  /** Address mode `ro` → the handle itself is read-only. */
  readonly: boolean;
  /** Connection-level read-only guard (§8.5), enforced with `PRAGMA query_only`. */
  queryOnly: boolean;
  busyTimeoutMs: number;
  /** null leaves the existing journal mode alone. */
  journalMode: string | null;
  foreignKeys: boolean;
  attach: { alias: string; path: string }[];
}

export interface OpenInfo {
  version: string;
  file: string;
  readonly: boolean;
  memory: boolean;
  journalMode: string;
  pageSize: number;
  encoding: string;
  foreignKeys: boolean;
  sizeBytes?: number;
  databases: { name: string; file: string }[];
  notices: string[];
}

export interface QueryPayload {
  sql: string;
  params?: unknown[];
  /** 0 or less means "no cap" (used by stream()). */
  maxRows: number;
}

export interface ChangeStatement {
  sql: string;
  params: unknown[];
  /** Rows this statement must touch; a mismatch aborts the whole apply (§6). */
  expected: number;
}

export type WorkerRequest =
  | { id: number; op: 'open'; payload: OpenPayload }
  | { id: number; op: 'ping' }
  | { id: number; op: 'query'; payload: QueryPayload }
  | { id: number; op: 'cursorFetch'; payload: { cursorId: string; n: number } }
  | { id: number; op: 'cursorClose'; payload: { cursorId: string } }
  | { id: number; op: 'execScript'; payload: { statements: string[] } }
  | { id: number; op: 'introspect'; payload: { scope: IntrospectScope } }
  | { id: number; op: 'explain'; payload: { sql: string; analyze: boolean; params?: unknown[] } }
  | { id: number; op: 'catalogDatabases' }
  | { id: number; op: 'catalogObjects'; payload: { schema: string; types: CatalogObject['type'][] } }
  | { id: number; op: 'tableFacts'; payload: { schema: string; table: string } }
  | { id: number; op: 'objectDdl'; payload: { schema: string; kind: 'table' | 'view' | 'index' | 'database'; name: string } }
  | { id: number; op: 'rebuildContext'; payload: { schema: string; table: string } }
  | { id: number; op: 'applyChangeset'; payload: { statements: ChangeStatement[] } }
  | { id: number; op: 'backup'; payload: { dest: string; attached?: string } }
  | { id: number; op: 'attach'; payload: { alias: string; path: string } }
  | { id: number; op: 'detach'; payload: { alias: string } }
  | { id: number; op: 'session'; payload: { cmd: 'begin' | 'commit' | 'rollback' } }
  | { id: number; op: 'close' };

export interface WireError {
  message: string;
  code?: string;
  detail?: string;
}

export type WorkerMessage =
  | { kind: 'reply'; id: number; ok: true; result: unknown }
  | { kind: 'reply'; id: number; ok: false; error: WireError }
  | { kind: 'progress'; id: number; done: number; total: number }
  | { kind: 'notice'; message: string };

export interface QueryResult extends ResultSet {
  /** Present when rows remain behind the cursor. */
  cursorId?: string;
}

export interface RebuildContextReply {
  triggers: { name: string; sql: string }[];
  views: { name: string; sql: string }[];
  foreignKeysEnabled: boolean;
  sqliteVersion: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Rows we are willing to hold in worker memory when no read handle is usable. */
const MAX_BUFFERED_ROWS = 200_000;
/** Idle read handles kept around for the next cursor. */
const READ_POOL_MAX = 4;

let db: Database.Database | null = null;
let opened: OpenPayload | null = null;
let sqliteVersion = '0.0.0';
const readPool: Database.Database[] = [];

interface CursorState {
  id: string;
  statement: string;
  columns: ColumnMeta[];
  iter: Iterator<unknown[]> | null;
  /** Dedicated read handle to hand back when the cursor closes. */
  handle: Database.Database | null;
  /** Rows already materialized (the no-read-handle path). */
  buffer: Row[] | null;
  pos: number;
  /** Row pulled to discover that more rows exist; belongs to the next chunk. */
  pending: Row | null;
  exhausted: boolean;
}

const cursors = new Map<string, CursorState>();

function database(): Database.Database {
  if (!db) throw new Error('SQLite connection is not open');
  return db;
}

function post(msg: WorkerMessage): void {
  parentPort?.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Wire encoding (§6 "Type fidelity" + trap 2 "Dynamic typing")
// ---------------------------------------------------------------------------

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Encode ONE CELL from its actual runtime type. SQLite's dynamic typing means a
 * column can hold an integer in one row and a string in the next, so the
 * declared column type must never decide the encoding (trap 2).
 */
export function encodeCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
      return v;
    case 'boolean':
      return v;
    case 'number':
      // SQLite REAL can hold ±Infinity, which JSON cannot represent.
      return Number.isFinite(v) ? v : tag('decimal', String(v));
    case 'bigint':
      // Safe integers are on, so every INTEGER arrives as BigInt; only the ones
      // that would lose precision as a JS number need the tagged envelope.
      return v <= MAX_SAFE && v >= MIN_SAFE ? Number(v) : tag('bigint', v.toString());
    case 'object':
      if (v instanceof Uint8Array) return bytesCell(v);
      return tag('unsupported', String(v));
    default:
      return tag('unsupported', String(v));
  }
}

function encodeRow(values: unknown[]): Row {
  const out: Row = new Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = encodeCell(values[i]);
  return out;
}

/** Wire value → a value better-sqlite3 will bind. */
export function toBinding(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0; // SQLite has no boolean storage class
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'object' && '$t' in (v as Record<string, unknown>)) {
    const t = v as TaggedCell;
    switch (t.$t) {
      case 'bytes':
        return Buffer.from(base64ToBytes(t.v));
      case 'bigint':
        return BigInt(t.v);
      default:
        // decimal/date/time/timestamp/json/uuid all round-trip as their lossless
        // text; column affinity converts numerics back on the way in.
        return t.v;
    }
  }
  return String(v);
}

function toNum(v: number | bigint | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

function applyPragmas(handle: Database.Database, p: OpenPayload, readonlyHandle: boolean, notices: string[]): void {
  handle.defaultSafeIntegers(true); // §6: 64-bit integers must not silently become floats
  handle.pragma(`busy_timeout = ${Math.max(0, Math.floor(p.busyTimeoutMs))}`); // trap 4
  if (!readonlyHandle && !p.memory && p.journalMode) {
    try {
      handle.pragma(`journal_mode = ${p.journalMode}`);
    } catch (e) {
      // WAL is impossible on read-only media and on some network filesystems.
      notices.push(`Could not set journal_mode=${p.journalMode}: ${(e as Error).message}`);
    }
  }
  handle.pragma(`foreign_keys = ${p.foreignKeys ? 'ON' : 'OFF'}`);
  if (p.queryOnly && !readonlyHandle) handle.pragma('query_only = ON');
  for (const a of p.attach) {
    handle
      .prepare(`ATTACH DATABASE ? AS ${quoteIdent(a.alias)}`)
      .run(a.path);
  }
}

function openPrimary(p: OpenPayload): { handle: Database.Database; notices: string[] } {
  const notices: string[] = [];
  // A read-only :memory: database can never contain anything, so `mode: ro` is
  // ignored there and reported instead of failing to open (§4 Address union).
  const readonly = p.readonly && !p.memory;
  if (p.readonly && p.memory) notices.push('Read-only mode ignored for an in-memory database.');
  const handle = new Database(p.file, {
    readonly,
    fileMustExist: readonly,
    timeout: Math.max(0, Math.floor(p.busyTimeoutMs)),
  });
  applyPragmas(handle, p, readonly, notices);
  return { handle, notices };
}

/**
 * An open iterator makes a better-sqlite3 connection busy: no other statement
 * can run on it until the iterator is exhausted or returned. Paging through a
 * result therefore gets its OWN read-only handle, so a half-scrolled grid never
 * blocks the next query. WAL keeps that handle on a consistent snapshot for the
 * life of the cursor.
 */
function canUseReadHandle(): boolean {
  // A second handle cannot see uncommitted rows, and :memory: is per-connection.
  return !!opened && !opened.memory && !!db && !db.inTransaction;
}

function acquireRead(): Database.Database | null {
  if (!canUseReadHandle() || !opened) return null;
  const pooled = readPool.pop();
  if (pooled) return pooled;
  try {
    const handle = new Database(opened.file, {
      readonly: true,
      fileMustExist: true,
      timeout: Math.max(0, Math.floor(opened.busyTimeoutMs)),
    });
    applyPragmas(handle, opened, true, []);
    return handle;
  } catch {
    return null; // fall back to the primary handle + buffering
  }
}

function releaseRead(handle: Database.Database): void {
  if (readPool.length < READ_POOL_MAX) readPool.push(handle);
  else handle.close();
}

function drainReadPool(): void {
  while (readPool.length > 0) {
    try {
      readPool.pop()?.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Columns and editability
// ---------------------------------------------------------------------------

function describeColumns(defs: Database.ColumnDefinition[]): ColumnMeta[] {
  return defs.map((d) => {
    const desc = typeDescriptor(d.type);
    const meta: ColumnMeta = {
      name: d.name,
      typeName: d.type ?? 'ANY',
      base: desc.base,
      // Trap 2: SQLite columns can hold mixed types per row, so the grid must
      // render per cell. This is true even inside STRICT tables for expressions.
      dynamicType: true,
    };
    if (d.table) meta.table = d.table;
    if (d.database) meta.schema = d.database;
    return meta;
  });
}

/**
 * Columns with no declared type (expressions, or a column declared with none)
 * get their base type from the first rows that actually arrived — the same
 * runtime-type-wins rule as the cells themselves (trap 2).
 */
function refineColumnTypes(columns: ColumnMeta[], sample: unknown[][]): void {
  for (let c = 0; c < columns.length; c++) {
    if (columns[c].base !== 'unknown') continue;
    for (const r of sample) {
      const inferred = baseTypeForValue(r[c]);
      if (inferred !== 'unknown') {
        columns[c].base = inferred;
        break;
      }
    }
  }
}

interface Editability {
  editTarget: ResultSet['editTarget'];
  readOnlyReason?: string;
}

/**
 * A result is editable only when every column comes from one real table and the
 * result carries that table's unique key (§6 "Grid editing"). Anything else is
 * read-only, and the UI is told exactly why.
 */
function detectEditability(defs: Database.ColumnDefinition[], names: string[]): Editability {
  const real = defs
    .map((d, i) => ({ i, schema: d.database ?? 'main', table: d.table, column: d.column }))
    .filter((o): o is { i: number; schema: string; table: string; column: string } => !!o.table && !!o.column);

  if (real.length === 0) {
    return { editTarget: null, readOnlyReason: 'No column in this result comes from a table.' };
  }
  const distinct = new Set(real.map((o) => `${o.schema}.${o.table}`));
  if (distinct.size > 1) {
    return {
      editTarget: null,
      readOnlyReason: `This result joins ${distinct.size} tables (${[...distinct].join(', ')}); only single-table results are editable.`,
    };
  }

  const { schema, table } = real[0];
  let facts: TableFacts;
  try {
    facts = tableFacts(database(), schema, table);
  } catch {
    return { editTarget: null, readOnlyReason: `Could not read the definition of ${schema}.${table}.` };
  }
  if (facts.kind !== 'table') {
    return { editTarget: null, readOnlyReason: `${schema}.${table} is a view.` };
  }
  const key = editKeyFor(facts);
  if (!key) {
    return {
      editTarget: null,
      readOnlyReason: `${table} has no primary key and no non-null unique index, so rows cannot be identified.`,
    };
  }

  const keyColumns: string[] = [];
  for (const k of key.columns) {
    const hit = real.find((o) => o.column === k);
    if (!hit) {
      return {
        editTarget: null,
        readOnlyReason:
          key.kind === 'rowid'
            ? `${table} has no primary key; add "rowid" to the SELECT list to edit rows.`
            : `Key column "${k}" is missing from the result.`,
      };
    }
    keyColumns.push(names[hit.i]);
  }
  return { editTarget: { schema, table, keyColumns } };
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

function isCommentOnly(sql: string): boolean {
  return sql.replace(/--[^\n]*\n?/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim() === '';
}

/** Strip leading `--` comment lines so a statement can be labelled and checked. */
function statementBody(sql: string): string {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl < 0 ? '' : s.slice(nl + 1).trimStart();
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end < 0 ? '' : s.slice(end + 2).trimStart();
      continue;
    }
    return s;
  }
}

function runQuery(p: QueryPayload): QueryResult {
  const t0 = performance.now();
  const binds = (p.params ?? []).map(toBinding);
  const primary = database();

  let stmt: Database.Statement;
  try {
    stmt = primary.prepare(p.sql);
  } catch (e) {
    if (/more than one statement/i.test((e as Error).message)) {
      // The editor splits statements with the shared lexer; be forgiving when a
      // whole script is pasted straight into query().
      primary.exec(p.sql);
      return {
        statement: p.sql,
        columns: [],
        rows: [],
        truncated: false,
        durationMs: performance.now() - t0,
        notices: ['Ran as a multi-statement script; scripts do not return result sets.'],
      };
    }
    throw e;
  }

  if (!stmt.reader) {
    const info = stmt.run(...binds);
    return {
      statement: p.sql,
      columns: [],
      rows: [],
      truncated: false,
      affectedRows: toNum(info.changes),
      insertId: String(info.lastInsertRowid),
      durationMs: performance.now() - t0,
    };
  }

  // Read-only statements get their own handle so a suspended cursor never
  // blocks the connection; writes with RETURNING must stay on the primary.
  let readHandle = stmt.readonly ? acquireRead() : null;
  let active = stmt;
  if (readHandle) {
    try {
      active = readHandle.prepare(p.sql);
    } catch {
      releaseRead(readHandle);
      readHandle = null;
      active = stmt;
    }
  }

  const defs = active.columns();
  const columns = describeColumns(defs);
  active.raw(true);

  const limit = p.maxRows > 0 ? p.maxRows : Number.POSITIVE_INFINITY;
  const iter = active.iterate(...binds) as unknown as Iterator<unknown[]>;
  const raw: unknown[][] = [];
  const rows: Row[] = [];
  let pending: Row | null = null;
  let exhausted = false;

  for (;;) {
    const next = iter.next();
    if (next.done) {
      exhausted = true;
      break;
    }
    if (rows.length >= limit) {
      // One row past the cap proves more exist; it belongs to the next chunk.
      pending = encodeRow(next.value);
      break;
    }
    if (raw.length < 5) raw.push(next.value);
    rows.push(encodeRow(next.value));
  }

  let cursorId: string | undefined;
  let truncated = false;
  const notices: string[] = [];

  if (!exhausted) {
    truncated = true;
    if (readHandle) {
      cursorId = randomUUID();
      cursors.set(cursorId, {
        id: cursorId,
        statement: p.sql,
        columns,
        iter,
        handle: readHandle,
        buffer: null,
        pos: 0,
        pending,
        exhausted: false,
      });
    } else {
      // No dedicated handle available (in-memory database, or inside a
      // transaction). Holding the iterator would make the connection busy, so
      // drain what is left into worker memory instead — bounded, and the worker
      // heap is not the main thread's heap.
      const buffer: Row[] = [];
      if (pending) buffer.push(pending);
      let overflow = false;
      for (;;) {
        const next = iter.next();
        if (next.done) break;
        if (buffer.length >= MAX_BUFFERED_ROWS) {
          overflow = true;
          (iter.return as (() => IteratorResult<unknown[]>) | undefined)?.call(iter);
          break;
        }
        buffer.push(encodeRow(next.value));
      }
      if (overflow) {
        notices.push(
          `Result exceeded ${MAX_BUFFERED_ROWS.toLocaleString('en-US')} buffered rows and was cut short; add a LIMIT or export with stream().`,
        );
      }
      if (buffer.length > 0) {
        cursorId = randomUUID();
        cursors.set(cursorId, {
          id: cursorId,
          statement: p.sql,
          columns,
          iter: null,
          handle: null,
          buffer,
          pos: 0,
          pending: null,
          exhausted: true,
        });
      } else {
        truncated = false;
      }
    }
  } else if (readHandle) {
    releaseRead(readHandle);
  }

  refineColumnTypes(columns, raw);

  const edit = detectEditability(defs, columns.map((c) => c.name));
  if (edit.editTarget) {
    for (const c of columns) {
      if (edit.editTarget.keyColumns.includes(c.name)) c.isKey = true;
    }
  }

  return {
    statement: p.sql,
    columns,
    rows,
    truncated,
    cursorId,
    durationMs: performance.now() - t0,
    notices: notices.length > 0 ? notices : undefined,
    editTarget: edit.editTarget,
    readOnlyReason: edit.readOnlyReason,
  };
}

function cursorFetch(cursorId: string, n: number): ResultChunk {
  const c = cursors.get(cursorId);
  if (!c) {
    throw new Error(
      `Cursor ${cursorId} is gone. It was closed, or the SQLite worker restarted (a cancel restarts it).`,
    );
  }
  const rows: Row[] = [];
  if (c.buffer) {
    const end = Math.min(c.buffer.length, c.pos + n);
    for (let i = c.pos; i < end; i++) rows.push(c.buffer[i]);
    c.pos = end;
    const truncated = c.pos < c.buffer.length;
    if (!truncated) closeCursor(cursorId);
    return { rows, truncated };
  }

  if (c.pending) {
    rows.push(c.pending);
    c.pending = null;
  }
  while (rows.length < n && c.iter) {
    const next = c.iter.next();
    if (next.done) {
      c.exhausted = true;
      break;
    }
    rows.push(encodeRow(next.value));
  }
  const truncated = !c.exhausted;
  if (!truncated) closeCursor(cursorId);
  return { rows, truncated };
}

function closeCursor(cursorId: string): void {
  const c = cursors.get(cursorId);
  if (!c) return;
  cursors.delete(cursorId);
  if (c.iter && !c.exhausted) {
    // Releasing the iterator is what un-busies the handle.
    (c.iter.return as (() => IteratorResult<unknown[]>) | undefined)?.call(c.iter);
  }
  if (c.handle) releaseRead(c.handle);
}

// ---------------------------------------------------------------------------
// Scripts, changesets, explain, backup
// ---------------------------------------------------------------------------

function execScript(statements: string[]): { statements: number; durationMs: number; notices: string[] } {
  const t0 = performance.now();
  const handle = database();
  const notices: string[] = [];
  const fkBefore = toNum(handle.pragma('foreign_keys', { simple: true }) as number | bigint) === 1;
  let count = 0;
  try {
    for (const raw of statements) {
      const sql = raw.trim();
      if (sql === '' || isCommentOnly(sql)) continue;
      const stmt = handle.prepare(sql);
      if (stmt.reader) {
        const rows = stmt.raw(true).all() as unknown[][];
        // Step 10 of the rebuild is only useful if somebody reads the answer.
        if (/foreign_key_check/i.test(statementBody(sql)) && rows.length > 0) {
          throw new Error(
            `PRAGMA foreign_key_check reported ${rows.length} violation(s); the change was rolled back. First: ${JSON.stringify(
              rows[0].map((v) => (typeof v === 'bigint' ? Number(v) : v)),
            )}`,
          );
        }
        if (rows.length > 0) notices.push(`${statementBody(sql).slice(0, 60)} → ${rows.length} row(s)`);
      } else {
        stmt.run();
      }
      count++;
    }
    return { statements: count, durationMs: performance.now() - t0, notices };
  } catch (e) {
    // Leave nothing half-applied and no pragma flipped behind us.
    if (handle.inTransaction) {
      try {
        handle.prepare('ROLLBACK').run();
      } catch {
        /* nothing to roll back */
      }
    }
    try {
      handle.pragma(`foreign_keys = ${fkBefore ? 'ON' : 'OFF'}`);
      handle.pragma('legacy_alter_table = OFF');
    } catch {
      /* best effort */
    }
    throw e;
  }
}

function applyChangeset(statements: ChangeStatement[]): ApplyResult {
  const t0 = performance.now();
  const handle = database();
  let applied = 0;
  // One transaction, with an affected-rows sanity check that aborts on any
  // mismatch — a WHERE that matches more rows than expected is a data-loss bug.
  const run = handle.transaction((list: ChangeStatement[]) => {
    for (const s of list) {
      const info = handle.prepare(s.sql).run(...s.params.map(toBinding));
      const changes = toNum(info.changes);
      if (changes !== s.expected) {
        throw new Error(
          `Aborted: a statement affected ${changes} row(s) but ${s.expected} was expected. Nothing was committed.\n${s.sql}`,
        );
      }
      applied += changes;
    }
  });
  run(statements);
  return { applied, statements: statements.length, durationMs: performance.now() - t0 };
}

function explain(sql: string, analyze: boolean, params?: unknown[]): ExplainPlan {
  const handle = database();
  const binds = (params ?? []).map(toBinding);
  const rows = handle
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .raw(true)
    .all(...binds) as unknown[][];

  const root: ExplainNode = { label: 'QUERY PLAN', children: [] };
  const byId = new Map<number, ExplainNode>([[0, root]]);
  const lines: string[] = [];
  for (const r of rows) {
    const id = toNum(r[0] as number | bigint);
    const parent = toNum(r[1] as number | bigint);
    const detail = String(r[3] ?? '');
    lines.push(`${id}|${parent}|${detail}`);
    const node: ExplainNode = { label: detail, children: [] };
    // SQLite puts the estimated row count in the detail text, e.g. "(~4 rows)".
    const est = /\(~(\d+) rows?\)/.exec(detail);
    if (est) node.estimatedRows = Number.parseInt(est[1], 10);
    byId.set(id, node);
    (byId.get(parent) ?? root).children.push(node);
  }

  const plan: ExplainPlan = {
    engine: 'sqlite',
    analyzed: false,
    root,
    raw: lines.join('\n'),
  };

  if (analyze) {
    // SQLite has no EXPLAIN ANALYZE. Run the statement for real inside a
    // savepoint that is always rolled back, and report the measured numbers.
    const sp = 'dbadmin_explain_analyze';
    handle.prepare(`SAVEPOINT ${sp}`).run();
    try {
      const t0 = performance.now();
      const stmt = handle.prepare(sql);
      let produced = 0;
      if (stmt.reader) {
        stmt.raw(true);
        const it = stmt.iterate(...binds) as unknown as Iterator<unknown[]>;
        for (;;) {
          const n = it.next();
          if (n.done) break;
          produced++;
        }
      } else {
        produced = toNum(stmt.run(...binds).changes);
      }
      plan.totalTimeMs = performance.now() - t0;
      plan.analyzed = true;
      root.actualRows = produced;
      root.actualTimeMs = plan.totalTimeMs;
      root.loops = 1;
    } finally {
      handle.prepare(`ROLLBACK TO ${sp}`).run();
      handle.prepare(`RELEASE ${sp}`).run();
    }
  }

  return plan;
}

function objectDdl(schema: string, kind: 'table' | 'view' | 'index' | 'database', name: string): string {
  const handle = database();
  if (kind === 'database') {
    const rows = handle
      .prepare(
        `SELECT sql FROM ${quoteIdent(schema)}.sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name`,
      )
      .pluck()
      .all() as string[];
    return rows.map((s) => `${s};`).join('\n\n');
  }
  if (kind === 'table' || kind === 'view') {
    const own = handle
      .prepare(`SELECT sql FROM ${quoteIdent(schema)}.sqlite_master WHERE type = ? AND name = ?`)
      .pluck()
      .get(kind, name) as string | undefined;
    if (!own) throw new Error(`No ${kind} named ${name} in ${schema}`);
    const parts = [`${own};`];
    if (kind === 'table') {
      const deps = handle
        .prepare(
          `SELECT sql FROM ${quoteIdent(schema)}.sqlite_master
            WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name`,
        )
        .pluck()
        .all(name) as string[];
      for (const d of deps) parts.push(`${d};`);
    }
    return parts.join('\n');
  }
  const sql = handle
    .prepare(`SELECT sql FROM ${quoteIdent(schema)}.sqlite_master WHERE type = 'index' AND name = ?`)
    .pluck()
    .get(name) as string | null | undefined;
  if (sql === undefined) throw new Error(`No index named ${name} in ${schema}`);
  if (sql === null) {
    return `-- ${name} is created implicitly by a PRIMARY KEY or UNIQUE constraint and has no CREATE INDEX statement.`;
  }
  return `${sql};`;
}

function rebuildContext(schema: string, table: string): RebuildContextReply {
  const handle = database();
  const objects = listObjects(handle, schema, ['trigger', 'view']);
  const triggers = objects
    .filter((o) => o.type === 'trigger' && o.tblName === table && o.sql)
    .map((o) => ({ name: o.name, sql: o.sql as string }));
  // A view "depends on" the table if it mentions it; SQLite records no
  // dependency graph, so this is the only signal available.
  const needle = new RegExp(`(^|[^A-Za-z0-9_])"?${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?($|[^A-Za-z0-9_])`, 'i');
  const views = objects
    .filter((o) => o.type === 'view' && o.sql && needle.test(o.sql))
    .map((o) => ({ name: o.name, sql: o.sql as string }));
  return {
    triggers,
    views,
    foreignKeysEnabled: toNum(handle.pragma('foreign_keys', { simple: true }) as number | bigint) === 1,
    sqliteVersion,
  };
}

async function backup(dest: string, id: number, attached?: string): Promise<{ totalPages: number }> {
  const handle = database();
  // PLAN §7.5: the online backup API is the right "export database" for SQLite —
  // consistent, non-blocking for writers, and safe on a WAL database where a
  // plain file copy would miss the -wal/-shm sidecars.
  // `attached` selects which attached database to copy; better-sqlite3 supports
  // it but its published types predate the option, hence the widened literal.
  const options: Database.BackupOptions & { attached?: string } = {
    progress: ({ totalPages, remainingPages }) => {
      post({ kind: 'progress', id, done: totalPages - remainingPages, total: totalPages });
      return 200; // pages per cycle: small enough to report progress, large enough to be fast
    },
  };
  if (attached) options.attached = attached;
  const meta = await handle.backup(dest, options);
  return { totalPages: meta.totalPages };
}

function sessionCommand(cmd: 'begin' | 'commit' | 'rollback'): { inTransaction: boolean } {
  const handle = database();
  if (cmd === 'begin' && handle.inTransaction) {
    throw new Error(
      'This SQLite connection already has an open transaction. SQLite allows one writer per connection, so pin one session at a time.',
    );
  }
  if (cmd !== 'begin' && !handle.inTransaction) {
    return { inTransaction: false };
  }
  handle.prepare(cmd.toUpperCase()).run();
  if (cmd === 'begin') drainReadPool(); // snapshots taken now would miss our writes
  return { inTransaction: handle.inTransaction };
}

function describeOpen(p: OpenPayload, notices: string[]): OpenInfo {
  const handle = database();
  sqliteVersion = String(handle.prepare('SELECT sqlite_version()').pluck().get());
  let sizeBytes: number | undefined;
  if (!p.memory) {
    try {
      sizeBytes = statSync(p.file).size;
    } catch {
      sizeBytes = undefined;
    }
  }
  return {
    version: sqliteVersion,
    file: p.file,
    readonly: p.readonly,
    memory: p.memory,
    journalMode: String(handle.pragma('journal_mode', { simple: true })),
    pageSize: toNum(handle.pragma('page_size', { simple: true }) as number | bigint),
    encoding: String(handle.pragma('encoding', { simple: true })),
    foreignKeys: toNum(handle.pragma('foreign_keys', { simple: true }) as number | bigint) === 1,
    sizeBytes,
    databases: listDatabases(handle),
    notices,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(msg: WorkerRequest): Promise<unknown> {
  switch (msg.op) {
    case 'open': {
      const { handle, notices } = openPrimary(msg.payload);
      db = handle;
      opened = msg.payload;
      return describeOpen(msg.payload, notices);
    }
    case 'ping': {
      if (!opened) throw new Error('SQLite connection is not open');
      return describeOpen(opened, []);
    }
    case 'query':
      return runQuery(msg.payload);
    case 'cursorFetch':
      return cursorFetch(msg.payload.cursorId, msg.payload.n);
    case 'cursorClose':
      closeCursor(msg.payload.cursorId);
      return { ok: true };
    case 'execScript':
      return execScript(msg.payload.statements);
    case 'introspect':
      return introspect(database(), msg.payload.scope) satisfies SchemaModel;
    case 'explain':
      return explain(msg.payload.sql, msg.payload.analyze, msg.payload.params);
    case 'catalogDatabases':
      return listDatabases(database());
    case 'catalogObjects':
      return listObjects(database(), msg.payload.schema, msg.payload.types);
    case 'tableFacts':
      return tableFacts(database(), msg.payload.schema, msg.payload.table);
    case 'objectDdl':
      return { sql: objectDdl(msg.payload.schema, msg.payload.kind, msg.payload.name) };
    case 'rebuildContext':
      return rebuildContext(msg.payload.schema, msg.payload.table);
    case 'applyChangeset':
      return applyChangeset(msg.payload.statements);
    case 'backup':
      return backup(msg.payload.dest, msg.id, msg.payload.attached);
    case 'attach': {
      database()
        .prepare(`ATTACH DATABASE ? AS ${quoteIdent(msg.payload.alias)}`)
        .run(msg.payload.path);
      if (opened) opened.attach = [...opened.attach.filter((a) => a.alias !== msg.payload.alias), msg.payload];
      drainReadPool(); // pooled handles do not have the new alias attached
      return listDatabases(database());
    }
    case 'detach': {
      database().prepare(`DETACH DATABASE ${quoteIdent(msg.payload.alias)}`).run();
      if (opened) opened.attach = opened.attach.filter((a) => a.alias !== msg.payload.alias);
      drainReadPool();
      return listDatabases(database());
    }
    case 'session':
      return sessionCommand(msg.payload.cmd);
    case 'close': {
      for (const id of [...cursors.keys()]) closeCursor(id);
      drainReadPool();
      db?.close();
      db = null;
      return { ok: true };
    }
    default: {
      const never: never = msg;
      throw new Error(`Unknown SQLite worker op: ${JSON.stringify(never)}`);
    }
  }
}

function serializeError(e: unknown): WireError {
  if (e instanceof Error) {
    const code = (e as Error & { code?: string }).code;
    return { message: e.message, code, detail: e.stack };
  }
  return { message: String(e) };
}

// `parentPort` is null when this module is loaded on the main thread (only ever
// for its types), so the worker loop simply does not start there.
if (parentPort) {
  parentPort.on('message', (msg: WorkerRequest) => {
    void (async () => {
      try {
        const result = await dispatch(msg);
        post({ kind: 'reply', id: msg.id, ok: true, result });
      } catch (e) {
        post({ kind: 'reply', id: msg.id, ok: false, error: serializeError(e) });
      }
    })();
  });
}
