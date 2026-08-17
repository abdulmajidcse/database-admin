/**
 * `runExport` — the JobManager runner for the built-in export engine
 * (PLAN §7.1 scope levels, §7.3 jobs, §7.4 pipeline, §7.5 consistency).
 *
 * It reports `{ phase, tablesDone, tablesTotal, rowsDone, bytesOut, etaMs }`
 * exactly as the §7.3 `Job.progress` shape expects, honours `ctx.signal` (which
 * also cancels the DB-side query, not just the local read), and — the point of
 * §7.5 — runs a multi-table export inside ONE `REPEATABLE READ` transaction on a
 * pinned session, so the dump is a single point in time instead of a set of
 * tables from different ones that restores into FK violations.
 *
 * The caller supplies an already-open connector; this module never resolves
 * connections or touches the vault (§8.1: the layers above hand us something
 * usable).
 *
 * Server-side only: no React, no Next (§11).
 */

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Duplex, Writable } from 'node:stream';
import { SQL_ENGINES, type EngineKind, type TableModel } from '../../../lib/schema-model';
import type { ColumnMeta, FindOpts, Namespace } from '../../../lib/results';
import type { Row } from '../../../lib/wire';
import {
  isDocumentConnector,
  isSqlConnector,
  type Connector,
  type DocumentConnector,
  type SqlConnector,
} from '../../db/types';
import { quoteIdent, quoteQualified } from '../../db/sql/quote';
import {
  XlsxWriter,
  createWriter,
  fileExtension,
  type ExportFormat,
  type ValuePolicy,
  type WriterOptions,
} from './writers';
import {
  createSqlWriter,
  renderDumpPostlude,
  renderDumpPrelude,
  type DumpContent,
  type SqlWriterOptions,
} from './sql-writer';
import {
  attachWriter,
  finishWriter,
  openSink,
  pumpRows,
  type CompressionKind,
  type SinkHandle,
  type SinkSpec,
} from './pipeline';
import { createZipArchive, type ZipArchive } from './zip';
import { INCOMPLETE_MARKER } from '../incomplete';

export * from './writers';
export * from './sql-writer';
export * from './pipeline';

// ---------------------------------------------------------------------------
// Job-facing shapes (§7.3)
// ---------------------------------------------------------------------------

export interface ExportProgress {
  phase: string;
  tablesDone: number;
  tablesTotal: number;
  rowsDone: number;
  bytesOut: number;
  etaMs?: number;
}

/**
 * What a JobManager runner is handed. Structural on purpose: any job context
 * carrying these three members works, and nothing here imports the manager.
 */
export interface ExportRunContext {
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  log?: (line: string) => void;
}

