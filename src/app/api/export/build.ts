/**
 * Shared plumbing for the two export routes (PLAN §7.1–§7.4).
 *
 * `/api/export` (JSON) and `/api/export/download` (form POST, because the
 * browser must own the transfer) accept the SAME `ExportRequest` payload and do
 * the same two things with it, so the validation, the API-request → engine-request
 * translation and the streaming response live here rather than being written
 * twice. This is a plain module, not a route: Next only treats `route.ts` as an
 * endpoint, and a route file may not export anything else.
 *
 * Two destinations, two very different mechanics (§7.3/§7.4):
 *   - `file`     → a JobManager job. A 50 GB dump cannot live inside an HTTP
 *                  request, so the route answers `{ jobId }` immediately.
 *   - `download` → the export is piped straight into the Response body. Nothing
 *                  is ever buffered: backpressure runs from the socket back to
 *                  the database cursor.
 */

import { PassThrough, Readable } from 'node:stream';
import type {
  ExportFormat,
  ExportOptions,
  ExportRequest as ApiExportRequest,
} from '@/lib/api-types';
import { allTables, type TableModel } from '@/lib/schema-model';
import { CONFIG, resolveWithin } from '@/server/config';
import { connectionManager } from '@/server/db/manager';
import { getSchema } from '@/server/db/schema-cache';
import { isDocumentConnector, type Connector } from '@/server/db/types';
import { jobManager, type ExportJobParams, type ExportSource as JobExportSource } from '@/server/jobs';
import { connectionsRepo } from '@/server/store/db';
import { nativeDump } from '@/server/transfer/native';
import {
  contentTypeFor,
  fileExtension,
  runExport,
  type DumpContent,
  type ExportDestination as EngineDestination,
  type ExportRequest as EngineRequest,
  type ExportSourceSpec,
} from '@/server/transfer/export';
import {
  asRecord,
  badRequest,
  oneOf,
  optionalBoolean,
  optionalString,
  requireString,
} from '../lib/respond';

const FORMATS: readonly ExportFormat[] = [
  'csv',
  'tsv',
  'json',
  'ndjson',
  'xlsx',
  'markdown',
  'html',
  'sql',
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function parseExportRequest(raw: unknown): ApiExportRequest {
  const body = asRecord(raw);
  return {
    connectionId: requireString(body, 'connectionId', 'connection id'),
    format: oneOf(body.format, FORMATS, 'format'),
    source: parseSource(body.source),
    destination: parseDestination(body.destination),
    options: parseOptions(body.options),
  };
}

function parseSource(raw: unknown): ApiExportRequest['source'] {
  const s = asRecord(raw, '"source"');
  const kind = oneOf(s.kind, ['query', 'table', 'database', 'server'] as const, 'source.kind');
  switch (kind) {
    case 'query':
      return { kind, sql: requireString(s, 'sql', 'SQL statement') };
    case 'table':
      return {
        kind,
        schema: optionalString(s, 'schema'),
        table: requireString(s, 'table', 'table name'),
        where: optionalString(s, 'where'),
      };
    case 'database': {
      const tables = s.tables;
      if (tables !== undefined && tables !== null && !Array.isArray(tables)) {
        throw badRequest('"source.tables" must be an array of table names.');
      }
      return {
        kind,
        database: requireString(s, 'database', 'database name'),
        tables: Array.isArray(tables)
          ? tables.filter((t): t is string => typeof t === 'string' && t !== '')
          : undefined,
      };
    }
    case 'server':
      return { kind };
  }
}

function parseDestination(raw: unknown): ApiExportRequest['destination'] {
  const d = asRecord(raw, '"destination"');
  const kind = oneOf(d.kind, ['file', 'directory', 'download'] as const, 'destination.kind');
  if (kind === 'download') {
    // `archive` turns the response into a zip holding one file per table — the
    // only coherent way to download a fifty-table CSV export (§7.1).
    const archive = optionalBoolean(d, 'archive');
    return archive === undefined ? { kind } : { kind, archive };
  }
  const requested = requireString(d, 'path', 'destination path');
  // Confined here as well as in the pipeline so a bad path is a 400 the form can
  // show, not a job that fails a second later (§7.2).
  resolveExportTarget(requested);
  return { kind, path: requested };
}

/** §7.2: an export may only be written under the export root. */
export function resolveExportTarget(candidate: string): string {
  try {
    return resolveWithin(CONFIG.exportRoot, candidate);
  } catch {
    throw badRequest(`The export path must stay inside ${CONFIG.exportRoot}.`, {
      code: 'PATH_OUTSIDE_ROOT',
      hint: `Pick a destination under ${CONFIG.exportRoot}; it is the only directory the server may write exports to.`,
    });
  }
}

function parseOptions(raw: unknown): ExportOptions {
  const o = raw === undefined || raw === null ? {} : asRecord(raw, '"options"');
  return {
    compression:
      o.compression === undefined ? 'none' : oneOf(o.compression, ['none', 'gzip'] as const, 'options.compression'),
    structure:
      o.structure === undefined
        ? 'both'
        : oneOf(o.structure, ['both', 'structure-only', 'data-only'] as const, 'options.structure'),
    binaryEncoding:
      o.binaryEncoding === undefined
        ? 'base64'
        : oneOf(o.binaryEncoding, ['base64', 'hex'] as const, 'options.binaryEncoding'),
    nullLiteral: typeof o.nullLiteral === 'string' ? o.nullLiteral : '',
    delimiter: optionalString(o, 'delimiter'),
    header: optionalBoolean(o, 'header') ?? true,
    batchSize: positiveInt(o.batchSize, 'options.batchSize'),
    useNativeTool: optionalBoolean(o, 'useNativeTool'),
    remoteSide: optionalBoolean(o, 'remoteSide'),
    stripDefiner: optionalBoolean(o, 'stripDefiner'),
    pgFormat:
      o.pgFormat === undefined ? undefined : oneOf(o.pgFormat, ['custom', 'plain'] as const, 'options.pgFormat'),
  };
}

function positiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw badRequest(`"${field}" must be a positive number.`);
  }
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// API request → engine request
// ---------------------------------------------------------------------------

