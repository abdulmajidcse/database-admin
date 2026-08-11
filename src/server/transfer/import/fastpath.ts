/**
 * Import fast paths (PLAN §7.4: "naive row-by-row INSERT is 50–100× slower").
 *
 * | Engine    | Fast path                                                      |
 * | --------- | -------------------------------------------------------------- |
 * | Postgres  | `COPY … FROM STDIN` via `pg-copy-streams`                       |
 * | MySQL     | `LOAD DATA LOCAL INFILE` when enabled *both* sides, else batched|
 * |           | multi-row `INSERT` sized against `max_allowed_packet`           |
 * | SQLite    | one transaction around a prepared-statement loop                |
 * | MongoDB   | unordered `bulkWrite` in batches                                |
 *
 * Every loader takes the same `AsyncIterable<Row[]>` the readers produce, so
 * the source (CSV, NDJSON, another connection) is irrelevant here — and reports
 * the same progress shape, so the jobs drawer does not care which path ran.
 *
 * The conflict strategies are where the fast paths get interesting: `COPY` and
 * `LOAD DATA` cannot express `ON CONFLICT DO UPDATE`, so an upsert stages into
 * a temp table and merges (still one bulk write per chunk), rather than
 * quietly degrading to row-at-a-time.
 *
 * Server-side only: no React, no Next (PLAN §11).
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Client as PgClient } from 'pg';
import type {
  Connection as MysqlConnection,
  QueryValues,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import type Database from 'better-sqlite3';
import { Binary, Decimal128, ObjectId } from 'mongodb';
import type { AnyBulkWriteOperation, Collection, Document } from 'mongodb';

import type { Cell, Row } from '../../../lib/wire';
import { base64ToBytes, isTagged } from '../../../lib/wire';
import { quoteIdent, quoteQualified } from '../../db/sql/quote';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export type OnConflict = 'insert' | 'upsert' | 'replace' | 'ignore';

export interface LoadTable {
  schema?: string;
  table: string;
  /** Target column names, in the order values appear in each row. */
  columns: string[];
  /** Unique key, required by `upsert` and `replace`. */
  keyColumns?: string[];
  /** Columns holding binary data — MySQL's text protocol needs `UNHEX()` (PLAN §7.4). */
  binaryColumns?: string[];
}

export interface LoadOptions {
  onConflict: OnConflict;
  /** Rows per bulk write. Writers may lower it to respect a protocol limit. */
  batchSize: number;
  /** Validate and count without writing anything (PLAN §7.4 "dry run"). */
  dryRun: boolean;
  /** Collect per-row failures instead of aborting (PLAN §7.4). */
  continueOnError: boolean;
  /** Stop collecting (not counting) errors past this many. */
  maxErrors?: number;
  /** Postgres only: savepoints are legal only inside a transaction block. */
  inTransaction?: boolean;
  /**
   * Off sends plain batched INSERTs everywhere. The wizard exposes it because a
   * bulk path can hit server policy (`local_infile`, COPY permissions) that the
   * probes cannot see (PLAN §7.4 knobs).
   */
  useFastPath?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: LoadProgress) => void;
  log?: (line: string) => void;
}

export interface LoadProgress {
  rows: number;
  /** Bytes handed to the driver — what the jobs drawer shows as throughput. */
  bytes: number;
  batches: number;
}

export interface LoadError {
  /** 1-based index of the row within the import. */
  row: number;
  message: string;
  code?: string;
  /** The offending row, truncated, so the report is actionable. */
  sample?: string;
}

export interface LoadResult extends LoadProgress {
  /** Which path actually ran — surfaced in the job log, and asserted by tests. */
  fastPath: string;
  /** Rows rejected under continue-on-error. */
  skipped: number;
  errors: LoadError[];
}

/** Thrown when `signal` aborts; the job manager maps it to status `cancelled`. */
export class ImportCancelled extends Error {
  constructor() {
    super('Import cancelled');
    this.name = 'ImportCancelled';
  }
}

export type LoadHandle =
  | { engine: 'postgres'; client: PgClient }
  | { engine: 'mysql' | 'mariadb'; conn: MysqlConnection }
  | { engine: 'sqlite'; db: Database.Database }
  | { engine: 'mongodb'; collection: Collection<Document> };

/** Dispatch to the right fast path. */
export function loadRows(
  handle: LoadHandle,
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
): Promise<LoadResult> {
  switch (handle.engine) {
    case 'postgres':
      return loadPostgres(handle.client, batches, table, opts);
    case 'mysql':
    case 'mariadb':
      return loadMysql(handle.conn, batches, table, opts);
    case 'sqlite':
      return loadSqlite(handle.db, batches, table, opts);
    case 'mongodb':
      return loadMongo(handle.collection, batches, table, opts);
  }
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ImportCancelled();
}

