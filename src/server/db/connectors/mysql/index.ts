/**
 * MySQL + MariaDB connector (PLAN §4, §6, §8).
 *
 * ONE connector, two flavors: `ctx.config.engine` picks the flag and the
 * divergences (JSON type, sequences, RETURNING, system versioning, EXPLAIN
 * ANALYZE vs ANALYZE FORMAT=JSON) are handled at this boundary so nothing
 * downstream ever branches on the engine.
 *
 * The three things that make this a tool rather than a demo (PLAN §6):
 *   • Type fidelity — the pool is configured for lossless values and every cell
 *     is encoded into the wire format (see ./types).
 *   • Cancellation — `connection.threadId` is tracked per run and `KILL QUERY`
 *     is issued from a *second* connection; closing the socket does nothing.
 *   • Big results — `query()` caps at maxRows and keeps the row stream paused as
 *     a server-side cursor; `stream()` never buffers.
 *
 * Per PLAN §8.1 this file never learns how the server was reached: it dials
 * `ctx.resolved.address`, which the AccessResolver has already made dialable.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import mysql from 'mysql2/promise';
import type {
  Connection as PromiseConnection,
  ConnectionOptions,
  FieldPacket,
  Pool,
  PoolConnection,
  PoolOptions,
  QueryValues,
  ResultSetHeader,
} from 'mysql2/promise';
import type { Connection as CoreConnection, SslOptions } from 'mysql2';

import type { Address, TlsConfig } from '../../../../lib/connection';
import type { EngineKind, IntrospectScope, SchemaModel, TableModel } from '../../../../lib/schema-model';
import type {
  ApplyResult,
  ChangePreview,
  Changeset,
  ExplainNode,
  ExplainPlan,
  ProcessInfo,
  ResultChunk,
  ResultSet,
  RunOpts,
  ServerInfo,
  SessionInfo,
  TreeNode,
  TreePath,
} from '../../../../lib/results';
import type { Row } from '../../../../lib/wire';
import { CONFIG, IS_CONTAINER, loopbackAdvice } from '../../../config';
import {
  DbError,
  type Capability,
  type ColumnFilter,
  type ConnectorContext,
  type DdlTarget,
  type SqlConnector,
  type TableReadRequest,
} from '../../types';
import { buildWhere } from '../../sql/filters';
import { splitStatements } from '../../sql/lexer';
import { quoterFor, type QuoteFns } from '../../sql/quote';
import {
  buildChangesetStatements,
  planMysqlTableDdl,
  previewChangesetSql,
  qualify,
  selectApplicableChanges,
} from './ddl';
import { introspectMysql } from './introspect';
import {
  columnMetaForFields,
  detectFlavor,
  encodeRow,
  FIELD_FLAG,
  mysqlTypeCast,
  type FlavorInfo,
  type MysqlFlavor,
} from './types';

/** Abandoned cursors hold a pooled connection, so they expire (PLAN §8.3). */
const CURSOR_IDLE_MS = 5 * 60_000;
/** Rows buffered inside the driver stream before it pauses the socket. */
const STREAM_HIGH_WATER_MARK = 256;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface MysqlError {
  message?: string;
  code?: string;
  errno?: number;
  sqlMessage?: string;
  sqlState?: string;
}

function toDbError(err: unknown, extra?: string): DbError {
  const e = (err ?? {}) as MysqlError;
  const message = e.sqlMessage ?? e.message ?? String(err);
  const detail = [e.sqlState ? `SQLSTATE ${e.sqlState}` : null, extra].filter(Boolean).join(' — ');
  return new DbError(message, e.code, detail || undefined);
}

/**
 * The shared lexer owns statement splitting (PLAN §6). We need the first
 * statement's text for the result-tab label and for wrapping in EXPLAIN.
 * MariaDB lexes as MySQL — same quoting, same DELIMITER handling.
 */
function firstStatementText(sql: string): string {
  try {
    const first = splitStatements(sql, 'mysql')[0];
    if (first?.text.trim()) return first.text.trim();
  } catch {
    // A statement the lexer cannot split still deserves to run.
  }
  return sql.trim();
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, '');
}

function parseSegment(segment: string): { kind: string; name: string } {
  const i = segment.indexOf(':');
  return i < 0 ? { kind: segment, name: '' } : { kind: segment.slice(0, i), name: segment.slice(i + 1) };
}

/** PEM text or a path to it (PLAN §8.2: TLS is one concept per engine). */
function readPem(value: string): string {
  return value.includes('-----BEGIN') ? value : readFileSync(value, 'utf8');
}

function coreOf(conn: PoolConnection | PromiseConnection): CoreConnection {
  // mysql2's promise wrapper keeps the callback-API connection here; the
  // streaming API (`query().stream()`) only exists on that object.
  return (conn as unknown as { connection: CoreConnection }).connection;
}

/** mysql2's parameter type is deliberately narrow; our params are opaque. */
function asValues(params: unknown[]): QueryValues {
  return params as unknown as QueryValues;
}

// ---------------------------------------------------------------------------
// Pull-based reader over the driver's row stream = our server-side cursor.
// ---------------------------------------------------------------------------

class StreamPump {
  private pushed: unknown[] = [];
  private ended = false;
  private failure: Error | null = null;
  private waiters: (() => void)[] = [];

