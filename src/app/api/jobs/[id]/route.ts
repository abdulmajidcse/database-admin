/**
 * /api/jobs/[id] — one job in full, and removal (PLAN §7.3).
 *
 * GET carries the ring-buffer log tail, which is what makes a failed export
 * diagnosable after the drawer was closed and the page reloaded. DELETE cancels
 * first when the job is still running, so "remove" can never orphan a child
 * process or leave a query running server-side.
 *
 * Thin route (§11): validate → call the server layer → serialize.
 */

import { jobManager } from '@/server/jobs';
import { handle, notFound, ok } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await params;
    // Live jobs answer from memory; finished ones from the `jobs` table.
    const detail = jobManager.get(id);
    if (!detail) throw notFound(`No job with id "${id}".`);
    return detail;
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await params;
    const existed = await jobManager.remove(id);
    if (!existed) throw notFound(`No job with id "${id}".`);
    return ok({ removed: true });
  });
}