function contentOf(req: ApiExportRequest): DumpContent {
  switch (req.options.structure) {
    case 'structure-only':
      return 'structure';
    case 'data-only':
      return 'data';
    default:
      return 'both';
  }
}

/**
 * Only a SQL dump has a DDL half, and DDL needs the canonical model (§4). A
 * query result has no table definition at all, so `structure` is meaningless
 * there and `both` degrades to the INSERTs alone.
 */
function effectiveContent(req: ApiExportRequest): DumpContent {
  const content = contentOf(req);
  if (req.format !== 'sql') return 'both';
  if (req.source.kind === 'query' && content !== 'data') {
    if (content === 'structure') {
      throw badRequest('A query result has no table definition, so "structure-only" cannot be exported as SQL.');
    }
    return 'data';
  }
  return content;
}

async function findTable(
  connectionId: string,
  scope: { namespaces: string[] } | undefined,
  schema: string | undefined,
  table: string,
): Promise<TableModel | undefined> {
  const { model } = await getSchema(connectionId, scope);
  return allTables(model).find((t) => t.name === table && (schema === undefined || t.schema === schema));
}

/**
 * Table definitions are only fetched when something actually needs them — a CSV
 * export does not care, a SQL dump cannot write `CREATE TABLE` without one.
 */
async function tableModelFor(
  connectionId: string,
  schema: string | undefined,
  table: string,
  required: boolean,
): Promise<TableModel | undefined> {
  const scope = schema ? { namespaces: [schema] } : undefined;
  try {
    let match = await findTable(connectionId, scope, schema, table);
    // A narrowed scope can miss when the engine spells its namespaces
    // differently (a MySQL "schema" is a database); one unscoped read settles it.
    if (!match && required && scope) match = await findTable(connectionId, undefined, schema, table);
    if (!match && required) {
      throw badRequest(
        `Table "${schema ? `${schema}.${table}` : table}" is not in the schema, so its DDL cannot be written.`,
      );
    }
    return match;
  } catch (err) {
    // Without the model the export still runs — it just cannot emit CREATE TABLE.
    if (required) throw err;
    return undefined;
  }
}

