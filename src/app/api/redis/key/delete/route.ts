/**
 * POST /api/redis/key/delete — delete one or more keys.
 *
 * The connector issues UNLINK (falling back to DEL on Redis < 4) one key at a
 * time through a pipeline: UNLINK reclaims a large collection on a background
 * thread instead of blocking the server, and a multi-key call would be
 * CROSSSLOT under Redis Cluster.
 */

import { asRecord, badRequest, handle, readJson, requireString } from '../../../lib/respond';
import { keyValueConnector, optionalInt, selectDb, stringList } from '../../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<{ deleted: number }> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    // Accept a single `key` as well: the key panel deletes exactly one.
    const keys = body.keys === undefined ? [requireString(body, 'key')] : stringList(body, 'keys');
    if (keys.length === 0) throw badRequest('"keys" must name at least one key to delete.');

    const connector = await keyValueConnector(connectionId);
    await selectDb(connector, optionalInt(body, 'db', { min: 0, max: 255 }));

    // Fewer than `keys.length` means some had already expired or were gone —
    // that is information the UI shows, not an error.
    return { deleted: await connector.deleteKeys(keys) };
  });
}
