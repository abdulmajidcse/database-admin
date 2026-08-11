/**
 * POST /api/mongo/replace — replace one document, identified by `_id`.
 *
 * `id` is sent as the value itself rather than as text: the grid holds an
 * ObjectId as the tagged cell `{ $t: 'objectid', v: '…' }` and the document
 * editor as `{"$oid": "…"}`, and the connector decodes both back into the exact
 * BSON the document was read with (PLAN §6 "Type fidelity"). `null` is a legal
 * `_id`, so the check is presence, not truthiness.
 *
 * PLAN §6 "Grid editing": a replace that matches no document is an error, not a
 * silent no-op — the row moved underneath the grid.
 */

import { asRecord, badRequest, handle, readJson, requireString } from '../../lib/respond';
import { documentConnector, documentField, namespaceOf } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<{ modified: number }> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const ns = namespaceOf(body);

    if (!('id' in body) || body.id === null || body.id === undefined) {
      throw badRequest('"id" is required: the _id of the document to replace.');
    }
    const document = documentField(body, 'document', true);

    const connector = await documentConnector(connectionId);
    return connector.replace(ns, body.id, document);
  });
}
