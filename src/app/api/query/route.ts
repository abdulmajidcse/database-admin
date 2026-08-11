/**
 * /api/query — run a statement or a whole script (PLAN §6).
 *
 * The three things that make this more than `connector.query(sql)`:
 *
 *  1. **Statement splitting.** `sql.split(';')` breaks on the first string
 *     literal, so a script goes through the hand-rolled lexer with the dialect
 *     of the connection's engine, and every statement runs IN ORDER with its
 *     own `StatementResult`. Execution stops at the first error unless the
 *     client explicitly asked to continue.
 *  2. **One run id for the whole request.** It is registered with the
 *     ConnectionManager before anything executes, so /api/query/cancel can find
 *     the link and issue a real server-side cancel while this handler is still
 *     awaiting (§6 "Query cancellation").
 *  3. **Adaptive row cap.** `maxRows` defaults to
 *     `connectionManager.suggestedPageSize()`, which is derived from the
 *     measured RTT — a 500-row first page is a visible stall on a 200 ms link
 *     (§8.3). The rest stays behind the connector's cursor.
 *
 * Every execution — success, failure or cancellation — is recorded in
 * `historyRepo`, and any DDL we run invalidates the schema cache (§6).
 */

import { randomUUID } from 'node:crypto';

import type { QueryResponse } from '@/lib/api-types';
import type { StatementResult } from '@/lib/results';
import { connectionManager } from '@/server/db/manager';
import { invalidate as invalidateSchema } from '@/server/db/schema-cache';
import { classifyStatement, dialectForEngine, splitStatements, type StatementKind } from '@/server/db/sql/lexer';
import { DbError, isSqlConnector } from '@/server/db/types';
import { connectionsRepo, historyRepo } from '@/server/store/db';
import {
  asRecord,
  badRequest,
  handle,
  HttpError,
  notFound,
  optionalString,
  readJson,
  requireString,
} from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * §6 "Never buffer": a client asking for a million rows would defeat the cursor
 * and the memory ceiling with it, so a request can only ever lower this bar,
 * never remove it.
 */
const MAX_ROWS_CEILING = 100_000;

/** §8.5 belt and braces: statement classes a read-only connection refuses. */
const WRITE_KINDS = new Set<StatementKind>(['insert', 'update', 'delete', 'ddl']);

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    const sql = requireString(body, 'sql');
    if (sql.trim() === '') throw badRequest('There is no SQL to run.');

    // 'script' is the forgiving default: a lone statement behaves identically
    // under it, whereas defaulting to 'single' would reject a pasted script.
    // 'single' is the explicit "run statement under cursor" path and stays strict.
    const mode = body.mode === 'single' ? 'single' : 'script';
    const sessionId = nonEmpty(optionalString(body, 'sessionId'));
    const database = nonEmpty(optionalString(body, 'database'));
    const schema = nonEmpty(optionalString(body, 'schema'));
    /**
     * QueryRequest does not declare this (the contract is frozen), so it is read
     * off the raw body: absent means the plan's default — stop at the first
     * error — and a client that wants mysql-style `--force` opts in.
     */
    const continueOnError = body.continueOnError === true;

    const config = connectionsRepo.get(connectionId);
    if (!config) throw notFound(`No such connection: ${connectionId}`);

    const connector = await connectionManager.acquire(connectionId);
    if (!isSqlConnector(connector)) {
      throw badRequest(`${connector.kind} is not a SQL engine — run this through its own workspace instead.`);
    }

    const dialect = dialectForEngine(connector.kind);
    const parsed = splitStatements(sql, dialect);
    if (parsed.length === 0) throw badRequest('There is no runnable statement — only comments or whitespace.');
    if (mode === 'single' && parsed.length > 1) {
      throw badRequest(`This is ${parsed.length} statements, not one — run it as a script instead.`);
    }
    const statements = mode === 'single' ? [parsed[0].text] : parsed.map((s) => s.text);

    // §8.5: the connectors also enforce read-only at the session level, but
    // SQLite has no such session, so classification is the second belt.
    if (config.readOnly) {
      const offender = statements.find((text) => WRITE_KINDS.has(classifyStatement(text, dialect)));
      if (offender !== undefined) {
        throw new HttpError(
          `"${config.name}" is a read-only connection, so nothing was run. The statement "${firstLine(offender)}" writes.`,
          403,
          { code: 'READ_ONLY_CONNECTION' },
        );
      }
    }

    const maxRows = clampRows(body.maxRows, connectionManager.suggestedPageSize(connectionId));
    const dbContext = [database, schema].filter((v): v is string => !!v).join('.') || undefined;

    // Registered before the first statement so a cancel arriving mid-script
    // finds the link; one run id covers every statement in the script.
    const run = connectionManager.registerRun(
      connectionId,
      nonEmpty(optionalString(body, 'runId')) ?? randomUUID(),
      req.signal,
    );

    const results: StatementResult[] = [];
    try {
      for (let index = 0; index < statements.length; index++) {
        const statement = statements[index];
        const startedAt = Date.now();
        try {
          const result = await connector.query(statement, {
            maxRows,
            runId: run.runId,
            sessionId,
            database,
            schema,
            signal: run.signal,
          });
          const durationMs = Date.now() - startedAt;
          results.push({ index, statement, result, durationMs });
          historyRepo.add({
            connectionId,
            sql: statement,
            dbContext,
            startedAt,
            durationMs,
            rowCount: result.affectedRows ?? result.rows.length,
            status: 'ok',
          });
          // §6: our own DDL is the one schema change we always know about.
          if (classifyStatement(statement, dialect) === 'ddl') invalidateSchema(connectionId);
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          const cancelled = run.signal.aborted || codeOf(err) === 'CANCELLED';
          results.push({ index, statement, error: statementError(err), durationMs });
          historyRepo.add({
            connectionId,
            sql: statement,
            dbContext,
            startedAt,
            durationMs,
            status: cancelled ? 'cancelled' : 'error',
            error: messageOf(err),
          });
          // A cancel means the user asked us to stop, so it always stops.
          if (!continueOnError || cancelled) break;
        }
      }
    } finally {
      run.done();
    }

    const response: QueryResponse = { results, runId: run.runId };
    return response;
  });
}

/**
 * The engine's own error, kept structured for the editor gutter. A statement
 * failing is a normal result, not an HTTP failure — the script may have three
 * more statements to report.
 */
function statementError(err: unknown): NonNullable<StatementResult['error']> {
  if (err instanceof DbError) {
    return { message: err.message, code: err.code, position: err.position, detail: err.detail };
  }
  return { message: messageOf(err) };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): string | undefined {
  if (err instanceof DbError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function firstLine(sql: string): string {
  const line = sql.split('\n', 1)[0].trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function clampRows(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest('"maxRows" must be a number.');
  return Math.max(1, Math.min(Math.floor(value), MAX_ROWS_CEILING));
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
