/**
 * GET|POST /api/redis/key — read one key's value and its TTL.
 *
 * The value is paged (`offset`/`limit`): PLAN §6 forbids pulling a 10-million
 * element list or a 512 MB string into memory to render a panel, so the
 * connector windows collections with SCAN/LRANGE and strings with GETRANGE.
 *
 * POST is the normal path (a key name can contain anything, including `#` and
 * `?`); GET is accepted for links and refreshes.
 */

import type { RedisKeyRequest, RedisKeyResponse } from '@/lib/api-types';
import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { keyValueConnector, optionalInt, queryOf, selectDb } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => read(asRecord(await readJson<unknown>(req))));
}

export async function GET(req: Request): Promise<Response> {
  return handle(async () => read(queryOf(req)));
}

async function read(body: Record<string, unknown>): Promise<RedisKeyResponse> {
  const request: RedisKeyRequest = {
    connectionId: requireString(body, 'connectionId'),
    key: requireString(body, 'key'),
    offset: optionalInt(body, 'offset', { min: 0 }),
    limit: optionalInt(body, 'limit', { min: 1, max: 5000 }),
  };

  const connector = await keyValueConnector(request.connectionId);
  await selectDb(connector, optionalInt(body, 'db', { min: 0, max: 255 }));

  const value = await connector.readKey(request.key, { offset: request.offset, limit: request.limit });
  // PTTL rather than TTL: the panel edits milliseconds, and -1 ("no expiry")
  // and -2 ("no such key") are different states the UI shows differently.
  const ttlMs = millis(await connector.command(['pttl', request.key]));

  return { value, ttlMs };
}

function millis(reply: unknown): number {
  if (typeof reply === 'number' && Number.isFinite(reply)) return Math.trunc(reply);
  if (typeof reply === 'string') {
    const parsed = Number(reply);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return -1;
}