function newTracker(opts: LoadOptions, fastPath: string): Tracker {
  return new Tracker(opts, fastPath);
}

/** Counters + throttled progress, shared by every loader. */
class Tracker {
  rows = 0;
  bytes = 0;
  batches = 0;
  skipped = 0;
  readonly errors: LoadError[] = [];
  private errorCount = 0;
  private lastEmit = 0;

  constructor(private readonly opts: LoadOptions, readonly fastPath: string) {}

  advance(rows: number, bytes: number): void {
    this.rows += rows;
    this.bytes += bytes;
    this.batches++;
    this.emit(false);
  }

  /** Progress at most 5×/s: a 10 M-row import must not spam the WebSocket (§7.3). */
  emit(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 200) return;
    this.lastEmit = now;
    this.opts.onProgress?.({ rows: this.rows, bytes: this.bytes, batches: this.batches });
  }

  fail(row: number, err: unknown, sample?: Row): void {
    this.skipped++;
    this.errorCount++;
    const max = this.opts.maxErrors ?? 1000;
    if (this.errors.length >= max) return;
    this.errors.push({
      row,
      message: errorMessage(err),
      code: errorCode(err),
      sample: sample ? truncate(sample.map((c) => cellToText(c)).join(' | '), 240) : undefined,
    });
  }

  get collectedErrors(): number {
    return this.errorCount;
  }

  result(): LoadResult {
    this.emit(true);
    return {
      rows: this.rows,
      bytes: this.bytes,
      batches: this.batches,
      skipped: this.skipped,
      fastPath: this.fastPath,
      errors: this.errors,
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function cellToText(c: Cell): string {
  if (c === null) return 'NULL';
  if (isTagged(c)) return c.$t === 'bytes' ? `<${c.v.length} b64>` : c.v;
  return String(c);
}

/** Re-cut incoming batches to exactly `n` rows, so protocol limits are respected. */
async function* rechunk(
  batches: AsyncIterable<Row[]>,
  n: number,
  signal?: AbortSignal,
): AsyncIterable<Row[]> {
  let buf: Row[] = [];
  for await (const batch of batches) {
    checkAbort(signal);
    for (const row of batch) {
      buf.push(row);
      if (buf.length >= n) {
        yield buf;
        buf = [];
      }
    }
  }
  if (buf.length > 0) yield buf;
}

/**
 * A row whose width does not match the target column list is a mapping bug, not
 * a value problem — it would silently shift every column, so it never loads.
 */
function checkWidth(row: Row, width: number): void {
  if (row.length !== width) {
    throw new Error(`Row has ${row.length} values but ${width} target columns are mapped`);
  }
}

/**
 * PLAN §7.4 "a DRY RUN that validates without writing": everything the real
 * path would do to each value happens here (width check, encoding, coercion
 * failures), and nothing is sent.
 */
async function dryRun(
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
  encode: (c: Cell) => unknown,
): Promise<LoadResult> {
  const t = newTracker(opts, 'dry-run');
  let index = 0;
  for await (const batch of rechunk(batches, Math.max(1, opts.batchSize), opts.signal)) {
    let bytes = 0;
    for (const row of batch) {
      index++;
      try {
        checkWidth(row, table.columns.length);
        for (const cell of row) {
          const v = encode(cell);
          bytes += typeof v === 'string' ? Buffer.byteLength(v) : 8;
        }
      } catch (err) {
        if (!opts.continueOnError) throw err;
        t.fail(index, err, row);
      }
    }
    t.advance(batch.length, bytes);
  }
  return t.result();
}

// ---------------------------------------------------------------------------
// Postgres — COPY FROM STDIN (PLAN §7.4)
// ---------------------------------------------------------------------------

/**
 * pg-copy-streams ships no type definitions; this is its whole surface for us.
 *
 * A STATIC import matters: a createRequire()/require() pair is opaque to
 * Turbopack, which then falls back to enumerating the project root and drags
 * PLAN.md, vitest.config.ts and Vite's native binaries into the route bundle.
 * The package is listed in next.config serverExternalPackages, so a static
 * import is still never bundled.
 */
import pgCopyStreams from 'pg-copy-streams';

function copyFromStream(sql: string): Writable {
  const mod = pgCopyStreams as unknown as { from(sql: string, options?: unknown): Writable };
  return mod.from(sql);
}

/**
 * Feed a `COPY … FROM stdin` block straight through, used by the dump runner
 * for plain-format `pg_dump` output (PLAN §7.5). The data is already in COPY
 * text form in the file, so it is passed through untouched.
 */
export async function pgCopyIn(
  client: PgClient,
  sql: string,
  data: AsyncIterable<string>,
): Promise<void> {
  const ingest = (client as unknown as { query(s: Writable): Writable }).query(copyFromStream(sql));
  await pipeline(Readable.from(data), ingest);
}

/** COPY text format: tab-separated, `\N` for NULL, backslash escapes (PLAN §7.4). */
function pgCopyField(cell: Cell): string {
  if (cell === null) return '\\N';
  if (typeof cell === 'boolean') return cell ? 't' : 'f';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : 'NaN';
  if (isTagged(cell)) {
    if (cell.$t === 'bytes') {
      // bytea in COPY text is `\x<hex>`; the backslash itself must be escaped.
      return `\\\\x${Buffer.from(base64ToBytes(cell.v)).toString('hex')}`;
    }
    return escapeCopyText(cell.v);
  }
  return escapeCopyText(cell);
}

function escapeCopyText(s: string): string {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\v':
        out += '\\v';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\b':
        out += '\\b';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function pgParam(cell: Cell): unknown {
  if (cell === null) return null;
  if (isTagged(cell)) {
    if (cell.$t === 'bytes') return Buffer.from(base64ToBytes(cell.v));
    // Everything else travels as text and is cast by the server, which is the
    // only way NUMERIC/BIGINT/timestamptz keep every digit (§6).
    return cell.v;
  }
  return cell;
}

function pgIdent(name: string): string {
  return quoteIdent(name, 'postgres');
}

function pgTableRef(table: LoadTable): string {
  return quoteQualified([table.schema, table.table], 'postgres');
}

export async function loadPostgres(
  client: PgClient,
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
): Promise<LoadResult> {
  if (opts.dryRun) return dryRun(batches, table, opts, pgParam);

  // COPY aborts the whole transaction on the first bad row, so continue-on-error
  // has to use statements it can isolate with savepoints (PLAN §7.4).
  if (opts.continueOnError || opts.useFastPath === false) {
    return pgInsertBatches(client, batches, table, opts);
  }
  if (opts.onConflict === 'insert') return pgCopy(client, batches, table, opts);
  return pgCopyStaged(client, batches, table, opts);
}

/** The straight fast path: one COPY for the whole file. */
async function pgCopy(
  client: PgClient,
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
  target = pgTableRef(table),
  tracker?: Tracker,
): Promise<LoadResult> {
  const t = tracker ?? newTracker(opts, 'postgres:copy');
  const cols = table.columns.map(pgIdent).join(', ');
  const sql = `COPY ${target} (${cols}) FROM STDIN WITH (FORMAT text)`;
  opts.log?.(`Postgres fast path: ${sql}`);

  const width = table.columns.length;
  const source = Readable.from(
    (async function* () {
      for await (const batch of batches) {
        checkAbort(opts.signal);
        let chunk = '';
        for (const row of batch) {
          checkWidth(row, width);
          chunk += `${row.map(pgCopyField).join('\t')}\n`;
        }
        t.advance(batch.length, Buffer.byteLength(chunk));
        yield chunk;
      }
    })(),
  );

  // pg's Submittable overload is the documented way to run a COPY stream; the
  // cast is only because pg-copy-streams is untyped.
  const ingest = (client as unknown as { query(s: Writable): Writable }).query(copyFromStream(sql));
  await pipeline(source, ingest);
  return t.result();
}

/**
 * Upsert / replace / ignore: COPY a chunk into a temp table shaped exactly like
 * the target's mapped columns, then merge with one statement. Still a bulk
 * write per chunk, and the temp table never grows past one chunk.
 */
async function pgCopyStaged(
  client: PgClient,
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
): Promise<LoadResult> {
  const t = newTracker(opts, `postgres:copy+merge(${opts.onConflict})`);
  const tmp = pgIdent(`dbadmin_import_${randomUUID().replace(/-/g, '').slice(0, 12)}`);
  const cols = table.columns.map(pgIdent).join(', ');
  const merge = pgMergeStatements(table, tmp, opts.onConflict);

  await client.query(
    `CREATE TEMP TABLE ${tmp} AS SELECT ${cols} FROM ${pgTableRef(table)} WITH NO DATA`,
  );
  opts.log?.(`Staging through ${tmp} for on-conflict "${opts.onConflict}"`);
  try {
    // 10k rows keeps the staging table small while amortizing the merge cost.
    const chunkRows = Math.max(opts.batchSize, 10_000);
    for await (const chunk of rechunk(batches, chunkRows, opts.signal)) {
      await pgCopy(client, oneBatch(chunk), table, opts, tmp, t);
      for (const sql of merge) await client.query(sql);
      await client.query(`TRUNCATE ${tmp}`);
    }
  } finally {
    await client.query(`DROP TABLE IF EXISTS ${tmp}`).catch(() => undefined);
  }
  return t.result();
}

async function* oneBatch(rows: Row[]): AsyncIterable<Row[]> {
  yield rows;
}

function pgMergeStatements(table: LoadTable, tmp: string, mode: OnConflict): string[] {
  const target = pgTableRef(table);
  const cols = table.columns.map(pgIdent).join(', ');
  const keys = table.keyColumns ?? [];
  const insert = `INSERT INTO ${target} (${cols}) SELECT ${cols} FROM ${tmp}`;

  switch (mode) {
    case 'ignore':
      // No key list: any unique violation is ignored, which is what "ignore" means.
      return [`${insert} ON CONFLICT DO NOTHING`];
    case 'upsert': {
      requireKeys(keys, 'upsert');
      const keySet = new Set(keys);
      const updatable = table.columns.filter((c) => !keySet.has(c));
      const conflict = keys.map(pgIdent).join(', ');
      if (updatable.length === 0) return [`${insert} ON CONFLICT (${conflict}) DO NOTHING`];
      const set = updatable.map((c) => `${pgIdent(c)} = EXCLUDED.${pgIdent(c)}`).join(', ');
      return [`${insert} ON CONFLICT (${conflict}) DO UPDATE SET ${set}`];
    }
    case 'replace': {
      // MySQL's REPLACE semantics: the old row goes away entirely, so columns
      // outside the mapping are reset to their defaults rather than preserved.
      requireKeys(keys, 'replace');
      const on = keys.map((k) => `t.${pgIdent(k)} = s.${pgIdent(k)}`).join(' AND ');
      return [`DELETE FROM ${target} t USING ${tmp} s WHERE ${on}`, insert];
    }
    case 'insert':
      return [insert];
  }
}

function requireKeys(keys: string[], mode: string): void {
  if (keys.length === 0) {
    throw new Error(
      `On-conflict "${mode}" needs a unique key: the target table has no primary key and none was chosen.`,
    );
  }
}

/** Batched INSERT with savepoint isolation — the continue-on-error path. */
async function pgInsertBatches(
  client: PgClient,
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
): Promise<LoadResult> {
  const t = newTracker(opts, 'postgres:insert-batched');
  const width = table.columns.length;
  // Postgres refuses more than 65535 bound parameters in one statement.
  const maxRows = Math.max(1, Math.min(opts.batchSize, Math.floor(65535 / Math.max(1, width))));
  const savepoints = opts.inTransaction === true;
  let index = 0;

  for await (const batch of rechunk(batches, maxRows, opts.signal)) {
    checkAbort(opts.signal);
    const start = index;
    index += batch.length;
    const { sql, params } = pgInsertSql(table, batch, opts.onConflict);
    try {
      if (savepoints) await client.query('SAVEPOINT dbadmin_import');
      await client.query(sql, params);
      if (savepoints) await client.query('RELEASE SAVEPOINT dbadmin_import');
      t.advance(batch.length, estimateBytes(params));
    } catch (err) {
      if (savepoints) await client.query('ROLLBACK TO SAVEPOINT dbadmin_import');
      // This path also serves `useFastPath: false`, where a failure is still fatal.
      if (!opts.continueOnError) throw err;
      // One bad row must not cost the other 999: retry the batch row by row so
      // the report names the offender (PLAN §7.4).
      let ok = 0;
      for (let i = 0; i < batch.length; i++) {
        const one = pgInsertSql(table, [batch[i]], opts.onConflict);
        try {
          if (savepoints) await client.query('SAVEPOINT dbadmin_import_row');
          await client.query(one.sql, one.params);
          if (savepoints) await client.query('RELEASE SAVEPOINT dbadmin_import_row');
          ok++;
        } catch (rowErr) {
          if (savepoints) await client.query('ROLLBACK TO SAVEPOINT dbadmin_import_row');
          t.fail(start + i + 1, rowErr, batch[i]);
        }
      }
      t.advance(ok, 0);
    }
  }
  return t.result();
}

function pgInsertSql(table: LoadTable, rows: Row[], mode: OnConflict): { sql: string; params: unknown[] } {
  const cols = table.columns.map(pgIdent).join(', ');
  const params: unknown[] = [];
  const tuples: string[] = [];
  for (const row of rows) {
    checkWidth(row, table.columns.length);
    tuples.push(`(${row.map((cell) => `$${params.push(pgParam(cell))}`).join(', ')})`);
  }
  let tail = '';
  const keys = table.keyColumns ?? [];
  if (mode === 'ignore') tail = ' ON CONFLICT DO NOTHING';
  else if (mode === 'upsert' || mode === 'replace') {
    requireKeys(keys, mode);
    const keySet = new Set(keys);
    const updatable = table.columns.filter((c) => !keySet.has(c));
    const conflict = keys.map(pgIdent).join(', ');
    tail =
      updatable.length === 0
        ? ` ON CONFLICT (${conflict}) DO NOTHING`
        : ` ON CONFLICT (${conflict}) DO UPDATE SET ${updatable
            .map((c) => `${pgIdent(c)} = EXCLUDED.${pgIdent(c)}`)
            .join(', ')}`;
  }
  return {
    sql: `INSERT INTO ${pgTableRef(table)} (${cols}) VALUES ${tuples.join(', ')}${tail}`,
    params,
  };
}

function estimateBytes(params: unknown[]): number {
  let n = 0;
  for (const p of params) {
    if (typeof p === 'string') n += Buffer.byteLength(p);
    else if (Buffer.isBuffer(p)) n += p.length;
    else n += 8;
  }
  return n;
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB — LOAD DATA LOCAL INFILE, else batched INSERT (PLAN §7.4)
// ---------------------------------------------------------------------------

const MYSQL_ENGINE = 'mysql' as const;

function myIdent(name: string): string {
  return quoteIdent(name, MYSQL_ENGINE);
}

function myTableRef(table: LoadTable): string {
  return quoteQualified([table.schema, table.table], MYSQL_ENGINE);
}

function asValues(params: unknown[]): QueryValues {
  // mysql2's parameter type is deliberately narrow; ours are opaque wire cells.
  return params as unknown as QueryValues;
}

async function mysqlScalar(conn: MysqlConnection, sql: string): Promise<string | null> {
  const [rows] = await conn.query<RowDataPacket[]>(sql);
  const first = rows[0] as Record<string, unknown> | undefined;
  if (!first) return null;
  const value = Object.values(first)[0];
  return value === null || value === undefined ? null : String(value);
}

export interface LocalInfileProbe {
  /** `local_infile` on the server. */
  server: boolean;
  /** The client capability flag on this connection. */
  client: boolean;
  enabled: boolean;
  reason?: string;
}

/**
 * PLAN §7.4: `LOAD DATA LOCAL INFILE` only when it is enabled on BOTH sides.
 * The server refuses with ER_NOT_ALLOWED_COMMAND otherwise, and a client built
 * without CLIENT_LOCAL_FILES never even offers the file — so both are probed
 * before we commit to a path we cannot rewind.
 */
export async function probeLocalInfile(conn: MysqlConnection): Promise<LocalInfileProbe> {
  let server = false;
  try {
    const value = await mysqlScalar(conn, 'SELECT @@GLOBAL.local_infile');
    server = value === '1' || value?.toUpperCase() === 'ON';
  } catch {
    server = false;
  }
  // mysql2 sets LOCAL_FILES by default; a config that removes it spells it '-LOCAL_FILES'.
  const flags = (conn.config as { flags?: string | string[] } | undefined)?.flags;
  const list = Array.isArray(flags) ? flags : typeof flags === 'string' ? flags.split(',') : [];
  const client = !list.some((f) => f.trim().toUpperCase() === '-LOCAL_FILES');
  const enabled = server && client;
  return {
    server,
    client,
    enabled,
    reason: enabled
      ? undefined
      : !server
        ? 'the server has local_infile=OFF'
        : 'this connection disabled the LOCAL_FILES capability',
  };
}

/** Batch sizing input for the INSERT fallback (PLAN §7.4). */
export async function maxAllowedPacket(conn: MysqlConnection): Promise<number> {
  try {
    const value = await mysqlScalar(conn, 'SELECT @@max_allowed_packet');
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 4 * 1024 * 1024;
  } catch {
    return 4 * 1024 * 1024;
  }
}

/** LOAD DATA's default escaping: `\` plus tab/newline/carriage-return/NUL, `\N` for NULL. */
function myLoadField(cell: Cell, binary: boolean): string {
  if (cell === null) return '\\N';
  if (typeof cell === 'boolean') return cell ? '1' : '0';
  if (typeof cell === 'number') return String(cell);
  if (isTagged(cell)) {
    if (cell.$t === 'bytes') return Buffer.from(base64ToBytes(cell.v)).toString('hex');
    return binary ? Buffer.from(cell.v, 'utf8').toString('hex') : escapeLoadText(cell.v);
  }
  return binary ? Buffer.from(cell, 'utf8').toString('hex') : escapeLoadText(cell);
}

function escapeLoadText(s: string): string {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\0':
        out += '\\0';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function myParam(cell: Cell): unknown {
  if (cell === null) return null;
  if (isTagged(cell)) {
    if (cell.$t === 'bytes') return Buffer.from(base64ToBytes(cell.v));
    return cell.v;
  }
  return cell;
}

export async function loadMysql(
  conn: MysqlConnection,
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
): Promise<LoadResult> {
  if (opts.dryRun) return dryRun(batches, table, opts, myParam);

  const probe = opts.useFastPath === false
    ? { server: false, client: false, enabled: false, reason: 'the fast path was turned off' }
    : await probeLocalInfile(conn);
  // LOAD DATA has REPLACE and IGNORE but no ON DUPLICATE KEY UPDATE, and it
  // cannot report which row failed — so upsert and continue-on-error take the
  // batched-INSERT path instead (PLAN §7.4).
  const canLoad = probe.enabled && opts.onConflict !== 'upsert' && !opts.continueOnError;
  if (!canLoad) {
    const why = probe.enabled
      ? opts.continueOnError
        ? 'continue-on-error needs per-row failures'
        : 'on-conflict "upsert" needs ON DUPLICATE KEY UPDATE'
      : probe.reason;
    opts.log?.(`MySQL fast path: batched INSERT (LOAD DATA unavailable — ${why}).`);
    return mysqlInsertBatches(conn, batches, table, opts);
  }
  return mysqlLoadData(conn, batches, table, opts);
}

async function mysqlLoadData(
  conn: MysqlConnection,
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
): Promise<LoadResult> {
  const t = newTracker(opts, 'mysql:load-data-local-infile');
  const binary = new Set(table.binaryColumns ?? []);
  // Binary columns arrive as hex in a user variable and are UNHEXed on the
  // server: raw bytes cannot survive the escaped text protocol (PLAN §7.4).
  const columnList = table.columns.map((c) => (binary.has(c) ? `@${varName(c)}` : myIdent(c))).join(', ');
  const setList = table.columns
    .filter((c) => binary.has(c))
    .map((c) => `${myIdent(c)} = UNHEX(@${varName(c)})`)
    .join(', ');
  const conflict = opts.onConflict === 'replace' ? 'REPLACE ' : opts.onConflict === 'ignore' ? 'IGNORE ' : '';

  const sql =
    `LOAD DATA LOCAL INFILE 'dbadmin-import.tsv' ${conflict}INTO TABLE ${myTableRef(table)} ` +
    `CHARACTER SET utf8mb4 ` +
    `FIELDS TERMINATED BY '\\t' ESCAPED BY '\\\\' ` +
    `LINES TERMINATED BY '\\n' ` +
    `(${columnList})` +
    (setList ? ` SET ${setList}` : '');
  opts.log?.(`MySQL fast path: ${sql}`);

  const width = table.columns.length;
  const binaryFlags = table.columns.map((c) => binary.has(c));
  const source = Readable.from(
    (async function* () {
      for await (const batch of batches) {
        checkAbort(opts.signal);
        let chunk = '';
        for (const row of batch) {
          checkWidth(row, width);
          chunk += `${row.map((cell, i) => myLoadField(cell, binaryFlags[i])).join('\t')}\n`;
        }
        t.advance(batch.length, Buffer.byteLength(chunk));
        yield chunk;
      }
    })(),
  );

  const [header] = await conn.query<ResultSetHeader>({ sql, infileStreamFactory: () => source });
  const warnings = (header as unknown as { warningStatus?: number }).warningStatus ?? 0;
  if (warnings > 0) {
    // Truncated values and bad dates are warnings here, not errors — saying so
    // is the difference between a clean import and a silently mangled table.
    opts.log?.(`LOAD DATA finished with ${warnings} warning(s); run SHOW WARNINGS to inspect.`);
  }
  return t.result();
}

function varName(column: string): string {
  // User variables have no quoting form, so anything exotic becomes positional.
  return column.replace(/[^A-Za-z0-9_]/g, '_');
}

async function mysqlInsertBatches(
  conn: MysqlConnection,
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
): Promise<LoadResult> {
  const t = newTracker(opts, 'mysql:insert-batched');
  const packet = await maxAllowedPacket(conn);
  // 70% of max_allowed_packet: the escaped literal is longer than our estimate
  // and the packet also carries the statement text (PLAN §7.4).
  const budget = Math.floor(packet * 0.7);
  const width = table.columns.length;
  let index = 0;

  let pending: Row[] = [];
  let pendingBytes = 0;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const rows = pending;
    const start = index;
    index += rows.length;
    pending = [];
    pendingBytes = 0;
    const { sql, params } = mysqlInsertSql(table, rows, opts.onConflict);
    try {
      await conn.query<ResultSetHeader>(sql, asValues(params));
      t.advance(rows.length, estimateBytes(params));
    } catch (err) {
      if (!opts.continueOnError) throw err;
      let ok = 0;
      for (let i = 0; i < rows.length; i++) {
        const one = mysqlInsertSql(table, [rows[i]], opts.onConflict);
        try {
          await conn.query<ResultSetHeader>(one.sql, asValues(one.params));
          ok++;
        } catch (rowErr) {
          t.fail(start + i + 1, rowErr, rows[i]);
        }
      }
      t.advance(ok, 0);
    }
  };

  for await (const batch of batches) {
    checkAbort(opts.signal);
    for (const row of batch) {
      checkWidth(row, width);
      pending.push(row);
      pendingBytes += rowBytes(row);
      if (pending.length >= opts.batchSize || pendingBytes >= budget) await flush();
    }
  }
  await flush();
  return t.result();
}

function rowBytes(row: Row): number {
  let n = row.length * 3; // separators and quotes
  for (const cell of row) {
    if (cell === null) n += 4;
    else if (typeof cell === 'string') n += Buffer.byteLength(cell);
    else if (isTagged(cell)) n += cell.v.length;
    else n += 8;
  }
  return n;
}

function mysqlInsertSql(
  table: LoadTable,
  rows: Row[],
  mode: OnConflict,
): { sql: string; params: unknown[] } {
  const cols = table.columns.map(myIdent).join(', ');
  const placeholders = `(${table.columns.map(() => '?').join(', ')})`;
  const params: unknown[] = [];
  for (const row of rows) {
    checkWidth(row, table.columns.length);
    for (const cell of row) params.push(myParam(cell));
  }
  const verb = mode === 'replace' ? 'REPLACE' : mode === 'ignore' ? 'INSERT IGNORE' : 'INSERT';

  let tail = '';
  if (mode === 'upsert') {
    const keys = table.keyColumns ?? [];
    const updatable = table.columns.filter((c) => !keys.includes(c));
    // `VALUES(col)` rather than the 8.0.20 row alias: MariaDB and MySQL < 8.0.19
    // reject the alias form, and this spelling is deprecated but universal.
    const assignments =
      updatable.length > 0
        ? updatable.map((c) => `${myIdent(c)} = VALUES(${myIdent(c)})`)
        : // Every mapped column is part of the key, so there is nothing to
          // update: a self-assignment keeps the statement legal and turns the
          // conflict into a no-op, matching Postgres' DO NOTHING.
          [`${myIdent(table.columns[0])} = ${myIdent(table.columns[0])}`];
    tail = ` ON DUPLICATE KEY UPDATE ${assignments.join(', ')}`;
  }

  const sql = `${verb} INTO ${myTableRef(table)} (${cols}) VALUES ${rows
    .map(() => placeholders)
    .join(', ')}${tail}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// SQLite — one transaction around a prepared statement (PLAN §7.4)
// ---------------------------------------------------------------------------

function liteIdent(name: string): string {
  return quoteIdent(name, 'sqlite');
}

function liteParam(cell: Cell): unknown {
  if (cell === null) return null;
  if (typeof cell === 'boolean') return cell ? 1 : 0;
  if (isTagged(cell)) {
    if (cell.$t === 'bytes') return Buffer.from(base64ToBytes(cell.v));
    if (cell.$t === 'bigint') {
      try {
        return BigInt(cell.v);
      } catch {
        return cell.v;
      }
    }
    // decimal/timestamp/json/uuid stay text: SQLite is dynamically typed and
    // text is the only lossless carrier for them (§6).
    return cell.v;
  }
  return cell;
}

export async function loadSqlite(
  db: Database.Database,
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
): Promise<LoadResult> {
  if (opts.dryRun) return dryRun(batches, table, opts, liteParam);

  const t = newTracker(opts, 'sqlite:prepared-loop');
  const cols = table.columns.map(liteIdent).join(', ');
  const holes = table.columns.map(() => '?').join(', ');
  const target = quoteQualified([table.schema, table.table], 'sqlite');

  let sql: string;
  switch (opts.onConflict) {
    case 'ignore':
      sql = `INSERT OR IGNORE INTO ${target} (${cols}) VALUES (${holes})`;
      break;
    case 'replace':
      sql = `INSERT OR REPLACE INTO ${target} (${cols}) VALUES (${holes})`;
      break;
    case 'upsert': {
      const keys = table.keyColumns ?? [];
      requireKeys(keys, 'upsert');
      const keySet = new Set(keys);
      const updatable = table.columns.filter((c) => !keySet.has(c));
      const set = updatable.map((c) => `${liteIdent(c)} = excluded.${liteIdent(c)}`).join(', ');
      sql =
        `INSERT INTO ${target} (${cols}) VALUES (${holes}) ` +
        `ON CONFLICT (${keys.map(liteIdent).join(', ')}) ` +
        (updatable.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${set}`);
      break;
    }
    default:
      sql = `INSERT INTO ${target} (${cols}) VALUES (${holes})`;
  }
  opts.log?.(`SQLite fast path: ${sql}`);

  const stmt = db.prepare(sql);
  const width = table.columns.length;
  let index = 0;

  for await (const batch of rechunk(batches, Math.max(1, opts.batchSize), opts.signal)) {
    checkAbort(opts.signal);
    const start = index;
    index += batch.length;
    let bytes = 0;
    try {
      // SAVEPOINT rather than BEGIN: outside a transaction it starts one (and
      // RELEASE commits it), inside one it nests — so `wrap in transaction`
      // composes instead of throwing "cannot start a transaction within a
      // transaction" (PLAN §7.4 knobs).
      db.exec('SAVEPOINT dbadmin_import');
      for (const row of batch) {
        checkWidth(row, width);
        const params = row.map(liteParam);
        bytes += estimateBytes(params);
        stmt.run(...params);
      }
      db.exec('RELEASE dbadmin_import');
      t.advance(batch.length, bytes);
    } catch (err) {
      db.exec('ROLLBACK TO dbadmin_import');
      db.exec('RELEASE dbadmin_import');
      if (!opts.continueOnError) throw err;
      // Retry row by row, each in its own transaction, so one bad row costs one row.
      let ok = 0;
      for (let i = 0; i < batch.length; i++) {
        try {
          checkWidth(batch[i], width);
          stmt.run(...batch[i].map(liteParam));
          ok++;
        } catch (rowErr) {
          t.fail(start + i + 1, rowErr, batch[i]);
        }
      }
      t.advance(ok, bytes);
    }
    // better-sqlite3 is synchronous: without an explicit yield the event loop
    // never runs and cancel/progress would be dead until the import finished.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return t.result();
}

// ---------------------------------------------------------------------------
// MongoDB — unordered bulkWrite (PLAN §7.4)
// ---------------------------------------------------------------------------

function mongoValue(cell: Cell): unknown {
  if (cell === null) return null;
  if (!isTagged(cell)) return cell;
  switch (cell.$t) {
    case 'bytes':
      return new Binary(Buffer.from(base64ToBytes(cell.v)));
    case 'objectid':
      return ObjectId.isValid(cell.v) ? new ObjectId(cell.v) : cell.v;
    case 'decimal':
    case 'decimal128':
      try {
        return Decimal128.fromString(cell.v);
      } catch {
        return cell.v;
      }
    case 'bigint':
      try {
        return BigInt(cell.v);
      } catch {
        return cell.v;
      }
    case 'date':
    case 'timestamp':
    case 'timestamptz': {
      // Our canonical text is `YYYY-MM-DD[ HH:MM:SS]`; with no offset it is read
      // as UTC, because BSON dates have no zone to record one in.
      const iso = cell.v.includes('T') ? cell.v : cell.v.replace(' ', 'T');
      const withZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`;
      const d = new Date(withZone);
      return Number.isNaN(d.getTime()) ? cell.v : d;
    }
    case 'json':
      try {
        return JSON.parse(cell.v) as unknown;
      } catch {
        return cell.v;
      }
    default:
      return cell.v;
  }
}

function mongoDoc(row: Row, columns: string[]): Document {
  const doc: Document = {};
  for (let i = 0; i < columns.length; i++) doc[columns[i]] = mongoValue(row[i] ?? null);
  return doc;
}

export async function loadMongo(
  collection: Collection<Document>,
  batches: AsyncIterable<Row[]>,
  table: LoadTable,
  opts: LoadOptions,
): Promise<LoadResult> {
  if (opts.dryRun) return dryRun(batches, table, opts, mongoValue);

  const t = newTracker(opts, 'mongodb:bulkwrite-unordered');
  const keys = table.keyColumns ?? [];
  if ((opts.onConflict === 'upsert' || opts.onConflict === 'replace') && keys.length === 0) {
    requireKeys(keys, opts.onConflict);
  }
  const width = table.columns.length;
  let index = 0;

  for await (const batch of rechunk(batches, Math.max(1, opts.batchSize), opts.signal)) {
    checkAbort(opts.signal);
    const start = index;
    index += batch.length;

    const ops: AnyBulkWriteOperation<Document>[] = [];
    let bytes = 0;
    for (const row of batch) {
      checkWidth(row, width);
      const doc = mongoDoc(row, table.columns);
      bytes += JSON.stringify(doc).length;
      const filter: Document = {};
      for (const k of keys) filter[k] = doc[k];
      switch (opts.onConflict) {
        case 'upsert':
          ops.push({ updateOne: { filter, update: { $set: doc }, upsert: true } });
          break;
        case 'replace':
          ops.push({ replaceOne: { filter, replacement: doc, upsert: true } });
          break;
        default:
          ops.push({ insertOne: { document: doc } });
      }
    }

    try {
      // Unordered: one duplicate key does not stop the other 999 (PLAN §7.4).
      await collection.bulkWrite(ops, { ordered: false });
      t.advance(batch.length, bytes);
    } catch (err) {
      const write = err as { writeErrors?: { index: number; errmsg?: string; code?: number }[]; result?: unknown };
      const failures = Array.isArray(write.writeErrors) ? write.writeErrors : [];
      const duplicatesOnly = failures.length > 0 && failures.every((f) => f.code === 11000);
      if (!opts.continueOnError && !(opts.onConflict === 'ignore' && duplicatesOnly)) throw err;
      for (const f of failures) {
        if (opts.onConflict === 'ignore' && f.code === 11000) continue;
        t.fail(start + f.index + 1, new Error(f.errmsg ?? 'write error'), batch[f.index]);
      }
      t.advance(Math.max(0, batch.length - failures.length), bytes);
    }
  }
  return t.result();
}
