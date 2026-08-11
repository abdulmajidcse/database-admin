/**
 * POST /api/redis/scan — one page of the keyspace browser.
 *
 * PLAN §6 "Redis at scale": this is SCAN with MATCH/COUNT and real cursor
 * pagination, never `KEYS *`, and the connector pipelines the per-key
 * TYPE/PTTL/MEMORY USAGE lookups so a page costs O(1) round trips. The route
 * itself only validates the cursor and picks the default COUNT.
 */

import type { RedisScanRequest, RedisScanResponse } from '@/lib/api-types';
import { connectionManager } from '@/server/db/manager';
import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { keyValueConnector, parseCursor } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');

    const request: RedisScanRequest = {
      connectionId,
      // §8.3: page size follows the measured RTT — a 500-key page is a visible
      // stall on a 200 ms link. An explicit cursor.count always wins.
      cursor: parseCursor(body.cursor, connectionManager.suggestedPageSize(connectionId)),
    };

    const connector = await keyValueConnector(request.connectionId);
    const page = await connector.scanKeys(request.cursor);

    const response: RedisScanResponse = { keys: page.keys, next: page.next, done: page.done };
    return response;
  });
}
