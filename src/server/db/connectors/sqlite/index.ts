/**
 * The SQLite `SqlConnector` (PLAN §4, §6 "SQLite's four traps").
 *
 * SQLite is the useful stress test of the connector abstraction: no host, no
 * port, no user, no password, no pool and no tunnel — the target is a file path
 * (or `:memory:`). Everything here runs on the MAIN thread and owns exactly one
 * `worker_thread` (./worker.ts) that holds the synchronous better-sqlite3
 * handle. This module never touches the driver itself; it correlates requests
 * and replies by id, and it is the only place that knows a worker exists.
 *
 * The four traps and where they are handled:
 *   1. synchronous driver  → one worker per connection; `cancel()` terminates
 *      and reopens it, which is the only interrupt better-sqlite3 offers.
 *   2. dynamic typing      → ./worker.ts encodes every CELL from its runtime
 *      type and marks every column `dynamicType`.
 *   3. no real ALTER TABLE → ./ddl.ts generates the 12-step rebuild.
 *   4. single writer       → WAL + busy_timeout, and SQLITE_BUSY comes back as
 *      a sentence, not a stack trace (`toDbError` below).
 *
 * §11: no React, no Next imports.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { Address, ConnectionConfig } from '../../../../lib/connection';
import type {
  IntrospectScope,
  SchemaModel,
  TableModel,
} from '../../../../lib/schema-model';
import type {
  ApplyResult,
  ChangePreview,
  Changeset,
  ChangeOp,
  ExplainPlan,
  ResultChunk,
  ResultSet,
  RunOpts,
  ServerInfo,
  SessionInfo,
  TreeNode,
  TreePath,
} from '../../../../lib/results';
import { base64ToBytes, type Cell, type Row } from '../../../../lib/wire';
import { CONFIG, IS_CONTAINER, resolveWithin } from '../../../config';
import {
  DbError,
  type Capability,
  type ColumnFilter,
  type Connector,
  type ConnectorContext,
  type ConnectorEvent,
  type DdlTarget,
  type SqlConnector,
  type TableReadRequest,
} from '../../types';
import {
  planTableDdl as buildTableDdl,
  quoteBlob,
  quoteIdent,
  quoteLiteral,
  type RebuildContext,
} from './ddl';
import { editKeyFor, type CatalogObject, type TableFacts } from './introspect';
import type {
  ChangeStatement,
  OpenInfo,
  OpenPayload,
  QueryResult,
  RebuildContextReply,
  WireError,
  WorkerMessage,
  WorkerRequest,
} from './worker';

/** Distributive Omit — `Omit` on a union collapses it to the common keys. */
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never;
type WorkerCall = WithoutId<WorkerRequest>;

/** Rows pulled per chunk by `stream()` — flat memory regardless of table size (§6). */
const STREAM_CHUNK = 2_000;

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'sql',
  'transactions',
  'ddl',
  'explain',
  'streaming',
  'cancel',
]);

/** The SQLite connector exposes a few things no other engine has (§7.5). */
export interface SqliteConnector extends SqlConnector {
  /** Online backup — a consistent copy of a live database into one file. */
  backup(
    dest: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ path: string; totalPages: number }>;
  /** Run an already-split script (what `planTableDdl` returns). */
  execScript(statements: string[]): Promise<{ statements: number; durationMs: number; notices: string[] }>;
  attachDatabase(alias: string, file: string): Promise<{ name: string; file: string }[]>;
  detachDatabase(alias: string): Promise<{ name: string; file: string }[]>;
}

export function isSqliteConnector(c: Connector): c is SqliteConnector {
  return c.kind === 'sqlite';
}

// ---------------------------------------------------------------------------
// Address → open payload
// ---------------------------------------------------------------------------

const RESERVED_ALIASES = new Set(['main', 'temp']);

function absolutize(p: string): string {
  // Absolute paths come from the connection form, which browses the container's
  // filesystem; relative ones are confined to the SQLite root (§7.2, §10.4).
  if (path.isAbsolute(p)) return path.normalize(p);
  try {
    return resolveWithin(CONFIG.sqliteRoot, p);
  } catch (e) {
    throw new DbError((e as Error).message, 'PATH_ESCAPE');
  }
}

