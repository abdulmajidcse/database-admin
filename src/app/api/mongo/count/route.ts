/**
 * GET|POST /api/mongo/count — how many documents match a filter.
 *
 * Response is `TableCountResponse`, and `estimated` is not decoration: with no
 * filter the connector reads the collection's metadata count (O(1)); with one
 * it has to run an aggregation over the matching documents, which is exact but
 * costs a scan. The grid shows "~12,000" for the first and "12,000" for the
 * second.
 */

import type { TableCountResponse } from '@/lib/api-types';
import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { documentConnector, documentField, namespaceOf, queryOf } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => count(queryOf(req)));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => count(asRecord(await readJson<unknown>(req))));
}

async function count(body: Record<string, unknown>): Promise<TableCountResponse> {
  const connectionId = requireString(body, 'connectionId');
  const ns = namespaceOf(body);
  const filter = documentField(body, 'filter');
  const estimated = Object.keys(filter as Record<string, unknown>).length === 0;

  const connector = await documentConnector(connectionId);
  return { count: await connector.count(ns, filter), estimated };
}
