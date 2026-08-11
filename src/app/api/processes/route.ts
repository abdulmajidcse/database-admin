/**
 * /api/processes — the live session/process list (PLAN §6 power tools).
 *
 * Not every engine has one: MySQL has `SHOW PROCESSLIST`, Postgres has
 * `pg_stat_activity`, Redis has `CLIENT LIST` and Mongo has `currentOp`, but
 * SQLite has no server at all. The capability is therefore checked structurally
 * — `listProcesses` is optional on SqlConnector and required on the document
 * connector — and an engine without one answers 501 with a message that says
 * so, rather than an empty list pretending everything is idle.
 *
 * This is the pull path; the same data streams over the `processes` WebSocket
 * channel for the live monitor.
 */

import type { ProcessListResponse } from '@/lib/api-types';
import type { ProcessInfo } from '@/lib/results';
import { connectionManager } from '@/server/db/manager';
import type { Connector } from '@/server/db/types';
import { asRecord, badRequest, handle, HttpError, readJson, requireString } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ProcessLister = Connector & { listProcesses(): Promise<ProcessInfo[]> };

function canListProcesses(connector: Connector): connector is ProcessLister {
  return typeof (connector as Partial<ProcessLister>).listProcesses === 'function';
}

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const connectionId = new URL(req.url).searchParams.get('connectionId');
    if (!connectionId) throw badRequest('"connectionId" is required.');
    return await list(connectionId);
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    return await list(requireString(body, 'connectionId'));
  });
}

async function list(connectionId: string): Promise<ProcessListResponse> {
  const connector = await connectionManager.acquire(connectionId);
  if (!canListProcesses(connector)) {
    throw new HttpError(`${connector.kind} does not expose a server-side process list.`, 501, {
      code: 'UNSUPPORTED_CAPABILITY',
    });
  }
  return { processes: await connector.listProcesses() };
}