/** A Mongo filter arrives as JSON text in the same `where` field a SQL source uses. */
function documentFilter(where: string | undefined): unknown {
  if (!where || where.trim() === '') return {};
  try {
    return JSON.parse(where) as unknown;
  } catch {
    throw badRequest('A MongoDB export filter must be a JSON document.');
  }
}

/**
 * Fan the four §7.1 scope levels out into the engine's source list. A database
 * or server export becomes one source per table, which is what makes a single
 * dump file (or one file per table) possible from the same code path.
 */
export async function buildSources(
  connectionId: string,
  connector: Connector,
  req: ApiExportRequest,
): Promise<ExportSourceSpec[]> {
  const needModel = req.format === 'sql' && effectiveContent(req) !== 'data';
  const src = req.source;

  switch (src.kind) {
    case 'query':
      return [{ kind: 'query', sql: src.sql }];

    case 'table': {
      if (isDocumentConnector(connector)) {
        if (!src.schema) {
          throw badRequest('A MongoDB export needs the database name in "source.schema".');
        }
        return [
          {
            kind: 'documents',
            database: src.schema,
            collection: src.table,
            filter: documentFilter(src.where),
            batchSize: req.options.batchSize,
          },
        ];
      }
      const model = await tableModelFor(connectionId, src.schema, src.table, needModel);
      return [{ kind: 'table', schema: src.schema, table: src.table, where: src.where, model }];
    }

    case 'database': {
      if (isDocumentConnector(connector)) {
        const collections = await connector.listCollections(src.database);
        const wanted = src.tables?.length ? new Set(src.tables) : null;
        const picked = collections.filter((c) => !wanted || wanted.has(c.name));
        if (picked.length === 0) throw badRequest(`No collections to export in "${src.database}".`);
        return picked.map((c) => ({
          kind: 'documents',
          database: src.database,
          collection: c.name,
          batchSize: req.options.batchSize,
        }));
      }
      const { model } = await getSchema(connectionId, { database: src.database });
      return tableSources(allTables(model), src.tables, `database "${src.database}"`);
    }

    case 'server': {
      if (isDocumentConnector(connector)) {
        const databases = await connector.listDatabases();
        const out: ExportSourceSpec[] = [];
        for (const db of databases) {
          for (const c of await connector.listCollections(db.name)) {
            out.push({
              kind: 'documents',
              database: db.name,
              collection: c.name,
              batchSize: req.options.batchSize,
            });
          }
        }
        if (out.length === 0) throw badRequest('This server has no collections to export.');
        return out;
      }
      // One introspection of everything the connection can see; the connector
      // decides what "everything" means for its engine (§4 IntrospectScope).
      const { model } = await getSchema(connectionId);
      return tableSources(allTables(model), undefined, 'this server');
    }
  }
}

function tableSources(tables: TableModel[], only: string[] | undefined, what: string): ExportSourceSpec[] {
  const wanted = only?.length ? new Set(only) : null;
  const picked = wanted
    ? tables.filter((t) => wanted.has(t.name) || wanted.has(`${t.schema ?? ''}.${t.name}`))
    : tables;
  if (picked.length === 0) throw badRequest(`No tables to export in ${what}.`);
  return picked.map((t) => ({
    kind: 'table',
    schema: t.schema,
    table: t.name,
    model: t,
    label: t.schema ? `${t.schema}.${t.name}` : t.name,
  }));
}

function engineRequest(
  connector: Connector,
  req: ApiExportRequest,
  sources: ExportSourceSpec[],
  destination: EngineDestination,
): EngineRequest {
  const o = req.options;
  return {
    connector,
    format: req.format,
    sources,
    destination,
    compress: o.compression ?? 'none',
    content: effectiveContent(req),
    // An empty nullLiteral means "use the format's own NULL" — an unquoted CSV
    // field, a JSON null — which is the only lossless option in those formats.
    policy: { binary: o.binaryEncoding, nullText: o.nullLiteral === '' ? null : o.nullLiteral },
    writer: { header: o.header ?? true, delimiter: o.delimiter },
    sql: { binary: o.binaryEncoding, batchSize: o.batchSize },
    fetchSize: o.batchSize,
  };
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function stemFor(req: ApiExportRequest): string {
  switch (req.source.kind) {
    case 'table':
      return req.source.schema ? `${req.source.schema}.${req.source.table}` : req.source.table;
    case 'database':
      return req.source.database;
    case 'server':
      return 'server';
    default:
      return 'query';
  }
}

function safeStem(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 100) : 'export';
}

