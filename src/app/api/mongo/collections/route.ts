/**
 * GET|POST /api/mongo/collections — collections and views in one database.
 *
 * PLAN §8.3: the connector adds `estimatedDocumentCount` (collection metadata,
 * O(1) server-side) concurrently and only for a tree-sized list, so a database
 * with thousands of collections does not turn one click into thousands of round
 * trips. Views have no metadata count and come back without one.
 */

import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { documentConnector, queryOf, requireName } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MongoCollectionsResponse {
  database: string;
  collections: { name: string; type: string; count?: number }[];
}

export async function GET(req: Request): Promise<Response> {
  return handle(async () => collections(queryOf(req)));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => collections(asRecord(await readJson<unknown>(req))));
}

async function collections(body: Record<string, unknown>): Promise<MongoCollectionsResponse> {
  const connectionId = requireString(body, 'connectionId');
  const database = requireName(body, 'database');
  const connector = await documentConnector(connectionId);
  return { database, collections: await connector.listCollections(database) };
}
