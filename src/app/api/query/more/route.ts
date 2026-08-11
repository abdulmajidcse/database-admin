/**
 * /api/query/more — advance a server-side cursor (PLAN §6 "Big results").
 *
 * The first page came back with a `cursorId`; this pulls the next chunk from
 * the connector's live cursor. Nothing is buffered on our side, and the count
 * is clamped to the same adaptive page size the first page used (§8.3).
 */

import type { FetchMoreResponse } from '@/lib/api-types';
import { connectionManager } from '@/server/db/manager';
import { isSqlConnector } from '@/server/db/types';
import { asRecord, badRequest, handle, readJson, requireString } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Same ceiling as /api/query: a cursor exists precisely to avoid huge pages. */
const MAX_ROWS_CEILING = 100_000;

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    const cursorId = requireString(body, 'cursorId');

    const connector = await connectionManager.acquire(connectionId);
    if (!isSqlConnector(connector)) throw badRequest(`${connector.kind} has no SQL cursors to advance.`);

    const count = clampRows(body.count, connectionManager.suggestedPageSize(connectionId));
    const chunk: FetchMoreResponse = await connector.fetchMore(cursorId, count);
    return chunk;
  });
}

/**
 * Release a cursor whose tab the user closed. Cursors hold a pooled connection
 * open, so the grid calls this on unmount rather than waiting for the
 * connector's idle timer.
 */
export async function DELETE(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    const cursorId = requireString(body, 'cursorId');

    const connector = await connectionManager.acquire(connectionId);
    if (!isSqlConnector(connector)) throw badRequest(`${connector.kind} has no SQL cursors to close.`);

    await connector.closeCursor(cursorId);
    return { closed: true, cursorId };
  });
}

function clampRows(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest('"count" must be a number.');
  return Math.max(1, Math.min(Math.floor(value), MAX_ROWS_CEILING));
}