export function buildOpenPayload(config: ConnectionConfig, address: Address): OpenPayload {
  if (address.kind === 'uri') {
    throw new DbError(
      'This connector opens local SQLite files. Remote SQLite (libsql://, Turso) is a different protocol — see PLAN §8.2.',
      'SQLITE_ADDRESS',
    );
  }
  if (address.kind !== 'file') {
    throw new DbError(
      `SQLite has no host or port: the address must be a file path, not "${address.kind}" (PLAN §4).`,
      'SQLITE_ADDRESS',
    );
  }

  const memory = address.path === ':memory:' || address.path.trim() === '';
  const opts = config.options.driverOptions ?? {};
  const attach = (address.attach ?? []).map((a) => {
    const alias = a.alias.trim();
    if (alias === '' || RESERVED_ALIASES.has(alias.toLowerCase())) {
      throw new DbError(
        `"${a.alias}" cannot be used as an ATTACH alias — main and temp are reserved by SQLite.`,
        'SQLITE_ATTACH',
      );
    }
    return { alias, path: a.path === ':memory:' ? ':memory:' : absolutize(a.path) };
  });

  return {
    file: memory ? ':memory:' : absolutize(address.path),
    memory,
    readonly: address.mode === 'ro',
    // §8.5: a read-only connection is enforced server-side, not just in the UI.
    queryOnly: config.readOnly,
    busyTimeoutMs: Number(opts.busyTimeoutMs ?? 5_000),
    // Trap 4: WAL lets readers and one writer coexist; meaningless for :memory:.
    journalMode: memory ? null : String(opts.journalMode ?? 'WAL'),
    foreignKeys: opts.foreignKeys === undefined ? true : Boolean(opts.foreignKeys),
    attach,
  };
}

const NETWORK_FILESYSTEMS = new Set(['nfs', 'nfs4', 'cifs', 'smbfs', 'smb3', 'afs', 'fuse.sshfs', 'ncpfs']);

/**
 * SQLite's locking is broken over NFS/SMB and will eventually corrupt the file
 * (§8.2). We cannot always detect it, but on Linux `/proc/mounts` tells us — and
 * a warning beats silent corruption.
 */
export function networkFilesystemWarning(file: string): string | null {
  if (file === ':memory:') return null;
  let mounts: string;
  try {
    mounts = readFileSync('/proc/mounts', 'utf8');
  } catch {
    return null; // macOS / non-Linux: no cheap way to ask
  }
  let best: { point: string; type: string } | null = null;
  for (const line of mounts.split('\n')) {
    const [, point, type] = line.split(/\s+/);
    if (!point || !type) continue;
    if (file === point || file.startsWith(point.endsWith('/') ? point : `${point}/`)) {
      if (!best || point.length > best.point.length) best = { point, type };
    }
  }
  if (!best || !NETWORK_FILESYSTEMS.has(best.type)) return null;
  return (
    `${file} is on a ${best.type} mount. SQLite's file locking is unreliable over network filesystems and can corrupt the database. ` +
    'Copy the file locally (or use a server-based engine) instead.'
  );
}

// ---------------------------------------------------------------------------
// Errors (trap 4 lives here)
// ---------------------------------------------------------------------------

function toDbError(e: unknown, busyTimeoutMs = 5_000): DbError {
  if (e instanceof DbError) return e;
  const wire: WireError =
    e && typeof e === 'object' && 'message' in (e as Record<string, unknown>)
      ? {
          message: String((e as Error).message),
          code: (e as Error & { code?: string }).code,
          detail: (e as { detail?: string }).detail ?? (e as Error).stack,
        }
      : { message: String(e) };

  const code = wire.code ?? '';
  const msg = wire.message;

  if (code.startsWith('SQLITE_BUSY') || /database is locked|database table is locked/i.test(msg)) {
    return new DbError(
      `SQLite is locked: another connection or process holds the single write lock. We waited ${busyTimeoutMs} ms (busy_timeout) in WAL mode and gave up. ` +
        'Close the other writer — a long-running transaction, another app, or an open `sqlite3` shell — and run this again.',
      code || 'SQLITE_BUSY',
      wire.detail,
    );
  }
  if (code.startsWith('SQLITE_READONLY') || /attempt to write a readonly database/i.test(msg)) {
    return new DbError(
      'This SQLite connection is read-only, so the write was refused. Change the connection to read-write (or clear its read-only flag) to make changes.',
      code || 'SQLITE_READONLY',
      wire.detail,
    );
  }
  if (code.startsWith('SQLITE_CANTOPEN') || /unable to open database file/i.test(msg)) {
    const advice = IS_CONTAINER
      ? ` Paths are CONTAINER paths (§10.4): the file must be under a mounted directory such as ${CONFIG.sqliteRoot}.`
      : '';
    return new DbError(`SQLite could not open the database file.${advice}`, code || 'SQLITE_CANTOPEN', wire.detail);
  }
  if (code.startsWith('SQLITE_NOTADB') || /file is not a database/i.test(msg)) {
    return new DbError(
      'That file is not a SQLite database (or it is encrypted with SQLCipher, which this build cannot read).',
      code || 'SQLITE_NOTADB',
      wire.detail,
    );
  }
  if (code.startsWith('SQLITE_CORRUPT')) {
    return new DbError(
      `${msg} — if this database lives on a network share, that is the usual cause (PLAN §8.2).`,
      code,
      wire.detail,
    );
  }
  return new DbError(msg, wire.code, wire.detail);
}

// ---------------------------------------------------------------------------
// Worker entry resolution
// ---------------------------------------------------------------------------

