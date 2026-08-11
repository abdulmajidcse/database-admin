/**
 * POST /api/redis/key/rename — RENAME one key.
 *
 * Under Redis Cluster both names must hash to the same slot; the connector
 * turns that CROSSSLOT reply into an error that names the hash-tag fix.
 */

import { asRecord, badRequest, handle, readJson, requireString } from '../../../lib/respond';
import { keyValueConnector, optionalInt, selectDb } from '../../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<{ from: string; to: string }> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const from = requireString(body, 'from');
    const to = requireString(body, 'to');
    // RENAME onto itself is a no-op the server accepts; catching it here keeps
    // an accidental double-submit from looking like it did something.
    if (from === to) throw badRequest('The new key name is the same as the old one.');

    const connector = await keyValueConnector(connectionId);
    await selectDb(connector, optionalInt(body, 'db', { min: 0, max: 255 }));
    await connector.renameKey(from, to);

    return { from, to };
  });
}
