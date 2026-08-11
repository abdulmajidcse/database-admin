/**
 * POST /api/mongo/explain — `executionStats` explain for a find.
 *
 * Response: `ExplainPlan`, the same shape the SQL engines produce, so the plan
 * visualizer is one component (PLAN §6 power tools). The connector mirrors
 * exactly what `find` would send — including the implicit `_id` sort — because
 * a plan for a different query is worse than no plan.
 */

import type { ExplainPlan } from '@/lib/results';
import { asRecord, handle, readJson, requireString } from '../../lib/respond';
import { documentConnector, documentField, findOptsOf, namespaceOf } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<ExplainPlan> => {
    const body = asRecord(await readJson<unknown>(req));
    const connectionId = requireString(body, 'connectionId');
    const ns = namespaceOf(body);
    const filter = documentField(body, 'filter');
    const opts = findOptsOf(body, connectionId);

    const connector = await documentConnector(connectionId);
    return connector.explainFind(ns, filter, opts);
  });
}
