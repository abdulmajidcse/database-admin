/**
 * PostgreSQL connector (PLAN §4, §6, §8).
 *
 * Design notes that are not obvious from the code:
 *
 * - **Nothing is buffered.** Every row-producing statement runs through
 *   `pg-cursor`, so `query()` returns the first page plus a live server-side
 *   cursor and `stream()` walks the whole result in batches (§6 "Big results").
 * - **Nothing is silently converted.** The pool installs identity text parsers
 *   (`./types`) and this file re-encodes each value from its OID, so int8 /
 *   numeric / money / date / timestamp / timestamptz / interval stay lossless
 *   strings and bytea becomes a Buffer (§6 "Type fidelity").
 * - **Cancellation uses a second connection**, because the busy one cannot
 *   accept another query: we keep `client.processID` per run and issue
 *   `pg_cancel_backend` from a throwaway client (§6 "Query cancellation").
 * - **Introspection has a fixed round-trip count** — see `./introspect` (§8.3).
 * - **Read-only connections are enforced by the server**, via
 *   `default_transaction_read_only` applied before the client is ever handed
 *   out, not just by client-side statement classification (§8.5).
 * - This file, like everything under `src/server`, imports zero React and zero
 *   Next types (§11).
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConnectionOptions as TlsOptions } from 'node:tls';
import { Client, Pool } from 'pg';
import type { FieldDef, PoolClient, PoolConfig, Submittable } from 'pg';
// @ts-ignore -- pg-cursor ships no type declarations; typed by PgCursorCtor below.
import CursorImpl from 'pg-cursor';

import type { IntrospectScope, SchemaModel, TableModel } from '../../../../lib/schema-model';
import type {
  ApplyResult,
  ChangePreview,
  Changeset,
  ColumnMeta,
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
import type { Cell, Row } from '../../../../lib/wire';
import { CONFIG, loopbackAdvice } from '../../../config';
import { DbError } from '../../types';
import type {
  Capability,
  ConnectorContext,
  ConnectorEvent,
  DdlTarget,
  SqlConnector,
  TableReadRequest,
} from '../../types';
import { buildWhere } from '../../sql/filters';
import { introspectPostgres } from './introspect';
import type { PgQueryFn, PgRow } from './introspect';
import {
  PG_TEXT_TYPES,
  PgTypeRegistry,
  cellToPgParam,
  encodePgCell,
  qualify,
  quoteIdent,
  quoteLiteral,
  toDbError,
} from './types';
import { buildPgChangeStatements, planPostgresTableDdl, renderTableDdl } from './ddl';

// ---------------------------------------------------------------------------
// pg-cursor typings (the package ships none).
// ---------------------------------------------------------------------------

interface PgResultLike {
  fields: FieldDef[];
  rowCount: number | null;
  command: string | null;
}

interface PgCursor {
  submit(connection: unknown): void;
  read(
    rows: number,
    cb: (err: Error | null, rows: unknown[][], result?: PgResultLike) => void,
  ): void;
  close(): Promise<void>;
}

interface PgCursorCtor {
  new (
    text: string,
    values: unknown[] | null,
    config?: { rowMode?: string; types?: unknown },
  ): PgCursor;
}

const Cursor = CursorImpl as unknown as PgCursorCtor;

function cursorRead(
  cursor: PgCursor,
  rows: number,
): Promise<{ rows: unknown[][]; result?: PgResultLike }> {
  return new Promise((resolve, reject) => {
    cursor.read(rows, (err, out, result) => {
      if (err) reject(err);
      else resolve({ rows: out ?? [], result });
    });
  });
}

/**
 * A cursor whose statement errored has already been synced by the driver, so
 * its `close()` waits for a readyForQuery that will never arrive. Cap the wait
 * rather than deadlocking the caller.
 */
async function closeCursorSafely(cursor: PgCursor): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      cursor.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Catalog SQL used outside introspection
// ---------------------------------------------------------------------------

const SQL_BOOTSTRAP = `
  SELECT version() AS version,
         current_setting('server_version_num') AS version_num,
         current_database() AS db`;

const SQL_TYPES = `
  SELECT t.oid::text  AS oid,
         t.typname    AS name,
         n.nspname    AS schema,
         t.typtype::text     AS kind,
         t.typcategory::text AS category,
         t.typelem::text     AS elem,
         t.typbasetype::text AS base,
         t.typdelim   AS delim
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace`;

const SQL_TYPES_BY_OID = `${SQL_TYPES} WHERE t.oid = ANY($1::oid[])`;

/**
 * Relation identity + the key the grid needs to become editable: the primary
 * key, or the first non-partial unique index whose members are all NOT NULL
 * (PLAN §6 "Grid editing"). int2vector goes through its text form because it
 * has no unnest() and is 0-based when subscripted.
 */
const SQL_RELATIONS = `
  SELECT c.oid::text AS oid,
         n.nspname   AS schema,
         c.relname   AS name,
         c.relkind::text AS kind,
         (SELECT array_agg(a.attname ORDER BY k.ord)::text
            FROM pg_index i
            CROSS JOIN LATERAL unnest(string_to_array(i.indkey::text, ' ')::int[])
                 WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           WHERE i.indrelid = c.oid AND i.indisprimary AND i.indisvalid) AS pk,
         (SELECT array_agg(a.attname ORDER BY k.ord)::text
            FROM (SELECT i.indrelid, i.indkey
                    FROM pg_index i
                   WHERE i.indrelid = c.oid AND i.indisunique AND i.indisvalid
                     AND i.indpred IS NULL
                     AND 0 <> ALL (string_to_array(i.indkey::text, ' ')::int[])
                     AND NOT EXISTS (
                           SELECT 1 FROM pg_attribute x
                            WHERE x.attrelid = i.indrelid
                              AND x.attnum = ANY (string_to_array(i.indkey::text, ' ')::int[])
                              AND NOT x.attnotnull)
                   ORDER BY i.indexrelid
                   LIMIT 1) i
            CROSS JOIN LATERAL unnest(string_to_array(i.indkey::text, ' ')::int[])
                 WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS uk
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = ANY($1::oid[])`;

const SQL_PROCESSES = `
  SELECT a.pid::text AS pid,
         a.usename   AS usename,
         COALESCE(host(a.client_addr) || ':' || a.client_port::text,
                  a.client_hostname,
                  NULLIF(a.application_name, '')) AS client,
         a.datname   AS datname,
         a.state     AS state,
         a.backend_type AS backend_type,
         (EXTRACT(EPOCH FROM (now() - COALESCE(a.query_start, a.backend_start))) * 1000)::bigint::text AS duration_ms,
         a.query     AS query,
         NULLIF(concat_ws(': ', a.wait_event_type, a.wait_event), '') AS wait_event,
         pg_blocking_pids(a.pid)::text AS blocking
    FROM pg_stat_activity a
   WHERE a.pid <> pg_backend_pid()
   ORDER BY a.backend_start`;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface RelationInfo {
  oid: number;
  schema: string;
  name: string;
  /** pg_class.relkind */
  kind: string;
  primaryKey: string[];
  uniqueKey: string[];
}

