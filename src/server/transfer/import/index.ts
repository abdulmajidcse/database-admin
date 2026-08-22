/**
 * The import job runner (PLAN §7.4 + §7.3).
 *
 * `runImport()` is a `JobManager` runner: it takes the request the wizard built,
 * honours `ctx.signal` for cancel, streams progress for the jobs drawer, and
 * returns a report the UI can show when the job is done. Nothing here buffers a
 * file — CSV/JSON rows are streamed into the engine's fast path, and a `.sql`
 * script is streamed through the dump runner.
 *
 * Why this opens its own connection rather than borrowing the connector's pool:
 * a bulk load needs a *session*, not a pooled connection — `LOAD DATA LOCAL
 * INFILE` requires the local-file capability, `COPY` and temp tables are
 * session-scoped, `SET FOREIGN_KEY_CHECKS`/`session_replication_role` are
 * session state, and `statement_timeout` must be off for a load that runs for
 * an hour. It still goes through the AccessResolver, so a tunnelled connection
 * imports exactly like a local one (PLAN §8.1).
 *
 * Server-side only: no React, no Next (PLAN §11).
 */

import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { Client as PgClient } from 'pg';
import type { ClientConfig as PgClientConfig } from 'pg';
import mysql from 'mysql2/promise';
import type {
  ConnectionOptions as MysqlOptions,
  QueryValues,
  RowDataPacket,
  SslOptions,
} from 'mysql2/promise';
import Database from 'better-sqlite3';
import { MongoClient } from 'mongodb';
import type { MongoClientOptions } from 'mongodb';

import type { Address, ConnectionConfig, TlsConfig } from '../../../lib/connection';
import type { EngineKind } from '../../../lib/schema-model';
import type { Cell, Row } from '../../../lib/wire';
import { tag } from '../../../lib/wire';
import type {
  ColumnMapping,
  CsvPreviewResponse,
  ImportOptions,
  ImportRequest,
  JobSummary,
} from '../../../lib/api-types';

import { CONFIG, resolveWithin } from '../../config';
import { connectionsRepo } from '../../store/db';
import { accessResolver } from '../../net';
import type { ResolvedAddress } from '../../db/types';
import { DbError } from '../../db/types';
import { quoteIdent, quoteQualified } from '../../db/sql/quote';
import type { SqlDialect } from '../../db/sql/lexer';

import {
  CsvRowError,
  PREVIEW_ROWS,
  coerceValue,
  defaultDialect,
  defaultMapping,
  inferColumnTypes,
  previewCsv,
  readCsvRows,
  sniffFile,
  syntheticHeaders,
  type CsvDialect,
} from './csv';
import { previewXlsx, readXlsxRows } from './xlsx';
import {
  ImportCancelled,
  loadRows,
  pgCopyIn,
  type LoadError,
  type LoadHandle,
  type LoadResult,
  type LoadTable,
  type OnConflict,
} from './fastpath';
import { runSqlScript, type ScriptError, type ScriptExecutor, type ScriptResult } from './dump-runner';
import { bundleMemberOverrides, bundleMembers } from './bundle';

// ---------------------------------------------------------------------------
// Job contract
// ---------------------------------------------------------------------------

/** The progress shape the JobManager persists and broadcasts (PLAN §7.3). */
export type JobProgressPatch = Partial<JobSummary['progress']>;

/**
 * What a JobManager runner is handed. Declared structurally so this module has
 * no import edge into the job manager itself — the manager's context satisfies
 * it by shape.
 */
export interface JobRunnerContext {
  readonly signal: AbortSignal;
  /** Appended to the job's log ring buffer, tailed live by the UI (§7.3). */
  log(line: string): void;
  progress(patch: JobProgressPatch): void;
}

export interface ImportParams extends ImportRequest {
  /** Wizard overrides on top of the sniffed dialect (CSV only). */
  csv?: Partial<CsvDialect>;
  /** Unique key for upsert/replace. Defaults to the target's primary key. */
  keyColumns?: string[];
}

export interface ImportErrorItem {
  /** 1-based row (data sources) or statement index (scripts). */
  at: number;
  line?: number;
  message: string;
  code?: string;
  sample?: string;
}

export interface ImportReport {
  connectionId: string;
  engine: EngineKind;
  source: ImportRequest['source']['kind'];
  target?: string;
  dryRun: boolean;
  /** Which fast path ran, e.g. `postgres:copy` (PLAN §7.4). */
  fastPath: string;
  rowsRead: number;
  rowsWritten: number;
  rowsSkipped: number;
  bytesProcessed: number;
  batches: number;
  /** Script imports only. */
  statements?: number;
  truncated: boolean;
  foreignKeysDisabled: boolean;
  durationMs: number;
  errors: ImportErrorItem[];
  warnings: string[];
}

const DEFAULT_OPTIONS: ImportOptions = {
  onConflict: 'insert',
  truncateFirst: false,
  disableForeignKeys: false,
  batchSize: 1000,
  wrapInTransaction: true,
  continueOnError: false,
  dryRun: false,
  useFastPath: true,
};

// ---------------------------------------------------------------------------
// CSV wizard backend (PLAN §7.4)
// ---------------------------------------------------------------------------

/**
 * Everything the wizard's first screen needs in one call: the sniffed dialect,
 * the header row, 50 preview rows and a per-column type guess.
 */
export async function previewCsvFile(
  file: string,
  overrides: Partial<CsvDialect> = {},
  rows = PREVIEW_ROWS,
): Promise<CsvPreviewResponse & { dialect: CsvDialect; mapping: ColumnMapping[] }> {
  const resolved = resolveImportPath(file);
  const dialect = { ...(await sniffFile(resolved)), ...overrides };
  const preview = await previewCsv(resolved, dialect, rows);
  const headers =
    preview.headers.length > 0
      ? preview.headers
      : syntheticHeaders(preview.rows.reduce((n, r) => Math.max(n, r.length), 0));
  const inferred = inferColumnTypes(preview.rows, dialect.nullLiteral);
  return {
    dialect,
    headers,
    rows: preview.rows,
    inferredTypes: inferred,
    mapping: defaultMapping(headers, inferred),
  };
}

/**
 * The validation pass PLAN §7.4 asks for: "reports bad rows *before* touching
 * the table". Coercion only — no connection is opened.
 */
export async function validateCsv(
  file: string,
  dialect: CsvDialect,
  mapping: ColumnMapping[],
  limit = 10_000,
): Promise<{ rows: number; errors: ImportErrorItem[] }> {
  const resolved = resolveImportPath(file);
  const errors: ImportErrorItem[] = [];
  let rows = 0;
  for await (const batch of readCsvRows(resolved, dialect, mapping, {
    limit,
    batchSize: 500,
    onError: (e) => errors.push(csvErrorItem(e)),
  })) {
    rows += batch.length;
  }
  return { rows, errors };
}

