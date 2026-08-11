/**
 * /api/processes/kill — terminate one server-side session (PLAN §6).
 *
 * Same capability rule as the list: an engine with no process list has nothing
 * to kill and answers 501. The connectors decide what "kill" means for their
 * engine (`KILL <id>`, `pg_terminate_backend`, `CLIENT KILL`, `killOp`) and
 * enforce their own read-only refusal, so this route only routes.
 */

import { connectionManager } from '@/server/db/manager';
import type { Connector } from '@/server/db/types';
import { asRecord, badRequest, handle, HttpError, readJson, requireString } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ProcessKiller = Connector & { killProcess(id: string): Promise<void> };

function canKillProcesses(connector: Connector): connector is ProcessKiller {
  return typeof (connector as Partial<ProcessKiller>).killProcess === 'function';
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    // Process ids are strings on the wire — MySQL's are numeric, Mongo's are
    // not — but a client that sends the number it was given is not wrong.
    const id = typeof body.id === 'number' && Number.isFinite(body.id) ? String(body.id) : body.id;
    if (typeof id !== 'string' || id === '') throw badRequest('"id" is required (the process id to kill).');

    const connector = await connectionManager.acquire(connectionId);
    if (!canKillProcesses(connector)) {
      throw new HttpError(`${connector.kind} has no server-side sessions to kill.`, 501, {
        code: 'UNSUPPORTED_CAPABILITY',
      });
    }
    await connector.killProcess(id);
    return { killed: true, id };
  });
}