function workerEntry(): URL {
  const self = fileURLToPath(import.meta.url);
  const dir = path.dirname(self);
  // Run from source under tsx (.ts) or from build output (.js): prefer whichever
  // extension this module itself was loaded with, then fall back.
  const order = self.endsWith('.ts') ? ['worker.ts', 'worker.js', 'worker.mjs'] : ['worker.js', 'worker.mjs', 'worker.ts'];
  for (const name of order) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return pathToFileURL(candidate);
  }
  throw new DbError(`Could not find the SQLite worker entry next to ${dir}`, 'WORKER_MISSING');
}

// ---------------------------------------------------------------------------
// Changeset → SQL (§6 "Grid editing")
// ---------------------------------------------------------------------------

interface BuiltStatement {
  sql: string;
  params: Cell[];
  expected: number;
  /** Same statement with literals inlined, for the preview pane. */
  display: string;
}

function renderLiteral(c: Cell): string {
  if (c === null) return 'NULL';
  if (typeof c === 'boolean') return c ? '1' : '0';
  if (typeof c === 'number') return Number.isFinite(c) ? String(c) : quoteLiteral(String(c));
  if (typeof c === 'string') return quoteLiteral(c);
  switch (c.$t) {
    case 'bytes':
      return quoteBlob(base64ToBytes(c.v));
    case 'bigint':
    case 'decimal':
      return c.v;
    default:
      return quoteLiteral(c.v);
  }
}

function inline(sql: string, params: Cell[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => renderLiteral(params[i++] ?? null));
}

function whereClause(keyColumns: string[], key: Record<string, Cell>): { sql: string; params: Cell[] } {
  const parts: string[] = [];
  const params: Cell[] = [];
  for (const col of keyColumns) {
    const v = key[col] ?? null;
    if (v === null) {
      parts.push(`${quoteIdent(col)} IS NULL`);
    } else {
      parts.push(`${quoteIdent(col)} = ?`);
      params.push(v);
    }
  }
  return { sql: parts.join(' AND '), params };
}

export function buildChangeStatements(cs: Changeset): { statements: BuiltStatement[]; warnings: string[] } {
  const warnings: string[] = [];
  const target = cs.schema ? `${quoteIdent(cs.schema)}.${quoteIdent(cs.table)}` : quoteIdent(cs.table);
  const statements: BuiltStatement[] = [];

  if (cs.keyColumns.length === 0 && cs.changes.some((c) => c.op !== 'insert')) {
    throw new DbError(
      `Cannot update or delete rows in ${cs.table}: no primary key or unique index identifies a row (PLAN §6 "Grid editing").`,
      'NO_ROW_KEY',
    );
  }

  const push = (sql: string, params: Cell[], expected: number): void => {
    statements.push({ sql, params, expected, display: inline(sql, params) });
  };

  for (const change of cs.changes as ChangeOp[]) {
    if (change.op === 'insert') {
      const cols = Object.keys(change.values);
      if (cols.length === 0) {
        push(`INSERT INTO ${target} DEFAULT VALUES`, [], 1);
        continue;
      }
      const sql = `INSERT INTO ${target} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols
        .map(() => '?')
        .join(', ')})`;
      push(sql, cols.map((c) => change.values[c]), 1);
      continue;
    }

    const where = whereClause(cs.keyColumns, change.key);
    if (cs.keyColumns.some((c) => (change.key[c] ?? null) === null)) {
      warnings.push(
        `A NULL key value is matched with IS NULL; if several rows share it the affected-row check will abort the apply.`,
      );
    }

    if (change.op === 'delete') {
      push(`DELETE FROM ${target} WHERE ${where.sql}`, where.params, 1);
      continue;
    }

    const cols = Object.keys(change.values);
    if (cols.length === 0) {
      warnings.push('An update with no changed columns was skipped.');
      continue;
    }
    const sql = `UPDATE ${target} SET ${cols.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE ${where.sql}`;
    push(sql, [...cols.map((c) => change.values[c]), ...where.params], 1);
  }

  return { statements, warnings };
}

// ---------------------------------------------------------------------------
// Filters (server-side, always parameterized — §9)
// ---------------------------------------------------------------------------

