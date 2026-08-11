/**
 * POST /api/mongo/insert — insert one or more documents.
 *
 * `documents` is Extended JSON text (an object or an array of them), or the
 * decoded values themselves. PLAN §7.4: the connector inserts unordered, so one
 * duplicate key does not abort the rest of the batch.
 */

import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { documentConnector, documentListField, namespaceOf } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<{ inserted: number }> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const ns = namespaceOf(body);
    // `document` is the single-document form the editor sends.
    const docs = documentListField(body, 'documents' in body ? 'documents' : 'document');

    const connector = await documentConnector(connectionId);
    return connector.insert(ns, docs);
  });
}
