/**
 * GET|POST /api/mongo/databases — `listDatabases` for the tree root.
 */

import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { documentConnector, queryOf } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MongoDatabasesResponse {
  databases: { name: string; sizeBytes?: number }[];
}

export async function GET(req: Request): Promise<Response> {
  return handle(async () => databases(queryOf(req)));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => databases(asRecord(await readJson<unknown>(req))));
}

async function databases(body: Record<string, unknown>): Promise<MongoDatabasesResponse> {
  const connector = await documentConnector(requireString(body, 'connectionId'));
  return { databases: await connector.listDatabases() };
}
