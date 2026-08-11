/**
 * POST /api/mongo/find — run a find and return a grid page.
 *
 * Body: `MongoFindRequest` (api-types). Response: `ResultSet`.
 *
 * `filter`, `projection` and `sort` arrive as Extended JSON **text** and are
 * parsed with `EJSON.parse` (PLAN §6) — never `eval`, so nothing a user types
 * in the query bar can execute. Malformed text is a 400 quoting the parser.
 *
 * The connector returns a `ResultSet` whose cells are already EJSON-encoded, so
 * this route serializes it unchanged.
 */

import type { ResultSet } from '@/lib/results';
import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { documentConnector, documentField, findOptsOf, namespaceOf } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<ResultSet> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const ns = namespaceOf(body);
    const filter = documentField(body, 'filter');
    // §8.3: limit defaults to the RTT-adjusted page size; the connector asks for
    // one extra document so `truncated` is known without a second query.
    const opts = findOptsOf(body, connectionId);

    const connector = await documentConnector(connectionId);
    return connector.find(ns, filter, opts);
  });
}
