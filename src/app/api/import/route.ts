/**
 * /api/import — CSV/JSON/NDJSON loads and `.sql`/dump restores (PLAN §7.4, §7.5).
 *
 * Always a job, never inline (§7.3): a 10 GB CSV takes far longer than any HTTP
 * timeout, and the wizard wants live progress, a cancel button and an error
 * report it can reopen. The route answers `{ jobId }` and the runner streams the
 * file into the engine's fast path (`COPY`, `LOAD DATA`, `bulkWrite`, a
 * prepared-statement loop) without ever buffering it.
 *
 * A `.sql`/dump source is a *restore*, so it becomes a `restore` job rather than
 * an `import` one — §7.5 gives it its own knobs (definers, ownership, ordering)
 * and the drawer labels it accordingly.
 *
 * Thin route (§11): validate → call the server layer → serialize.
 */

import path from 'node:path';
import type { ColumnMapping, ImportOptions, ImportRequest } from '@/lib/api-types';
import { connectionManager } from '@/server/db/manager';
import { jobManager, type ImportJobParams, type RestoreJobParams } from '@/server/jobs';
import { connectionsRepo } from '@/server/store/db';
import { nativeRestore } from '@/server/transfer/native';
import { resolveImportPath, runImport, type ImportParams } from '@/server/transfer/import';
import type { CsvDialect } from '@/server/transfer/import/csv';
import {
  asRecord,
  badRequest,
  handle,
  ok,
  oneOf,
  optionalBoolean,
  optionalString,
  readJson,
  requireString,
} from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_KINDS = ['csv', 'json', 'ndjson', 'sql', 'dump'] as const;
const CONFLICTS = ['insert', 'upsert', 'replace', 'ignore'] as const;

type SourceKind = (typeof SOURCE_KINDS)[number];

/** Wizard extras `runImport` understands on top of the frozen `ImportRequest`. */
interface ParsedImport extends ImportParams {
  source: { kind: SourceKind; path: string };
}

function parseImportRequest(raw: unknown): ParsedImport {
  const body = asRecord(raw);
  const connectionId = requireString(body, 'connectionId', 'connection id');
  const source = asRecord(body.source, '"source"');
  const kind = oneOf(source.kind, SOURCE_KINDS, 'source.kind');
  const file = requireString(source, 'path', 'source path');

  return {
    connectionId,
    source: { kind, path: file },
    target: parseTarget(body.target, kind),
    mapping: parseMapping(body.mapping),
    options: parseOptions(body.options),
    csv: parseCsv(body.csv),
    keyColumns: parseStringArray(body.keyColumns, 'keyColumns'),
  };
}

function parseTarget(raw: unknown, kind: SourceKind): ImportRequest['target'] {
  if (raw === undefined || raw === null) {
    // A row source has nowhere to go without one; a script carries its own
    // targets in the SQL itself.
    if (kind === 'sql' || kind === 'dump') return undefined;
    throw badRequest('"target.table" is required for a CSV/JSON/NDJSON import.');
  }
  const t = asRecord(raw, '"target"');
  return {
    schema: optionalString(t, 'schema'),
    table: requireString(t, 'table', 'target table'),
    createTable: optionalBoolean(t, 'createTable'),
  };
}

function parseMapping(raw: unknown): ColumnMapping[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw badRequest('"mapping" must be an array of column mappings.');
  return raw.map((entry, i) => {
    const m = asRecord(entry, `"mapping[${i}]"`);
    const sourceIndex = m.sourceIndex;
    if (typeof sourceIndex !== 'number' || !Number.isInteger(sourceIndex) || sourceIndex < 0) {
      throw badRequest(`"mapping[${i}].sourceIndex" must be a non-negative integer.`);
    }
    const targetColumn = m.targetColumn;
    if (targetColumn !== null && typeof targetColumn !== 'string') {
      // null is meaningful: "skip this source column" (§7.4 mapping wizard).
      throw badRequest(`"mapping[${i}].targetColumn" must be a string or null.`);
    }
    return {
      sourceIndex,
      sourceName: requireString(m, 'sourceName', 'source column name'),
      targetColumn,
      targetType: optionalString(m, 'targetType'),
      dateFormat: optionalString(m, 'dateFormat'),
      nullLiteral: optionalString(m, 'nullLiteral'),
      trim: optionalBoolean(m, 'trim'),
    };
  });
}

/**
 * Every knob has a default, so the wizard can send only what the user changed.
 * The defaults are the safe ones: plain INSERT, one transaction, stop on the
 * first bad row (§7.4).
 */
