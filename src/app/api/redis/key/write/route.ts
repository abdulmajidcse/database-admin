/**
 * POST /api/redis/key/write — replace a key's whole value.
 *
 * The connector runs DEL + rebuild inside a MULTI, so nobody ever observes a
 * half-written key, and a read-only connection is refused server-side
 * (PLAN §8.5). Writing `{ type: 'none' }` deletes the key: Redis has no empty
 * list/set/hash.
 */

import { asRecord, handle, readJson, requireString } from '../../../lib/respond';
import { keyValueConnector, optionalInt, parseTypedValue, selectDb } from '../../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RedisWriteResponse {
  key: string;
  /** Milliseconds left, or -1 when the key has no expiry (PTTL semantics). */
  ttlMs: number;
}

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<RedisWriteResponse> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const key = requireString(body, 'key');
    const value = parseTypedValue(body.value);
    // Absent means "keep whatever expiry the key has"; the connector only
    // issues PEXPIRE for a positive TTL.
    const ttlMs = optionalInt(body, 'ttlMs', { min: 1 });

    const connector = await keyValueConnector(connectionId);
    await selectDb(connector, optionalInt(body, 'db', { min: 0, max: 255 }));
    await connector.writeKey(key, value, ttlMs);

    // Report the TTL that actually survived the rewrite: DEL drops the old
    // expiry, so a caller that sent none now has a persistent key.
    const pttl = await connector.command(['pttl', key]);
    return { key, ttlMs: typeof pttl === 'number' ? Math.trunc(pttl) : -1 };
  });
}