interface PgDatabase {
  key: string;
  /** Actual `current_database()`, resolved on connect. */
  name: string;
  pool: Pool;
  types: PgTypeRegistry;
  relations: Map<number, RelationInfo>;
}

interface Lease {
  client: PoolClient;
  db: PgDatabase;
  release(): void;
  /** True for pinned transaction sessions, which must not be released. */
  pinned: boolean;
}

interface CursorEntry {
  cursor: PgCursor;
  lease: Lease;
  fields: FieldDef[];
  db: PgDatabase;
  pending?: Row;
  timer: NodeJS.Timeout;
}

interface SessionEntry {
  info: SessionInfo;
  lease: Lease;
  timer: NodeJS.Timeout;
}

interface RunEntry {
  pid: number | null;
  database: string;
}

const CURSOR_IDLE_MS = 10 * 60 * 1000;
const SESSION_IDLE_MS = 15 * 60 * 1000;

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'sql',
  'transactions',
  'explain',
  'ddl',
  'routines',
  'schemas',
  'multipleDatabases',
  'processList',
  'cancel',
  'streaming',
]);

// ---------------------------------------------------------------------------

export function createPostgresConnector(ctx: ConnectorContext): SqlConnector {
  return new PostgresConnector(ctx);
}

class PostgresConnector implements SqlConnector {
  readonly kind = 'postgres' as const;
  readonly capabilities = CAPABILITIES;

  private readonly ctx: ConnectorContext;
  private readonly dbs = new Map<string, Promise<PgDatabase>>();
  private readonly cursors = new Map<string, CursorEntry>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly runs = new Map<string, RunEntry>();
  /** Applied search_path per pooled client, so we only SET when it changes. */
  private readonly searchPaths = new WeakMap<object, string>();
  private serverVersion = '';
  private serverVersionNum = 0;
  private closed = false;

  constructor(ctx: ConnectorContext) {
    this.ctx = ctx;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async open(): Promise<void> {
    this.emit({ type: 'state', state: 'connecting' });
    try {
      await this.db();
      this.emit({ type: 'state', state: 'connected', message: this.serverVersion });
    } catch (err) {
      const e = this.connectError(err);
      this.emit({ type: 'state', state: 'closed', message: e.message });
      throw e;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.cursors.keys()]) await this.closeCursor(id);
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
    const pools = [...this.dbs.values()];
    this.dbs.clear();
    for (const p of pools) {
      const db = await p.catch(() => null);
      if (db) await db.pool.end().catch(() => undefined);
    }
    await this.ctx.resolved.release().catch(() => undefined);
    this.emit({ type: 'state', state: 'closed' });
  }

  async ping(): Promise<ServerInfo> {
    const db = await this.db();
    const started = Date.now();
    const res = await db.pool.query<PgRow>(`
      SELECT version() AS version,
             current_setting('server_version_num') AS version_num,
             EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint::text AS uptime,
             current_database() AS db,
             current_user AS "user",
             current_setting('server_encoding') AS encoding,
             current_setting('default_transaction_read_only') AS read_only,
             inet_server_addr()::text AS server_addr`);
    const rttMs = Date.now() - started;
    const row: PgRow = res.rows[0] ?? {};
    this.serverVersion = row.version ?? this.serverVersion;
    this.serverVersionNum = Number(row.version_num ?? this.serverVersionNum);
    return {
      version: row.version ?? '',
      versionNumber: Number(row.version_num ?? 0) || undefined,
      edition: /PostgreSQL ([\d.]+)/.exec(row.version ?? '')?.[1],
      uptimeSeconds: row.uptime ? Number(row.uptime) : undefined,
      rttMs,
      details: {
        database: row.db ?? '',
        user: row.user ?? '',
        encoding: row.encoding ?? '',
        readOnlyTransactions: row.read_only ?? 'off',
        serverAddress: row.server_addr ?? 'unix socket',
        tunneled: this.ctx.resolved.tunneled ? 'yes' : 'no',
      },
    };
  }

  private emit(e: ConnectorEvent): void {
    this.ctx.onEvent?.(e);
  }

  // -------------------------------------------------------------------------
  // Pools (one per database — Postgres cannot switch database on a live link)
  // -------------------------------------------------------------------------

  private db(name?: string): Promise<PgDatabase> {
    if (this.closed) return Promise.reject(new DbError('Connection is closed'));
    const key = name ?? '';
    const existing = this.dbs.get(key);
    if (existing) return existing;
    const created = this.openDatabase(key, name).catch((err: unknown) => {
      this.dbs.delete(key);
      throw err;
    });
    this.dbs.set(key, created);
    return created;
  }

  private async openDatabase(key: string, name?: string): Promise<PgDatabase> {
    const pool = new Pool(this.poolConfig(name));
    // An idle pooled client that errors (NAT timeout, server restart) must not
    // take the process down (§8.3 "Idle connections die").
    pool.on('error', (err: Error) => this.emit({ type: 'error', message: err.message }));

    const db: PgDatabase = {
      key,
      name: name ?? '',
      pool,
      types: new PgTypeRegistry(),
      relations: new Map(),
    };
    try {
      const boot = await pool.query<PgRow>(SQL_BOOTSTRAP);
      const row: PgRow = boot.rows[0] ?? {};
      db.name = row.db ?? db.name;
      this.serverVersion = row.version ?? '';
      this.serverVersionNum = Number(row.version_num ?? 0);
      const types = await pool.query<PgRow>(SQL_TYPES);
      this.absorbTypes(db, types.rows);
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw this.connectError(err);
    }
    return db;
  }

  private poolConfig(database?: string): PoolConfig {
    const { config, resolved, password } = this.ctx;
    const address = resolved.address;
    const options = config.options;

    const cfg: PoolConfig = {
      user: config.username,
      password,
      database: database ?? options.database,
      application_name: 'dbadmin',
      connectionTimeoutMillis: options.connectTimeoutMs ?? 15_000,
      // Two connections minimum: a page held open behind a cursor must never
      // starve the catalog lookups that build its column metadata.
      max: Math.max(2, options.poolSize ?? 5),
      idleTimeoutMillis: CONFIG.poolIdleMs,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
      types: PG_TEXT_TYPES,
      onConnect: (client) => client.query(this.sessionSetupSql()),
    };

    switch (address.kind) {
      case 'tcp':
        cfg.host = address.host;
        cfg.port = address.port;
        break;
      case 'unix': {
        // libpq (and pg) take the socket *directory* as the host and derive
        // `<dir>/.s.PGSQL.<port>` from it (§8.2).
        const socket = splitUnixSocket(address.socketPath);
        cfg.host = socket.directory;
        cfg.port = socket.port;
        break;
      }
      case 'uri':
        // A parsed connection string wins over sibling config fields in pg, so
        // switching database has to happen inside the URI itself.
        cfg.connectionString = database ? withUriDatabase(address.uri, database) : address.uri;
        break;
      case 'file':
        throw new DbError('PostgreSQL cannot be opened from a file path');
    }

    const ssl = this.tlsOptions();
    if (ssl) cfg.ssl = ssl;

    for (const [k, v] of Object.entries(options.driverOptions ?? {})) {
      (cfg as Record<string, unknown>)[k] = v;
    }
    return cfg;
  }

