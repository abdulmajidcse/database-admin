/**
 * POST /api/ddl/execute — run a generated DDL script (PLAN §6, §9).
 *
 * Three rules this route enforces, none of which a connector can:
 *
 *  1. §8.5 — a read-only connection never runs DDL. Refused with 403 before the
 *     pool is touched, rather than surfacing as a driver error.
 *  2. §9 — every statement goes through `isDestructive()` and the verdicts come
 *     back in the response, so the editor can name the target in a typed
 *     confirm dialog. Until that confirmation is echoed back nothing runs: the
 *     first POST is a dry run that answers with the flags.
 *  3. §6 — the statements run in ONE transaction on ONE pinned session, so a
 *     failure half-way leaves nothing behind... unless the script already
 *     manages its own transaction, which SQLite's 12-step rebuild does (trap 3:
 *     `PRAGMA foreign_keys` is a no-op inside a transaction, so the pragmas sit
 *     outside the script's own BEGIN/COMMIT). Wrapping that in a second
 *     transaction is an error on every engine, so it is detected and the script
 *     runs as written instead.
 *
 * Either way the schema cache is invalidated afterwards (§6 "Schema cache
 * freshness"), including after a rollback — a half-applied MySQL script is
 * exactly the case where the cached model must not be trusted.
 */

import type { EngineKind } from '@/lib/schema-model';
import { connectionManager } from '@/server/db/manager';
import { invalidate } from '@/server/db/schema-cache';
import {
  classifyStatement,
  dialectForEngine,
  isDestructive,
  splitStatements,
  type SqlDialect,
} from '@/server/db/sql/lexer';
import { DbError, type SqlConnector } from '@/server/db/types';
import { connectionsRepo } from '@/server/store/db';
import {
  asRecord,
  badRequest,
  handle,
  HttpError,
  notFound,
  optionalString,
  readJson,
  requireString,
} from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Request shape. `statements` is what /api/ddl/plan returned; `sql` is the
 * escape hatch for the DDL editor's own buffer, which is split with the §6
 * lexer rather than on semicolons.
 */
export interface DdlExecuteRequest {
  connectionId: string;
  statements?: string[];
  sql?: string;
  /** Echo of `requiresConfirmation.phrase` from the dry-run response (§9). */
  confirm?: string;
}

export interface DdlStatementOutcome {
  index: number;
  statement: string;
  status: 'ok' | 'error' | 'skipped';
  /** Rows the statement reported touching, when the driver reports any. */
  affectedRows?: number;
  durationMs: number;
  error?: { message: string; code?: string; detail?: string; position?: number };
  /** §9: drives the confirm dialog, and stays in the result as an audit trail. */
  destructive: boolean;
  destructiveReason?: string;
  /** UPDATE/DELETE with no WHERE — "every row" needs the louder warning. */
  unqualified?: boolean;
  notices?: string[];
}

export interface DdlExecuteResponse {
  /** False when the script was withheld pending confirmation — nothing ran. */
  executed: boolean;
  /** True when this route opened the transaction; false when the script owns it. */
  transactional: boolean;
  rolledBack: boolean;
  /** Statements that completed successfully. */
  succeeded: number;
  durationMs: number;
  statements: DdlStatementOutcome[];
  warnings: string[];
  requiresConfirmation?: { phrase: string; reasons: string[] };
}

/** Rows we still read back — SQLite's step-10 `foreign_key_check` returns them. */
const MAX_ROWS = 100;

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<DdlExecuteResponse> => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    const confirm = optionalString(body, 'confirm');

    const config = connectionsRepo.get(connectionId);
    if (!config) throw notFound(`No such connection: ${connectionId}`);
    if (config.readOnly) {
      throw new HttpError(
        'This connection is marked read-only, so DDL cannot be executed on it.',
        403,
        { code: 'READ_ONLY' },
      );
    }

    const connector = await connectionManager.acquireSql(connectionId);
    if (!connector.capabilities.has('ddl')) {
      throw badRequest(`${connector.kind} connections do not support DDL.`);
    }
    const dialect = dialectForEngine(connector.kind);
    const list = resolveStatements(body, dialect);

    // §9 first, always: the verdicts are computed before anything can run.
    const outcomes: DdlStatementOutcome[] = list.map((statement, index) => {
      const verdict = isDestructive(statement, dialect);
      return {
        index,
        statement,
        status: 'skipped',
        durationMs: 0,
        destructive: verdict.destructive,
        destructiveReason: verdict.reason,
        unqualified: verdict.unqualified,
      };
    });

    const reasons = outcomes
      .filter((o) => o.destructive)
      .map((o) => `Statement ${o.index + 1}: ${o.destructiveReason ?? 'data will be lost'}`);
    // §9: a prod connection gets the stricter confirm — every script, not only
    // the destructive ones.
    if (config.envTag === 'prod') reasons.push(`This connection is tagged prod (${config.name}).`);

    if (reasons.length > 0 && confirm !== config.name) {
      return {
        executed: false,
        transactional: false,
        rolledBack: false,
        succeeded: 0,
        durationMs: 0,
        statements: outcomes,
        warnings: [],
        // Typing the connection's name proves the user knows which database
        // they are about to change — which a plain "are you sure?" never does.
        requiresConfirmation: { phrase: config.name, reasons },
      };
    }

    const result = await execute(connector, connectionId, connector.kind, dialect, outcomes);

    // Even a rolled-back run may have moved MySQL, which commits implicitly on
    // DDL; the cached model is untrustworthy either way.
    invalidate(connectionId);

    return result;
  });
}

