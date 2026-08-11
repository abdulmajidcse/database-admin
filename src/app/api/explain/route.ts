/**
 * /api/explain — the query plan, parsed into the engine-neutral ExplainPlan
 * tree that drives the flame bars (PLAN §6 power tools).
 *
 * `analyze: true` really executes the statement. Postgres wraps it in a
 * transaction that always rolls back (the connector does that), but a read-only
 * connection still refuses to ANALYZE a write statement here — §8.5 belt and
 * braces, because the rollback trick is engine-specific and this rule is not.
 */

import type { ExplainResponse } from '@/lib/api-types';
import { connectionManager } from '@/server/db/manager';
import { classifyStatement, dialectForEngine, splitStatements, type StatementKind } from '@/server/db/sql/lexer';
import { isSqlConnector } from '@/server/db/types';
import { connectionsRepo } from '@/server/store/db';
import { asRecord, badRequest, handle, HttpError, notFound, readJson, requireString } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WRITE_KINDS = new Set<StatementKind>(['insert', 'update', 'delete', 'ddl']);

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    const sql = requireString(body, 'sql');
    if (sql.trim() === '') throw badRequest('There is no SQL to explain.');
    const analyze = body.analyze === true;

    const config = connectionsRepo.get(connectionId);
    if (!config) throw notFound(`No such connection: ${connectionId}`);

    const connector = await connectionManager.acquire(connectionId);
    if (!isSqlConnector(connector)) {
      throw badRequest(`${connector.kind} has no SQL planner — explain it from its own workspace instead.`);
    }
    if (!connector.capabilities.has('explain')) {
      throw new HttpError(`${connector.kind} cannot produce a query plan.`, 501);
    }

    const dialect = dialectForEngine(connector.kind);
    // One plan per request: EXPLAIN takes a single statement, and splitting is
    // also how we strip a trailing `;` that some engines reject after EXPLAIN.
    const statements = splitStatements(sql, dialect);
    if (statements.length === 0) throw badRequest('There is no statement to explain.');
    if (statements.length > 1) throw badRequest('Select a single statement to explain.');
    const statement = statements[0].text;

    if (analyze && config.readOnly && WRITE_KINDS.has(classifyStatement(statement, dialect))) {
      throw new HttpError(
        `"${config.name}" is read-only, and EXPLAIN ANALYZE would actually run this statement. Explain it without ANALYZE.`,
        403,
        { code: 'READ_ONLY_CONNECTION' },
      );
    }

    const plan: ExplainResponse = await connector.explain(statement, analyze);
    return plan;
  });
}
