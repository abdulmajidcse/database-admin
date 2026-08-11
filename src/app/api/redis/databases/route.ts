/**
 * GET|POST /api/redis/databases — the numbered databases and their key counts.
 *
 * `INFO keyspace` only reports databases that hold keys, so the connector fills
 * in the empty ones from `CONFIG GET databases` where that command is allowed
 * (managed Redis usually disables it). Under Redis Cluster there is a single
 * logical database, and the count is the sum across masters.
 */

import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { keyValueConnector, queryOf } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RedisDatabasesResponse {
  databases: { index: number; keys: number }[];
  /** False under Redis Cluster, where SELECT does not exist. */
  selectable: boolean;
}

export async function GET(req: Request): Promise<Response> {
  return handle(async () => databases(queryOf(req)));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => databases(asRecord(await readJson<unknown>(req))));
}

async function databases(body: Record<string, unknown>): Promise<RedisDatabasesResponse> {
  const connectionId = requireString(body, 'connectionId');
  const connector = await keyValueConnector(connectionId);
  return {
    databases: await connector.listDatabases(),
    selectable: connector.capabilities.has('multipleDatabases'),
  };
}
