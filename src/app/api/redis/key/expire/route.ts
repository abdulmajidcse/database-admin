/**
 * POST /api/redis/key/expire — set or clear a key's TTL.
 *
 * `ttlMs: null` is PERSIST (clear the expiry); a number is PEXPIRE. The field
 * must be present, because "no TTL sent" and "remove the TTL" are different
 * intentions and only one of them should touch the key.
 */

import { asRecord, badRequest, handle, readJson, requireString } from '../../../lib/respond';
import { intFrom, keyValueConnector, optionalInt, selectDb } from '../../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<{ key: string; ttlMs: number | null }> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const key = requireString(body, 'key');

    if (!('ttlMs' in body)) {
      throw badRequest('"ttlMs" is required: a number of milliseconds, or null to clear the expiry.');
    }
    const raw = body.ttlMs;
    const ttlMs = raw === null ? null : intFrom(raw, 'ttlMs', { min: 1 });

    const connector = await keyValueConnector(connectionId);
    await selectDb(connector, optionalInt(body, 'db', { min: 0, max: 255 }));
    // Setting a TTL on a missing key throws NO_SUCH_KEY from the connector,
    // which is a 400 the panel shows next to the field.
    await connector.expireKey(key, ttlMs);

    return { key, ttlMs };
  });
}
