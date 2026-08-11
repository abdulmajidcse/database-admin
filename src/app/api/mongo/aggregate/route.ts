/**
 * POST /api/mongo/aggregate — run an aggregation pipeline.
 *
 * Body: `MongoAggregateRequest` (api-types). Response: `ResultSet`.
 *
 * The pipeline arrives as Extended JSON **text** and is parsed with
 * `EJSON.parse` (PLAN §6) — never `eval`. Each stage must be an object, which
 * is checked here so a typo comes back as a 400 naming the stage index instead
 * of a driver error.
 *
 * The connector appends a `$limit` guard (PLAN §6 "Big results") unless the
 * pipeline ends in `$out`/`$merge`, and refuses those two entirely on a
 * read-only connection (§8.5).
 */

import type { ResultSet } from '@/lib/results';
import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { documentConnector, namespaceOf, optionalInt, pipelineField } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<ResultSet> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const ns = namespaceOf(body);
    const pipeline = pipelineField(body);
    const limit = optionalInt(body, 'limit', { min: 1, max: 10_000 });

    const connector = await documentConnector(connectionId);
    return connector.aggregate(ns, pipeline, { limit });
  });
}