function csvErrorItem(e: CsvRowError): ImportErrorItem {
  return { at: e.line, line: e.line, message: e.message, sample: e.value.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// runImport
// ---------------------------------------------------------------------------

export async function runImport(params: ImportParams, ctx: JobRunnerContext): Promise<ImportReport> {
  const startedAt = Date.now();
  const options: ImportOptions = { ...DEFAULT_OPTIONS, ...params.options };
  const config = connectionsRepo.get(params.connectionId);
  if (!config) throw new DbError(`No such connection: ${params.connectionId}`, 'NO_CONNECTION');
  // PLAN §8.5: a read-only connection is enforced server-side, not in the UI.
  if (config.readOnly && !options.dryRun) {
    throw new DbError(`Connection "${config.name}" is marked read-only; imports are refused.`, 'READ_ONLY');
  }

  const isScript = params.source.kind === 'sql' || params.source.kind === 'dump';
  if (isScript && config.engine === 'mongodb') {
    throw new DbError('MongoDB cannot run a SQL script; import JSON or NDJSON instead.', 'UNSUPPORTED');
  }
  // `openTarget` binds a Mongo handle to one collection, so a bundle — which
  // needs a different target per file — can never work there. Say so, rather
  // than failing later with "a target collection is required" for a wizard that
  // deliberately never asked for one.
  if (params.source.kind === 'bundle' && config.engine === 'mongodb') {
    throw new DbError(
      'MongoDB cannot import a folder of CSVs; import one collection at a time.',
      'UNSUPPORTED',
    );
  }

  const file = resolveImportPath(params.source.path);
  const fileSize = (await stat(file)).size;
  const warnings: string[] = [];

  ctx.progress({ phase: 'connecting', tablesTotal: 1, tablesDone: 0, rowsDone: 0, bytesOut: 0 });
  ctx.log(
    `Import ${params.source.kind} from ${file} into ${config.name} (${config.engine})` +
      (options.dryRun ? ' — DRY RUN, nothing will be written' : ''),
  );

  const resolved = await accessResolver.resolve(config, connectionsRepo.sshSecrets(config.id));
  const password = connectionsRepo.password(config.id);
  const target = await openTarget(config, resolved, password, {
    database: params.target?.schema,
    collection: params.target?.table,
  });

  try {
    if (isScript) {
      return await runScriptImport(params, options, config, target, file, fileSize, ctx, startedAt, warnings);
    }
    if (params.source.kind === 'bundle') {
      return await runBundleImport(params, options, config, target, file, ctx, startedAt, warnings);
    }
    return await runRowImport(params, options, config, target, file, fileSize, ctx, startedAt, warnings);
  } finally {
    await target.close().catch(() => undefined);
    await resolved.release().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Bundle imports (a directory of CSV/TSV files → many tables)
// ---------------------------------------------------------------------------

/**
 * Load every delimited file in a directory into the table its name implies —
 * the import half of the §7.1 database scope, and the mirror of the directory
 * export.
 *
 * Each member is a full row import in its own right: its own sniffed dialect,
 * its own mapping derived from its own header, its own optional CREATE TABLE.
 * That is what makes fifty heterogeneous files loadable in one action; a shared
 * mapping could only ever describe one of them.
 *
 * The members run in sequence rather than in parallel. They share one target
 * connection, and a bundle written by an export is exactly the case where
 * foreign keys point across the files in it — a defined order is recoverable,
 * an interleaved one is not.
 */
async function runBundleImport(
  params: ImportParams,
  options: ImportOptions,
  config: ConnectionConfig,
  target: Target,
  dir: string,
  ctx: JobRunnerContext,
  startedAt: number,
  warnings: string[],
): Promise<ImportReport> {
  const members = await bundleMembers(dir);
  ctx.log(`Bundle: ${members.length} file(s) → ${members.map((m) => m.table).join(', ')}`);
  ctx.progress({ phase: 'starting', tablesTotal: members.length, tablesDone: 0 });

  const reports: ImportReport[] = [];
  const loaded: string[] = [];
  for (const [index, member] of members.entries()) {
    const name = basename(member.path);
    ctx.log(`[${index + 1}/${members.length}] ${name} → ${member.table}`);
    const size = (await stat(member.path)).size;

    const memberParams: ImportParams = { ...params, ...bundleMemberOverrides(params, member) };

    try {
      reports.push(
        // Its own `startedAt`: the ETA is computed from bytes read against
        // elapsed time, so sharing the bundle's start makes every member after
        // the first report a progressively more wrong estimate.
        await runRowImport(memberParams, options, config, target, member.path, size, ctx, Date.now(), warnings),
      );
      loaded.push(member.table);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Members commit individually, so by the time one fails the earlier ones
      // are already durable. Saying which is the difference between a recoverable
      // restore and a database in an unknown state.
      const done = loaded.length === 0 ? 'none' : loaded.join(', ');
      ctx.log(`${member.table} failed: ${message}`);
      ctx.log(`Committed before the failure: ${done}. Not attempted: ${members.length - index - 1} file(s).`);
      warnings.push(`${member.table} failed: ${message}`);
      if (!options.continueOnError) {
        throw new DbError(
          `Bundle import stopped at ${name}: ${message}. Already committed: ${done}.`,
          'BUNDLE_MEMBER_FAILED',
        );
      }
    }
    ctx.progress({ phase: 'importing', tablesTotal: members.length, tablesDone: index + 1 });
  }

  return mergeBundleReports(params, config, members.length, reports, startedAt, warnings);
}

/** One report for the whole bundle: totals across members, errors concatenated. */
function mergeBundleReports(
  params: ImportParams,
  config: ConnectionConfig,
  memberCount: number,
  reports: ImportReport[],
  startedAt: number,
  warnings: string[],
): ImportReport {
  const sum = (pick: (r: ImportReport) => number): number => reports.reduce((n, r) => n + pick(r), 0);
  return {
    connectionId: params.connectionId,
    engine: config.engine,
    source: 'bundle',
    target: `${memberCount} table(s): ${reports.map((r) => r.target ?? '?').join(', ')}`,
    dryRun: reports.every((r) => r.dryRun),
    // The members all take the same path for the same engine, so reporting the
    // first is accurate rather than a guess.
    fastPath: reports[0]?.fastPath ?? 'none',
    rowsRead: sum((r) => r.rowsRead),
    rowsWritten: sum((r) => r.rowsWritten),
    rowsSkipped: sum((r) => r.rowsSkipped),
    bytesProcessed: sum((r) => r.bytesProcessed),
    batches: sum((r) => r.batches),
    truncated: reports.some((r) => r.truncated),
    foreignKeysDisabled: reports.some((r) => r.foreignKeysDisabled),
    durationMs: Date.now() - startedAt,
    errors: reports.flatMap((r) => r.errors),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Row imports (CSV / JSON / NDJSON)
// ---------------------------------------------------------------------------

async function runRowImport(
  params: ImportParams,
  options: ImportOptions,
  config: ConnectionConfig,
  target: Target,
  file: string,
  fileSize: number,
  ctx: JobRunnerContext,
  startedAt: number,
  warnings: string[],
): Promise<ImportReport> {
  if (!params.target?.table) {
    throw new DbError('An import target table is required.', 'NO_TARGET');
  }
  const table = params.target.table;
  const schema = params.target.schema;

  // Mapping: use what the wizard produced, or derive one from the file itself.
  const dialect: CsvDialect =
    params.source.kind === 'csv'
      ? { ...(await sniffFile(file)), ...(params.csv ?? {}) }
      : { ...defaultDialect(), ...(params.csv ?? {}) };

  let mapping = params.mapping ?? [];
  if (mapping.length === 0) {
    mapping = await deriveMapping(params.source.kind, file, dialect);
    ctx.log(`Derived a column mapping from the file: ${mapping.map((m) => m.sourceName).join(', ')}`);
  }
  const active = mapping.filter((m) => m.targetColumn);
  if (active.length === 0) throw new DbError('No source column is mapped to a target column.', 'NO_MAPPING');

  const columns = active.map((m) => m.targetColumn as string);
  const binaryColumns = active
    .filter((m) => (m.targetType ?? '') === 'binary')
    .map((m) => m.targetColumn as string);
  const qualified = schema ? `${schema}.${table}` : table;

  // Verify before anything else touches the server: a typo in the mapping is
  // the most common failure and it should cost milliseconds, not a rollback.
  ctx.progress({ phase: 'validating' });

  // §7.1: the target may not exist yet. A dry run must still write nothing, so
  // it prints the DDL instead of running it — which is more useful anyway, since
  // the types come from a sniffed sample and this is the moment to disagree.
  const createSql = params.target.createTable
    ? createTableSql(target.engine, { schema, table }, active)
    : null;
  if (createSql && !options.dryRun) {
    await execDdl(target, createSql);
    ctx.log(`Ensured the target table exists:\n${createSql}`);
  } else if (createSql) {
    ctx.log(`Dry run: the target table would be created first —\n${createSql}`);
  }

  let targetMissing = false;
  try {
    await verifyTarget(target, { schema, table, columns });
  } catch (err) {
    // Only a dry run against a table that is yet to be created may skip this,
    // and only when the engine actually said "no such table". Every other
    // failure — a mistyped target column, a denied SELECT — is exactly what this
    // check exists to catch cheaply, and swallowing it would report a clean dry
    // run for an import that cannot succeed.
    if (!createSql || !options.dryRun || !isMissingTableError(err)) throw err;
    targetMissing = true;
    warnings.push(`${qualified} does not exist yet, so the column checks were skipped.`);
    ctx.log(`Dry run: ${qualified} does not exist yet, so the column checks were skipped.`);
  }

  // A table that does not exist has no primary key to read, and Postgres'
  // `$1::regclass` cast *errors* on a missing relation rather than answering
  // NULL — so this has to be skipped, not merely tolerated.
  const keyColumns =
    params.keyColumns ?? (targetMissing ? [] : await primaryKeyOf(target, schema, table));
  const loadTable: LoadTable = { schema, table, columns, keyColumns, binaryColumns };

  const prep = await prepareSession(target, loadTable, options, ctx, warnings);

  let rowsRead = 0;
  let bytesRead = 0;
  let sourceSkipped = 0;
  const errors: ImportErrorItem[] = [];
  const rows = sourceRows(params.source.kind, file, dialect, active, {
    batchSize: options.batchSize,
    signal: ctx.signal,
    // Reader-level failures are coercion failures: they are only survivable
    // when continue-on-error is on (PLAN §7.4).
    onError: options.continueOnError
      ? (e) => {
          sourceSkipped++;
          if (errors.length < 1000) errors.push(csvErrorItem(e));
        }
      : undefined,
    onProgress: (p) => {
      rowsRead = p.rows;
      bytesRead = p.bytes;
    },
  });

  ctx.progress({ phase: options.dryRun ? 'validating' : 'loading' });
  let result: LoadResult;
  try {
    result = await loadRows(target.handle, rows, loadTable, {
      onConflict: options.onConflict as OnConflict,
      batchSize: Math.max(1, options.batchSize || DEFAULT_OPTIONS.batchSize),
      dryRun: options.dryRun,
      continueOnError: options.continueOnError,
      inTransaction: prep.inTransaction,
      useFastPath: options.useFastPath,
      signal: ctx.signal,
      log: (line) => ctx.log(line),
      onProgress: (p) => {
        ctx.progress({
          phase: options.dryRun ? 'validating' : 'loading',
          rowsDone: p.rows,
          bytesOut: p.bytes,
          // The ETA comes from how much of the *file* has been read, which is
          // the only quantity with a known total.
          etaMs: estimateEta(startedAt, bytesRead, fileSize),
        });
      },
    });
    await prep.commit();
  } catch (err) {
    await prep.rollback();
    if (err instanceof ImportCancelled) {
      ctx.log('Cancelled; the transaction was rolled back.');
    }
    throw err;
  } finally {
    await prep.restore();
  }

  for (const e of result.errors) errors.push(loadErrorItem(e));
  const durationMs = Date.now() - startedAt;
  ctx.progress({
    phase: 'done',
    tablesDone: 1,
    rowsDone: result.rows,
    bytesOut: result.bytes,
    etaMs: 0,
  });
  ctx.log(
    `${options.dryRun ? 'Validated' : 'Imported'} ${result.rows} row(s) into ${qualified} ` +
      `via ${result.fastPath} in ${(durationMs / 1000).toFixed(1)}s` +
      (result.skipped > 0 ? `, ${result.skipped} row(s) skipped` : ''),
  );

  return {
    connectionId: config.id,
    engine: config.engine,
    source: params.source.kind,
    target: qualified,
    dryRun: options.dryRun,
    fastPath: result.fastPath,
    rowsRead: Math.max(rowsRead, result.rows + result.skipped),
    rowsWritten: options.dryRun ? 0 : result.rows,
    rowsSkipped: result.skipped + sourceSkipped,
    bytesProcessed: result.bytes,
    batches: result.batches,
    truncated: prep.truncated,
    foreignKeysDisabled: prep.foreignKeysDisabled,
    durationMs,
    errors,
    warnings,
  };
}

function loadErrorItem(e: LoadError): ImportErrorItem {
  return { at: e.row, message: e.message, code: e.code, sample: e.sample };
}

function estimateEta(startedAt: number, done: number, total: number): number | undefined {
  if (total <= 0 || done <= 0) return undefined;
  const elapsed = Date.now() - startedAt;
  const ratio = Math.min(1, done / total);
  if (ratio <= 0.01) return undefined;
  return Math.max(0, Math.round(elapsed / ratio - elapsed));
}

// ---------------------------------------------------------------------------
// Script imports (.sql / dump)
// ---------------------------------------------------------------------------

async function runScriptImport(
  params: ImportParams,
  options: ImportOptions,
  config: ConnectionConfig,
  target: Target,
  file: string,
  fileSize: number,
  ctx: JobRunnerContext,
  startedAt: number,
  warnings: string[],
): Promise<ImportReport> {
  const executor = scriptExecutor(target);
  if (options.wrapInTransaction && !options.dryRun) {
    // Dumps carry their own transaction and DDL statements, and DDL commits
    // implicitly on MySQL — so the wrap is real but cannot be a guarantee.
    warnings.push(
      'The script runs inside a transaction, but any COMMIT or DDL statement inside it ends that transaction early.',
    );
  }
  const prep = await prepareSession(target, null, options, ctx, warnings);

  ctx.progress({ phase: options.dryRun ? 'parsing script' : 'running script' });
  let result: ScriptResult;
  try {
    result = await runSqlScript(file, executor, {
      continueOnError: options.continueOnError,
      dryRun: options.dryRun,
      signal: ctx.signal,
      log: (line) => ctx.log(line),
      onProgress: (p) => {
        ctx.progress({
          phase: options.dryRun ? 'parsing script' : 'running script',
          rowsDone: p.statements,
          bytesOut: p.bytesDone,
          etaMs: estimateEta(startedAt, p.bytesDone, p.bytesTotal || fileSize),
        });
      },
    });
    await prep.commit();
  } catch (err) {
    await prep.rollback();
    throw err;
  } finally {
    await prep.restore();
  }

  const durationMs = Date.now() - startedAt;
  ctx.progress({ phase: 'done', tablesDone: 1, rowsDone: result.statements, bytesOut: result.bytesTotal, etaMs: 0 });
  ctx.log(
    `${result.executed}/${result.statements} statement(s) ran in ${(durationMs / 1000).toFixed(1)}s` +
      (result.failed > 0 ? `, ${result.failed} failed` : '') +
      (result.skipped > 0 ? `, ${result.skipped} skipped` : ''),
  );

  return {
    connectionId: config.id,
    engine: config.engine,
    source: params.source.kind,
    dryRun: options.dryRun,
    fastPath: `script:${executor.dialect}`,
    rowsRead: result.statements,
    rowsWritten: result.executed,
    rowsSkipped: result.skipped,
    bytesProcessed: result.bytesTotal,
    batches: 0,
    statements: result.statements,
    truncated: false,
    foreignKeysDisabled: prep.foreignKeysDisabled,
    durationMs,
    errors: result.errors.map(scriptErrorItem),
    warnings,
  };
}

function scriptErrorItem(e: ScriptError): ImportErrorItem {
  return { at: e.index, line: e.line, message: e.message, code: e.code, sample: e.statement };
}

function scriptExecutor(target: Target): ScriptExecutor {
  switch (target.handle.engine) {
    case 'postgres': {
      const client = target.handle.client;
      return {
        dialect: 'postgres',
        exec: async (sql) => {
          await client.query(sql);
        },
        copyIn: (sql, data) => pgCopyIn(client, sql, data),
      };
    }
    case 'mysql':
    case 'mariadb': {
      const conn = target.handle.conn;
      return {
        dialect: 'mysql',
        exec: async (sql) => {
          await conn.query(sql);
        },
      };
    }
    case 'sqlite': {
      const db = target.handle.db;
      return {
        dialect: 'sqlite',
        exec: async (sql) => {
          db.exec(sql);
        },
      };
    }
    case 'mongodb':
      throw new DbError('MongoDB cannot run a SQL script; import JSON or NDJSON instead.', 'UNSUPPORTED');
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface SourceOptions {
  batchSize: number;
  signal: AbortSignal;
  onError?: (e: CsvRowError) => void;
  onProgress?: (p: { rows: number; bytes: number }) => void;
}

function sourceRows(
  kind: ImportRequest['source']['kind'],
  file: string,
  dialect: CsvDialect,
  mapping: ColumnMapping[],
  opts: SourceOptions,
): AsyncIterable<Row[]> {
  if (kind === 'csv') {
    return readCsvRows(file, dialect, mapping, {
      batchSize: opts.batchSize,
      signal: opts.signal,
      onError: opts.onError,
      onProgress: opts.onProgress,
    });
  }
  if (kind === 'xlsx') {
    return readXlsxRows(file, mapping, {
      batchSize: opts.batchSize,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
  }
  return readJsonRows(file, dialect, mapping, opts);
}

async function deriveMapping(
  kind: ImportRequest['source']['kind'],
  file: string,
  dialect: CsvDialect,
): Promise<ColumnMapping[]> {
  if (kind === 'csv') {
    const preview = await previewCsv(file, dialect, PREVIEW_ROWS);
    return defaultMapping(preview.headers, inferColumnTypes(preview.rows, dialect.nullLiteral));
  }
  if (kind === 'xlsx') {
    // Types are inferred from the sampled text exactly as for CSV: a sheet's
    // own cell types describe the spreadsheet, not the target column.
    const preview = await previewXlsx(file, PREVIEW_ROWS);
    return defaultMapping(preview.headers, inferColumnTypes(preview.rows, ''));
  }
  // JSON/NDJSON: the union of the keys in the first records, in first-seen order.
  const keys: string[] = [];
  let seen = 0;
  for await (const value of streamJsonValues(file)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of Object.keys(value as Record<string, unknown>)) {
        if (!keys.includes(k)) keys.push(k);
      }
    }
    if (++seen >= 50) break;
  }
  return keys.map((k, i) => ({ sourceIndex: i, sourceName: k, targetColumn: k }));
}

/**
 * JSON and NDJSON rows. Values that are already typed (numbers, booleans,
 * nested objects) skip text coercion; strings go through the same coercion as
 * CSV so an explicit date format still applies.
 */
async function* readJsonRows(
  file: string,
  dialect: CsvDialect,
  mapping: ColumnMapping[],
  opts: SourceOptions,
): AsyncIterable<Row[]> {
  let batch: Row[] = [];
  let rows = 0;
  let line = 0;
  let bytes = 0;

  for await (const value of streamJsonValues(file, opts.signal, (n) => {
    bytes = n;
  })) {
    line++;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      const err = new CsvRowError(`Record ${line} is not a JSON object`, line, 0, '', String(value));
      if (!opts.onError) throw err;
      opts.onError(err);
      continue;
    }
    const record = value as Record<string, unknown>;
    try {
      const row: Row = mapping.map((m) => jsonCell(record[m.sourceName], m, dialect, line));
      batch.push(row);
      rows++;
    } catch (err) {
      if (!opts.onError || !(err instanceof CsvRowError)) throw err;
      opts.onError(err);
      continue;
    }
    if (batch.length >= opts.batchSize) {
      yield batch;
      batch = [];
      opts.onProgress?.({ rows, bytes });
    }
  }
  if (batch.length > 0) yield batch;
  opts.onProgress?.({ rows, bytes: 0 });
}

function jsonCell(value: unknown, m: ColumnMapping, dialect: CsvDialect, line: number): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return coerceValue(value, m, dialect, line);
  // Objects and arrays keep their JSON text: the §6 wire format carries them
  // losslessly and every writer knows what to do with a `json` cell.
  return tag('json', JSON.stringify(value));
}

/**
 * Stream top-level values out of a JSON array or an NDJSON file without ever
 * holding more than one record plus the read buffer. The shape is detected from
 * the first non-whitespace character.
 */
export async function* streamJsonValues(
  file: string,
  signal?: AbortSignal,
  onBytes?: (bytesRead: number) => void,
): AsyncIterable<unknown> {
  const stream = createReadStream(file, { highWaterMark: 1 << 20 });
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let mode: 'unknown' | 'array' | 'ndjson' = 'unknown';
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  const abort = (): void => {
    stream.destroy();
  };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) return;
      buf += decoder.write(chunk as Buffer);
      onBytes?.(stream.bytesRead);

      if (mode === 'unknown') {
        const first = buf.replace(/^[\s\uFEFF]+/, '');
        if (first === '') {
          buf = '';
          continue;
        }
        mode = first.startsWith('[') ? 'array' : 'ndjson';
        buf = mode === 'array' ? first.slice(1) : first;
      }

      if (mode === 'ndjson') {
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const text = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (text !== '' && text !== ',') yield JSON.parse(stripTrailingComma(text)) as unknown;
        }
        continue;
      }

      // Array mode: walk the buffer tracking string and nesting state so a `}`
      // inside a string cannot end a record.
      let i = 0;
      while (i < buf.length) {
        const c = buf.charAt(i);
        if (inString) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') inString = false;
          i++;
          continue;
        }
        if (c === '"') {
          // Only records (objects/arrays) are importable, so a bare string at
          // the top level is skipped rather than emitted.
          inString = true;
          i++;
          continue;
        }
        if (c === '{' || c === '[') {
          if (depth === 0) start = i;
          depth++;
          i++;
          continue;
        }
        if (c === '}' || c === ']') {
          if (depth === 0) {
            // The array's own closing bracket: consume it and keep going.
            buf = buf.slice(i + 1);
            i = 0;
            continue;
          }
          depth--;
          i++;
          if (depth === 0 && start >= 0) {
            yield JSON.parse(buf.slice(start, i)) as unknown;
            buf = buf.slice(i);
            i = 0;
            start = -1;
          }
          continue;
        }
        if (depth === 0 && (c === ',' || /\s/.test(c))) {
          buf = buf.slice(i + 1);
          i = 0;
          start = -1;
          continue;
        }
        i++;
      }
      // Nothing is pending between records, so the buffer can be released.
      if (depth === 0 && start < 0) buf = '';
    }

    const tail = (buf + decoder.end()).trim();
    if (mode === 'ndjson' && tail !== '') yield JSON.parse(stripTrailingComma(tail)) as unknown;
  } finally {
    signal?.removeEventListener('abort', abort);
    stream.destroy();
  }
}

function stripTrailingComma(text: string): string {
  return text.endsWith(',') ? text.slice(0, -1) : text;
}

// ---------------------------------------------------------------------------
// Target: a dedicated bulk-load session per engine
// ---------------------------------------------------------------------------

interface Target {
  handle: LoadHandle;
  engine: EngineKind;
  close(): Promise<void>;
}

async function openTarget(
  config: ConnectionConfig,
  resolved: ResolvedAddress,
  password: string | undefined,
  ns: { database?: string; collection?: string },
): Promise<Target> {
  switch (config.engine) {
    case 'postgres': {
      const client = new PgClient(pgConfig(config, resolved.address, password));
      await client.connect();
      // A load that runs for an hour must not be killed by the connection's
      // normal statement timeout (PLAN §8.3 sets one for interactive queries).
      await client.query('SET statement_timeout = 0');
      if (config.options.defaultSchema) {
        await client.query(`SET search_path TO ${quoteIdent(config.options.defaultSchema, 'postgres')}, public`);
      }
      return {
        engine: 'postgres',
        handle: { engine: 'postgres', client },
        close: () => client.end(),
      };
    }
    case 'mysql':
    case 'mariadb': {
      const conn = await mysql.createConnection(mysqlConfig(config, resolved.address, password));
      return {
        engine: config.engine,
        handle: { engine: config.engine, conn },
        close: () => conn.end(),
      };
    }
    case 'sqlite': {
      if (resolved.address.kind !== 'file') {
        throw new DbError('A SQLite connection needs a file address.', 'BAD_ADDRESS');
      }
      const db = new Database(resolved.address.path, { readonly: false });
      // The connector's worker may be reading the same file; WAL plus a busy
      // timeout is what keeps both alive (PLAN §6 "SQLite locking").
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 15000');
      db.pragma('foreign_keys = ON');
      return {
        engine: 'sqlite',
        handle: { engine: 'sqlite', db },
        close: async () => {
          db.close();
        },
      };
    }
    case 'redis':
      // PLAN §7.5: Redis has no per-key file format — its import is a pipelined
      // RESTORE of DUMP payloads wrapped in an NDJSON envelope, which is a
      // different pipeline (the keyspace, not a table) and lives with the Redis
      // connector rather than here.
      throw new DbError(
        'Redis import is not part of the table-import pipeline; use the keyspace RESTORE import instead.',
        'UNSUPPORTED_ENGINE',
      );
    case 'mongodb': {
      const { uri, options } = mongoConfig(config, resolved.address, password);
      const database = ns.database ?? config.options.database;
      if (!ns.collection) {
        throw new DbError('A MongoDB import needs a target collection.', 'NO_TARGET');
      }
      const client = new MongoClient(uri, options);
      await client.connect();
      // `client.db(undefined)` uses the database from the URI, which is what a
      // mongodb+srv connection string usually carries (PLAN §4 Address union).
      const collection = client.db(database).collection(ns.collection);
      return {
        engine: 'mongodb',
        handle: { engine: 'mongodb', collection },
        close: () => client.close(),
      };
    }
  }
}

/** PEM text or a path to it, matching the connectors' convention (PLAN §8.2). */
function readPem(value: string): string {
  return value.includes('-----BEGIN') ? value : readFileSync(value, 'utf8');
}

function pgConfig(config: ConnectionConfig, address: Address, password?: string): PgClientConfig {
  const cfg: PgClientConfig = {
    user: config.username,
    password,
    database: config.options.database,
    application_name: 'dbadmin-import',
    connectionTimeoutMillis: config.options.connectTimeoutMs ?? 15_000,
    keepAlive: true,
  };
  switch (address.kind) {
    case 'tcp':
      cfg.host = address.host;
      cfg.port = address.port;
      break;
    case 'unix': {
      // libpq takes the socket *directory* plus the port (PLAN §8.2).
      const m = /^(.*)\/\.s\.PGSQL\.(\d+)$/.exec(address.socketPath);
      cfg.host = m ? m[1] : address.socketPath;
      cfg.port = m ? Number(m[2]) : 5432;
      break;
    }
    case 'uri':
      cfg.connectionString = address.uri;
      break;
    case 'file':
      throw new DbError('PostgreSQL cannot be opened from a file path', 'BAD_ADDRESS');
  }
  const tls = config.tls;
  if (tls?.enabled) {
    cfg.ssl = {
      rejectUnauthorized: tls.verify === 'verify-full' ? true : tls.verify === 'require' ? !!tls.caCert : false,
      ca: tls.caCert ? readPem(tls.caCert) : undefined,
      cert: tls.clientCert ? readPem(tls.clientCert) : undefined,
      key: tls.clientKey ? readPem(tls.clientKey) : undefined,
      servername: tls.serverName,
    };
  }
  return cfg;
}

function mysqlConfig(config: ConnectionConfig, address: Address, password?: string): MysqlOptions {
  const base: MysqlOptions = {
    user: config.username,
    password,
    database: config.options.database,
    connectTimeout: config.options.connectTimeoutMs ?? 15_000,
    charset: 'UTF8MB4_UNICODE_CI',
    // §6 type fidelity, same settings the connector uses.
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    decimalNumbers: false,
    timezone: 'Z',
    multipleStatements: false,
    // mysql2 sets LOCAL_FILES by default; naming it makes the requirement for
    // `LOAD DATA LOCAL INFILE` explicit rather than incidental (PLAN §7.4).
    flags: ['LOCAL_FILES'],
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
  };
  switch (address.kind) {
    case 'tcp':
      base.host = address.host;
      base.port = address.port;
      break;
    case 'unix':
      base.socketPath = address.socketPath;
      break;
    case 'uri': {
      const url = new URL(address.uri);
      base.host = decodeURIComponent(url.hostname);
      base.port = url.port ? Number(url.port) : 3306;
      if (url.username) base.user = decodeURIComponent(url.username);
      if (url.password) base.password = decodeURIComponent(url.password);
      const db = url.pathname.replace(/^\//, '');
      if (db) base.database = decodeURIComponent(db);
      break;
    }
    case 'file':
      throw new DbError('MySQL cannot be opened from a file path', 'BAD_ADDRESS');
  }
  if (config.tls?.enabled) base.ssl = mysqlSsl(config.tls);
  return base;
}

function mysqlSsl(tls: TlsConfig): SslOptions {
  const ssl: SslOptions = {};
  if (tls.caCert) ssl.ca = readPem(tls.caCert);
  if (tls.clientCert) ssl.cert = readPem(tls.clientCert);
  if (tls.clientKey) ssl.key = readPem(tls.clientKey);
  ssl.rejectUnauthorized = tls.verify === 'verify-full' ? true : tls.verify === 'require' ? !!tls.caCert : false;
  ssl.verifyIdentity = tls.verify === 'verify-full';
  return ssl;
}

function mongoConfig(
  config: ConnectionConfig,
  address: Address,
  password?: string,
): { uri: string; options: MongoClientOptions } {
  const options: MongoClientOptions = {
    appName: 'dbadmin-import',
    serverSelectionTimeoutMS: config.options.connectTimeoutMs ?? 15_000,
  };
  if (config.username) options.auth = { username: config.username, password };
  if (config.options.authSource) options.authSource = config.options.authSource;
  if (config.options.replicaSet) options.replicaSet = config.options.replicaSet;
  if (config.tls?.enabled) {
    options.tls = true;
    options.tlsAllowInvalidCertificates = config.tls.verify === 'skip';
    options.tlsAllowInvalidHostnames = config.tls.verify !== 'verify-full';
    if (config.tls.caCert) options.ca = readPem(config.tls.caCert);
  }
  switch (address.kind) {
    case 'uri':
      return { uri: address.uri, options };
    case 'tcp':
      return { uri: `mongodb://${address.host}:${address.port}`, options };
    case 'unix':
      return { uri: `mongodb://${encodeURIComponent(address.socketPath)}`, options };
    case 'file':
      throw new DbError('MongoDB cannot be opened from a file path', 'BAD_ADDRESS');
  }
}

// ---------------------------------------------------------------------------
// Target preparation: the PLAN §7.4 knobs
// ---------------------------------------------------------------------------

interface Prepared {
  inTransaction: boolean;
  truncated: boolean;
  foreignKeysDisabled: boolean;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  restore(): Promise<void>;
}

/**
 * Truncate-before-load, FK checks off, and wrap-in-transaction — in the only
 * order that works: FK checks first (a truncate on a referenced table needs
 * them off), then the truncate (MySQL's TRUNCATE commits implicitly, so it can
 * never be inside our transaction), then BEGIN.
 */
async function prepareSession(
  target: Target,
  table: LoadTable | null,
  options: ImportOptions,
  ctx: JobRunnerContext,
  warnings: string[],
): Promise<Prepared> {
  const state: Prepared = {
    inTransaction: false,
    truncated: false,
    foreignKeysDisabled: false,
    commit: async () => undefined,
    rollback: async () => undefined,
    restore: async () => undefined,
  };
  if (options.dryRun) {
    ctx.log('Dry run: no truncate, no FK changes, no transaction, no writes.');
    return state;
  }

  const restores: (() => Promise<void>)[] = [];

  if (options.disableForeignKeys) {
    const done = await disableForeignKeys(target, ctx, warnings);
    state.foreignKeysDisabled = done.disabled;
    if (done.restore) restores.push(done.restore);
  }

  if (options.truncateFirst && table) {
    await truncateTarget(target, table);
    state.truncated = true;
    ctx.log(`Truncated ${table.schema ? `${table.schema}.` : ''}${table.table} before loading.`);
  }

  if (options.wrapInTransaction) {
    const tx = await beginTransaction(target, ctx, warnings);
    state.inTransaction = tx.began;
    state.commit = tx.commit;
    state.rollback = tx.rollback;
    // Postgres' deferred-constraint fallback only exists inside a transaction.
    if (options.disableForeignKeys && !state.foreignKeysDisabled && target.handle.engine === 'postgres') {
      try {
        await target.handle.client.query('SET CONSTRAINTS ALL DEFERRED');
        state.foreignKeysDisabled = true;
        warnings.push(
          'session_replication_role needs superuser, so constraints were only DEFERRED — non-deferrable foreign keys are still checked (PLAN §7.4).',
        );
        ctx.log('Fell back to SET CONSTRAINTS ALL DEFERRED.');
      } catch {
        // Nothing more to try; the warning from disableForeignKeys stands.
      }
    }
  }

  state.restore = async () => {
    for (const r of restores) await r().catch(() => undefined);
  };
  return state;
}

async function disableForeignKeys(
  target: Target,
  ctx: JobRunnerContext,
  warnings: string[],
): Promise<{ disabled: boolean; restore?: () => Promise<void> }> {
  switch (target.handle.engine) {
    case 'mysql':
    case 'mariadb': {
      const conn = target.handle.conn;
      await conn.query('SET SESSION FOREIGN_KEY_CHECKS = 0');
      // UNIQUE_CHECKS off is the other half of the dump-restore idiom: it lets
      // InnoDB insert without a uniqueness probe per row.
      await conn.query('SET SESSION UNIQUE_CHECKS = 0');
      ctx.log('Foreign-key and unique checks disabled for this session.');
      return {
        disabled: true,
        restore: async () => {
          await conn.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
          await conn.query('SET SESSION UNIQUE_CHECKS = 1');
        },
      };
    }
    case 'postgres': {
      const client = target.handle.client;
      try {
        // PLAN §7.4: this needs superuser; detect and fall back rather than
        // failing the whole import.
        await client.query(`SET session_replication_role = 'replica'`);
        ctx.log('session_replication_role = replica: triggers and FK checks are off.');
        return {
          disabled: true,
          restore: async () => {
            await client.query(`SET session_replication_role = 'origin'`);
          },
        };
      } catch (err) {
        warnings.push(
          `Could not disable foreign-key checks (${err instanceof Error ? err.message : String(err)}); ` +
            'this needs a superuser. Constraints will be deferred instead where possible.',
        );
        return { disabled: false };
      }
    }
    case 'sqlite': {
      const db = target.handle.db;
      // PRAGMA foreign_keys is a no-op inside a transaction, so this must run
      // before any BEGIN — which is exactly where prepareSession calls it.
      db.pragma('foreign_keys = OFF');
      ctx.log('PRAGMA foreign_keys = OFF for this connection.');
      return {
        disabled: true,
        restore: async () => {
          db.pragma('foreign_keys = ON');
        },
      };
    }
    case 'mongodb':
      warnings.push('MongoDB has no foreign keys; the setting was ignored.');
      return { disabled: false };
  }
}

async function truncateTarget(target: Target, table: LoadTable): Promise<void> {
  switch (target.handle.engine) {
    case 'postgres':
      await target.handle.client.query(`TRUNCATE TABLE ${quoteQualified([table.schema, table.table], 'postgres')}`);
      return;
    case 'mysql':
    case 'mariadb':
      await target.handle.conn.query(`TRUNCATE TABLE ${quoteQualified([table.schema, table.table], 'mysql')}`);
      return;
    case 'sqlite':
      // SQLite has no TRUNCATE; a bare DELETE is optimized into one internally.
      target.handle.db.exec(`DELETE FROM ${quoteQualified([table.schema, table.table], 'sqlite')}`);
      return;
    case 'mongodb':
      await target.handle.collection.deleteMany({});
      return;
  }
}

async function beginTransaction(
  target: Target,
  ctx: JobRunnerContext,
  warnings: string[],
): Promise<{ began: boolean; commit(): Promise<void>; rollback(): Promise<void> }> {
  switch (target.handle.engine) {
    case 'postgres': {
      const client = target.handle.client;
      await client.query('BEGIN');
      return {
        began: true,
        commit: async () => {
          await client.query('COMMIT');
        },
        rollback: async () => {
          await client.query('ROLLBACK').catch(() => undefined);
        },
      };
    }
    case 'mysql':
    case 'mariadb': {
      const conn = target.handle.conn;
      await conn.beginTransaction();
      return {
        began: true,
        commit: () => conn.commit(),
        rollback: () => conn.rollback().catch(() => undefined),
      };
    }
    case 'sqlite': {
      const db = target.handle.db;
      db.exec('BEGIN');
      return {
        began: true,
        commit: async () => {
          if (db.inTransaction) db.exec('COMMIT');
        },
        rollback: async () => {
          if (db.inTransaction) db.exec('ROLLBACK');
        },
      };
    }
    case 'mongodb':
      // Multi-document transactions need a replica set; a standalone server
      // rejects them, and an import is not worth failing over it.
      warnings.push('MongoDB writes are not wrapped in a transaction (that would require a replica set).');
      ctx.log('Transaction wrapping skipped for MongoDB.');
      return { began: false, commit: async () => undefined, rollback: async () => undefined };
  }
}

// ---------------------------------------------------------------------------
// Target introspection: keys and column checks
// ---------------------------------------------------------------------------

async function primaryKeyOf(target: Target, schema: string | undefined, table: string): Promise<string[]> {
  switch (target.handle.engine) {
    case 'postgres': {
      const ref = quoteQualified([schema, table], 'postgres');
      const res = await target.handle.client.query<{ attname: string }>(
        `SELECT a.attname
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = $1::regclass AND i.indisprimary
          ORDER BY array_position(i.indkey, a.attnum)`,
        [ref],
      );
      return res.rows.map((r) => r.attname);
    }
    case 'mysql':
    case 'mariadb': {
      const [rows] = await target.handle.conn.query<RowDataPacket[]>(
        `SELECT COLUMN_NAME AS c FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
          ORDER BY SEQ_IN_INDEX`,
        [schema ?? null, table] as unknown as QueryValues,
      );
      return rows.map((r) => String((r as Record<string, unknown>).c));
    }
    case 'sqlite': {
      const info = target.handle.db
        .prepare(`SELECT name, pk FROM pragma_table_info(?)`)
        .all(table) as { name: string; pk: number }[];
      return info
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    }
    case 'mongodb':
      return ['_id'];
  }
}

/**
 * Cheapest possible existence check for the table *and* every mapped column:
 * a plan-only select that returns nothing. Runs before any write, so a typo in
 * the mapping fails in milliseconds instead of half way through 10 GB.
 */
async function verifyTarget(target: Target, table: LoadTable): Promise<void> {
  switch (target.handle.engine) {
    case 'postgres': {
      const cols = table.columns.map((c) => quoteIdent(c, 'postgres')).join(', ');
      await target.handle.client.query(
        `SELECT ${cols} FROM ${quoteQualified([table.schema, table.table], 'postgres')} WHERE false`,
      );
      return;
    }
    case 'mysql':
    case 'mariadb': {
      const cols = table.columns.map((c) => quoteIdent(c, 'mysql')).join(', ');
      await target.handle.conn.query(
        `SELECT ${cols} FROM ${quoteQualified([table.schema, table.table], 'mysql')} WHERE 1 = 0`,
      );
      return;
    }
    case 'sqlite': {
      const cols = table.columns.map((c) => quoteIdent(c, 'sqlite')).join(', ');
      target.handle.db
        .prepare(`SELECT ${cols} FROM ${quoteQualified([table.schema, table.table], 'sqlite')} WHERE 0`)
        .all();
      return;
    }
    case 'mongodb':
      // A collection is created on first write; there is nothing to verify.
      return;
  }
}

/**
 * "The relation does not exist", per engine — the only `verifyTarget` failure a
 * dry run with "create the table" ticked is allowed to walk past. Everything
 * else (a bad column, a denied SELECT) must still fail the run.
 */
function isMissingTableError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown };
  // 42P01 = Postgres undefined_table; 1146 / ER_NO_SUCH_TABLE = MySQL.
  if (e.code === '42P01' || e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146) return true;
  // better-sqlite3 has no stable code for this one.
  return typeof e.message === 'string' && /no such table/i.test(e.message);
}