function parseOptions(raw: unknown): ImportOptions {
  const o = raw === undefined || raw === null ? {} : asRecord(raw, '"options"');
  const batchSize = o.batchSize;
  if (batchSize !== undefined && batchSize !== null) {
    if (typeof batchSize !== 'number' || !Number.isFinite(batchSize) || batchSize < 1) {
      throw badRequest('"options.batchSize" must be a positive number.');
    }
  }
  return {
    onConflict: o.onConflict === undefined ? 'insert' : oneOf(o.onConflict, CONFLICTS, 'options.onConflict'),
    truncateFirst: optionalBoolean(o, 'truncateFirst') ?? false,
    disableForeignKeys: optionalBoolean(o, 'disableForeignKeys') ?? false,
    batchSize: typeof batchSize === 'number' ? Math.floor(batchSize) : 1000,
    wrapInTransaction: optionalBoolean(o, 'wrapInTransaction') ?? true,
    continueOnError: optionalBoolean(o, 'continueOnError') ?? false,
    dryRun: optionalBoolean(o, 'dryRun') ?? false,
    useFastPath: optionalBoolean(o, 'useFastPath') ?? true,
  };
}

/** Only the fields the preview screen exposes; the rest stay as sniffed. */
function parseCsv(raw: unknown): Partial<CsvDialect> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const d = asRecord(raw, '"csv"');
  const out: Partial<CsvDialect> = {};
  const delimiter = optionalString(d, 'delimiter');
  if (delimiter !== undefined) {
    if (delimiter.length !== 1) throw badRequest('"csv.delimiter" must be exactly one character.');
    out.delimiter = delimiter;
  }
  const quote = optionalString(d, 'quote');
  if (quote !== undefined) {
    if (quote.length !== 1) throw badRequest('"csv.quote" must be exactly one character.');
    out.quote = quote;
    out.escape = quote;
  }
  if (d.encoding !== undefined && d.encoding !== null) {
    out.encoding = oneOf(d.encoding, ['utf8', 'utf16le', 'utf16be', 'latin1'] as const, 'csv.encoding');
  }
  const hasHeader = optionalBoolean(d, 'hasHeader');
  if (hasHeader !== undefined) out.hasHeader = hasHeader;
  const nullLiteral = optionalString(d, 'nullLiteral');
  if (nullLiteral !== undefined) out.nullLiteral = nullLiteral;
  const trim = optionalBoolean(d, 'trim');
  if (trim !== undefined) out.trim = trim;
  return out;
}

function parseStringArray(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    throw badRequest(`"${field}" must be an array of strings.`);
  }
  return raw as string[];
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const request = parseImportRequest(await readJson<unknown>(req));
    // Confined to the export/SQLite roots before a job exists, so a bad path is
    // a 400 in the wizard rather than a job that fails a second later (§7.2).
    const file = resolveImportPath(request.source.path);
    const name = path.basename(file);
    const isScript = request.source.kind === 'sql' || request.source.kind === 'dump';

    const title = isScript
      ? `Restore ${name}`
      : `Import ${name} → ${request.target?.schema ? `${request.target.schema}.` : ''}${request.target?.table ?? ''}`;

    // A dump is a restore, not a row import: §7.5's knobs (definers, ownership,
    // ordering) belong to `RestoreJobParams`, and the drawer labels it that way.
    const params: ImportJobParams | RestoreJobParams = isScript
      ? {
          kind: 'restore',
          source: { kind: request.source.kind as 'sql' | 'dump', path: file },
          target: { database: request.target?.schema },
          options: {
            disableForeignKeys: request.options.disableForeignKeys,
            continueOnError: request.options.continueOnError,
            singleTransaction: request.options.wrapInTransaction,
            dryRun: request.options.dryRun,
          },
        }
      : {
          kind: 'import',
          source: { kind: request.source.kind as 'csv' | 'json' | 'ndjson', path: file },
          // Guaranteed by parseTarget for every non-script source.
          target: request.target as { schema?: string; table: string; createTable?: boolean },
          mapping: request.mapping,
          options: request.options,
        };

    const job = jobManager.create(params.kind, title, request.connectionId, params, async (ctx) => {
      // §7.2/§7.5: a real dump restores best with its own client — pg_restore
      // does selective and parallel restores, `mysql` accepts everything
      // mysqldump wrote. `nativeRestore` returns `{ used: 'builtin' }` rather
      // than throwing when the built-in script runner is the better engine (a
      // dry run, SQLite, Redis, a missing binary), and throws when a native run
      // fails, so a half-restored database is never reported as done.
      if (params.kind === 'restore') {
        const config = connectionsRepo.get(request.connectionId);
        if (config) {
          const outcome = await nativeRestore(
            config,
            {
              source: params.source,
              target: params.target,
              options: params.options,
              serverVersion: connectionManager.status(request.connectionId)?.serverVersion,
            },
            ctx,
          );
          if (outcome.used === 'native') {
            for (const warning of outcome.warnings) ctx.log(`Warning: ${warning}`);
            ctx.progress({ phase: 'done', tablesDone: 1, tablesTotal: 1, bytesOut: outcome.bytesOut });
            return outcome;
          }
          ctx.log(`Built-in script runner: ${outcome.reason}`);
        }
      }
      return runImport(
        { ...request, source: { ...request.source, path: file } },
        {
          signal: ctx.signal,
          log: (line) => ctx.log(line),
          progress: (patch) => ctx.progress(patch),
        },
      );
    });

    // 202: accepted, not finished. The wizard follows it on the `jobs` channel.
    return ok({ jobId: job.id }, { status: 202 });
  });
}
