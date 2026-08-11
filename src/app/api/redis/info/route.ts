/**
 * GET|POST /api/redis/info — parsed INFO, section by section.
 *
 * The connector asks for `INFO everything` (commandstats/latencystats included)
 * and falls back to plain INFO on servers that reject it, then parses the
 * `# Section` / `key:value` text into a nested record. In cluster mode a
 * server-wide INFO is meaningless, so it comes from one master.
 */

import { handle, readJson, requireString, asRecord } from '../../lib/respond';
import { keyValueConnector, queryOf } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RedisInfoResponse {
  sections: Record<string, Record<string, string>>;
  /** Convenience for the header, pulled out of the `server` section. */
  version: string | null;
}

export async function GET(req: Request): Promise<Response> {
  return handle(async () => info(queryOf(req)));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => info(asRecord(await readJson<unknown>(req))));
}

async function info(body: Record<string, unknown>): Promise<RedisInfoResponse> {
  const connectionId = requireString(body, 'connectionId');
  const connector = await keyValueConnector(connectionId);
  const sections = await connector.info();
  const server = sections.server ?? {};
  return { sections, version: server.redis_version ?? server.valkey_version ?? null };
}