// ---------------------------------------------------------------------------
// Creating the target (§7.1 "CSV / JSON / NDJSON → existing **or new** table")
// ---------------------------------------------------------------------------

/**
 * The wizard's target types (components/transfer/csv-mapping.ts `TARGET_TYPES`)
 * rendered per engine. The mapping screen has already decided every column's
 * type from the sniffed sample, so the DDL is that decision plus a name.
 *
 * `text` is the fallback for anything unrecognised, which is the same direction
 * `coerceValue` errs in — a landing table that holds the value is recoverable,
 * one that rejects it is not.
 */
const CREATE_COLUMN_TYPES: Record<'postgres' | 'mysql' | 'sqlite', Record<string, string>> = {
  postgres: {
    text: 'text',
    integer: 'integer',
    bigint: 'bigint',
    decimal: 'numeric',
    float: 'double precision',
    boolean: 'boolean',
    date: 'date',
    time: 'time',
    timestamp: 'timestamptz',
    json: 'jsonb',
    uuid: 'uuid',
    binary: 'bytea',
  },
  mysql: {
    text: 'TEXT',
    integer: 'INT',
    bigint: 'BIGINT',
    decimal: 'DECIMAL(38,10)',
    float: 'DOUBLE',
    boolean: 'TINYINT(1)',
    date: 'DATE',
    time: 'TIME',
    timestamp: 'DATETIME',
    json: 'JSON',
    uuid: 'CHAR(36)',
    binary: 'LONGBLOB',
  },
  // Affinity, not a type: SQLite stores what it is given (PLAN §6 "dynamic
  // typing"), so these only steer the affinity rules.
  sqlite: {
    text: 'TEXT',
    integer: 'INTEGER',
    bigint: 'INTEGER',
    decimal: 'NUMERIC',
    float: 'REAL',
    boolean: 'INTEGER',
    date: 'TEXT',
    time: 'TEXT',
    timestamp: 'TEXT',
    json: 'TEXT',
    uuid: 'TEXT',
    binary: 'BLOB',
  },
};

