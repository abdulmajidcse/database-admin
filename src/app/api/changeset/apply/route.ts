/**
 * POST /api/changeset/apply — PLAN §6 "Grid editing".
 *
 * The contract this route exists to uphold: every statement of a changeset runs
 * in ONE transaction, and the apply ABORTS on an affected-rows mismatch. That
 * check is what protects against a `WHERE` clause matching more rows than the
 * grid intended — a row that changed under the user since the page was read
 * makes the count differ, and the whole batch rolls back rather than quietly
 * rewriting somebody else's data.
 *
 * The transaction and the row-count guard live inside each connector (they need
 * the driver's own affectedRows), so this route's job is: refuse read-only
 * connections before anything is dialled, validate the wire shape, delegate,
 * and invalidate the schema cache afterwards.
 */

import type { ChangesetApplyResponse } from '@/lib/api-types';
import type { ChangeOp, Changeset } from '@/lib/results';
import { connectionManager } from '@/server/db/manager';
import { invalidate } from '@/server/db/schema-cache';
import { DbError } from '@/server/db/types';
import { connectionsRepo } from '@/server/store/db';
import {
  asRecord,
  badRequest,
  conflict,
  handle,
  HttpError,
  notFound,
  readJson,
  requireString,
} from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<ChangesetApplyResponse> => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    const changeset = parseChangeset(body.changeset);

    // §8.5: the connectors refuse too, but a read-only connection should never
    // be opened for a write at all — and 403 beats a driver error.
    const config = connectionsRepo.get(connectionId);
    if (!config) throw notFound(`No such connection: ${connectionId}`);
    if (config.readOnly) {
      throw new HttpError('This connection is marked read-only, so edits are not allowed.', 403, {
        code: 'READ_ONLY',
      });
    }

    const connector = await connectionManager.acquireSql(connectionId);

    let result: ChangesetApplyResponse;
    try {
      result = await connector.applyChangeset(changeset);
    } catch (err) {
      throw asMismatchConflict(err) ?? err;
    }

    // §6 "Schema cache freshness": row estimates and sequence values in the
    // cached model are stale the moment rows change, and an insert may have
    // been the first row of a table the tree still shows as empty.
    invalidate(connectionId);

    return result;
  });
}

/**
 * The affected-rows guard firing is a conflict, not a server fault: the row
 * moved under the grid. 409 tells the UI to re-read the row and show what
 * changed instead of offering a plain "retry".
 *
 * MySQL tags it; the Postgres and SQLite writers throw the same guard without a
 * code, so the message the three of them share is matched as well.
 */
function asMismatchConflict(err: unknown): HttpError | null {
  if (!(err instanceof DbError)) return null;
  const isMismatch =
    err.code === 'DBADMIN_AFFECTED_MISMATCH' || /Expected \d+ row\(s\)/i.test(err.message);
  if (!isMismatch) return null;
  return conflict(err.message, {
    code: err.code ?? 'DBADMIN_AFFECTED_MISMATCH',
    detail: err.detail,
    hint: 'The rows changed since the grid read them. Refresh the result and re-apply your edits.',
  });
}

/**
 * Structural validation only — cell values keep the §6 wire format and are
 * decoded (and rejected, if malformed) by the connector's changeset writer.
 *
 * Mirrors the preview route on purpose: Next rejects value exports from a route
 * module other than the handlers and segment config, so neither file can be a
 * library for the other, and the two must not drift.
 */
function parseChangeset(value: unknown): Changeset {
  const cs = asRecord(value, '"changeset"');

  const table = requireString(cs, 'table');
  if (cs.schema !== undefined && cs.schema !== null && typeof cs.schema !== 'string') {
    throw badRequest('"changeset.schema" must be a string when present.');
  }
  if (!Array.isArray(cs.keyColumns) || cs.keyColumns.some((c) => typeof c !== 'string')) {
    throw badRequest('"changeset.keyColumns" must be an array of column names.');
  }
  if (!Array.isArray(cs.changes) || cs.changes.length === 0) {
    throw badRequest('"changeset.changes" must be a non-empty array.');
  }
  for (let i = 0; i < cs.changes.length; i++) validateChange(cs.changes[i], i);

  const changes = cs.changes as ChangeOp[];
  if (cs.keyColumns.length === 0 && changes.some((c) => c.op !== 'insert')) {
    throw badRequest('"changeset.keyColumns" is empty, so updates and deletes cannot identify a row.');
  }

  return {
    schema: typeof cs.schema === 'string' ? cs.schema : undefined,
    table,
    keyColumns: cs.keyColumns as string[],
    changes,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateChange(change: unknown, index: number): void {
  if (!isRecord(change)) throw badRequest(`"changes[${index}]" must be an object.`);
  switch (change.op) {
    case 'insert':
      if (!isRecord(change.values)) throw badRequest(`"changes[${index}].values" must be an object.`);
      return;
    case 'update':
      if (!isRecord(change.key)) throw badRequest(`"changes[${index}].key" must be an object.`);
      if (!isRecord(change.values) || Object.keys(change.values).length === 0) {
        throw badRequest(`"changes[${index}].values" must be a non-empty object.`);
      }
      return;
    case 'delete':
      if (!isRecord(change.key)) throw badRequest(`"changes[${index}].key" must be an object.`);
      return;
    default:
      throw badRequest(`"changes[${index}].op" must be "insert", "update" or "delete".`);
  }
}