  /**
   * One multi-statement simple query, run once per physical connection *before*
   * the pool hands it out. Sent as `SET` rather than startup `options=-c …`
   * because connection poolers (PgBouncer in transaction mode) reject unknown
   * startup parameters outright.
   *
   * DateStyle/IntervalStyle/bytea_output are pinned so the text we parse in
   * `./types` is the format we expect regardless of server defaults (§6).
   */
  private sessionSetupSql(): string {
    const { config } = this.ctx;
    const stmts = [
      `SET DateStyle = 'ISO, MDY'`,
      `SET IntervalStyle = 'postgres'`,
      `SET bytea_output = 'hex'`,
      `SET client_min_messages = notice`,
      `SET search_path TO ${this.defaultSearchPath}`,
    ];
    const timeout = config.options.statementTimeoutMs;
    if (timeout && timeout > 0) stmts.push(`SET statement_timeout = ${Math.floor(timeout)}`);
    // Belt and braces with the client-side statement classifier (§8.5).
    if (config.readOnly) stmts.push(`SET default_transaction_read_only = on`);
    return `${stmts.join('; ')};`;
  }

  private get defaultSearchPath(): string {
    const schema = this.ctx.config.options.defaultSchema;
    return schema ? `${quoteIdent(schema)}, "$user", public` : `"$user", public`;
  }

  private tlsOptions(): TlsOptions | undefined {
    const tls = this.ctx.config.tls;
    if (!tls?.enabled) return undefined;
    const opts: TlsOptions = {};
    if (tls.caCert) opts.ca = readPem(tls.caCert);
    if (tls.clientCert) opts.cert = readPem(tls.clientCert);
    if (tls.clientKey) opts.key = readPem(tls.clientKey);

    // Through a tunnel the dialled host is 127.0.0.1, which no certificate
    // names; verify against the host the user actually configured (§8.1).
    const original = this.ctx.resolved.original;
    if (tls.serverName) opts.servername = tls.serverName;
    else if (this.ctx.resolved.tunneled && original.kind === 'tcp') opts.servername = original.host;

    switch (tls.verify) {
      case 'verify-full':
        opts.rejectUnauthorized = true;
        break;
      case 'require':
        // libpq's `require`: encrypt, but do not validate the chain or name.
        opts.rejectUnauthorized = false;
        break;
      case 'skip':
        opts.rejectUnauthorized = false;
        delete opts.ca;
        break;
    }
    return opts;
  }

  /** A refused loopback connection inside a container is almost always §10.3. */
  private connectError(err: unknown): DbError {
    const base = toDbError(err);
    const original = this.ctx.resolved.original;
    if (this.ctx.resolved.tunneled || original.kind !== 'tcp') return base;
    const advice = loopbackAdvice(original.host);
    if (!advice) return base;
    return new DbError(`${base.message}\n\n${advice}`, base.code, base.detail, base.position);
  }

  // -------------------------------------------------------------------------
  // Catalog caches
  // -------------------------------------------------------------------------

  private absorbTypes(db: PgDatabase, rows: PgRow[]): void {
    for (const r of rows) {
      db.types.set({
        oid: Number(r.oid),
        name: r.name ?? '',
        schema: r.schema ?? '',
        kind: r.kind ?? 'b',
        category: r.category ?? '',
        elem: Number(r.elem ?? 0),
        base: Number(r.base ?? 0),
        delim: r.delim ?? ',',
      });
    }
  }

  /** Lazy top-up when a query returns a type created since we connected. */
  private async ensureTypes(db: PgDatabase, oids: number[]): Promise<void> {
    const missing = db.types.missing(oids);
    if (missing.length === 0) return;
    const res = await db.pool.query<PgRow>(SQL_TYPES_BY_OID, [missing]);
    this.absorbTypes(db, res.rows);
  }

  private async relations(db: PgDatabase, oids: number[]): Promise<Map<number, RelationInfo>> {
    const out = new Map<number, RelationInfo>();
    const missing: number[] = [];
    for (const oid of oids) {
      const cached = db.relations.get(oid);
      if (cached) out.set(oid, cached);
      else if (oid > 0) missing.push(oid);
    }
    if (missing.length > 0) {
      const res = await db.pool.query<PgRow>(SQL_RELATIONS, [missing]);
      for (const r of res.rows) {
        const info: RelationInfo = {
          oid: Number(r.oid),
          schema: r.schema ?? '',
          name: r.name ?? '',
          kind: r.kind ?? 'r',
          primaryKey: parseNameArray(r.pk),
          uniqueKey: parseNameArray(r.uk),
        };
        db.relations.set(info.oid, info);
        out.set(info.oid, info);
      }
    }
    return out;
  }

  private catalogQuery(db: PgDatabase): PgQueryFn {
    return async (sql, params) => {
      const res = await db.pool.query<PgRow>(sql, (params ?? []) as unknown[]);
      return res.rows;
    };
  }

  // -------------------------------------------------------------------------
  // Leases and search_path
  // -------------------------------------------------------------------------

  private async acquire(opts: RunOpts): Promise<Lease> {
    if (opts.sessionId) {
      const session = this.sessions.get(opts.sessionId);
      if (!session) throw new DbError(`Session ${opts.sessionId} is no longer open`);
      this.touchSession(session);
      return session.lease;
    }
    const db = await this.db(opts.database);
    const client = await db.pool.connect();
    let released = false;
    return {
      client,
      db,
      pinned: false,
      release: () => {
        if (released) return;
        released = true;
        client.release();
      },
    };
  }

  private async ensureSearchPath(lease: Lease, schema?: string): Promise<void> {
    const want = schema ? `${quoteIdent(schema)}, "$user", public` : this.defaultSearchPath;
    const current = this.searchPaths.get(lease.client) ?? this.defaultSearchPath;
    if (current === want) {
      this.searchPaths.set(lease.client, want);
      return;
    }
    await lease.client.query(`SET search_path TO ${want}`);
    this.searchPaths.set(lease.client, want);
  }

  // -------------------------------------------------------------------------
  // Query execution
  // -------------------------------------------------------------------------