async function execute(
  connector: SqlConnector,
  connectionId: string,
  engine: EngineKind,
  dialect: SqlDialect,
  outcomes: DdlStatementOutcome[],
): Promise<DdlExecuteResponse> {
  const started = Date.now();
  const warnings: string[] = [];

  // Trap 3: a script holding its own BEGIN/COMMIT (and pragmas that must stay
  // outside it) runs verbatim. Everything else gets one transaction here.
  const selfManaged = outcomes.some((o) => classifyStatement(o.statement, dialect) === 'transaction');
  const canPin = connector.capabilities.has('transactions');
  const transactional = canPin && !selfManaged;

  if (selfManaged) {
    warnings.push(
      'This script manages its own transaction, so it ran as written rather than wrapped in another one.',
    );
  }
  if (engine === 'mysql' || engine === 'mariadb') {
    warnings.push(
      'MySQL commits implicitly around each DDL statement, so a failure part-way through cannot be rolled back: the statements reported as ok have already taken effect.',
    );
  }

  // One pinned session for the whole script (§6 "Sessions vs pools"): a pool
  // checkout per statement would put BEGIN and COMMIT on different connections.
  const session = canPin ? await connectionManager.openSession(connectionId) : null;
  const sessionId = session?.id;
  let rolledBack = false;
  let succeeded = 0;
  let failed = false;

  try {
    if (transactional && sessionId) await connectionManager.sessionCommand(sessionId, 'begin');

    for (const outcome of outcomes) {
      const at = Date.now();
      try {
        const res = await connector.query(outcome.statement, { sessionId, maxRows: MAX_ROWS });
        // A cursor left open pins a read handle until the idle sweep.
        if (res.cursorId) await connector.closeCursor(res.cursorId).catch(() => undefined);

        // Step 10 of the SQLite rebuild proves no foreign key was broken by it.
        // Violations come back as ROWS, not as an error, so passing over them
        // would commit a corrupted database.
        if (/foreign_key_check/i.test(outcome.statement) && res.rows.length > 0) {
          throw new DbError(
            `foreign_key_check reported ${res.rows.length} violation(s); the change was not kept.`,
            'DBADMIN_FK_VIOLATION',
          );
        }

        outcome.status = 'ok';
        outcome.affectedRows = res.affectedRows;
        outcome.notices = res.notices;
        outcome.durationMs = Date.now() - at;
        succeeded++;
      } catch (err) {
        outcome.status = 'error';
        outcome.durationMs = Date.now() - at;
        outcome.error = describeError(err);
        failed = true;
        break; // the rest stay 'skipped'
      }
    }

    if (transactional && sessionId) {
      await connectionManager.sessionCommand(sessionId, failed ? 'rollback' : 'commit');
      rolledBack = failed;
    } else if (failed) {
      // The script's own transaction may still be open; close it the safe way.
      rolledBack = await rollbackSelfManaged(connector, sessionId);
      if (!rolledBack) {
        warnings.push(
          'The script opened its own transaction and the rollback attempt did not succeed; check the table before retrying.',
        );
      }
    }
  } finally {
    if (sessionId) await connectionManager.closeSession(sessionId).catch(() => undefined);
  }

  return {
    executed: true,
    transactional,
    rolledBack,
    succeeded,
    durationMs: Date.now() - started,
    statements: outcomes,
    warnings,
  };
}

/**
 * `ROLLBACK` against a script-owned transaction. It fails harmlessly when the
 * script had already committed or never reached its BEGIN, so the failure is
 * swallowed — the statement error is the one worth reporting.
 */
async function rollbackSelfManaged(connector: SqlConnector, sessionId?: string): Promise<boolean> {
  try {
    await connector.query('ROLLBACK', { sessionId, maxRows: 1 });
    return true;
  } catch {
    return false;
  }
}

function describeError(err: unknown): { message: string; code?: string; detail?: string; position?: number } {
  if (err instanceof DbError) {
    return { message: err.message, code: err.code, detail: err.detail, position: err.position };
  }
  // Never a stack trace: the message is all the UI gets (§9).
  return { message: err instanceof Error ? err.message : String(err) };
}

function resolveStatements(body: Record<string, unknown>, dialect: SqlDialect): string[] {
  if (Array.isArray(body.statements)) {
    const list: string[] = [];
    for (const s of body.statements) {
      if (typeof s !== 'string') throw badRequest('"statements" must be an array of SQL strings.');
      const text = s.trim();
      if (text !== '') list.push(text);
    }
    if (list.length === 0) throw badRequest('"statements" is empty; there is nothing to run.');
    return list;
  }
  if (typeof body.sql === 'string') {
    // §6: split with the lexer, never on `;` — a semicolon inside a string
    // literal or a dollar-quoted function body is not a terminator.
    const list = splitStatements(body.sql, dialect).map((s) => s.text);
    if (list.length === 0) throw badRequest('"sql" contains no runnable statement.');
    return list;
  }
  throw badRequest('Provide either "statements" (an array of SQL strings) or "sql" (a script).');
}