function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function filterSql(f: ColumnFilter, params: Cell[]): string {
  const col = quoteIdent(f.column);
  const v = f.value ?? null;
  switch (f.op) {
    case 'eq':
      if (v === null) return `${col} IS NULL`;
      params.push(v);
      return `${col} = ?`;
    case 'ne':
      if (v === null) return `${col} IS NOT NULL`;
      params.push(v);
      return `(${col} IS NULL OR ${col} <> ?)`;
    case 'lt':
      params.push(v);
      return `${col} < ?`;
    case 'lte':
      params.push(v);
      return `${col} <= ?`;
    case 'gt':
      params.push(v);
      return `${col} > ?`;
    case 'gte':
      params.push(v);
      return `${col} >= ?`;
    case 'contains':
      params.push(`%${escapeLike(String(v ?? ''))}%`);
      return `${col} LIKE ? ESCAPE '\\'`;
    case 'startsWith':
      params.push(`${escapeLike(String(v ?? ''))}%`);
      return `${col} LIKE ? ESCAPE '\\'`;
    case 'endsWith':
      params.push(`%${escapeLike(String(v ?? ''))}`);
      return `${col} LIKE ? ESCAPE '\\'`;
    case 'isNull':
      return `${col} IS NULL`;
    case 'isNotNull':
      return `${col} IS NOT NULL`;
    case 'in': {
      const values = f.values ?? [];
      if (values.length === 0) return '0 = 1';
      for (const x of values) params.push(x);
      return `${col} IN (${values.map(() => '?').join(', ')})`;
    }
    case 'between':
      params.push(v, f.value2 ?? null);
      return `${col} BETWEEN ? AND ?`;
    default:
      throw new DbError(`Unsupported filter operator: ${String(f.op)}`, 'BAD_FILTER');
  }
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function parseSegment(s: string): { kind: string; name: string } {
  const i = s.indexOf(':');
  return i < 0 ? { kind: s, name: '' } : { kind: s.slice(0, i), name: s.slice(i + 1) };
}

function childId(segments: string[], child: string): string {
  return [...segments, child].join('/');
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  runId?: string;
}

class SqliteConnectorImpl implements SqliteConnector {
  readonly kind = 'sqlite' as const;
  readonly capabilities = CAPABILITIES;

  private readonly openPayload: OpenPayload;
  private worker: Worker | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** runId → in-flight request ids, so `cancel()` knows whether to restart. */
  private readonly runs = new Map<string, Set<number>>();
  private readonly progress = new Map<number, (done: number, total: number) => void>();
  private readonly sessions = new Map<string, SessionInfo>();
  private info: OpenInfo | null = null;

  constructor(private readonly ctx: ConnectorContext) {
    this.openPayload = buildOpenPayload(ctx.config, ctx.resolved.address);
  }

  // -- plumbing ------------------------------------------------------------

  private emit(e: ConnectorEvent): void {
    this.ctx.onEvent?.(e);
  }

  private send<T>(
    worker: Worker,
    call: WorkerCall,
    runId?: string,
    register?: (id: number) => void,
  ): Promise<T> {
    const id = this.nextId++;
    register?.(id);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, runId });
      if (runId) {
        const set = this.runs.get(runId) ?? new Set<number>();
        set.add(id);
        this.runs.set(runId, set);
      }
      try {
        worker.postMessage({ id, ...call } as unknown as WorkerRequest);
      } catch (e) {
        this.pending.delete(id);
        reject(toDbError(e, this.openPayload.busyTimeoutMs));
      }
    });
  }

  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    this.progress.delete(id);
    if (p.runId) {
      const set = this.runs.get(p.runId);
      set?.delete(id);
      if (set && set.size === 0) this.runs.delete(p.runId);
    }
    return p;
  }

  private onMessage(worker: Worker, msg: WorkerMessage): void {
    if (this.worker !== worker) return; // a terminated worker's last words
    if (msg.kind === 'notice') {
      this.emit({ type: 'notice', message: msg.message });
      return;
    }
    if (msg.kind === 'progress') {
      this.progress.get(msg.id)?.(msg.done, msg.total);
      return;
    }
    const p = this.settle(msg.id);
    if (!p) return;
    if (msg.ok) p.resolve(msg.result);
    else p.reject(toDbError(msg.error, this.openPayload.busyTimeoutMs));
  }

  private failAll(make: (runId?: string) => DbError): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    this.runs.clear();
    this.progress.clear();
    for (const [, p] of entries) p.reject(make(p.runId));
  }

  private async startWorker(): Promise<void> {
    this.emit({ type: 'state', state: 'connecting' });
    const warning = networkFilesystemWarning(this.openPayload.file);
    if (warning) this.emit({ type: 'notice', message: warning });

    const worker = new Worker(workerEntry(), { name: `sqlite:${this.ctx.config.name}` });
    this.worker = worker;
    worker.on('message', (m: WorkerMessage) => this.onMessage(worker, m));
    worker.on('error', (e: Error) => this.onWorkerDown(worker, `SQLite worker crashed: ${e.message}`));
    worker.on('exit', (code: number) => {
      if (code !== 0) this.onWorkerDown(worker, `SQLite worker exited with code ${code}.`);
    });

    try {
      const info = await this.send<OpenInfo>(worker, { op: 'open', payload: this.openPayload });
      this.info = info;
      for (const n of info.notices) this.emit({ type: 'notice', message: n });
      this.emit({ type: 'state', state: 'connected' });
    } catch (e) {
      this.worker = null;
      void worker.terminate().catch(() => undefined);
      throw toDbError(e, this.openPayload.busyTimeoutMs);
    }
  }

  private onWorkerDown(worker: Worker, message: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.info = null;
    for (const s of this.sessions.values()) {
      s.inTransaction = false;
      s.autoCommit = true;
    }
    this.failAll(() => new DbError(message, 'WORKER_DOWN'));
    this.emit({ type: 'state', state: this.closed ? 'closed' : 'reconnecting', message });
  }

  private ensureWorker(): Promise<void> {
    if (this.closed) return Promise.reject(new DbError('This SQLite connection is closed.', 'CLOSED'));
    if (this.worker) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.startWorker().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async call<T>(call: WorkerCall, runId?: string): Promise<T> {
    await this.ensureWorker();
    const worker = this.worker;
    if (!worker) throw new DbError('The SQLite worker is not running.', 'WORKER_DOWN');
    return this.send<T>(worker, call, runId);
  }

  /**
   * Trap 1: terminating the thread is the only interrupt better-sqlite3 offers,
   * so cancel means "kill the worker and reopen the file". Everything in flight
   * fails with a sentence saying so, and open cursors die with it.
   */
  private async restart(reason: (runId?: string) => DbError): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.info = null;
    for (const s of this.sessions.values()) {
      s.inTransaction = false;
      s.autoCommit = true;
    }
    this.failAll(reason);
    if (worker) {
      // A thread blocked inside a native sqlite3_step only stops when it returns
      // to JS, so do not wait on terminate() forever — abandon it and move on.
      worker.unref();
      void worker.terminate().catch(() => undefined);
    }
    if (!this.closed) await this.ensureWorker();
  }

  /** Wires `RunOpts.signal` to `cancel()`; every remote op needs a cancel (§8.3). */
  private wireAbort(opts: RunOpts, runId: string): () => void {
    const signal = opts.signal;
    if (!signal) return () => undefined;
    if (signal.aborted) throw new DbError('Cancelled before the statement started.', 'DBADMIN_CANCELLED');
    const onAbort = (): void => {
      void this.cancel(runId);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  // -- Connector -----------------------------------------------------------

  async open(): Promise<void> {
    await this.ensureWorker();
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (worker) {
      try {
        await this.send(worker, { op: 'close' });
      } catch {
        /* the worker may already be gone */
      }
      this.worker = null;
      await worker.terminate().catch(() => undefined);
    }
    this.failAll(() => new DbError('The SQLite connection was closed.', 'CLOSED'));
    this.sessions.clear();
    this.emit({ type: 'state', state: 'closed' });
    await this.ctx.resolved.release();
  }

  async ping(): Promise<ServerInfo> {
    const started = performance.now();
    const info = await this.call<OpenInfo>({ op: 'ping' });
    this.info = info;
    const details: Record<string, string> = {
      file: info.file,
      journalMode: info.journalMode,
      pageSize: String(info.pageSize),
      encoding: info.encoding,
      foreignKeys: info.foreignKeys ? 'on' : 'off',
      readOnly: info.readonly || this.openPayload.queryOnly ? 'yes' : 'no',
      attached: info.databases.map((d) => d.name).join(', '),
    };
    if (info.sizeBytes !== undefined) details.sizeBytes = String(info.sizeBytes);
    return {
      version: info.version,
      edition: info.memory ? 'in-memory' : 'file',
      // The "round trip" is a postMessage to our own worker: microseconds, not
      // milliseconds, which is exactly why SQLite gets bigger page sizes (§8.3).
      rttMs: performance.now() - started,
      details,
    };
  }

  async listNodes(treePath: TreePath): Promise<TreeNode[]> {
    const segs = treePath.segments;
    if (segs.length === 0) {
      const dbs = await this.call<{ name: string; file: string }[]>({ op: 'catalogDatabases' });
      return dbs.map((d) => ({
        id: `db:${d.name}`,
        kind: 'database' as const,
        label: d.name,
        detail: d.file || 'in-memory',
        hasChildren: true,
        meta: { schema: d.name, file: d.file },
      }));
    }

    const first = parseSegment(segs[0]);
    const schema = first.name || 'main';

    if (segs.length === 1) {
      return [
        { id: childId(segs, 'table-folder'), kind: 'table-folder', label: 'Tables', hasChildren: true, meta: { schema } },
        { id: childId(segs, 'view-folder'), kind: 'view-folder', label: 'Views', hasChildren: true, meta: { schema } },
        { id: childId(segs, 'index-folder'), kind: 'index-folder', label: 'Indexes', hasChildren: true, meta: { schema } },
        { id: childId(segs, 'trigger-folder'), kind: 'trigger-folder', label: 'Triggers', hasChildren: true, meta: { schema } },
      ];
    }

    const second = parseSegment(segs[1]);
    const objects = async (types: CatalogObject['type'][]): Promise<CatalogObject[]> =>
      this.call<CatalogObject[]>({ op: 'catalogObjects', payload: { schema, types } });

    if (second.kind === 'table-folder' || second.kind === 'view-folder') {
      const isView = second.kind === 'view-folder';
      const list = await objects([isView ? 'view' : 'table']);
      return list.map((o) => ({
        id: childId(segs, `${isView ? 'view' : 'table'}:${o.name}`),
        kind: isView ? ('view' as const) : ('table' as const),
        label: o.name,
        hasChildren: true,
        meta: { schema, table: o.name, kind: o.type },
      }));
    }

    if (second.kind === 'index-folder' && segs.length === 2) {
      const list = await objects(['index']);
      return list.map((o) => ({
        id: childId(segs, `index:${o.name}`),
        kind: 'index' as const,
        label: o.name,
        detail: o.tblName,
        hasChildren: false,
        meta: { schema, table: o.tblName, index: o.name },
      }));
    }

    if (second.kind === 'trigger-folder') {
      const list = await objects(['trigger']);
      return list.map((o) => ({
        id: childId(segs, `trigger:${o.name}`),
        kind: 'trigger' as const,
        label: o.name,
        detail: o.tblName,
        hasChildren: false,
        meta: { schema, table: o.tblName, trigger: o.name },
      }));
    }

    if (second.kind === 'table' || second.kind === 'view') {
      const table = second.name;
      if (segs.length === 2) {
        const nodes: TreeNode[] = [
          { id: childId(segs, 'column-folder'), kind: 'column-folder', label: 'Columns', hasChildren: true, meta: { schema, table } },
        ];
        if (second.kind === 'table') {
          nodes.push({
            id: childId(segs, 'index-folder'),
            kind: 'index-folder',
            label: 'Keys & indexes',
            hasChildren: true,
            meta: { schema, table },
          });
        }
        return nodes;
      }
      const facts = await this.call<TableFacts>({ op: 'tableFacts', payload: { schema, table } });
      const third = parseSegment(segs[2]);
      if (third.kind === 'column-folder') {
        const pk = new Set(facts.primaryKey);
        return facts.columns.map((c) => ({
          id: childId(segs, `column:${c.name}`),
          kind: 'column' as const,
          label: c.name,
          detail: `${c.type.raw || 'ANY'}${c.nullable ? '' : ' NOT NULL'}${pk.has(c.name) ? ' PK' : ''}`,
          hasChildren: false,
          meta: { schema, table, column: c.name, base: c.type.base },
        }));
      }
      if (third.kind === 'index-folder') {
        const nodes: TreeNode[] = facts.indexes.map((i) => ({
          id: childId(segs, `index:${i.name}`),
          kind: 'index' as const,
          label: i.name,
          detail: `${i.primary ? 'PRIMARY ' : i.unique ? 'UNIQUE ' : ''}(${i.columns
            .map((c) => c.name ?? c.expression ?? '?')
            .join(', ')})`,
          hasChildren: false,
          meta: { schema, table, index: i.name },
        }));
        for (const fk of facts.foreignKeys) {
          nodes.push({
            id: childId(segs, `foreign-key:${fk.name}`),
            kind: 'foreign-key',
            label: fk.columns.join(', '),
            detail: `→ ${fk.refTable}(${fk.refColumns.join(', ')})`,
            hasChildren: false,
            meta: { schema, table, foreignKey: fk.name },
          });
        }
        return nodes;
      }
    }

    return [];
  }

  // -- SqlConnector --------------------------------------------------------

  async query(sql: string, opts: RunOpts = {}): Promise<ResultSet> {
    const runId = opts.runId ?? randomUUID();
    const unwire = this.wireAbort(opts, runId);
    try {
      return await this.call<QueryResult>(
        {
          op: 'query',
          payload: { sql, params: opts.params, maxRows: opts.maxRows ?? CONFIG.defaultPageSize },
        },
        runId,
      );
    } finally {
      unwire();
    }
  }

  async fetchMore(cursorId: string, n: number): Promise<ResultChunk> {
    return this.call<ResultChunk>({ op: 'cursorFetch', payload: { cursorId, n } });
  }

  async closeCursor(cursorId: string): Promise<void> {
    await this.call({ op: 'cursorClose', payload: { cursorId } });
  }

  /** Unbounded, chunk-pulled streaming for export/copy — never buffers (§6, §7.4). */
  async *stream(sql: string, opts: RunOpts = {}): AsyncIterable<Row[]> {
    const runId = opts.runId ?? randomUUID();
    const chunk = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : STREAM_CHUNK;
    const unwire = this.wireAbort(opts, runId);
    let cursorId: string | undefined;
    let truncated = false;
    try {
      const first = await this.call<QueryResult>(
        { op: 'query', payload: { sql, params: opts.params, maxRows: chunk } },
        runId,
      );
      cursorId = first.cursorId;
      truncated = first.truncated;
      if (first.rows.length > 0) yield first.rows;
      while (truncated && cursorId) {
        const next = await this.call<ResultChunk>(
          { op: 'cursorFetch', payload: { cursorId, n: chunk } },
          runId,
        );
        truncated = next.truncated;
        if (next.rows.length > 0) yield next.rows;
      }
      cursorId = undefined;
    } finally {
      unwire();
      // The consumer may have stopped early (a cancelled export); free the
      // cursor's read handle rather than waiting for the worker to die.
      if (cursorId) await this.closeCursor(cursorId).catch(() => undefined);
    }
  }

  async cancel(runId: string): Promise<void> {
    const inFlight = this.runs.get(runId);
    if (!inFlight || inFlight.size === 0) return;
    await this.restart((pendingRun) =>
      pendingRun === runId
        ? new DbError(
            'Cancelled. SQLite has no query interrupt, so the connection’s worker was terminated and reopened.',
            'DBADMIN_CANCELLED',
          )
        : new DbError(
            'Interrupted: another statement on this SQLite connection was cancelled, which restarts the shared worker. Run it again.',
            'DBADMIN_INTERRUPTED',
          ),
    );
  }

  async introspect(scope: IntrospectScope = {}): Promise<SchemaModel> {
    return this.call<SchemaModel>({ op: 'introspect', payload: { scope } });
  }

  async readTable(req: TableReadRequest): Promise<ResultSet> {
    const schema = req.schema ?? 'main';
    const facts = await this.call<TableFacts>({ op: 'tableFacts', payload: { schema, table: req.table } });
    if (facts.kind === null) throw new DbError(`No table or view named ${schema}.${req.table}`, 'NO_SUCH_TABLE');

    const wanted = req.columns?.length ? req.columns : facts.columns.map((c) => c.name);
    const projection = wanted.map(quoteIdent);
    const key = editKeyFor(facts);
    // A table with no PK/unique index is still editable through SQLite's
    // implicit rowid — but only if the grid can see it (§6 "Grid editing").
    if (key?.kind === 'rowid' && !wanted.includes('rowid')) projection.unshift(quoteIdent('rowid'));

    const params: Cell[] = [];
    const conditions: string[] = [];
    for (const f of req.filters ?? []) conditions.push(filterSql(f, params));
    if (req.where && req.where.trim() !== '') conditions.push(`(${req.where})`);

    const order = (req.orderBy ?? [])
      .map((o) => `${quoteIdent(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`)
      .join(', ');

    const sql =
      `SELECT ${projection.join(', ')} FROM ${quoteIdent(schema)}.${quoteIdent(req.table)}` +
      (conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '') +
      (order ? ` ORDER BY ${order}` : '') +
      ` LIMIT ${Math.max(0, Math.floor(req.limit))} OFFSET ${Math.max(0, Math.floor(req.offset))}`;

    return this.query(sql, { params, maxRows: Math.max(1, Math.floor(req.limit)) });
  }

  async countTable(req: Omit<TableReadRequest, 'offset' | 'limit' | 'orderBy'>): Promise<number> {
    const schema = req.schema ?? 'main';
    const params: Cell[] = [];
    const conditions: string[] = [];
    for (const f of req.filters ?? []) conditions.push(filterSql(f, params));
    if (req.where && req.where.trim() !== '') conditions.push(`(${req.where})`);
    const sql =
      `SELECT COUNT(*) FROM ${quoteIdent(schema)}.${quoteIdent(req.table)}` +
      (conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '');
    const res = await this.query(sql, { params, maxRows: 1 });
    const cell = res.rows[0]?.[0] ?? 0;
    if (typeof cell === 'number') return cell;
    if (typeof cell === 'string') return Number(cell);
    if (cell && typeof cell === 'object' && '$t' in cell) return Number(cell.v);
    return 0;
  }

  async generateDdl(target: DdlTarget): Promise<string> {
    const schema = ('schema' in target ? target.schema : undefined) ?? 'main';
    switch (target.type) {
      case 'table':
      case 'view':
        return (await this.call<{ sql: string }>({ op: 'objectDdl', payload: { schema, kind: target.type, name: target.name } })).sql;
      case 'index':
        return (await this.call<{ sql: string }>({ op: 'objectDdl', payload: { schema, kind: 'index', name: target.name } })).sql;
      case 'database':
        return (await this.call<{ sql: string }>({ op: 'objectDdl', payload: { schema: target.name, kind: 'database', name: target.name } })).sql;
      case 'routine':
        throw new DbError(
          'SQLite has no stored functions or procedures, so there is no routine DDL to generate.',
          'UNSUPPORTED',
        );
    }
  }

  async previewChangeset(cs: Changeset): Promise<ChangePreview> {
    const { statements, warnings } = buildChangeStatements(cs);
    return {
      statements: statements.map((s) => s.display),
      expectedAffected: statements.map((s) => s.expected),
      warnings,
    };
  }

  async applyChangeset(cs: Changeset): Promise<ApplyResult> {
    const { statements } = buildChangeStatements(cs);
    if (statements.length === 0) return { applied: 0, statements: 0, durationMs: 0 };
    const payload: ChangeStatement[] = statements.map((s) => ({
      sql: s.sql,
      params: s.params,
      expected: s.expected,
    }));
    return this.call<ApplyResult>({ op: 'applyChangeset', payload: { statements: payload } });
  }

  /**
   * Trap 3. Everything beyond add/rename/drop-column becomes the documented
   * 12-step rebuild, and the caller shows the script before running it.
   */
  async planTableDdl(current: TableModel | null, desired: TableModel): Promise<string[]> {
    const schema = desired.schema ?? current?.schema ?? 'main';
    let ctx: RebuildContext = {
      schema,
      triggers: [],
      views: [],
      foreignKeysEnabled: this.openPayload.foreignKeys,
      sqliteVersion: this.info?.version ?? '3.0.0',
    };
    if (current) {
      const reply = await this.call<RebuildContextReply>({
        op: 'rebuildContext',
        payload: { schema, table: current.name },
      });
      ctx = {
        schema,
        triggers: reply.triggers,
        views: reply.views,
        foreignKeysEnabled: reply.foreignKeysEnabled,
        sqliteVersion: reply.sqliteVersion,
      };
    }
    return buildTableDdl(current, desired, ctx);
  }

  async explain(sql: string, analyze: boolean): Promise<ExplainPlan> {
    return this.call<ExplainPlan>({ op: 'explain', payload: { sql, analyze } });
  }

  // -- Sessions ------------------------------------------------------------
  //
  // A SQLite connection is one file handle in one worker, so "sessions" are
  // logical: they exist so the editor's transaction toggle behaves like the
  // other engines, and only one of them may hold the write transaction (§6).

  async openSession(): Promise<SessionInfo> {
    await this.ensureWorker();
    const session: SessionInfo = {
      id: randomUUID(),
      connectionId: this.ctx.config.id,
      inTransaction: false,
      autoCommit: true,
      createdAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s?.inTransaction) await this.sessionCommand(sessionId, 'rollback');
    this.sessions.delete(sessionId);
  }

  async sessionCommand(sessionId: string, cmd: 'begin' | 'commit' | 'rollback'): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new DbError(`No such session: ${sessionId}`, 'NO_SESSION');
    if (cmd === 'begin') {
      const other = [...this.sessions.values()].find((s) => s.id !== sessionId && s.inTransaction);
      if (other) {
        throw new DbError(
          'Another pinned session already holds this SQLite connection’s transaction — SQLite allows one writer per connection.',
          'SQLITE_ONE_WRITER',
        );
      }
    } else if (!session.inTransaction) {
      // Never commit or roll back a transaction another session opened.
      return;
    }
    const reply = await this.call<{ inTransaction: boolean }>({ op: 'session', payload: { cmd } });
    session.inTransaction = reply.inTransaction;
    session.autoCommit = !reply.inTransaction;
  }

  // -- Quoting (§9) --------------------------------------------------------

  quoteIdent(name: string): string {
    return quoteIdent(name);
  }

  quoteLiteral(value: string): string {
    return quoteLiteral(value);
  }

  // -- SQLite extras -------------------------------------------------------

  /**
   * PLAN §7.5: the online backup API is the right "export database" for SQLite.
   * It is consistent, does not block writers, and — unlike copying the file —
   * cannot miss the `-wal`/`-shm` sidecars.
   */
  async backup(
    dest: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ path: string; totalPages: number }> {
    // §7.2: any user-supplied output path must resolve inside the export root.
    let target: string;
    try {
      target = resolveWithin(CONFIG.exportRoot, dest);
    } catch (e) {
      throw new DbError((e as Error).message, 'PATH_ESCAPE');
    }
    mkdirSync(path.dirname(target), { recursive: true });

    await this.ensureWorker();
    const worker = this.worker;
    if (!worker) throw new DbError('The SQLite worker is not running.', 'WORKER_DOWN');
    const result = await this.send<{ totalPages: number }>(
      worker,
      { op: 'backup', payload: { dest: target } },
      undefined,
      (id) => {
        if (onProgress) this.progress.set(id, onProgress);
      },
    );
    return { path: target, totalPages: result.totalPages };
  }

  async execScript(statements: string[]): Promise<{ statements: number; durationMs: number; notices: string[] }> {
    return this.call({ op: 'execScript', payload: { statements } });
  }

  /** ATTACH makes another file a namespace of this connection (§4). */
  async attachDatabase(alias: string, file: string): Promise<{ name: string; file: string }[]> {
    if (RESERVED_ALIASES.has(alias.trim().toLowerCase())) {
      throw new DbError(`"${alias}" is reserved by SQLite and cannot be an ATTACH alias.`, 'SQLITE_ATTACH');
    }
    const resolved = file === ':memory:' ? ':memory:' : absolutize(file);
    const dbs = await this.call<{ name: string; file: string }[]>({
      op: 'attach',
      payload: { alias: alias.trim(), path: resolved },
    });
    // Keep the reopen payload in step so a cancel-restart re-attaches.
    this.openPayload.attach = [
      ...this.openPayload.attach.filter((a) => a.alias !== alias.trim()),
      { alias: alias.trim(), path: resolved },
    ];
    return dbs;
  }

  async detachDatabase(alias: string): Promise<{ name: string; file: string }[]> {
    const dbs = await this.call<{ name: string; file: string }[]>({ op: 'detach', payload: { alias } });
    this.openPayload.attach = this.openPayload.attach.filter((a) => a.alias !== alias);
    return dbs;
  }
}

export function createSqliteConnector(ctx: ConnectorContext): SqlConnector {
  return new SqliteConnectorImpl(ctx);
}