/** `orders-2026-08-10T14-05-33.csv.gz` — sorted, unique, and obviously ours. */
export function downloadFilename(req: ApiExportRequest, asArchive = false): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
  // The archive's own extension, not the entries': naming a zip `.csv` makes
  // every desktop OS open it with the wrong application.
  const ext = asArchive
    ? 'zip'
    : fileExtension(req.format, req.options.compression ?? 'none');
  return `${safeStem(stemFor(req))}-${stamp}.${ext}`;
}

/**
 * RFC 6266: the plain `filename` stays ASCII for old clients, `filename*` carries
 * the real thing. Quotes and backslashes are stripped so the header cannot be
 * broken out of.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------------------------------------------------------------------------
// Destination: file → a job (§7.3)
// ---------------------------------------------------------------------------

function jobSource(req: ApiExportRequest): JobExportSource {
  const s = req.source;
  switch (s.kind) {
    case 'query':
      return { kind: 'query', sql: s.sql };
    case 'table':
      return { kind: 'table', schema: s.schema, table: s.table, where: s.where };
    case 'database':
      return { kind: 'database', database: s.database, tables: s.tables };
    case 'server':
      return { kind: 'server' };
  }
}

/**
 * Create the job and return its id. Nothing here awaits the export: `create()`
 * writes the row, enqueues and returns, so a 50 GB dump outlives this request
 * (§7.3). Progress reaches the drawer over the WebSocket `jobs` channel.
 */
export function startExportJob(req: ApiExportRequest, path: string): string {
  const absolute = resolveExportTarget(path);
  // A directory destination writes one file per table into `absolute` (§7.1);
  // a file destination writes every table into that one file.
  const perTable = req.destination.kind === 'directory';
  const params: ExportJobParams = {
    kind: 'export',
    source: jobSource(req),
    format: req.format,
    // The real shape, not always 'file': the persisted row is what the drawer
    // and any later inspection read, and `perTable` lives only in the closure
    // below — so recording 'file' for a directory export makes the row lie.
    destination: { kind: perTable ? 'directory' : 'file', path: absolute },
    options: req.options,
  };
  const title = perTable
    ? `Export ${stemFor(req)} → ${absolute}/ (one file per table)`
    : `Export ${stemFor(req)} → ${absolute}`;

  const job = jobManager.create('export', title, req.connectionId, params, async (ctx) => {
    ctx.progress({ phase: 'planning' });

    // §7.2: a full dump prefers the native tool when one is present — definers,
    // collations, partitions and extensions are all things a hand-rolled dumper
    // gets subtly wrong. `nativeDump` returns `{ used: 'builtin' }` instead of
    // throwing whenever native is not the right engine for this request (a
    // converted format, a filtered table, a missing binary), which is exactly
    // the fallback below. A native run that *fails* still throws, so a broken
    // dump is never mistaken for a good one. JobContext satisfies ToolContext
    // structurally, so cancel reaches the child process unchanged.
    // Native tools emit one dump file, so they cannot serve a per-table request:
    // pointing pg_dump at `absolute` would write a single file where the user
    // asked for a directory of them. The built-in engine handles this scope.
    const config = perTable ? null : connectionsRepo.get(req.connectionId);
    if (config) {
      const outcome = await nativeDump(
        config,
        {
          source: params.source,
          format: req.format,
          outPath: absolute,
          options: req.options,
          serverVersion: connectionManager.status(req.connectionId)?.serverVersion,
        },
        ctx,
      );
      if (outcome.used === 'native') {
        for (const warning of outcome.warnings) ctx.log(`Warning: ${warning}`);
        ctx.progress({ phase: 'done', tablesDone: 1, tablesTotal: 1, bytesOut: outcome.bytesOut });
        ctx.log(`${outcome.tool} wrote ${outcome.bytesOut} byte(s) to ${outcome.outputPath ?? absolute}`);
        return outcome;
      }
      ctx.log(`Built-in streaming engine: ${outcome.reason}`);
    }

    const connector = await connectionManager.acquire(req.connectionId);
    const sources = await buildSources(req.connectionId, connector, req);
    ctx.progress({ phase: 'starting', tablesTotal: sources.length });
    ctx.log(`Exporting ${sources.length} source(s) as ${req.format} to ${absolute}`);
    const result = await runExport(
      engineRequest(connector, req, sources, {
        kind: perTable ? 'directory' : 'file',
        path: absolute,
        root: CONFIG.exportRoot,
        overwrite: true,
      }),
      {
        signal: ctx.signal,
        log: (line) => ctx.log(line),
        onProgress: (p) => ctx.progress(p),
      },
    );
    ctx.log(`Wrote ${result.rowsDone} row(s), ${result.bytesOut} byte(s) to ${result.files.join(', ')}`);
    return result;
  });

  return job.id;
}

