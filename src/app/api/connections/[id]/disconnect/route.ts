/**
 * Close a connection explicitly (PLAN §6, §8.3).
 *
 * `close()` cancels in-flight runs, rolls back and releases pinned transaction
 * sessions, and drops the AccessResolver's tunnel reference — which is exactly
 * what "Disconnect" has to mean, or an SSH tunnel outlives the thing that
 * needed it. Disconnecting a connection that was never open is a no-op, so the
 * button is always safe to press.
 */

import { connectionManager } from '@/server/db/manager';
import { connectionsRepo } from '@/server/store/db';
import { handle, notFound } from '../../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(async () => {
    if (!connectionsRepo.get(id)) throw notFound(`No such connection: ${id}`);
    await connectionManager.close(id, 'Disconnected.');
    return connectionManager.status(id);
  });
}