export interface ExportResult {
  format: ExportFormat;
  tablesTotal: number;
  tablesDone: number;
  rowsDone: number;
  bytesOut: number;
  /** Absolute paths written, for file/directory destinations. */
  files: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface TableSourceSpec {
  kind: 'table';
  schema?: string;
  table: string;
  /** Subset and order of columns; defaults to the model's order. */
  columns?: string[];
  /** Raw WHERE from the filter bar — a filtered subset export (§7.1). */
  where?: string;
  orderBy?: { column: string; direction: 'asc' | 'desc' }[];
  /** Canonical model: required for a SQL dump's DDL, otherwise an optimisation. */
  model?: TableModel;
  label?: string;
}

export interface QuerySourceSpec {
  kind: 'query';
  sql: string;
  /**
   * Result metadata. Pass it whenever you have it (the editor always does):
   * without it the query must be run once with `maxRows: 1` just to learn the
   * column shape, since `stream()` yields rows only.
   */
  columns?: ColumnMeta[];
  params?: unknown[];
  database?: string;
  schema?: string;
  /** Result-tab name — and, for a SQL export, the INSERT target table. */
  label?: string;
}

/** Any pre-existing cursor — a Mongo cursor, a cross-engine copy source (§7.6). */
export interface RowsSourceSpec {
  kind: 'rows';
  columns: ColumnMeta[];
  rows: AsyncIterable<Row[]>;
  label?: string;
  rowEstimate?: number;
}

export interface DocumentSourceSpec {
  kind: 'documents';
  database: string;
  collection: string;
  filter?: unknown;
  find?: FindOpts;
  /** Documents per round trip. */
  batchSize?: number;
  label?: string;
}

export type ExportSourceSpec =
  | TableSourceSpec
  | QuerySourceSpec
  | RowsSourceSpec
  | DocumentSourceSpec;

export type ExportDestination =
  | { kind: 'file'; path: string; root?: string; overwrite?: boolean }
  /** One file per source, named after it — the natural shape for many tables. */
  | { kind: 'directory'; path: string; root?: string; overwrite?: boolean }
  /**
   * One ZIP entry per source, written to `stream`. The directory destination's
   * shape for a download: a browser gets one response, and CSV keeps one header
   * per table instead of burying the second one mid-file.
   */
  | { kind: 'archive'; stream: Writable; level?: number }
  | { kind: 'stream'; stream: Writable; end?: boolean };

export interface ExportRequest {
  /** An open connector. Never resolved here (§8.1). */
  connector: Connector;
  format: ExportFormat;
  sources: ExportSourceSpec[];
  destination: ExportDestination;
  compress?: CompressionKind;
  gzipLevel?: number;
  /** Binary encoding, NULL literal, … (§7.4). */
  policy?: Partial<ValuePolicy>;
  /** Presentation knobs handed to the writer. */
  writer?: Omit<WriterOptions, 'columns' | 'policy' | 'title'>;
  /** SQL-dump knobs. `engine`, `columns`, `table` and `model` are filled in. */
  sql?: Omit<SqlWriterOptions, 'engine' | 'columns' | 'table' | 'model' | 'content'>;
  /** Wrap a single-file SQL dump in one transaction. On by default. */
  dumpTransaction?: boolean;
  /**
   * Emit `SET FOREIGN_KEY_CHECKS=0` / `PRAGMA foreign_keys=OFF` around a SQL
   * dump. Off by default: constraints are already created after the data (§7.5),
   * so the restore does not need it.
   */
  disableForeignKeyChecks?: boolean;
  /** structure-only / data-only / both (§7.1). Only the SQL format has DDL. */
  content?: DumpContent;
  /**
   * Wrap every source in one REPEATABLE READ transaction on a pinned session
   * (§7.5). Defaults to on for multi-source exports. The connector honours it
   * through `openSession()` + `sessionId` on each `stream()` call.
   */
  consistentSnapshot?: boolean;
  /** Rows per round trip from the driver's cursor. */
  fetchSize?: number;
  keepPartial?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MYSQL_LIKE = new Set<EngineKind>(['mysql', 'mariadb']);

function cancelledError(): Error {
  const err = new Error('Export cancelled');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

/** Column metadata straight from the canonical model (§4). */
export function columnMetaFromModel(model: TableModel, only?: string[]): ColumnMeta[] {
  const ordered = model.columns.slice().sort((a, b) => a.position - b.position);
  const picked = only?.length
    ? only.map((name) => {
        const col = ordered.find((c) => c.name === name);
        if (!col) throw new Error(`Column "${name}" does not exist on ${model.name}`);
        return col;
      })
    : ordered;
  return picked.map((c) => ({
    name: c.name,
    typeName: c.type.raw,
    base: c.type.base,
    nullable: c.nullable,
    table: model.name,
    schema: model.schema,
    isKey: model.primaryKey.includes(c.name),
  }));
}

function sanitizeFileStem(label: string): string {
  // The label becomes a filename; strip anything that could walk out of the
  // directory before it ever reaches resolveWithin (§7.2).
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'export';
}

function sourceLabel(spec: ExportSourceSpec, index: number): string {
  if (spec.label) return spec.label;
  switch (spec.kind) {
    case 'table':
      return spec.schema ? `${spec.schema}.${spec.table}` : spec.table;
    case 'documents':
      return `${spec.database}.${spec.collection}`;
    case 'query':
      return `query_${index + 1}`;
    default:
      return `result_${index + 1}`;
  }
}

async function writeText(sink: Writable, text: string): Promise<void> {
  if (text.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    sink.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

/** An empty batch stream, for structure-only exports that must not read data. */
async function* noRows(): AsyncGenerator<Row[]> {
  // Intentionally yields nothing: a structure-only dump issues no data query.
}

/**
 * Cancelling has to reach the server: closing the socket leaves the query
 * running (§6/§7.3), so an abort also fires the connector's `cancel(runId)`.
 */
function withServerCancel(
  connector: SqlConnector,
  runId: string,
  signal: AbortSignal | undefined,
  batches: AsyncIterable<Row[]>,
): AsyncIterable<Row[]> {
  if (!signal) return batches;
  return (async function* forward(): AsyncGenerator<Row[]> {
    const onAbort = (): void => {
      void connector.cancel(runId).catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const batch of batches) yield batch;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  })();
}

function buildTableSelect(
  engine: EngineKind,
  spec: TableSourceSpec,
  columns: string[],
): string {
  const target = quoteQualified([engine === 'sqlite' ? undefined : spec.schema, spec.table], engine);
  const list = columns.map((c) => quoteIdent(c, engine)).join(', ');
  let sql = `SELECT ${list} FROM ${target}`;
  // The WHERE is raw text the user typed in the filter bar (§7.1 filtered
  // export); identifiers we generate still go through the quoting module.
  if (spec.where && spec.where.trim().length > 0) sql += ` WHERE ${spec.where}`;
  if (spec.orderBy && spec.orderBy.length > 0) {
    const order = spec.orderBy
      .map((o) => `${quoteIdent(o.column, engine)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`)
      .join(', ');
    sql += ` ORDER BY ${order}`;
  }
  return sql;
}

/** Page a collection into `Row[]` batches — the document equivalent of a cursor. */
async function* documentBatches(
  connector: DocumentConnector,
  ns: Namespace,
  spec: DocumentSourceSpec,
  signal?: AbortSignal,
): AsyncGenerator<Row[]> {
  const batchSize = Math.max(1, spec.batchSize ?? 500);
  const find = spec.find ?? {};
  const hardLimit = find.limit;
  let skip = find.skip ?? 0;
  let fetched = 0;
  for (;;) {
    throwIfAborted(signal);
    const remaining = hardLimit === undefined ? batchSize : Math.min(batchSize, hardLimit - fetched);
    if (remaining <= 0) return;
    const page = await connector.find(ns, spec.filter ?? {}, { ...find, skip, limit: remaining });
    if (page.rows.length === 0) return;
    yield page.rows;
    fetched += page.rows.length;
    skip += page.rows.length;
    if (page.rows.length < remaining) return;
  }
}

interface ResolvedSource {
  label: string;
  columns: ColumnMeta[];
  rows: AsyncIterable<Row[]>;
  model?: TableModel;
  table?: { schema?: string; name: string };
  rowEstimate?: number;
}

interface ResolveOptions {
  connector: Connector;
  engine: EngineKind;
  sessionId?: string;
  signal?: AbortSignal;
  fetchSize?: number;
  /** False for structure-only SQL exports: no data query is issued at all. */
  wantData: boolean;
  /**
   * Drop generated columns. A stored/virtual column cannot appear in an INSERT
   * column list, so a dump that includes one fails on restore (§7.5).
   */
  excludeGenerated: boolean;
}

async function resolveSource(
  spec: ExportSourceSpec,
  index: number,
  opts: ResolveOptions,
): Promise<ResolvedSource> {
  const label = sourceLabel(spec, index);

  if (spec.kind === 'rows') {
    return { label, columns: spec.columns, rows: spec.rows, rowEstimate: spec.rowEstimate };
  }

  if (spec.kind === 'documents') {
    if (!isDocumentConnector(opts.connector)) {
      throw new Error('A document source needs a document connector');
    }
    const ns: Namespace = { database: spec.database, collection: spec.collection };
    // One cheap probe for the column shape; documents usually have exactly one.
    const probe = await opts.connector.find(ns, spec.filter ?? {}, { ...(spec.find ?? {}), limit: 1, skip: 0 });
    return {
      label,
      columns: probe.columns,
      rows: opts.wantData ? documentBatches(opts.connector, ns, spec, opts.signal) : noRows(),
    };
  }

  if (!isSqlConnector(opts.connector)) {
    throw new Error(`A ${spec.kind} source needs a SQL connector`);
  }
  const sql = opts.connector;
  const runId = `export-${randomUUID()}`;

  if (spec.kind === 'query') {
    const columns =
      spec.columns ??
      (
        await sql.query(spec.sql, {
          maxRows: 1,
          sessionId: opts.sessionId,
          signal: opts.signal,
          database: spec.database,
          schema: spec.schema,
          params: spec.params,
        })
      ).columns;
    const rows = opts.wantData
      ? withServerCancel(
          sql,
          runId,
          opts.signal,
          sql.stream(spec.sql, {
            runId,
            sessionId: opts.sessionId,
            signal: opts.signal,
            maxRows: opts.fetchSize,
            database: spec.database,
            schema: spec.schema,
            params: spec.params,
          }),
        )
      : noRows();
    return { label, columns, rows };
  }

  // A table source.
  let columns: ColumnMeta[];
  if (spec.model) {
    const wanted =
      spec.columns ??
      spec.model.columns
        .slice()
        .sort((a, b) => a.position - b.position)
        .filter((c) => !(opts.excludeGenerated && c.generatedExpression))
        .map((c) => c.name);
    columns = columnMetaFromModel(spec.model, wanted);
  } else {
    // No model: one bounded read tells us the shape. The names it returns then
    // become the explicit SELECT list, so row order and metadata cannot drift.
    const probe = await sql.readTable({
      schema: spec.schema,
      table: spec.table,
      columns: spec.columns,
      offset: 0,
      limit: 1,
      where: spec.where,
    });
    columns = probe.columns;
  }

  const selectSql = buildTableSelect(
    opts.engine,
    spec,
    columns.map((c) => c.name),
  );
  const rows = opts.wantData
    ? withServerCancel(
        sql,
        runId,
        opts.signal,
        sql.stream(selectSql, {
          runId,
          sessionId: opts.sessionId,
          signal: opts.signal,
          maxRows: opts.fetchSize,
          schema: spec.schema,
        }),
      )
    : noRows();

  return {
    label,
    columns,
    rows,
    model: spec.model,
    table: { schema: spec.schema ?? spec.model?.schema, name: spec.table },
    rowEstimate: spec.model?.rowEstimate,
  };
}

// ---------------------------------------------------------------------------
// Consistency: one repeatable-read snapshot for the whole export (§7.5)
// ---------------------------------------------------------------------------

/**
 * Pin a session and open a snapshot transaction on it. Every `stream()` call
 * then passes that `sessionId`, so all tables are read at one point in time.
 *
 * The isolation statement differs by engine and, importantly, so does its
 * placement: MySQL's `SET TRANSACTION` applies to the *next* transaction, so it
 * must precede BEGIN, while Postgres only accepts it as the first statement
 * *inside* one. SQLite needs nothing — a deferred transaction in WAL mode is
 * already a snapshot from its first read.
 */
export async function beginSnapshot(connector: SqlConnector): Promise<string> {
  const session = await connector.openSession();
  try {
    if (MYSQL_LIKE.has(connector.kind)) {
      await connector.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', {
        sessionId: session.id,
      });
    }
    await connector.sessionCommand(session.id, 'begin');
    if (connector.kind === 'postgres') {
      await connector.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', {
        sessionId: session.id,
      });
    }
    return session.id;
  } catch (err) {
    await connector.closeSession(session.id).catch(() => undefined);
    throw err;
  }
}

async function endSnapshot(connector: SqlConnector, sessionId: string, commit: boolean): Promise<void> {
  try {
    await connector.sessionCommand(sessionId, commit ? 'commit' : 'rollback');
  } catch {
    // A failed rollback on a dying session must not mask the export's error.
  } finally {
    await connector.closeSession(sessionId).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// runExport
// ---------------------------------------------------------------------------

async function writeIncompleteMarker(dir: string, err: unknown): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err);
  await writeFile(
    path.join(dir, INCOMPLETE_MARKER),
    `This export did not finish, so the files here are only part of the database.\n` +
      `Do not restore from it.\n\nReason: ${reason}\n`,
    'utf8',
  );
}

export async function runExport(
  request: ExportRequest,
  ctx: ExportRunContext = {},
): Promise<ExportResult> {
  const startedAt = Date.now();
  const { connector, format, sources, destination } = request;
  if (sources.length === 0) throw new Error('runExport: at least one source is required');

  const engine = connector.kind;
  const compress = request.compress ?? 'none';
  const content = request.content ?? 'both';
  const signal = ctx.signal;
  // Both destinations give each source its own file; they differ only in where
  // those files land, so the whole per-source loop below is shared.
  const perFile = destination.kind === 'directory' || destination.kind === 'archive';

  if (format === 'sql' && !SQL_ENGINES.includes(engine)) {
    // Identifier/literal quoting is per SQL engine; there is no correct answer
    // for Redis or Mongo (see ../../db/sql/quote).
    throw new Error(`A SQL dump is not available for ${engine}`);
  }
  if (format === 'json' && sources.length > 1 && !perFile) {
    // Concatenated JSON arrays are not a JSON document; refuse instead of
    // writing a file no parser accepts.
    throw new Error(
      'A JSON array export of several sources needs a directory destination — or use ndjson.',
    );
  }
  if ((format === 'csv' || format === 'tsv') && sources.length > 1 && !perFile) {
    // The same defect as the JSON case above, but it used to be written
    // silently: one delimited file carries one header and one column shape, so
    // concatenating tables buries a second header mid-file and no parser will
    // read it back. Refusing costs the user a re-run; not refusing costs them a
    // "successful" export they discover is unusable at restore time.
    const label = format.toUpperCase();
    throw new Error(
      `A ${label} export covers one table at a time. Export as SQL or XLSX to hold every table ` +
        `in one file, or pick a directory or archive destination to get one ${label} per table.`,
    );
  }

  const tablesTotal = sources.length;
  let tablesDone = 0;
  let rowsDone = 0;
  let bytesClosed = 0;
  let currentSink: SinkHandle | null = null;
  let archive: ZipArchive | null = null;
  const files: string[] = [];

  const rowsExpected = sources.reduce((sum, s) => {
    if (s.kind === 'table' && s.model?.rowEstimate) return sum + s.model.rowEstimate;
    if (s.kind === 'rows' && s.rowEstimate) return sum + s.rowEstimate;
    return sum;
  }, 0);

  let lastEmit = 0;
  // For an archive the only number that means anything to the user is the size
  // of the file they receive; summing the entries would report the uncompressed
  // total and overstate a compressed archive substantially.
  const bytesOut = (): number =>
    archive ? archive.bytesWritten() : bytesClosed + (currentSink?.bytesWritten() ?? 0);
  const report = (phase: string, force = false): void => {
    if (!ctx.onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    const elapsed = now - startedAt;
    const etaMs =
      rowsExpected > 0 && rowsDone > 0 && rowsDone < rowsExpected
        ? Math.round((elapsed / rowsDone) * (rowsExpected - rowsDone))
        : undefined;
    ctx.onProgress({ phase, tablesDone, tablesTotal, rowsDone, bytesOut: bytesOut(), etaMs });
  };

  throwIfAborted(signal);

  // §7.5 Consistency: multi-source exports read from one snapshot by default.
  const wantSnapshot =
    request.consistentSnapshot ??
    (sources.length > 1 && sources.some((s) => s.kind === 'table' || s.kind === 'query'));
  let sessionId: string | undefined;
  if (wantSnapshot && isSqlConnector(connector) && connector.capabilities.has('transactions')) {
    report('snapshot', true);
    sessionId = await beginSnapshot(connector);
    ctx.log?.(`Opened a repeatable-read snapshot for ${tablesTotal} source(s)`);
  } else if (wantSnapshot) {
    // Worth saying out loud: without a snapshot the tables come from different
    // points in time and can restore into FK violations (§7.5).
    ctx.log?.(`${engine} cannot pin a snapshot session; tables are read independently`);
  }

  const resolveOptions: Omit<ResolveOptions, 'wantData'> = {
    connector,
    engine,
    sessionId,
    signal,
    fetchSize: request.fetchSize,
    excludeGenerated: format === 'sql',
  };
  const wantData = !(format === 'sql' && content === 'structure');

  const makeWriter = (resolved: ResolvedSource): Duplex => {
    if (format === 'sql') {
      return createSqlWriter({
        ...(request.sql ?? {}),
        engine,
        columns: resolved.columns,
        table: resolved.table ?? { name: resolved.label },
        model: resolved.model,
        content,
      });
    }
    return createWriter(format, {
      ...(request.writer ?? {}),
      columns: resolved.columns,
      policy: request.policy,
      title: resolved.label,
    });
  };

  /**
   * A filesystem-safe stem that has not been used yet in this export.
   *
   * `sanitizeFileStem` is lossy — `my table` and `my_table` are both legal table
   * names in MySQL and SQLite and both become `my_table`. Left alone, the second
   * overwrites the first for a directory destination (or becomes a duplicate zip
   * entry that most tools silently overwrite), so a table disappears from a
   * "whole database" export that still reports success.
   */
  const usedStems = new Set<string>();
  const uniqueStem = (label: string): string => {
    const base = sanitizeFileStem(label);
    if (!usedStems.has(base)) {
      usedStems.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!usedStems.has(candidate)) {
        usedStems.add(candidate);
        ctx.log?.(`Two sources share the file name "${base}"; wrote this one as "${candidate}"`);
        return candidate;
      }
    }
  };

  const sinkSpecFor = (label: string): SinkSpec => {
    if (destination.kind === 'stream') {
      return { kind: 'stream', stream: destination.stream, end: destination.end };
    }
    if (destination.kind === 'file') {
      return {
        kind: 'file',
        path: destination.path,
        root: destination.root,
        overwrite: destination.overwrite,
      };
    }
    if (destination.kind === 'archive') {
      // No gzip layer inside the entry: the archive already deflates, and a
      // `users.csv.gz` inside a .zip is a second unwrap for no gain.
      const entryName = `${uniqueStem(label)}.${fileExtension(format, 'none')}`;
      return { kind: 'stream', stream: archive!.entry(entryName), end: true };
    }
    const name = `${uniqueStem(label)}.${fileExtension(format, compress)}`;
    return {
      kind: 'file',
      path: path.join(destination.path, name),
      root: destination.root,
      overwrite: destination.overwrite,
    };
  };

  const sinkOptions = {
    // See sinkSpecFor: an archive entry is deflated by the archive itself.
    compress: destination.kind === 'archive' ? ('none' as CompressionKind) : compress,
    gzipLevel: request.gzipLevel,
    keepPartial: request.keepPartial,
  };

  const runSource = async (
    spec: ExportSourceSpec,
    index: number,
    sink: SinkHandle,
    shared: { writer: XlsxWriter; attached: Promise<void> } | null,
  ): Promise<void> => {
    throwIfAborted(signal);
    const resolved = await resolveSource(spec, index, { ...resolveOptions, wantData });
    ctx.log?.(`Exporting ${resolved.label}`);
    report(`export ${resolved.label}`, true);

    let writer: Duplex;
    if (shared) {
      // One workbook, one sheet per source (§7.1 schema-level scope). The
      // writer was constructed with `deferSheet`, so every source — including
      // the first — opens its own sheet here.
      shared.writer.startSheet(resolved.label, resolved.columns);
      writer = shared.writer;
    } else {
      writer = makeWriter(resolved);
    }

    const before = rowsDone;
    const written = await pumpRows({
      source: resolved.rows,
      writer,
      sink,
      signal,
      endWriter: shared === null,
      onRows: (n) => {
        rowsDone = before + n;
        report(`export ${resolved.label}`);
      },
    });
    rowsDone = before + written;
    tablesDone += 1;
    report(`export ${resolved.label}`, true);
  };

  try {
    if (destination.kind === 'archive') {
      // Opened here rather than beside `perFile` so an export refused by the
      // format checks above never leaves a half-built archive — and never leaves
      // the HTTP response it pipes into waiting for a central directory.
      archive = await createZipArchive(destination.stream, { level: destination.level });
    }
    if (perFile) {
      const perFileWrapper = {
        transaction: request.dumpTransaction ?? true,
        disableForeignKeyChecks: request.disableForeignKeyChecks ?? false,
      };
      // One sink per source; each closes before the next opens.
      for (let i = 0; i < sources.length; i++) {
        const sink = await openSink(sinkSpecFor(sourceLabel(sources[i], i)), sinkOptions);
        currentSink = sink;
        try {
          // Each per-table script is restored on its own, so each needs its own
          // wrapper — without it a restore failing partway through one file
          // leaves that table half-loaded.
          if (format === 'sql') {
            await writeText(
              sink.head,
              renderDumpPrelude(engine, { ...perFileWrapper, header: `dbadmin export (${engine})` }),
            );
          }
          await runSource(sources[i], i, sink, null);
          if (format === 'sql') await writeText(sink.head, renderDumpPostlude(engine, perFileWrapper));
          await sink.close();
        } catch (err) {
          await sink.abort(err);
          throw err;
        } finally {
          bytesClosed += sink.bytesWritten();
          currentSink = null;
          if (sink.path) files.push(sink.path);
        }
      }
      // Only now is the central directory correct; until it is written the bytes
      // on the wire are not yet a readable archive.
      if (archive) await archive.finalize();
    } else {
      const sink = await openSink(sinkSpecFor(sourceLabel(sources[0], 0)), sinkOptions);
      currentSink = sink;
      let shared: { writer: XlsxWriter; attached: Promise<void> } | null = null;
      const wrapper = {
        transaction: request.dumpTransaction ?? true,
        disableForeignKeyChecks: request.disableForeignKeyChecks ?? false,
      };
      try {
        if (format === 'xlsx') {
          const writer = new XlsxWriter({
            ...(request.writer ?? {}),
            columns: [],
            policy: request.policy,
            deferSheet: true,
          });
          shared = { writer, attached: attachWriter(writer, sink) };
        }
        if (format === 'sql') {
          await writeText(
            sink.head,
            renderDumpPrelude(engine, { ...wrapper, header: `dbadmin export (${engine})` }),
          );
        }

        for (let i = 0; i < sources.length; i++) {
          await runSource(sources[i], i, sink, shared);
        }

        if (shared) await finishWriter(shared.writer, shared.attached);
        if (format === 'sql') {
          await writeText(sink.head, renderDumpPostlude(engine, wrapper));
        }
        await sink.close();
      } catch (err) {
        await sink.abort(err);
        throw err;
      } finally {
        bytesClosed += sink.bytesWritten();
        currentSink = null;
        if (sink.path) files.push(sink.path);
      }
    }

    if (sessionId && isSqlConnector(connector)) await endSnapshot(connector, sessionId, true);
    report('done', true);
    return {
      format,
      tablesTotal,
      tablesDone,
      rowsDone,
      bytesOut: bytesOut(),
      files,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (sessionId && isSqlConnector(connector)) await endSnapshot(connector, sessionId, false);
    if (archive && destination.kind === 'archive') {
      // A failed archive must NOT be finalized: a readable zip holding half the
      // tables is the worst outcome, because it looks like a complete backup.
      // Destroying the stream truncates the download, which is recognisably
      // broken to both the browser and the user.
      destination.stream.destroy(err instanceof Error ? err : new Error(String(err)));
    }
    if (destination.kind === 'directory') {
      // The same hazard, and a directory cannot be truncated the way a stream
      // can: the tables written before the failure stay on disk, and a directory
      // of CSVs is exactly what a bundle import consumes. Without this marker,
      // half a database restores as though it were all of it. Best-effort — if
      // the directory is what broke, there is nothing further to do here.
      await writeIncompleteMarker(destination.path, err).catch(() => undefined);
    }
    ctx.log?.(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