// ---------------------------------------------------------------------------
// Destination: download → straight into the Response body (§7.4)
// ---------------------------------------------------------------------------

/**
 * Never buffered. The engine writes into a PassThrough whose web-stream view is
 * the Response body, so a slow browser pauses the writer, which pauses the row
 * source, which stops pulling from the database cursor.
 *
 * The first chunk is awaited before the Response is constructed: an export that
 * fails on its very first round trip (a bad table, a syntax error) then still
 * becomes a JSON `ApiError` instead of a 200 with an empty file. After that
 * first chunk the headers are gone, so a later failure can only destroy the body
 * — which is exactly what a truncated download should look like.
 */
export async function streamExportResponse(
  req: ApiExportRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const connector = await connectionManager.acquire(req.connectionId);
  const sources = await buildSources(req.connectionId, connector, req);

  const produced = new PassThrough();
  const body = new PassThrough({ highWaterMark: 1 << 20 });

  let started = false;
  let markStarted: () => void = () => undefined;
  const firstChunk = new Promise<void>((resolve) => {
    markStarted = () => {
      if (started) return;
      started = true;
      resolve();
    };
  });

  // `pipe` carries the backpressure; the extra listeners only observe. Both are
  // attached in this tick, before the stream can start flowing on the next one.
  produced.pipe(body);
  produced.on('data', () => markStarted());
  produced.on('end', () => markStarted());
  produced.on('error', (err: Error) => body.destroy(err));

  // A zip download is the only coherent shape for many tables in a format that
  // holds one table per file; the engine writes one entry per source into it.
  const asArchive = req.destination.kind === 'download' && req.destination.archive === true;
  const run = runExport(
    engineRequest(
      connector,
      req,
      sources,
      asArchive
        ? { kind: 'archive', stream: produced }
        : { kind: 'stream', stream: produced, end: true },
    ),
    { signal },
  );

  const failed = run.then(
    () => undefined,
    (err: unknown) => {
      // Before the first chunk this rejection wins the race and becomes an
      // ApiError; after it, destroying the body is all a truncated download can
      // be told.
      body.destroy(err instanceof Error ? err : new Error(String(err)));
      throw err;
    },
  );
  // Nothing else awaits `run` once the response is returned; without this the
  // rejection would be reported as unhandled after `failed` has been raced away.
  failed.catch(() => undefined);

  await Promise.race([firstChunk, failed]);

  return new Response(Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>, {
    status: 200,
    headers: {
      'content-type': asArchive
        ? 'application/zip'
        : contentTypeFor(req.format, req.options.compression ?? 'none'),
      'content-disposition': contentDisposition(downloadFilename(req, asArchive)),
      'cache-control': 'no-store',
      // The length is unknowable up front; say so rather than letting a proxy guess.
      'x-content-type-options': 'nosniff',
    },
  });
}