/**
 * `CREATE TABLE IF NOT EXISTS` for the mapped columns, or null when the engine
 * has no such thing (Mongo creates a collection on first write).
 *
 * Deliberately minimal: every column is nullable and there is no key or index.
 * A load target is a landing table, and §7.5 is explicit that indexes and
 * constraints belong *after* the data — building them first is both slower and
 * a way to fail half way through on a row order you did not choose.
 */
function createTableSql(
  engine: EngineKind,
  at: { schema?: string; table: string },
  mapping: ColumnMapping[],
): string | null {
  if (engine === 'mongodb' || engine === 'redis') return null;
  const dialect = engine === 'sqlite' ? 'sqlite' : engine === 'postgres' ? 'postgres' : 'mysql';
  const types = CREATE_COLUMN_TYPES[dialect];
  // SQLite has no schema-qualified CREATE beyond an ATTACHed alias, and the
  // quoting module already drops the namespace for it.
  const qualified = quoteQualified([engine === 'sqlite' ? undefined : at.schema, at.table], engine);
  const columns = mapping.map((m) => {
    const name = quoteIdent(m.targetColumn as string, engine);
    return `  ${name} ${types[m.targetType ?? 'text'] ?? types.text}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${qualified} (\n${columns.join(',\n')}\n)`;
}

async function execDdl(target: Target, sql: string): Promise<void> {
  switch (target.handle.engine) {
    case 'postgres':
      await target.handle.client.query(sql);
      return;
    case 'mysql':
    case 'mariadb':
      await target.handle.conn.query(sql);
      return;
    case 'sqlite':
      target.handle.db.exec(sql);
      return;
    case 'mongodb':
      return;
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * PLAN §7.2: "Validate that any user-supplied output path resolves inside an
 * allowed directory" — the same rule applies to reads, or an import would
 * happily copy /etc/passwd into a table. Both mounted roots are allowed.
 */
export function resolveImportPath(candidate: string): string {
  const roots = [CONFIG.exportRoot, CONFIG.sqliteRoot];
  for (const root of roots) {
    try {
      return resolveWithin(root, candidate);
    } catch {
      // Try the next root.
    }
  }
  throw new DbError(
    `Import files must live under ${roots.join(' or ')} — "${candidate}" is outside both.`,
    'PATH_NOT_ALLOWED',
  );
}

// ---------------------------------------------------------------------------
// Re-exports so callers have one import site for the subsystem.
// ---------------------------------------------------------------------------

export { previewCsv, readCsvRows, sniffFile, type CsvDialect } from './csv';
export { loadRows, probeLocalInfile, type LoadResult, type LoadTable } from './fastpath';
export { runSqlScript, streamScriptStatements, type ScriptResult } from './dump-runner';
export type { SqlDialect };
