/**
 * /api/query/cancel — stop a running statement (PLAN §6 "Query cancellation").
 *
 * Closing the socket does NOT stop the server, so this is a real request: the
 * ConnectionManager looks the run id up in its cancel registry, aborts our own
 * pipeline, and the connector issues `pg_cancel_backend` / `KILL QUERY` / a
 * worker terminate on a SECOND connection. The original /api/query request is
 * still in flight and returns its statements with the cancellation recorded.
 *
 * An unknown run id is not an error: the statement almost certainly just
 * finished, and the cancel button must not turn a won race into a red box.
 */

import { connectionManager } from '@/server/db/manager';
import { asRecord, handle, readJson, requireString } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    // The registry is keyed by run id alone; connectionId travels with the
    // request for symmetry with the rest of the API but is not needed here.
    const runId = requireString(body, 'runId');
    const cancelled = await connectionManager.cancel(runId);
    return { cancelled, runId };
  });
}
