/**
 * /api/tree — one level of the object tree (PLAN §6 "Lazy tree, one level at a
 * time").
 *
 * Deliberately capability-agnostic: `listNodes` is on the base `Connector`, so
 * Redis keyspaces and Mongo collections come through exactly this route. The
 * path is the `TreePath.segments` array, e.g. `["db:app", "schema:public"]`.
 *
 * Thin route (§11): validate → call the server layer → serialize.
 */

import type { TreeResponse } from '@/lib/api-types';
import { connectionManager } from '@/server/db/manager';
import { asRecord, badRequest, handle, readJson, requireString } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A tree level is a pure read, so GET is supported too: the sidebar can request
 * it with a plain URL. `?path=` repeats once per segment; a single value may
 * also be slash-joined.
 */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const connectionId = params.get('connectionId');
    if (!connectionId) throw badRequest('"connectionId" is required.');
    const raw = params.getAll('path');
    const path = (raw.length === 1 ? raw[0].split('/') : raw).filter((s) => s !== '');
    return await listLevel(connectionId, path);
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    const raw = body.path;
    if (raw !== undefined && !Array.isArray(raw)) throw badRequest('"path" must be an array of segments.');
    const path = Array.isArray(raw)
      ? raw.filter((s): s is string => typeof s === 'string' && s !== '')
      : [];
    return await listLevel(connectionId, path);
  });
}

async function listLevel(connectionId: string, path: string[]): Promise<TreeResponse> {
  const connector = await connectionManager.acquire(connectionId);
  const nodes = await connector.listNodes({ segments: path });
  return { nodes };
}
