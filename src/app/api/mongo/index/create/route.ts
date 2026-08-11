/**
 * POST /api/mongo/index/create — create an index on a collection.
 *
 * The spec is an `IndexInfo` (results.ts): `keys` maps field → 1 | -1 for a
 * B-tree direction, or a string for a special index (`text`, `2dsphere`,
 * `hashed`, …). The connector rejects any other string with the list of what it
 * accepts, so a typo never reaches the server as a silent no-op.
 */

import type { IndexInfo } from '@/lib/results';
import { asRecord, badRequest, handle, optionalBoolean, optionalString, readJson, requireString } from '../../../lib/respond';
import { documentConnector, namespaceOf, optionalInt } from '../../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<{ name: string; keys: Record<string, 1 | -1 | string> }> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const ns = namespaceOf(body);
    // Accept the spec nested under "index" or flattened onto the body.
    const source = body.index === undefined ? body : asRecord(body.index, '"index"');
    const spec = indexSpec(source);

    const connector = await documentConnector(connectionId);
    await connector.createIndex(ns, spec);
    return { name: spec.name, keys: spec.keys };
  });
}

function indexSpec(source: Record<string, unknown>): IndexInfo {
  const rawKeys = source.keys;
  if (rawKeys === undefined || rawKeys === null) {
    throw badRequest('"keys" is required, e.g. {"createdAt": -1}.');
  }
  const keySpec = asRecord(rawKeys, '"keys"');
  const keys: Record<string, 1 | -1 | string> = {};
  for (const [field, direction] of Object.entries(keySpec)) {
    if (direction === 1 || direction === -1) keys[field] = direction;
    else if (direction === '1') keys[field] = 1;
    else if (direction === '-1') keys[field] = -1;
    else if (typeof direction === 'string' && direction.length > 0) keys[field] = direction;
    else throw badRequest(`"keys.${field}" must be 1, -1, or an index type such as "text" or "2dsphere".`);
  }
  if (Object.keys(keys).length === 0) throw badRequest('"keys" must name at least one field.');

  const spec: IndexInfo = { name: optionalString(source, 'name') || defaultName(keys), keys };
  const unique = optionalBoolean(source, 'unique');
  if (unique !== undefined) spec.unique = unique;
  const sparse = optionalBoolean(source, 'sparse');
  if (sparse !== undefined) spec.sparse = sparse;
  // 0 is meaningful for a TTL index (expire at the date in the field).
  const ttl = optionalInt(source, 'ttlSeconds', { min: 0 });
  if (ttl !== undefined) spec.ttlSeconds = ttl;
  return spec;
}

/** Mongo's own convention, so a generated name matches what the server would pick. */
function defaultName(keys: Record<string, 1 | -1 | string>): string {
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}
