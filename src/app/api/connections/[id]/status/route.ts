/**
 * Live status for one connection (PLAN §8.3).
 *
 * What the status bar polls: state, measured RTT, server version, whether the
 * link is tunneled, and how many pinned sessions and in-flight runs it carries.
 * Read-only and cheap — it reports what the manager already knows and never
 * opens anything, so polling it cannot resurrect a connection the user closed.
 */

import { connectionManager } from '@/server/db/manager';
import { handle, notFound } from '../../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(() => {
    const status = connectionManager.status(id);
    if (!status) throw notFound(`No such connection: ${id}`);
    return status;
  });
}
