/**
 * /api/jobs/[id]/cancel (PLAN §7.3).
 *
 * Cancel is not a status flag: the manager aborts the runner, fires the cancel
 * hooks that kill the DB-side query, and SIGTERMs then SIGKILLs any child
 * process. A `pg_dump` killed only on this side leaves its backend running on
 * the server, which is the failure this route exists to avoid.
 *
 * Returns immediately — a cancel that has to wait out the SIGTERM grace period
 * would otherwise hold the request open for eight seconds. The drawer learns the
 * outcome from the `jobs` WebSocket channel.
 *
 * Thin route (§11): validate → call the server layer → serialize.
 */

import { jobManager } from '@/server/jobs';
import { handle, notFound } from '../../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await params;
    if (!jobManager.get(id)) throw notFound(`No job with id "${id}".`);
    // False means it was already finished (or already cancelling) — not an
    // error, just nothing left to stop.
    const cancelling = await jobManager.cancel(id);
    return { ok: true, cancelling };
  });
}
