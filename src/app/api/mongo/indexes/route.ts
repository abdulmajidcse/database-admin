/**
 * GET|POST /api/mongo/indexes — the indexes on one collection.
 *
 * Response: `MongoIndexesResponse` (api-types). Sizes come from `$collStats`
 * and are best effort: shared Atlas tiers do not grant the privilege, and an
 * index without a size is still worth listing.
 */

import type { MongoIndexesResponse } from '@/lib/api-types';
import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { documentConnector, namespaceOf, queryOf } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => indexes(queryOf(req)));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => indexes(asRecord(await readJson<unknown>(req))));
}

async function indexes(body: Record<string, unknown>): Promise<MongoIndexesResponse> {
  const connectionId = requireString(body, 'connectionId');
  const ns = namespaceOf(body);
  const connector = await documentConnector(connectionId);
  return { indexes: await connector.indexes(ns) };
}
