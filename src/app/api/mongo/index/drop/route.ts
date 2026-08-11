/**
 * POST /api/mongo/index/drop — drop one index by name.
 *
 * The connector refuses `_id_`, which Mongo cannot drop anyway; catching it
 * before the round trip means the UI gets a sentence instead of a driver code.
 */

import { asRecord, handle, readJson, requireString } from '../../../lib/respond';
import { documentConnector, namespaceOf } from '../../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<{ name: string }> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const ns = namespaceOf(body);
    const name = requireString(body, 'name');

    const connector = await documentConnector(connectionId);
    await connector.dropIndex(ns, name);
    return { name };
  });
}