  constructor(private readonly stream: Readable) {
    stream.on('readable', () => this.wake());
    stream.on('end', () => {
      this.ended = true;
      this.wake();
    });
    stream.on('close', () => {
      this.ended = true;
      this.wake();
    });
    stream.on('error', (err: Error) => {
      this.failure = err;
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Reads up to `n` rows. Returns early only when the result set is exhausted. */
  async take(n: number): Promise<{ rows: unknown[]; done: boolean }> {
    const rows: unknown[] = [];
    while (rows.length < n) {
      if (this.failure) throw toDbError(this.failure);
      if (this.pushed.length > 0) {
        rows.push(this.pushed.shift());
        continue;
      }
      const row = this.stream.read() as unknown;
      if (row !== null && row !== undefined) {
        rows.push(row);
        continue;
      }
      if (this.ended) break;
      await this.wait();
    }
    if (this.failure) throw toDbError(this.failure);
    return { rows, done: this.exhausted() };
  }

  /** Rows read past the page boundary go back so the cursor stays exact. */
  pushBack(rows: unknown[]): void {
    this.pushed = [...rows, ...this.pushed];
  }

  exhausted(): boolean {
    return this.pushed.length === 0 && this.ended && this.stream.readableLength === 0;
  }

  destroy(): void {
    this.stream.destroy();
  }
}

interface Lease {
  conn: PoolConnection;
  core: CoreConnection;
  threadId: number;
  /** No-op for pinned sessions — they are released by closeSession(). */
  release(): void;
}

interface StreamMeta {
  fields: FieldPacket[] | null;
  /** Result sets seen so far — >1 means a CALL. */
  sets: number;
  /** Rows in the first result set, once a second set has started. */
  boundary: number | null;
}

interface StreamStart {
  pump: StreamPump;
  meta: StreamMeta;
}

interface CursorState {
  id: string;
  pump: StreamPump;
  fields: FieldPacket[];
  lease: Lease;
  threadId: number;
  statement: string;
  timer: NodeJS.Timeout;
  /** Drops the runId → threadId entry the run registered (PLAN §6 cancel map). */
  unregister: () => void;
}

interface SessionState {
  info: SessionInfo;
  conn: PoolConnection;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

class MysqlConnector implements SqlConnector {
  readonly kind: EngineKind;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'sql',
    'transactions',
    'explain',
    'ddl',
    'routines',
    'multipleDatabases',
    'processList',
    'cancel',
    'streaming',
  ]);

  private readonly quoter: QuoteFns;
  private pool: Pool | null = null;
  private flavorInfo: FlavorInfo | null = null;
  private readonly runs = new Map<string, number>();
  private readonly cursors = new Map<string, CursorState>();
  private readonly sessions = new Map<string, SessionState>();
  /** Tracks the current database per physical connection so `USE` is rare. */
  private readonly currentDb = new WeakMap<object, string>();

  constructor(private readonly ctx: ConnectorContext) {
    this.kind = ctx.config.engine === 'mariadb' ? 'mariadb' : 'mysql';
    this.quoter = quoterFor(this.kind);
  }

  // --- flavor ---------------------------------------------------------------

  private get flavor(): FlavorInfo {
    return (
      this.flavorInfo ?? {
        // Conservative defaults until the version probe lands: assume the
        // feature is absent rather than emitting SQL the server will reject.
        flavor: this.kind as MysqlFlavor,
        versionText: 'unknown',
        version: 0,
        supportsJsonType: false,
        supportsCheckConstraints: false,
        supportsGeneratedColumns: false,
        supportsFunctionalIndexes: false,
        supportsSequences: false,
        supportsReturning: false,
        supportsSystemVersioning: false,
        supportsExplainAnalyze: false,
        supportsAnalyzeJson: false,
        supportsExplainJson: true,
        supportsMaxExecutionTime: false,
        supportsMaxStatementTime: false,
      }
    );
  }

  // --- connection options ---------------------------------------------------

  private tlsOptions(tls: TlsConfig | undefined): SslOptions | undefined {
    if (!tls?.enabled) return undefined;
    const ssl: SslOptions = {};
    if (tls.caCert) ssl.ca = readPem(tls.caCert);
    if (tls.clientCert) ssl.cert = readPem(tls.clientCert);
    if (tls.clientKey) ssl.key = readPem(tls.clientKey);
    switch (tls.verify) {
      case 'verify-full':
        ssl.rejectUnauthorized = true;
        // Also check the hostname against the certificate, not just the chain.
        ssl.verifyIdentity = true;
        break;
      case 'require':
        // Encrypted, chain checked only when the user supplied a CA.
        ssl.rejectUnauthorized = !!tls.caCert;
        ssl.verifyIdentity = false;
        break;
      case 'skip':
        ssl.rejectUnauthorized = false;
        ssl.verifyIdentity = false;
        // PLAN §8.2: say plainly what "skip" costs instead of hiding it.
        this.emit({
          type: 'notice',
          message: 'TLS certificate verification is off: this connection can be intercepted (MITM).',
        });
        break;
    }
    return ssl;
  }

  private addressOptions(address: Address): ConnectionOptions {
    switch (address.kind) {
      case 'tcp': {
        const advice = loopbackAdvice(address.host);
        if (advice) this.emit({ type: 'notice', message: advice });
        return { host: address.host, port: address.port };
      }
      case 'unix':
        // PLAN §8.2: often the only thing that works — auth_socket has no password.
        return { socketPath: address.socketPath };
      case 'uri': {
        const url = new URL(address.uri);
        const opts: ConnectionOptions = {
          host: decodeURIComponent(url.hostname),
          port: url.port ? Number(url.port) : 3306,
        };
        if (url.username) opts.user = decodeURIComponent(url.username);
        if (url.password) opts.password = decodeURIComponent(url.password);
        const db = url.pathname.replace(/^\//, '');
        if (db) opts.database = decodeURIComponent(db);
        return opts;
      }
      case 'file':
        throw new DbError(
          `A ${this.kind} connection needs a host, socket or URI — "${address.path}" is a file address.`,
          'DBADMIN_BAD_ADDRESS',
        );
    }
  }

  /** Shared by the pool and by the second connection that issues KILL QUERY. */
  private driverOptions(): ConnectionOptions {
    const { config, resolved, password } = this.ctx;
    const address = resolved.address;
    const options = config.options;
    const driverExtras = options.driverOptions ?? {};

    // PLAN §8.3: protocol compression pays for itself on remote links only; on
    // a unix socket it is pure CPU cost.
    const compress = options.compress === true && address.kind !== 'unix';
    if (options.compress === true && address.kind === 'unix') {
      this.emit({
        type: 'notice',
        message: 'Protocol compression was requested but ignored: this is a local unix socket.',
      });
    }

    const base: ConnectionOptions = {
      ...this.addressOptions(address),
      user: config.username,
      password,
      database: options.database,
      connectTimeout: options.connectTimeoutMs ?? 10_000,
      ssl: this.tlsOptions(config.tls),
      compress,
      // PLAN §6 "Type fidelity" — the four settings that stop mysql2 from
      // quietly destroying BIGINT, DECIMAL and DATETIME values.
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      typeCast: mysqlTypeCast,
      decimalNumbers: false,
      // Never let a stray Date be re-interpreted in the server process's zone.
      timezone: 'Z',
      // utf8mb4 or emoji and CJK supplementary characters get mangled.
      charset: 'UTF8MB4_UNICODE_CI',
      // One statement per call: multi-statement is an SQL-injection amplifier
      // and the runner splits scripts with the shared lexer instead (PLAN §6).
      multipleStatements: false,
      // CLIENT_FOUND_ROWS makes UPDATE report *matched* rows, which is what the
      // changeset affected-rows check needs (PLAN §6 "Grid editing"). mysql2
      // only treats a leading '-' as special, so the flag is named bare.
      flags: ['FOUND_ROWS'],
      // PLAN §8.3: NAT and SSH tunnels drop idle TCP silently.
      enableKeepAlive: true,
      keepAliveInitialDelay: 30_000,
    };
    // Driver-specific escape hatch, passed through untouched (ConnectionOptions).
    return { ...base, ...driverExtras } as ConnectionOptions;
  }

  private poolOptions(): PoolOptions {
    return {
      ...this.driverOptions(),
      connectionLimit: Math.max(1, this.ctx.config.options.poolSize ?? 5),
      maxIdle: Math.max(1, this.ctx.config.options.poolSize ?? 5),
      // Below the usual 5-minute NAT window (PLAN §8.3).
      idleTimeout: CONFIG.poolIdleMs,
      waitForConnections: true,
      queueLimit: 0,
    };
  }

  /** Runs once per freshly opened physical connection. */
  private sessionSetupStatements(): string[] {
    const out: string[] = [];
    const timeout = this.ctx.config.options.statementTimeoutMs ?? 0;
    const flavor = this.flavorInfo;
    if (timeout > 0) {
      // MySQL counts milliseconds and only limits SELECTs; MariaDB counts
      // seconds. When the version probe has not run yet, try both and let the
      // wrong one fail harmlessly.
      if (!flavor || flavor.supportsMaxExecutionTime) {
        out.push(`SET SESSION max_execution_time = ${Math.floor(timeout)}`);
      }
      if (!flavor || flavor.supportsMaxStatementTime) {
        out.push(`SET SESSION max_statement_time = ${(timeout / 1000).toFixed(3)}`);
      }
    }
    // PLAN §8.5: a read-only connection is enforced server-side, not just in the UI.
    if (this.ctx.config.readOnly) out.push('SET SESSION TRANSACTION READ ONLY');
    return out;
  }

  private emit(event: Parameters<NonNullable<ConnectorContext['onEvent']>>[0]): void {
    this.ctx.onEvent?.(event);
  }

  private requirePool(): Pool {
    if (!this.pool) throw new DbError('Connection is not open', 'DBADMIN_CLOSED');
    return this.pool;
  }

  // --- lifecycle ------------------------------------------------------------

  async open(): Promise<void> {
    if (this.pool) return;
    this.emit({ type: 'state', state: 'connecting' });
    const pool = mysql.createPool(this.poolOptions());
    pool.on('connection', (conn) => {
      // The pool forwards the *core* connection, not the promise wrapper.
      const core = conn as unknown as CoreConnection;
      for (const stmt of this.sessionSetupStatements()) {
        core.query(stmt, () => {
          // Best effort: an old server without max_execution_time must not
          // break the connection.
        });
      }
    });
    this.pool = pool;

    try {
      await this.probeVersion();
    } catch (err) {
      this.pool = null;
      await pool.end().catch(() => undefined);
      const address = this.ctx.resolved.original;
      const advice =
        address.kind === 'tcp' && IS_CONTAINER ? loopbackAdvice(address.host) ?? undefined : undefined;
      const dbErr = toDbError(err, advice);
      this.emit({ type: 'state', state: 'closed', message: dbErr.message });
      throw dbErr;
    }
    this.emit({ type: 'state', state: 'connected', message: this.flavor.versionText });
  }

  private async probeVersion(): Promise<FlavorInfo> {
    const rows = await this.selectObjects<{ version: string; comment: string | null }>(
      'SELECT VERSION() AS version, @@version_comment AS comment',
      [],
    );
    const row = rows[0];
    const info = detectFlavor(
      String(row?.version ?? ''),
      row?.comment ?? undefined,
      this.kind === 'mariadb' ? 'mariadb' : 'mysql',
    );
    this.flavorInfo = info;
    return info;
  }

  async close(): Promise<void> {
    for (const id of [...this.cursors.keys()]) await this.closeCursor(id).catch(() => undefined);
    for (const id of [...this.sessions.keys()]) await this.closeSession(id).catch(() => undefined);
    this.runs.clear();
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.end().catch(() => undefined);
    this.emit({ type: 'state', state: 'closed' });
  }

  async ping(): Promise<ServerInfo> {
    const started = performance.now();
    const rows = await this.selectObjects<{ version: string; comment: string | null; host: string | null }>(
      'SELECT VERSION() AS version, @@version_comment AS comment, @@hostname AS host',
      [],
    );
    const rttMs = performance.now() - started;
    const row = rows[0];
    const info = detectFlavor(
      String(row?.version ?? ''),
      row?.comment ?? undefined,
      this.kind === 'mariadb' ? 'mariadb' : 'mysql',
    );
    this.flavorInfo = info;

    let uptimeSeconds: number | undefined;
    try {
      const status = await this.selectObjects<{ Variable_name: string; Value: string }>(
        "SHOW GLOBAL STATUS LIKE 'Uptime'",
        [],
      );
      const value = status[0]?.Value;
      if (value !== undefined) uptimeSeconds = Number(value);
    } catch {
      // SHOW GLOBAL STATUS needs privileges we may not have; uptime is optional.
    }

    return {
      version: info.versionText,
      versionNumber: info.version,
      edition: info.edition,
      uptimeSeconds,
      rttMs,
      details: {
        flavor: info.flavor,
        host: row?.host ?? '',
        tunneled: String(this.ctx.resolved.tunneled),
      },
    };
  }

  // --- internal query helpers ----------------------------------------------

  /** Object rows, for catalog queries. One round trip. */
  private async selectObjects<T>(sql: string, params: unknown[]): Promise<T[]> {
    try {
      const [rows] = params.length
        ? await this.requirePool().query(sql, asValues(params))
        : await this.requirePool().query(sql);
      return (Array.isArray(rows) ? rows : []) as T[];
    } catch (err) {
      throw toDbError(err);
    }
  }

  /** Array rows, for SHOW commands whose column names are unhelpful. */
  private async selectArrays(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    try {
      const options =
        params.length > 0
          ? { sql, values: asValues(params), rowsAsArray: true }
          : { sql, rowsAsArray: true };
      const [rows] = await this.requirePool().query(options);
      return (Array.isArray(rows) ? rows : []) as unknown[][];
    } catch (err) {
      throw toDbError(err);
    }
  }

  private async acquire(opts: RunOpts): Promise<Lease> {
    if (opts.sessionId) {
      const session = this.sessions.get(opts.sessionId);
      if (!session) throw new DbError(`No such session: ${opts.sessionId}`, 'DBADMIN_NO_SESSION');
      const core = coreOf(session.conn);
      await this.ensureDatabase(session.conn, core, opts.database);
      return {
        conn: session.conn,
        core,
        threadId: session.conn.threadId,
        release: () => undefined,
      };
    }
    const conn = await this.requirePool().getConnection();
    const core = coreOf(conn);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      conn.release();
    };
    try {
      await this.ensureDatabase(conn, core, opts.database);
    } catch (err) {
      release();
      throw err;
    }
    return { conn, core, threadId: conn.threadId, release };
  }

  private async ensureDatabase(
    conn: PoolConnection,
    core: CoreConnection,
    database?: string,
  ): Promise<void> {
    const want = database ?? this.ctx.config.options.database;
    if (!want) return;
    if (this.currentDb.get(core as unknown as object) === want) return;
    try {
      await conn.query(`USE ${this.quoteIdent(want)}`);
    } catch (err) {
      throw toDbError(err);
    }
    this.currentDb.set(core as unknown as object, want);
  }

  private registerRun(opts: RunOpts, threadId: number): () => void {
    const runId = opts.runId;
    const signal = opts.signal;
    if (!runId && !signal) return () => undefined;
    if (runId) this.runs.set(runId, threadId);
    const onAbort = (): void => {
      void this.killThread(threadId);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    return () => {
      if (runId) this.runs.delete(runId);
      signal?.removeEventListener('abort', onAbort);
    };
  }

  private startStream(core: CoreConnection, sql: string, params?: unknown[]): StreamStart {
    // rowsAsArray: duplicate column names (a self-join) must not collapse.
    const query =
      params && params.length > 0
        ? core.query({ sql, values: asValues(params), rowsAsArray: true })
        : core.query({ sql, rowsAsArray: true });
    const stream = query.stream({ highWaterMark: STREAM_HIGH_WATER_MARK });
    const meta: StreamMeta = { fields: null, sets: 0, boundary: null };

    // A CALL returns several result sets with different column lists. The
    // driver emits a new `fields` event before the first row of each, so the
    // count of rows produced at that moment is exactly where set 1 ends —
    // without it we would decode set 2's rows with set 1's column types.
    let produced = 0;
    stream.on('result', () => {
      produced++;
    });
    stream.on('fields', (fields: FieldPacket[] | undefined) => {
      if (!fields) return;
      meta.sets++;
      if (!meta.fields) meta.fields = fields;
      else if (meta.boundary === null) meta.boundary = produced;
    });
    return { pump: new StreamPump(stream), meta };
  }

  // --- query / cursors ------------------------------------------------------

  async query(sql: string, opts: RunOpts = {}): Promise<ResultSet> {
    if (opts.signal?.aborted) throw new DbError('Cancelled before it started', 'DBADMIN_CANCELLED');
    const statement = firstStatementText(sql);
    const maxRows = Math.max(1, opts.maxRows ?? CONFIG.defaultPageSize);
    const started = Date.now();
    const lease = await this.acquire(opts);
    const unregister = this.registerRun(opts, lease.threadId);
    let cursorTookOver = false;

    try {
      const { pump, meta } = this.startStream(lease.core, sql, opts.params as unknown[] | undefined);
      // One row past the page tells us truthfully whether more remain.
      const first = await pump.take(maxRows + 1);

      // A statement with no result set pushes a single ResultSetHeader.
      if (first.rows.length > 0 && !Array.isArray(first.rows[0])) {
        const header = first.rows[0] as ResultSetHeader;
        const notices = header.warningStatus > 0 ? await this.fetchWarnings(lease.conn) : undefined;
        return {
          statement,
          columns: [],
          rows: [],
          truncated: false,
          affectedRows: header.affectedRows,
          insertId: header.insertId ? String(header.insertId) : undefined,
          durationMs: Date.now() - started,
          notices,
          editTarget: null,
        };
      }

      const fields = meta.fields ?? [];
      const notices: string[] = [];
      let available = first.rows;
      // Never decode a later result set with these columns.
      if (meta.boundary !== null && meta.boundary < available.length) {
        available = available.slice(0, meta.boundary);
        notices.push('Only the first result set is shown.');
      }
      const rows: Row[] = available
        .slice(0, maxRows)
        .map((r) => encodeRow(r as unknown[], fields));
      const truncated = available.length > maxRows;

      let cursorId: string | undefined;
      if (truncated) {
        pump.pushBack(available.slice(maxRows));
        cursorId = this.openCursor(pump, fields, lease, statement, unregister);
        cursorTookOver = true;
      }

      const edit = editTargetFor(fields);
      return {
        statement,
        columns: columnMetaForFields(fields),
        rows,
        truncated,
        cursorId,
        durationMs: Date.now() - started,
        notices: notices.length > 0 ? notices : undefined,
        editTarget: edit.target,
        readOnlyReason: edit.reason,
      };
    } catch (err) {
      throw toDbError(err);
    } finally {
      if (!cursorTookOver) {
        unregister();
        lease.release();
      }
    }
  }

  private openCursor(
    pump: StreamPump,
    fields: FieldPacket[],
    lease: Lease,
    statement: string,
    unregister: () => void,
  ): string {
    const id = randomUUID();
    const state: CursorState = {
      id,
      pump,
      fields,
      lease,
      threadId: lease.threadId,
      statement,
      timer: this.cursorTimer(id),
      unregister,
    };
    this.cursors.set(id, state);
    return id;
  }

  private cursorTimer(id: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.closeCursor(id);
    }, CURSOR_IDLE_MS);
    // A forgotten cursor must not keep the process alive.
    timer.unref?.();
    return timer;
  }

  async fetchMore(cursorId: string, n: number): Promise<ResultChunk> {
    const cursor = this.cursors.get(cursorId);
    if (!cursor) throw new DbError(`Cursor ${cursorId} is closed`, 'DBADMIN_NO_CURSOR');
    clearTimeout(cursor.timer);
    const want = Math.max(1, n);
    try {
      const { rows } = await cursor.pump.take(want + 1);
      const truncated = rows.length > want;
      if (truncated) cursor.pump.pushBack(rows.slice(want));
      const page = rows.slice(0, want).map((r) => encodeRow(r as unknown[], cursor.fields));
      if (!truncated) {
        await this.disposeCursor(cursorId, false);
      } else {
        cursor.timer = this.cursorTimer(cursorId);
      }
      return { rows: page, truncated };
    } catch (err) {
      await this.disposeCursor(cursorId, false);
      throw toDbError(err);
    }
  }

  async closeCursor(cursorId: string): Promise<void> {
    await this.disposeCursor(cursorId, true);
  }

  /**
   * `kill` stops a result set the user walked away from: destroying the stream
   * only stops *us* reading, the server keeps sending (PLAN §6).
   */
  private async disposeCursor(cursorId: string, kill: boolean): Promise<void> {
    const cursor = this.cursors.get(cursorId);
    if (!cursor) return;
    this.cursors.delete(cursorId);
    clearTimeout(cursor.timer);
    const unfinished = !cursor.pump.exhausted();
    cursor.pump.destroy();
    if (kill && unfinished) await this.killThread(cursor.threadId);
    cursor.unregister();
    cursor.lease.release();
  }

  async *stream(sql: string, opts: RunOpts = {}): AsyncIterable<Row[]> {
    const lease = await this.acquire(opts);
    const unregister = this.registerRun(opts, lease.threadId);
    const batchSize = Math.max(1, opts.maxRows ?? CONFIG.defaultPageSize);
    let pump: StreamPump | null = null;
    try {
      const { pump: rowPump, meta } = this.startStream(
        lease.core,
        sql,
        opts.params as unknown[] | undefined,
      );
      pump = rowPump;
      let emitted = 0;
      for (;;) {
        const { rows, done } = await pump.take(batchSize);
        // A DML statement in the export path yields no rows, just a header.
        let dataRows = rows.filter((r) => Array.isArray(r)) as unknown[][];
        let stop = done;
        if (meta.boundary !== null && emitted + dataRows.length > meta.boundary) {
          // Export takes the first result set only; a CALL's extra sets have
          // different columns and would corrupt the file.
          dataRows = dataRows.slice(0, Math.max(0, meta.boundary - emitted));
          stop = true;
        }
        emitted += dataRows.length;
        if (dataRows.length > 0) {
          const fields = meta.fields ?? [];
          yield dataRows.map((r) => encodeRow(r, fields));
        }
        if (stop) break;
      }
    } catch (err) {
      throw toDbError(err);
    } finally {
      pump?.destroy();
      unregister();
      lease.release();
    }
  }

  async cancel(runId: string): Promise<void> {
    const threadId = this.runs.get(runId);
    if (threadId === undefined) return;
    await this.killThread(threadId);
  }

  /**
   * PLAN §6: a second connection is mandatory. The one running the query is
   * blocked waiting for its result, so it cannot carry the KILL.
   */
  private async killThread(threadId: number): Promise<void> {
    if (!Number.isInteger(threadId) || threadId <= 0) return;
    let conn: PromiseConnection | null = null;
    try {
      conn = await mysql.createConnection(this.driverOptions());
      await conn.query(`KILL QUERY ${threadId}`);
    } catch (err) {
      const code = (err as MysqlError).code;
      // The query finished on its own between our lookup and the KILL.
      if (code !== 'ER_NO_SUCH_THREAD') {
        this.emit({ type: 'notice', message: `Cancel failed: ${toDbError(err).message}` });
      }
    } finally {
      await conn?.end().catch(() => undefined);
    }
  }

  private async fetchWarnings(conn: PoolConnection): Promise<string[] | undefined> {
    try {
      const [rows] = await conn.query({ sql: 'SHOW WARNINGS', rowsAsArray: true });
      const list = (Array.isArray(rows) ? rows : []) as unknown[][];
      const messages = list.map((r) => `${String(r[0])} ${String(r[1])}: ${String(r[2])}`);
      return messages.length > 0 ? messages : undefined;
    } catch {
      return undefined;
    }
  }

  // --- introspection --------------------------------------------------------

  async introspect(scope: IntrospectScope): Promise<SchemaModel> {
    if (!this.flavorInfo) await this.probeVersion();
    return introspectMysql(
      {
        query: <T>(sql: string, params: unknown[]) => this.selectObjects<T>(sql, params),
        flavor: this.flavor,
        defaultDatabase: this.ctx.config.options.database,
      },
      scope,
    );
  }

  // --- table reads ----------------------------------------------------------

  private whereFor(req: { filters?: ColumnFilter[]; where?: string }): {
    sql: string;
    params: unknown[];
  } {
    const parts: string[] = [];
    const params: unknown[] = [];
    // Structured filters are always parameterized (PLAN §9); the raw box is the
    // user's own SQL and goes through verbatim. buildWhere returns the clause
    // with its `WHERE` keyword, which we strip so it can be ANDed.
    const built = buildWhere(req.filters ?? [], this.kind, 'qmark');
    const clause = built.sql.trim().replace(/^where\s+/i, '');
    if (clause) {
      parts.push(`(${clause})`);
      params.push(...built.params);
    }
    const raw = req.where?.trim();
    if (raw) parts.push(`(${raw})`);
    return parts.length > 0 ? { sql: ` WHERE ${parts.join(' AND ')}`, params } : { sql: '', params };
  }

  async readTable(req: TableReadRequest): Promise<ResultSet> {
    const target = qualify(this.quoter, req.schema, req.table);
    const columns = req.columns?.length
      ? req.columns.map((c) => this.quoteIdent(c)).join(', ')
      : '*';
    const where = this.whereFor(req);
    const order = req.orderBy?.length
      ? ` ORDER BY ${req.orderBy
          .map((o) => `${this.quoteIdent(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`)
          .join(', ')}`
      : '';
    const limit = Math.max(1, req.limit);
    const offset = Math.max(0, req.offset);
    const sql = `SELECT ${columns} FROM ${target}${where.sql}${order} LIMIT ? OFFSET ?`;
    const result = await this.query(sql, {
      params: [...where.params, limit, offset],
      maxRows: limit,
      database: req.schema,
    });
    if (result.editTarget) {
      result.editTarget = { ...result.editTarget, schema: req.schema, table: req.table };
    }
    return result;
  }

  async countTable(req: Omit<TableReadRequest, 'offset' | 'limit' | 'orderBy'>): Promise<number> {
    const target = qualify(this.quoter, req.schema, req.table);
    const where = this.whereFor(req);
    const rows = await this.selectObjects<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM ${target}${where.sql}`,
      where.params,
    );
    return Number(rows[0]?.n ?? 0);
  }

  // --- DDL ------------------------------------------------------------------

  async generateDdl(target: DdlTarget): Promise<string> {
    switch (target.type) {
      case 'table': {
        const rows = await this.selectArrays(
          `SHOW CREATE TABLE ${qualify(this.quoter, target.schema, target.name)}`,
        );
        return String(rows[0]?.[1] ?? '');
      }
      case 'view': {
        const rows = await this.selectArrays(
          `SHOW CREATE VIEW ${qualify(this.quoter, target.schema, target.name)}`,
        );
        return String(rows[0]?.[1] ?? '');
      }
      case 'database': {
        const rows = await this.selectArrays(`SHOW CREATE DATABASE ${this.quoteIdent(target.name)}`);
        return String(rows[0]?.[1] ?? '');
      }
      case 'routine': {
        // The catalog knows whether it is a PROCEDURE or a FUNCTION; asking the
        // wrong SHOW CREATE is an error, so look it up first.
        const meta = await this.selectObjects<{ ROUTINE_TYPE: string }>(
          `SELECT ROUTINE_TYPE FROM information_schema.ROUTINES
            WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? LIMIT 1`,
          [target.schema ?? this.ctx.config.options.database ?? '', target.name],
        );
        const kind = (meta[0]?.ROUTINE_TYPE ?? 'PROCEDURE').toUpperCase() === 'FUNCTION'
          ? 'FUNCTION'
          : 'PROCEDURE';
        const rows = await this.selectArrays(
          `SHOW CREATE ${kind} ${qualify(this.quoter, target.schema, target.name)}`,
        );
        // SHOW CREATE PROCEDURE/FUNCTION puts sql_mode in column 1.
        return String(rows[0]?.[2] ?? '');
      }
      case 'index': {
        const model = await this.introspect({
          database: target.schema,
          namespaces: target.schema ? [target.schema] : undefined,
          shallow: true,
        });
        for (const ns of model.namespaces) {
          const table = ns.tables.find((t) => t.name === target.table);
          const index = table?.indexes.find((i) => i.name === target.name);
          if (!table || !index) continue;
          const parts = index.columns.filter((c) => c.expression || c.name);
          if (index.primary) {
            return `ALTER TABLE ${qualify(this.quoter, ns.name, table.name)} ADD PRIMARY KEY (${parts
              .map((c) => this.quoteIdent(c.name as string))
              .join(', ')})`;
          }
          const unique = index.unique ? 'UNIQUE ' : '';
          const cols = parts
            .map((c) =>
              c.expression
                ? `(${c.expression})`
                : `${this.quoteIdent(c.name as string)}${c.length ? `(${c.length})` : ''}${
                    c.order === 'desc' ? ' DESC' : ''
                  }`,
            )
            .join(', ');
          return `CREATE ${unique}INDEX ${this.quoteIdent(index.name)} ON ${qualify(
            this.quoter,
            ns.name,
            table.name,
          )} (${cols})`;
        }
        throw new DbError(`No index ${target.name} on ${target.table}`, 'DBADMIN_NO_OBJECT');
      }
    }
  }

  async previewChangeset(cs: Changeset): Promise<ChangePreview> {
    return previewChangesetSql(this.quoter, cs);
  }

  async applyChangeset(cs: Changeset): Promise<ApplyResult> {
    if (this.ctx.config.readOnly) {
      throw new DbError('This connection is read-only', 'DBADMIN_READ_ONLY');
    }
    const { changeset, warnings } = selectApplicableChanges(cs);
    const statements = buildChangesetStatements(this.quoter, changeset);
    if (statements.length === 0) {
      if (warnings.length > 0) throw new DbError(warnings.join(' '), 'DBADMIN_NO_KEY');
      return { applied: 0, statements: 0, durationMs: 0 };
    }

    const started = Date.now();
    const conn = await this.requirePool().getConnection();
    let applied = 0;
    try {
      await this.ensureDatabase(conn, coreOf(conn), cs.schema);
      // One transaction, with an affected-rows check that aborts on a mismatch:
      // protects against a WHERE matching more rows than expected (PLAN §6).
      await conn.beginTransaction();
      for (const stmt of statements) {
        const [result] = await conn.query(stmt.sql, asValues(stmt.params));
        const header = result as unknown as ResultSetHeader;
        const affected = typeof header?.affectedRows === 'number' ? header.affectedRows : 0;
        if (affected !== stmt.expected) {
          throw new DbError(
            `Expected ${stmt.expected} row(s) to change but ${affected} did — rolled back. Statement: ${stmt.sql}`,
            'DBADMIN_AFFECTED_MISMATCH',
          );
        }
        applied += affected;
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err instanceof DbError ? err : toDbError(err);
    } finally {
      conn.release();
    }
    return { applied, statements: statements.length, durationMs: Date.now() - started };
  }

  async planTableDdl(current: TableModel | null, desired: TableModel): Promise<string[]> {
    return planMysqlTableDdl(this.quoter, this.flavor, current, desired);
  }

  // --- explain --------------------------------------------------------------

  async explain(sql: string, analyze: boolean): Promise<ExplainPlan> {
    const statement = stripTrailingSemicolon(firstStatementText(sql));
    const flavor = this.flavor;

    if (analyze && flavor.supportsExplainAnalyze) {
      // MySQL 8.0.18+: a tree with real timings. It EXECUTES the statement.
      const rows = await this.selectArrays(`EXPLAIN ANALYZE ${statement}`);
      const raw = rows.map((r) => String(r[0] ?? '')).join('\n');
      return parseTreePlan(this.kind, raw);
    }
    if (analyze && flavor.supportsAnalyzeJson) {
      // MariaDB's equivalent, with r_rows / r_total_time_ms in the JSON.
      const rows = await this.selectArrays(`ANALYZE FORMAT=JSON ${statement}`);
      const raw = String(rows[0]?.[0] ?? '{}');
      return parseJsonPlan(this.kind, raw, true);
    }
    const rows = await this.selectArrays(`EXPLAIN FORMAT=JSON ${statement}`);
    const raw = String(rows[0]?.[0] ?? '{}');
    return parseJsonPlan(this.kind, raw, false);
  }

  // --- sessions (PLAN §6 "Sessions vs pools") -------------------------------

  async openSession(): Promise<SessionInfo> {
    const conn = await this.requirePool().getConnection();
    const info: SessionInfo = {
      id: randomUUID(),
      connectionId: this.ctx.config.id,
      inTransaction: false,
      autoCommit: true,
      backendId: String(conn.threadId),
      createdAt: Date.now(),
    };
    this.sessions.set(info.id, { info, conn });
    return info;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.info.inTransaction) await session.conn.rollback().catch(() => undefined);
    session.conn.release();
  }

  async sessionCommand(sessionId: string, cmd: 'begin' | 'commit' | 'rollback'): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new DbError(`No such session: ${sessionId}`, 'DBADMIN_NO_SESSION');
    try {
      if (cmd === 'begin') {
        await session.conn.beginTransaction();
        session.info.inTransaction = true;
        session.info.autoCommit = false;
      } else if (cmd === 'commit') {
        await session.conn.commit();
        session.info.inTransaction = false;
      } else {
        await session.conn.rollback();
        session.info.inTransaction = false;
      }
    } catch (err) {
      throw toDbError(err);
    }
  }

  // --- monitor --------------------------------------------------------------

  async listProcesses(): Promise<ProcessInfo[]> {
    const rows = await this.selectObjects<Record<string, unknown>>('SHOW FULL PROCESSLIST', []);
    return rows.map((r) => {
      const seconds = Number(r.Time ?? 0);
      return {
        id: String(r.Id ?? ''),
        user: r.User === null || r.User === undefined ? undefined : String(r.User),
        client: r.Host === null || r.Host === undefined ? undefined : String(r.Host),
        database: r.db === null || r.db === undefined ? undefined : String(r.db),
        state: r.State === null || r.State === undefined ? undefined : String(r.State),
        command: r.Command === null || r.Command === undefined ? undefined : String(r.Command),
        durationMs: Number.isFinite(seconds) ? seconds * 1000 : undefined,
        query: r.Info === null || r.Info === undefined ? undefined : String(r.Info),
      } satisfies ProcessInfo;
    });
  }

  async killProcess(id: string): Promise<void> {
    const threadId = Number(id);
    // Never interpolate an unvalidated id (PLAN §9).
    if (!Number.isInteger(threadId) || threadId <= 0) {
      throw new DbError(`Not a thread id: ${id}`, 'DBADMIN_BAD_ID');
    }
    try {
      await this.requirePool().query(`KILL ${threadId}`);
    } catch (err) {
      throw toDbError(err);
    }
  }

  // --- tree -----------------------------------------------------------------

  async listNodes(path: TreePath): Promise<TreeNode[]> {
    const segments = path.segments.map(parseSegment);
    const prefix = path.segments.length > 0 ? `${path.segments.join('/')}/` : '';
    const dbSegment = segments.find((s) => s.kind === 'db' || s.kind === 'database');
    const database = dbSegment?.name;
    // The *last* folder segment is the one being expanded: a column list lives
    // at db:x/table-folder:tables/table:y/column-folder:columns.
    const folders = segments.filter((s) => s.kind.endsWith('-folder'));
    const folder = folders.length > 0 ? folders[folders.length - 1] : undefined;
    const tableSegment = segments.filter((s) => s.kind === 'table' || s.kind === 'view').pop();

    if (!database) {
      const rows = await this.selectObjects<{ SCHEMA_NAME: string }>(
        `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME`,
        [],
      );
      return rows.map((r) => ({
        id: `db:${r.SCHEMA_NAME}`,
        kind: 'database' as const,
        label: r.SCHEMA_NAME,
        hasChildren: true,
        meta: { database: r.SCHEMA_NAME },
      }));
    }

    if (tableSegment) {
      if (!folder || folder.kind === 'table-folder' || folder.kind === 'view-folder') {
        return [
          {
            id: `${prefix}column-folder:columns`,
            kind: 'column-folder',
            label: 'Columns',
            hasChildren: true,
            meta: { database, table: tableSegment.name },
          },
          {
            id: `${prefix}index-folder:indexes`,
            kind: 'index-folder',
            label: 'Indexes',
            hasChildren: true,
            meta: { database, table: tableSegment.name },
          },
        ];
      }
    }

    if (folder?.kind === 'column-folder' && tableSegment) {
      const rows = await this.selectObjects<{
        COLUMN_NAME: string;
        COLUMN_TYPE: string;
        IS_NULLABLE: string;
        COLUMN_KEY: string;
      }>(
        `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [database, tableSegment.name],
      );
      return rows.map((r) => ({
        id: `${prefix}column:${r.COLUMN_NAME}`,
        kind: 'column' as const,
        label: r.COLUMN_NAME,
        detail: `${r.COLUMN_TYPE}${r.IS_NULLABLE === 'NO' ? ' NOT NULL' : ''}`,
        hasChildren: false,
        meta: { database, table: tableSegment.name, primaryKey: r.COLUMN_KEY === 'PRI' },
      }));
    }

    if (folder?.kind === 'index-folder' && tableSegment) {
      const rows = await this.selectObjects<{ INDEX_NAME: string; NON_UNIQUE: number; INDEX_TYPE: string }>(
        `SELECT DISTINCT INDEX_NAME, NON_UNIQUE, INDEX_TYPE FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME`,
        [database, tableSegment.name],
      );
      return rows.map((r) => ({
        id: `${prefix}index:${r.INDEX_NAME}`,
        kind: 'index' as const,
        label: r.INDEX_NAME,
        detail: `${Number(r.NON_UNIQUE) === 0 ? 'unique ' : ''}${(r.INDEX_TYPE ?? '').toLowerCase()}`,
        hasChildren: false,
        meta: { database, table: tableSegment.name },
      }));
    }

    if (!folder) {
      const folders: TreeNode[] = [
        {
          id: `${prefix}table-folder:tables`,
          kind: 'table-folder',
          label: 'Tables',
          hasChildren: true,
          meta: { database },
        },
        {
          id: `${prefix}view-folder:views`,
          kind: 'view-folder',
          label: 'Views',
          hasChildren: true,
          meta: { database },
        },
        {
          id: `${prefix}routine-folder:routines`,
          kind: 'routine-folder',
          label: 'Routines',
          hasChildren: true,
          meta: { database },
        },
        {
          id: `${prefix}trigger-folder:triggers`,
          kind: 'trigger-folder',
          label: 'Triggers',
          hasChildren: true,
          meta: { database },
        },
      ];
      // Sequences are a MariaDB 10.3+ object (PLAN §4).
      if (this.flavor.supportsSequences) {
        folders.push({
          id: `${prefix}sequence-folder:sequences`,
          kind: 'sequence-folder',
          label: 'Sequences',
          hasChildren: true,
          meta: { database },
        });
      }
      return folders;
    }

    switch (folder.kind) {
      case 'table-folder':
      case 'view-folder':
      case 'sequence-folder': {
        const wanted =
          folder.kind === 'view-folder'
            ? ['VIEW', 'SYSTEM VIEW']
            : folder.kind === 'sequence-folder'
              ? ['SEQUENCE']
              : ['BASE TABLE', 'SYSTEM VERSIONED', 'TEMPORARY'];
        const rows = await this.selectObjects<{
          TABLE_NAME: string;
          TABLE_TYPE: string;
          TABLE_ROWS: string | number | null;
          ENGINE: string | null;
        }>(
          `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, ENGINE FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (?) ORDER BY TABLE_NAME`,
          [database, wanted],
        );
        return rows.map((r) => {
          const isView = r.TABLE_TYPE.toUpperCase().includes('VIEW');
          const isSequence = r.TABLE_TYPE.toUpperCase() === 'SEQUENCE';
          return {
            id: `${prefix}${isSequence ? 'sequence' : isView ? 'view' : 'table'}:${r.TABLE_NAME}`,
            kind: isSequence ? ('sequence' as const) : isView ? ('view' as const) : ('table' as const),
            label: r.TABLE_NAME,
            detail:
              !isView && !isSequence && r.TABLE_ROWS !== null
                ? `~${Number(r.TABLE_ROWS).toLocaleString()} rows`
                : undefined,
            hasChildren: !isSequence,
            meta: { database, table: r.TABLE_NAME, engine: r.ENGINE ?? undefined },
          };
        });
      }
      case 'routine-folder': {
        const rows = await this.selectObjects<{ ROUTINE_NAME: string; ROUTINE_TYPE: string }>(
          `SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES
            WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
          [database],
        );
        return rows.map((r) => ({
          id: `${prefix}routine:${r.ROUTINE_NAME}`,
          kind: 'routine' as const,
          label: r.ROUTINE_NAME,
          detail: r.ROUTINE_TYPE.toLowerCase(),
          hasChildren: false,
          meta: { database, routine: r.ROUTINE_NAME, routineType: r.ROUTINE_TYPE },
        }));
      }
      case 'trigger-folder': {
        const rows = await this.selectObjects<{
          TRIGGER_NAME: string;
          EVENT_OBJECT_TABLE: string;
          ACTION_TIMING: string;
          EVENT_MANIPULATION: string;
        }>(
          `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION
             FROM information_schema.TRIGGERS
            WHERE EVENT_OBJECT_SCHEMA = ? ORDER BY TRIGGER_NAME`,
          [database],
        );
        return rows.map((r) => ({
          id: `${prefix}trigger:${r.TRIGGER_NAME}`,
          kind: 'trigger' as const,
          label: r.TRIGGER_NAME,
          detail: `${r.ACTION_TIMING} ${r.EVENT_MANIPULATION} on ${r.EVENT_OBJECT_TABLE}`,
          hasChildren: false,
          meta: { database, table: r.EVENT_OBJECT_TABLE },
        }));
      }
      default:
        return [];
    }
  }

  // --- quoting (PLAN §9) ----------------------------------------------------

  quoteIdent(name: string): string {
    return this.quoter.ident(name);
  }

  quoteLiteral(value: string): string {
    return this.quoter.literal(value);
  }
}

// ---------------------------------------------------------------------------
// Editability (PLAN §6 "Grid editing")
// ---------------------------------------------------------------------------

function editTargetFor(fields: FieldPacket[]): {
  target: ResultSet['editTarget'];
  reason?: string;
} {
  if (fields.length === 0) return { target: null };
  const tables = new Set(fields.map((f) => f.orgTable).filter((t): t is string => !!t));
  if (tables.size === 0) return { target: null, reason: 'The result has no source table.' };
  if (tables.size > 1) {
    return { target: null, reason: 'The result joins more than one table, so rows cannot be updated.' };
  }
  const expression = fields.find((f) => !f.orgName);
  if (expression) {
    return {
      target: null,
      reason: `Column "${expression.name}" is an expression, so the result is read-only.`,
    };
  }

  const flagged = (flag: number): string[] =>
    fields
      .filter((f) => typeof f.flags === 'number' && (f.flags & flag) !== 0)
      .map((f) => f.orgName || f.name);

  let keyColumns = flagged(FIELD_FLAG.PRI_KEY);
  if (keyColumns.length === 0) {
    // Fall back to a unique index with no nullable member.
    keyColumns = fields
      .filter(
        (f) =>
          typeof f.flags === 'number' &&
          (f.flags & FIELD_FLAG.UNIQUE_KEY) !== 0 &&
          (f.flags & FIELD_FLAG.NOT_NULL) !== 0,
      )
      .map((f) => f.orgName || f.name);
  }
  if (keyColumns.length === 0) {
    return {
      target: null,
      reason: 'No primary or unique key is present in the result, so rows cannot be addressed.',
    };
  }

  const first = fields[0];
  return {
    target: { schema: first.schema || first.db || undefined, table: [...tables][0], keyColumns },
  };
}

// ---------------------------------------------------------------------------
// EXPLAIN parsing
// ---------------------------------------------------------------------------

/** Scalars worth showing inline on a plan node. */
const PLAN_DETAIL_KEYS = new Set([
  'access_type',
  'key',
  'possible_keys',
  'key_length',
  'ref',
  'filtered',
  'attached_condition',
  'using_index',
  'using_filesort',
  'using_temporary_table',
  'select_id',
  'message',
  'index_condition',
  'table_name',
]);

const PLAN_METRIC_KEYS = new Set([
  'cost_info',
  'rows_produced_per_join',
  'rows_examined_per_scan',
  'rows',
  'r_rows',
  'r_total_time_ms',
  'r_loops',
  'loops',
]);

function planNode(label: string, value: unknown): ExplainNode {
  const node: ExplainNode = { label, children: [] };
  if (value === null || value === undefined) return node;
  if (typeof value !== 'object') {
    node.detail = String(value);
    return node;
  }
  if (Array.isArray(value)) {
    value.forEach((child, i) => node.children.push(planNode(`${label} #${i + 1}`, child)));
    return node;
  }

  const obj = value as Record<string, unknown>;
  const details: string[] = [];
  const extra: Record<string, unknown> = {};

  if (typeof obj.table_name === 'string') {
    const access = typeof obj.access_type === 'string' ? obj.access_type : 'scan';
    node.label = `${access} on ${obj.table_name}`;
  }

  for (const [key, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (key === 'cost_info' && typeof v === 'object') {
      const info = v as Record<string, unknown>;
      const cost = Number(info.query_cost ?? info.prefix_cost ?? info.read_cost ?? Number.NaN);
      if (Number.isFinite(cost)) node.estimatedCost = cost;
      continue;
    }
    if (key === 'rows_produced_per_join' || key === 'rows_examined_per_scan' || key === 'rows') {
      const n = Number(v);
      if (Number.isFinite(n)) node.estimatedRows = node.estimatedRows ?? n;
      continue;
    }
    if (key === 'r_rows') {
      const n = Number(v);
      if (Number.isFinite(n)) node.actualRows = n;
      continue;
    }
    if (key === 'r_total_time_ms') {
      const n = Number(v);
      if (Number.isFinite(n)) node.actualTimeMs = n;
      continue;
    }
    if (key === 'r_loops' || key === 'loops') {
      const n = Number(v);
      if (Number.isFinite(n)) node.loops = n;
      continue;
    }
    if (typeof v === 'object') {
      node.children.push(planNode(key, v));
      continue;
    }
    if (PLAN_DETAIL_KEYS.has(key)) details.push(`${key}=${String(v)}`);
    else if (!PLAN_METRIC_KEYS.has(key)) extra[key] = v;
  }

  if (details.length > 0) node.detail = details.join(', ');
  if (Object.keys(extra).length > 0) node.extra = extra;
  return node;
}

function applyShares(node: ExplainNode, total: number): void {
  if (total > 0 && node.actualTimeMs !== undefined) node.share = node.actualTimeMs / total;
  for (const child of node.children) applyShares(child, total);
}

export function parseJsonPlan(engine: EngineKind, raw: string, analyzed: boolean): ExplainPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      engine,
      analyzed,
      root: { label: 'plan', detail: raw, children: [] },
      raw,
    };
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const block = obj.query_block ?? parsed;
  const root = planNode('query_block', block);
  const total = root.actualTimeMs ?? 0;
  if (analyzed) applyShares(root, total);
  return {
    engine,
    analyzed,
    root,
    totalTimeMs: analyzed ? root.actualTimeMs : undefined,
    raw,
  };
}

/**
 * MySQL 8's `EXPLAIN ANALYZE` emits an indented tree:
 *   `-> Limit: 10 row(s)  (cost=1.05 rows=10) (actual time=0.03..0.04 rows=10 loops=1)`
 * Depth is the indentation of the arrow.
 */
export function parseTreePlan(engine: EngineKind, raw: string): ExplainPlan {
  const root: ExplainNode = { label: 'Query', children: [] };
  const stack: { indent: number; node: ExplainNode }[] = [{ indent: -1, node: root }];

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^(\s*)->\s?(.*)$/.exec(line);
    if (!match) {
      const top = stack[stack.length - 1].node;
      top.detail = top.detail ? `${top.detail}\n${line.trim()}` : line.trim();
      continue;
    }
    const indent = match[1].length;
    const text = match[2];
    const node: ExplainNode = { label: text.replace(/\s*\((cost|actual)=.*$/, '').trim(), children: [] };

    const estimate = /\(cost=([\d.e+-]+)\s+rows=([\d.e+-]+)\)/i.exec(text);
    if (estimate) {
      node.estimatedCost = Number(estimate[1]);
      node.estimatedRows = Number(estimate[2]);
    }
    const actual = /\(actual time=([\d.]+)\.\.([\d.]+)\s+rows=([\d.e+-]+)\s+loops=(\d+)\)/i.exec(text);
    if (actual) {
      // The second number is the time to the *last* row, per loop.
      node.actualTimeMs = Number(actual[2]) * Number(actual[4]);
      node.actualRows = Number(actual[3]);
      node.loops = Number(actual[4]);
    } else if (/\(never executed\)/i.test(text)) {
      node.actualRows = 0;
      node.actualTimeMs = 0;
    }

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }

  const top = root.children.length === 1 ? root.children[0] : root;
  const total = top.actualTimeMs ?? 0;
  applyShares(top, total);
  return { engine, analyzed: true, root: top, totalTimeMs: total || undefined, raw };
}

export function createMysqlConnector(ctx: ConnectorContext): SqlConnector {
  return new MysqlConnector(ctx);
}
