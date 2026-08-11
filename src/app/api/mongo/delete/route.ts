/**
 * POST /api/mongo/delete — delete documents by `_id`.
 *
 * One `deleteMany({_id: {$in: […]}})` rather than a call per row, so deleting a
 * selection costs one round trip. `_id: null` is a legal id and survives.
 */

import { asRecord, badRequest, handle, readJson, requireString } from '../../lib/respond';
import { documentConnector, idListField, namespaceOf } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<{ deleted: number }> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const ns = namespaceOf(body);
    // `id` is the single-row form; `ids` the selection form. An array is never
    // unwrapped, because an array is itself a legal `_id` value.
    const ids = 'ids' in body ? idListField(body, 'ids') : [singleId(body)];
    if (ids.length === 0) throw badRequest('"ids" must contain at least one _id.');

    const connector = await documentConnector(connectionId);
    return connector.deleteDocs(ns, ids);
  });
}

function singleId(body: Record<string, unknown>): unknown {
  if (!('id' in body) || body.id === undefined) {
    throw badRequest('"ids" is required: an array of _id values (or "id" for a single document).');
  }
  return body.id;
}