  async query(sql: string, opts: RunOpts = {}): Promise<ResultSet> {
    const started = Date.now();
    const lease = await this.acquire(opts);
    const notices: string[] = [];
    const onNotice = (n: { message?: string }): void => {
      if (!n.message) return;
      notices.push(n.message);
      this.emit({ type: 'notice', message: n.message });
    };
    lease.client.on('notice', onNotice);

    const runId = opts.runId;
    if (runId) this.runs.set(runId, { pid: backendPid(lease.client), database: lease.db.name });
    const onAbort = runId ? () => void this.cancel(runId).catch(() => undefined) : undefined;
    if (onAbort && opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

    let keepLease = false;
    let cursor: PgCursor | undefined;
    try {
      await this.ensureSearchPath(lease, opts.schema);
      const params = (opts.params ?? []).map((p) => cellToPgParam(p as Cell));
      const maxRows = Math.max(1, opts.maxRows ?? CONFIG.defaultPageSize);

      // DDL/DML without RETURNING produces no portal worth streaming.
      if (!returnsRows(sql)) {
        const res = await lease.client.query({ text: sql, values: params, rowMode: 'array' });
        return {
          statement: sql,
          columns: [],
          rows: [],
          truncated: false,
          affectedRows: res.rowCount ?? undefined,
          durationMs: Date.now() - started,
          notices: notices.length > 0 ? notices : undefined,
          editTarget: null,
        };
      }

      cursor = new Cursor(sql, params.length > 0 ? params : null, {
        rowMode: 'array',
        types: PG_TEXT_TYPES,
      });
      lease.client.query(cursor as unknown as Submittable);

      // Read one extra row: that is how we know whether more remain without
      // paying a second round trip to find out.
      const first = await cursorRead(cursor, maxRows + 1);
      const fields = first.result?.fields ?? [];
      const affected = first.result?.rowCount ?? undefined;

      await this.ensureTypes(
        lease.db,
        fields.map((f) => f.dataTypeID),
      );
      const rows = first.rows.map((r) => this.encodeRow(r, fields, lease.db.types));
      const meta = await this.describeResult(lease.db, fields);

      let truncated = false;
      let cursorId: string | undefined;
      if (rows.length > maxRows) {
        const pending = rows.pop();
        truncated = true;
        cursorId = randomUUID();
        keepLease = true;
        const entry: CursorEntry = {
          cursor,
          lease,
          fields,
          db: lease.db,
          pending,
          timer: setTimeout(() => void this.closeCursor(cursorId as string), CURSOR_IDLE_MS),
        };
        entry.timer.unref?.();
        this.cursors.set(cursorId, entry);
      }

      return {
        statement: sql,
        columns: meta.columns,
        rows,
        truncated,
        cursorId,
        affectedRows: fields.length === 0 ? affected : undefined,
        durationMs: Date.now() - started,
        notices: notices.length > 0 ? notices : undefined,
        editTarget: meta.editTarget,
        readOnlyReason: meta.readOnlyReason,
      };
    } catch (err) {
      throw toDbError(err);
    } finally {
      lease.client.removeListener('notice', onNotice);
      if (runId) this.runs.delete(runId);
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
      // A portal left open would poison the pooled connection for its next user.
      if (!keepLease && cursor) await closeCursorSafely(cursor);
      if (!keepLease && !lease.pinned) lease.release();
    }
  }

  async fetchMore(cursorId: string, n: number): Promise<ResultChunk> {
    const entry = this.cursors.get(cursorId);
    if (!entry) throw new DbError(`Cursor ${cursorId} has expired`);
    clearTimeout(entry.timer);
    const want = Math.max(1, n);
    const rows: Row[] = [];
    if (entry.pending) {
      rows.push(entry.pending);
      entry.pending = undefined;
    }
    try {
      while (rows.length <= want) {
        const batch = await cursorRead(entry.cursor, want + 1 - rows.length);
        if (batch.rows.length === 0) break;
        for (const raw of batch.rows) rows.push(this.encodeRow(raw, entry.fields, entry.db.types));
      }
    } catch (err) {
      await this.closeCursor(cursorId);
      throw toDbError(err);
    }

    let truncated = false;
    if (rows.length > want) {
      entry.pending = rows.pop();
      truncated = true;
      entry.timer = setTimeout(() => void this.closeCursor(cursorId), CURSOR_IDLE_MS);
      entry.timer.unref?.();
    } else {
      await this.closeCursor(cursorId);
    }
    return { rows, truncated };
  }

  async closeCursor(cursorId: string): Promise<void> {
    const entry = this.cursors.get(cursorId);
    if (!entry) return;
    this.cursors.delete(cursorId);
    clearTimeout(entry.timer);
    await closeCursorSafely(entry.cursor);
    if (!entry.lease.pinned) entry.lease.release();
  }

  /** Unbounded read for export/copy: batches through the cursor, never buffers. */
  async *stream(sql: string, opts: RunOpts = {}) {
    const lease = await this.acquire(opts);
    const runId = opts.runId;
    if (runId) this.runs.set(runId, { pid: backendPid(lease.client), database: lease.db.name });
    const batchSize = Math.max(1, opts.maxRows ?? 1_000);
    let cursor: PgCursor | undefined;
    try {
      await this.ensureSearchPath(lease, opts.schema);
      const params = (opts.params ?? []).map((p) => cellToPgParam(p as Cell));
      cursor = new Cursor(sql, params.length > 0 ? params : null, {
        rowMode: 'array',
        types: PG_TEXT_TYPES,
      });
      lease.client.query(cursor as unknown as Submittable);

      let fields: FieldDef[] | undefined;
      for (;;) {
        if (opts.signal?.aborted) break;
        const batch = await cursorRead(cursor, batchSize);
        if (!fields) {
          fields = batch.result?.fields ?? [];
          await this.ensureTypes(
            lease.db,
            fields.map((f) => f.dataTypeID),
          );
        }
        if (batch.rows.length === 0) break;
        yield batch.rows.map((r) => this.encodeRow(r, fields as FieldDef[], lease.db.types));
      }
    } catch (err) {
      throw toDbError(err);
    } finally {
      if (cursor) await closeCursorSafely(cursor);
      if (runId) this.runs.delete(runId);
      if (!lease.pinned) lease.release();
    }
  }

  /**
   * Closing the socket does not stop the server, so cancellation goes out over a
   * *separate* connection targeting the backend pid we recorded (§6).
   */
  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.pid === null) return;
    const client = new Client(this.poolConfig(run.database || undefined));
    try {
      await client.connect();
      await client.query('SELECT pg_cancel_backend($1::int)', [run.pid]);
    } catch (err) {
      throw toDbError(err, 'Cancel failed');
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private encodeRow(raw: unknown[], fields: FieldDef[], types: PgTypeRegistry): Row {
    const out: Cell[] = new Array(fields.length);
    for (let i = 0; i < fields.length; i++) {
      const value = raw[i];
      out[i] =
        value === null || value === undefined
          ? null
          : encodePgCell(fields[i].dataTypeID, String(value), types);
    }
    return out;
  }

  /**
   * Column metadata plus the editability verdict. `FieldDef.tableID` is the
   * source relation's oid, which is the only trustworthy way to know whether a
   * result is a plain single-table select (§6 "Grid editing").
   */
  private async describeResult(
    db: PgDatabase,
    fields: FieldDef[],
  ): Promise<{
    columns: ColumnMeta[];
    editTarget: ResultSet['editTarget'];
    readOnlyReason?: string;
  }> {
    const tableIds = new Set(fields.filter((f) => f.tableID > 0).map((f) => f.tableID));
    const rels = await this.relations(db, [...tableIds]);
    const columns: ColumnMeta[] = fields.map((f) => {
      const rel = f.tableID > 0 ? rels.get(f.tableID) : undefined;
      return {
        name: f.name,
        typeName: db.types.displayName(f.dataTypeID),
        base: db.types.baseOf(f.dataTypeID),
        table: rel?.name,
        schema: rel?.schema,
      };
    });

    if (this.ctx.config.readOnly) {
      return { columns, editTarget: null, readOnlyReason: 'This connection is read-only.' };
    }
    if (fields.length === 0) return { columns, editTarget: null };
    if (tableIds.size === 0) {
      return { columns, editTarget: null, readOnlyReason: 'Result is not backed by a table.' };
    }
    if (tableIds.size > 1) {
      return { columns, editTarget: null, readOnlyReason: 'Result combines more than one table.' };
    }
    const rel = rels.get([...tableIds][0]);
    if (!rel) {
      return { columns, editTarget: null, readOnlyReason: 'Source table could not be resolved.' };
    }
    if (rel.kind !== 'r' && rel.kind !== 'p' && rel.kind !== 'f') {
      return { columns, editTarget: null, readOnlyReason: 'Views and materialized views are read-only.' };
    }
    const key = rel.primaryKey.length > 0 ? rel.primaryKey : rel.uniqueKey;
    if (key.length === 0) {
      return {
        columns,
        editTarget: null,
        readOnlyReason: `${rel.name} has no primary key or non-nullable unique index.`,
      };
    }
    const present = new Set(columns.map((c) => c.name));
    const missing = key.filter((k) => !present.has(k));
    if (missing.length > 0) {
      return {
        columns,
        editTarget: null,
        readOnlyReason: `Include ${missing.join(', ')} in the result to edit these rows.`,
      };
    }
    for (const c of columns) if (key.includes(c.name)) c.isKey = true;
    return { columns, editTarget: { schema: rel.schema, table: rel.name, keyColumns: key } };
  }

  // -------------------------------------------------------------------------
  // Table reads
  // -------------------------------------------------------------------------

  async readTable(req: TableReadRequest): Promise<ResultSet> {
    const target = qualify(req.schema, req.table);
    const projection =
      req.columns && req.columns.length > 0 ? req.columns.map(quoteIdent).join(', ') : '*';
    const where = this.where(req);
    const order =
      req.orderBy && req.orderBy.length > 0
        ? ` ORDER BY ${req.orderBy
            .map((o) => `${quoteIdent(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`)
            .join(', ')}`
        : '';
    const limitIndex = where.params.length + 1;
    const sql =
      `SELECT ${projection} FROM ${target}${where.clause}${order}` +
      ` LIMIT $${limitIndex} OFFSET $${limitIndex + 1}`;
    // No `schema` opt: the table reference is already qualified, so there is no
    // reason to spend a round trip moving search_path (§8.3).
    return this.query(sql, { params: [...where.params, req.limit, req.offset], maxRows: req.limit });
  }

  async countTable(req: Omit<TableReadRequest, 'offset' | 'limit' | 'orderBy'>): Promise<number> {
    const db = await this.db();
    const where = this.where(req);
    const sql = `SELECT count(*)::text AS n FROM ${qualify(req.schema, req.table)}${where.clause}`;
    const res = await db.pool.query<PgRow>(sql, where.params);
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * Filter translation is shared across engines; Postgres supplies the `$n`
   * placeholder style and its own identifier quoting.
   */
  private where(req: { filters?: TableReadRequest['filters']; where?: string }): {
    clause: string;
    params: unknown[];
  } {
    // buildWhere emits "WHERE ..." (or '') using $n placeholders for Postgres.
    const built = buildWhere(req.filters ?? [], this.kind, 'dollar');
    const structured = (built.sql ?? '').replace(/^\s*where\b/i, '').trim();
    const raw = (req.where ?? '').replace(/^\s*where\b/i, '').trim();

    // A raw filter-bar expression ANDs with the structured filters rather than
    // replacing them — dropping either silently would return the wrong rows.
    const parts = [structured, raw].filter((x) => x !== '');
    if (parts.length === 0) return { clause: '', params: built.params ?? [] };
    const clause = parts.map((x) => `(${x})`).join(' AND ');
    return { clause: ` WHERE ${clause}`, params: built.params ?? [] };
  }

  // -------------------------------------------------------------------------
  // Introspection & DDL
  // -------------------------------------------------------------------------

  async introspect(scope: IntrospectScope = {}): Promise<SchemaModel> {
    const db = await this.db(scope.database);
    return introspectPostgres({
      scope,
      query: this.catalogQuery(db),
      serverVersion: this.serverVersion,
      serverVersionNum: this.serverVersionNum,
    });
  }

  async generateDdl(target: DdlTarget): Promise<string> {
    const db = await this.db();
    const q = this.catalogQuery(db);

    switch (target.type) {
      case 'table':
      case 'view': {
        const schema = target.schema ?? 'public';
        const model = await introspectPostgres({
          scope: { namespaces: [schema], shallow: true },
          query: q,
          serverVersion: this.serverVersion,
          serverVersionNum: this.serverVersionNum,
          only: { schema, name: target.name },
        });
        const table = model.namespaces
          .flatMap((n) => n.tables)
          .find((t) => t.name === target.name);
        if (!table) throw new DbError(`No such relation: ${schema}.${target.name}`);
        return renderTableDdl(table);
      }
      case 'index': {
        const rows = await q(
          `SELECT pg_get_indexdef(ic.oid, 0, true) AS def
             FROM pg_class ic
             JOIN pg_namespace n ON n.oid = ic.relnamespace
            WHERE ic.relname = $2 AND n.nspname = $1`,
          [target.schema ?? 'public', target.name],
        );
        if (rows.length === 0) throw new DbError(`No such index: ${target.name}`);
        return `${rows[0].def ?? ''};`;
      }
      case 'routine': {
        const rows = await q(
          `SELECT pg_get_functiondef(p.oid) AS def
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = $1 AND p.proname = $2
            ORDER BY p.oid`,
          [target.schema ?? 'public', target.name],
        );
        if (rows.length === 0) throw new DbError(`No such routine: ${target.name}`);
        // Overloads share a name, so every definition is emitted.
        return rows.map((r) => r.def ?? '').join('\n\n');
      }
      case 'database': {
        const rows = await q(
          `SELECT d.datname AS name,
                  pg_get_userbyid(d.datdba) AS owner,
                  pg_encoding_to_char(d.encoding) AS encoding,
                  d.datcollate AS collate,
                  d.datctype AS ctype
             FROM pg_database d WHERE d.datname = $1`,
          [target.name],
        );
        if (rows.length === 0) throw new DbError(`No such database: ${target.name}`);
        const r: PgRow = rows[0];
        return (
          `CREATE DATABASE ${quoteIdent(r.name ?? target.name)}\n` +
          `  WITH OWNER = ${quoteIdent(r.owner ?? 'postgres')}\n` +
          `       ENCODING = ${quoteLiteral(r.encoding ?? 'UTF8')}\n` +
          `       LC_COLLATE = ${quoteLiteral(r.collate ?? 'C')}\n` +
          `       LC_CTYPE = ${quoteLiteral(r.ctype ?? 'C')};`
        );
      }
      default:
        throw new DbError(`Unsupported DDL target`);
    }
  }

  async planTableDdl(current: TableModel | null, desired: TableModel): Promise<string[]> {
    return planPostgresTableDdl(current, desired);
  }

  // -------------------------------------------------------------------------
  // Changesets
  // -------------------------------------------------------------------------

  async previewChangeset(cs: Changeset): Promise<ChangePreview> {
    const { statements, warnings } = buildPgChangeStatements(cs);
    if (this.ctx.config.readOnly) {
      warnings.push('This connection is read-only; the apply will be rejected by the server.');
    }
    return {
      statements: statements.map((s) => s.display),
      expectedAffected: statements.map((s) => s.expected),
      warnings,
    };
  }

  async applyChangeset(cs: Changeset): Promise<ApplyResult> {
    if (this.ctx.config.readOnly) {
      throw new DbError('This connection is read-only (§8.5): edits are not allowed.');
    }
    const { statements } = buildPgChangeStatements(cs);
    if (statements.length === 0) return { applied: 0, statements: 0, durationMs: 0 };

    const started = Date.now();
    const lease = await this.acquire({});
    let applied = 0;
    try {
      await lease.client.query('BEGIN');
      for (const stmt of statements) {
        const res = await lease.client.query({ text: stmt.text, values: stmt.params, rowMode: 'array' });
        const affected = res.rowCount ?? 0;
        // A WHERE clause that matched more (or fewer) rows than the grid
        // expected means the row moved under us — abort the whole batch (§6).
        if (affected !== stmt.expected) {
          throw new DbError(
            `Expected ${stmt.expected} row(s) but ${affected} matched — rolled back.\n${stmt.display}`,
          );
        }
        applied += affected;
      }
      await lease.client.query('COMMIT');
      return { applied, statements: statements.length, durationMs: Date.now() - started };
    } catch (err) {
      await lease.client.query('ROLLBACK').catch(() => undefined);
      throw toDbError(err);
    } finally {
      if (!lease.pinned) lease.release();
    }
  }

  // -------------------------------------------------------------------------
  // EXPLAIN
  // -------------------------------------------------------------------------

  async explain(sql: string, analyze: boolean): Promise<ExplainPlan> {
    const lease = await this.acquire({});
    // BUFFERS is only accepted alongside ANALYZE before PG 16.
    const options = analyze
      ? '(FORMAT JSON, ANALYZE, BUFFERS, VERBOSE)'
      : '(FORMAT JSON, VERBOSE)';
    const body = sql.trim().replace(/;\s*$/, '');
    try {
      let raw: string;
      if (analyze) {
        // ANALYZE really executes the statement; a transaction that always
        // rolls back keeps `EXPLAIN ANALYZE DELETE …` from destroying data.
        await lease.client.query('BEGIN');
        try {
          const res = await lease.client.query<Record<string, string>>(`EXPLAIN ${options} ${body}`);
          raw = firstExplainValue(res.rows);
        } finally {
          await lease.client.query('ROLLBACK').catch(() => undefined);
        }
      } else {
        const res = await lease.client.query<Record<string, string>>(`EXPLAIN ${options} ${body}`);
        raw = firstExplainValue(res.rows);
      }
      return buildExplainPlan(raw, analyze);
    } catch (err) {
      throw toDbError(err);
    } finally {
      if (!lease.pinned) lease.release();
    }
  }

  // -------------------------------------------------------------------------
  // Sessions (pinned connections for transaction mode, §6)
  // -------------------------------------------------------------------------

  async openSession(): Promise<SessionInfo> {
    const db = await this.db();
    const client = await db.pool.connect();
    const id = randomUUID();
    let released = false;
    const lease: Lease = {
      client,
      db,
      pinned: true,
      release: () => {
        if (released) return;
        released = true;
        client.release();
      },
    };
    const info: SessionInfo = {
      id,
      connectionId: this.ctx.config.id,
      inTransaction: false,
      autoCommit: true,
      backendId: String(backendPid(client) ?? ''),
      createdAt: Date.now(),
    };
    const entry: SessionEntry = {
      info,
      lease,
      timer: setTimeout(() => void this.closeSession(id), SESSION_IDLE_MS),
    };
    entry.timer.unref?.();
    this.sessions.set(id, entry);
    return info;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.timer);
    if (session.info.inTransaction) {
      await session.lease.client.query('ROLLBACK').catch(() => undefined);
    }
    session.lease.release();
  }

  async sessionCommand(sessionId: string, cmd: 'begin' | 'commit' | 'rollback'): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new DbError(`Session ${sessionId} is no longer open`);
    this.touchSession(session);
    try {
      await session.lease.client.query(cmd.toUpperCase());
    } catch (err) {
      throw toDbError(err);
    }
    session.info.inTransaction = cmd === 'begin';
    session.info.autoCommit = cmd !== 'begin';
  }

  private touchSession(session: SessionEntry): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => void this.closeSession(session.info.id), SESSION_IDLE_MS);
    session.timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Process monitor (§6 power tools)
  // -------------------------------------------------------------------------

  async listProcesses(): Promise<ProcessInfo[]> {
    const db = await this.db();
    const res = await db.pool.query<PgRow>(SQL_PROCESSES);
    return res.rows.map((r) => {
      const blocking = parseNameArray(r.blocking);
      return {
        id: r.pid ?? '',
        user: r.usename ?? undefined,
        client: r.client ?? undefined,
        database: r.datname ?? undefined,
        state: r.state ?? undefined,
        command: r.backend_type ?? undefined,
        durationMs: r.duration_ms ? Number(r.duration_ms) : undefined,
        query: r.query ?? undefined,
        waitEvent: r.wait_event ?? undefined,
        blockedBy: blocking.length > 0 ? blocking.join(', ') : undefined,
      };
    });
  }

  async killProcess(id: string): Promise<void> {
    const pid = Number(id);
    if (!Number.isInteger(pid)) throw new DbError(`Not a backend pid: ${id}`);
    const db = await this.db();
    await db.pool.query('SELECT pg_terminate_backend($1::int)', [pid]);
  }

  // -------------------------------------------------------------------------
  // Lazy tree (one query per expanded level, §4)
  // -------------------------------------------------------------------------

  async listNodes(path: TreePath): Promise<TreeNode[]> {
    const segments = path.segments ?? [];
    const at = (i: number) => parseSegment(segments[i]);
    const id = (...extra: string[]) => [...segments, ...extra].join('/');

    if (segments.length === 0) {
      const db = await this.db();
      const res = await db.pool.query<PgRow>(`
        SELECT d.datname AS name,
               pg_get_userbyid(d.datdba) AS owner,
               CASE WHEN has_database_privilege(d.datname, 'CONNECT')
                    THEN pg_size_pretty(pg_database_size(d.datname)) END AS size
          FROM pg_database d
         WHERE d.datallowconn AND NOT d.datistemplate
         ORDER BY d.datname`);
      return res.rows.map((r) => ({
        id: `db:${r.name}`,
        kind: 'database' as const,
        label: r.name ?? '',
        detail: r.size ?? undefined,
        hasChildren: true,
        meta: { database: r.name, owner: r.owner },
      }));
    }

    const database = at(0)?.name;
    const db = await this.db(database);

    if (segments.length === 1) {
      const res = await db.pool.query<PgRow>(`
        SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner
          FROM pg_namespace n
         WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
         ORDER BY n.nspname`);
      return res.rows.map((r) => ({
        id: id(`schema:${r.name}`),
        kind: 'schema' as const,
        label: r.name ?? '',
        detail: r.owner ?? undefined,
        hasChildren: true,
        meta: { database, schema: r.name },
      }));
    }

    const schema = at(1)?.name ?? 'public';

    if (segments.length === 2) {
      const folders: TreeNode[] = [
        { id: id('table-folder:tables'), kind: 'table-folder', label: 'Tables', hasChildren: true },
        { id: id('view-folder:views'), kind: 'view-folder', label: 'Views', hasChildren: true },
        { id: id('routine-folder:routines'), kind: 'routine-folder', label: 'Routines', hasChildren: true },
        { id: id('sequence-folder:sequences'), kind: 'sequence-folder', label: 'Sequences', hasChildren: true },
        { id: id('trigger-folder:triggers'), kind: 'trigger-folder', label: 'Triggers', hasChildren: true },
      ];
      const enums = await db.pool.query<PgRow>(
        `SELECT t.typname AS name, count(e.enumlabel)::text AS n
           FROM pg_type t
           JOIN pg_namespace ns ON ns.oid = t.typnamespace
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE ns.nspname = $1
          GROUP BY t.typname ORDER BY t.typname`,
        [schema],
      );
      for (const r of enums.rows) {
        folders.push({
          id: id(`enum:${r.name}`),
          kind: 'enum',
          label: r.name ?? '',
          detail: `${r.n} values`,
          hasChildren: false,
          meta: { database, schema, name: r.name },
        });
      }
      return folders;
    }

    const third = at(2);

    if (segments.length === 3 && third) {
      switch (third.kind) {
        case 'table-folder':
        case 'view-folder': {
          const kinds = third.kind === 'table-folder' ? ['r', 'p', 'f'] : ['v', 'm'];
          const res = await db.pool.query<PgRow>(
            `SELECT c.relname AS name, c.relkind::text AS kind,
                    CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint::text END AS rows
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relkind = ANY($2::"char"[])
              ORDER BY c.relname`,
            [schema, kinds],
          );
          return res.rows.map((r) => ({
            id: id(`table:${r.name}`),
            kind:
              r.kind === 'v' ? ('view' as const)
              : r.kind === 'm' ? ('materialized-view' as const)
              : ('table' as const),
            label: r.name ?? '',
            detail: r.rows ? `~${r.rows} rows` : undefined,
            hasChildren: true,
            meta: { database, schema, table: r.name, relkind: r.kind },
          }));
        }
        case 'routine-folder': {
          const res = await db.pool.query<PgRow>(
            `SELECT p.proname AS name, pg_get_function_arguments(p.oid) AS args
               FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = $1
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
              ORDER BY p.proname`,
            [schema],
          );
          return res.rows.map((r) => ({
            id: id(`routine:${r.name}`),
            kind: 'routine' as const,
            label: r.name ?? '',
            detail: r.args ?? undefined,
            hasChildren: false,
            meta: { database, schema, name: r.name },
          }));
        }
        case 'sequence-folder': {
          const res = await db.pool.query<PgRow>(
            `SELECT c.relname AS name FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relkind = 'S' ORDER BY c.relname`,
            [schema],
          );
          return res.rows.map((r) => ({
            id: id(`sequence:${r.name}`),
            kind: 'sequence' as const,
            label: r.name ?? '',
            hasChildren: false,
            meta: { database, schema, name: r.name },
          }));
        }
        case 'trigger-folder': {
          const res = await db.pool.query<PgRow>(
            `SELECT t.tgname AS name, c.relname AS table_name
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND NOT t.tgisinternal
              ORDER BY c.relname, t.tgname`,
            [schema],
          );
          return res.rows.map((r) => ({
            id: id(`trigger:${r.name}`),
            kind: 'trigger' as const,
            label: r.name ?? '',
            detail: r.table_name ?? undefined,
            hasChildren: false,
            meta: { database, schema, name: r.name, table: r.table_name },
          }));
        }
        default:
          return [];
      }
    }

    // …/table:NAME
    if (segments.length === 4 && third && at(3)?.kind === 'table') {
      const table = at(3)?.name ?? '';
      const fks = await db.pool.query<PgRow>(
        `SELECT c.conname AS name, pg_get_constraintdef(c.oid, true) AS def
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'f'
          ORDER BY c.conname`,
        [schema, table],
      );
      const nodes: TreeNode[] = [
        { id: id('column-folder:columns'), kind: 'column-folder', label: 'Columns', hasChildren: true },
        { id: id('index-folder:indexes'), kind: 'index-folder', label: 'Indexes', hasChildren: true },
      ];
      for (const r of fks.rows) {
        nodes.push({
          id: id(`foreign-key:${r.name}`),
          kind: 'foreign-key',
          label: r.name ?? '',
          detail: r.def ?? undefined,
          hasChildren: false,
          meta: { database, schema, table, name: r.name },
        });
      }
      return nodes;
    }

    // …/table:NAME/column-folder | index-folder
    if (segments.length === 5 && at(3)?.kind === 'table') {
      const table = at(3)?.name ?? '';
      const leaf = at(4);
      if (leaf?.kind === 'column-folder') {
        const res = await db.pool.query<PgRow>(
          `SELECT a.attname AS name,
                  format_type(a.atttypid, a.atttypmod) AS type,
                  a.attnotnull AS not_null
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum`,
          [schema, table],
        );
        return res.rows.map((r) => ({
          id: id(`column:${r.name}`),
          kind: 'column' as const,
          label: r.name ?? '',
          detail: `${r.type}${r.not_null === 't' ? ' NOT NULL' : ''}`,
          hasChildren: false,
          meta: { database, schema, table, column: r.name },
        }));
      }
      if (leaf?.kind === 'index-folder') {
        const res = await db.pool.query<PgRow>(
          `SELECT ic.relname AS name, i.indisunique AS is_unique, i.indisprimary AS is_primary,
                  pg_get_indexdef(i.indexrelid, 0, true) AS def
             FROM pg_index i
             JOIN pg_class ic ON ic.oid = i.indexrelid
             JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2
            ORDER BY ic.relname`,
          [schema, table],
        );
        return res.rows.map((r) => ({
          id: id(`index:${r.name}`),
          kind: 'index' as const,
          label: r.name ?? '',
          detail:
            r.is_primary === 't' ? 'PRIMARY KEY' : r.is_unique === 't' ? 'UNIQUE' : (r.def ?? undefined),
          hasChildren: false,
          meta: { database, schema, table, name: r.name, definition: r.def },
        }));
      }
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // Quoting (the bare calls below resolve to the module imports, not to these
  // methods — class members are not lexically scoped identifiers).
  // -------------------------------------------------------------------------

  quoteIdent(name: string): string {
    return quoteIdent(name);
  }

  quoteLiteral(value: string): string {
    return quoteLiteral(value);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `client.processID` is set from BackendKeyData but is absent from @types/pg. */
function backendPid(client: PoolClient | Client): number | null {
  return (client as unknown as { processID?: number | null }).processID ?? null;
}

function readPem(value: string): string {
  return value.trimStart().startsWith('-----BEGIN') ? value : readFileSync(value, 'utf8');
}

/**
 * Postgres wants the socket *directory*; users usually have either that or the
 * full `/var/run/postgresql/.s.PGSQL.5432` path in hand, so accept both (§8.2).
 */
function splitUnixSocket(socketPath: string): { directory: string; port: number } {
  const match = /^(.*)\/\.s\.PGSQL\.(\d+)$/.exec(socketPath);
  if (match) return { directory: match[1], port: Number(match[2]) };
  return { directory: socketPath.replace(/\/$/, ''), port: 5432 };
}

function withUriDatabase(uri: string, database: string): string {
  try {
    const url = new URL(uri);
    url.pathname = `/${encodeURIComponent(database)}`;
    return url.toString();
  } catch {
    return uri;
  }
}

function parseSegment(segment: string | undefined): { kind: string; name: string } | undefined {
  if (!segment) return undefined;
  const i = segment.indexOf(':');
  return i < 0 ? { kind: segment, name: '' } : { kind: segment.slice(0, i), name: segment.slice(i + 1) };
}

/** `{a,b}` from a `::text`-cast `text[]`. Names never need escape handling. */
function parseNameArray(value: string | null | undefined): string[] {
  if (!value) return [];
  const inner = value.replace(/^\{/, '').replace(/\}$/, '');
  if (inner === '') return [];
  return inner.split(',').map((s) => s.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
}

/**
 * Which statements produce a row set. The full lexer lives in the shared SQL
 * helpers; here we only need the leading keyword, since the caller has already
 * split the script into single statements (§6 "Statement splitting").
 */
function returnsRows(sql: string): boolean {
  let s = sql;
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      if (nl < 0) return false;
      s = s.slice(nl + 1);
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      if (end < 0) return false;
      s = s.slice(end + 2);
      continue;
    }
    break;
  }
  const keyword = /^[A-Za-z_]+/.exec(s)?.[0]?.toLowerCase() ?? '';
  if (['select', 'with', 'table', 'values', 'show', 'explain', 'fetch', 'call'].includes(keyword)) {
    return true;
  }
  if (['insert', 'update', 'delete', 'merge'].includes(keyword)) return /\breturning\b/i.test(sql);
  return false;
}

function firstExplainValue(rows: Record<string, string>[]): string {
  const row = rows[0];
  if (!row) return '[]';
  const value = row['QUERY PLAN'] ?? Object.values(row)[0];
  return typeof value === 'string' ? value : JSON.stringify(value);
}

interface PgPlanNode {
  [key: string]: unknown;
  Plans?: PgPlanNode[];
}

const PLAN_DETAIL_KEYS = [
  'Index Cond',
  'Recheck Cond',
  'Filter',
  'Join Filter',
  'Hash Cond',
  'Merge Cond',
  'Sort Key',
  'Group Key',
  'One-Time Filter',
  'TID Cond',
];

const PLAN_EXTRA_KEYS = [
  'Rows Removed by Filter',
  'Rows Removed by Index Recheck',
  'Rows Removed by Join Filter',
  'Sort Method',
  'Sort Space Used',
  'Heap Fetches',
  'Workers Planned',
  'Workers Launched',
  'Shared Hit Blocks',
  'Shared Read Blocks',
  'Shared Dirtied Blocks',
  'Shared Written Blocks',
  'Temp Read Blocks',
  'Temp Written Blocks',
  'Output',
];

/**
 * `EXPLAIN (FORMAT JSON)` → the `ExplainPlan` tree, with each node's *exclusive*
 * share of total runtime so the UI can draw a flame bar (§6 power tools).
 */
export function buildExplainPlan(raw: string, analyzed: boolean): ExplainPlan {
  let doc: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    doc = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
  } catch {
    return {
      engine: 'postgres',
      analyzed,
      root: { label: 'Plan', detail: raw, children: [] },
      raw,
    };
  }

  const rootRaw = (doc.Plan ?? {}) as PgPlanNode;
  const executionTime = numberOf(doc['Execution Time']);
  const planningTime = numberOf(doc['Planning Time']);

  // A node's total time is per-loop; multiply by loops for the real cost.
  const totalOf = (n: PgPlanNode): number => {
    const t = numberOf(n['Actual Total Time']);
    if (t === undefined) return 0;
    return t * (numberOf(n['Actual Loops']) ?? 1);
  };
  const denominator = executionTime ?? totalOf(rootRaw);

  const build = (n: PgPlanNode): { node: ExplainNode; total: number } => {
    const children = (n.Plans ?? []).map(build);
    const total = totalOf(n);
    const childTotal = children.reduce((sum, c) => sum + c.total, 0);
    const exclusive = Math.max(0, total - childTotal);

    const detail = PLAN_DETAIL_KEYS.filter((k) => n[k] !== undefined)
      .map((k) => `${k}: ${formatPlanValue(n[k])}`)
      .join('\n');
    const extra: Record<string, unknown> = {};
    for (const k of PLAN_EXTRA_KEYS) if (n[k] !== undefined) extra[k] = n[k];

    const node: ExplainNode = {
      label: planLabel(n),
      detail: detail || undefined,
      estimatedCost: numberOf(n['Total Cost']),
      estimatedRows: numberOf(n['Plan Rows']),
      actualRows: numberOf(n['Actual Rows']),
      actualTimeMs: total || undefined,
      loops: numberOf(n['Actual Loops']),
      share: denominator > 0 && total > 0 ? Math.min(1, exclusive / denominator) : undefined,
      children: children.map((c) => c.node),
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
    return { node, total };
  };

  return {
    engine: 'postgres',
    analyzed,
    root: build(rootRaw).node,
    totalTimeMs: executionTime,
    planningTimeMs: planningTime,
    raw,
  };
}

function planLabel(n: PgPlanNode): string {
  let label = String(n['Node Type'] ?? 'Node');
  if (n['Parallel Aware'] === true) label = `Parallel ${label}`;
  const strategy = n['Strategy'];
  if (typeof strategy === 'string' && strategy !== 'Plain') label += ` (${strategy})`;
  const join = n['Join Type'];
  if (typeof join === 'string' && join !== 'Inner') label += ` ${join}`;
  if (typeof n['Index Name'] === 'string') label += ` using ${n['Index Name']}`;
  const relation = n['Relation Name'];
  if (typeof relation === 'string') {
    const schema = typeof n['Schema'] === 'string' ? `${n['Schema']}.` : '';
    label += ` on ${schema}${relation}`;
    const alias = n['Alias'];
    if (typeof alias === 'string' && alias !== relation) label += ` ${alias}`;
  }
  return label;
}

function formatPlanValue(v: unknown): string {
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function numberOf(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
