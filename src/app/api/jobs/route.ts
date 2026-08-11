/**
 * /api/jobs — the jobs drawer's list (PLAN §7.3).
 *
 * The drawer is fed live by the WebSocket `jobs` channel; this route is what it
 * loads on mount and after a page reload, which is the whole point of persisting
 * jobs in the first place. Summaries only — the log tail and the params blob
 * come from /api/jobs/[id].
 *
 * Thin route (§11): validate → call the server layer → serialize.
 */

import type { JobSummary } from '@/lib/api-types';
import { jobManager, type JobKind, type JobStatus } from '@/server/jobs';
import { badRequest, handle } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: readonly JobKind[] = ['export', 'import', 'restore', 'copy'];
const STATUSES: readonly JobStatus[] = ['queued', 'running', 'cancelling', 'done', 'failed', 'cancelled'];

function count(value: string | null, field: string, fallback: number): number {
  if (value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`"${field}" must be a non-negative number.`);
  return Math.floor(n);
}

export async function GET(req: Request): Promise<Response> {
  return handle(() => {
    const params = new URL(req.url).searchParams;

    const kindParam = params.get('kind');
    if (kindParam !== null && !KINDS.includes(kindParam as JobKind)) {
      throw badRequest(`"kind" must be one of: ${KINDS.join(', ')}.`);
    }

    const statusParams = params.getAll('status').filter((s) => s !== '');
    for (const s of statusParams) {
      if (!STATUSES.includes(s as JobStatus)) {
        throw badRequest(`"status" must be one of: ${STATUSES.join(', ')}.`);
      }
    }

    const activeParam = params.get('active');
    const jobs: JobSummary[] = jobManager.list({
      connectionId: params.get('connectionId') ?? undefined,
      kind: kindParam === null ? undefined : (kindParam as JobKind),
      status: statusParams.length > 0 ? (statusParams as JobStatus[]) : undefined,
      // `active` shorthand wins over `status`, matching JobListOptions.
      active: activeParam === '1' || activeParam === 'true',
      limit: count(params.get('limit'), 'limit', 100),
      offset: count(params.get('offset'), 'offset', 0),
    });

    return { jobs };
  });
}
