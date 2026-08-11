/**
 * POST /api/changeset/preview — PLAN §6 "Grid editing".
 *
 * Renders the EXACT SQL a pending set of grid edits would run, in order, with
 * the number of rows each statement is expected to touch. Nothing executes
 * here. The connector builds the statements with the same code path that
 * /api/changeset/apply uses, so the preview pane is not an approximation of
 * what will run — it is what will run.
 *
 * Thin route (§11): validate the wire shape, hand the canonical `Changeset` to
 * the connector, serialize. All SQL knowledge stays behind the connector
 * boundary; cell values keep the §6 wire format and are decoded down there.
 */

import type { ChangesetPreviewResponse } from '@/lib/api-types';
import type { ChangeOp, Changeset } from '@/lib/results';
import { connectionManager } from '@/server/db/manager';
import { asRecord, badRequest, handle, readJson, requireString } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<ChangesetPreviewResponse> => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    const changeset = parseChangeset(body.changeset);

    // acquireSql refuses Redis/Mongo up front, so the route needs no cast (§4).
    const connector = await connectionManager.acquireSql(connectionId);
    return connector.previewChangeset(changeset);
  });
}

/**
 * Structural validation only. Cell values stay `unknown` on purpose: the wire
 * format (null | string | number | boolean | {$t,v}) is decoded by the
 * connector's changeset writer, which is also where an unknown tag has to be
 * rejected — duplicating that here would let the two disagree.
 *
 * Kept file-local (and mirrored in the apply route): Next type-checks route
 * modules and rejects value exports other than the handlers and the segment
 * config, so a route file cannot be a library.
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
  // §6: without a unique key an update or delete cannot address exactly one
  // row — which is precisely the case the grid marks read-only.
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
