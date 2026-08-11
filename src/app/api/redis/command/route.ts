/**
 * POST /api/redis/command — the raw CLI console.
 *
 * Two refusals come back from the connector and both deserve a status of their
 * own rather than a generic 400:
 *
 *  - PLAN §8.5: Redis has no server-side read-only session, so a read-only
 *    connection enforces a client-side blocklist. That is a 403, and the
 *    message already names the `_RO` variant where one exists.
 *  - PLAN §6: MONITOR / SUBSCRIBE / MULTI put a connection into a mode where no
 *    other command works. They are refused here and pointed at the panels that
 *    own a dedicated socket.
 */

import type { RedisCommandRequest } from '@/lib/api-types';
import { DbError } from '@/server/db/types';
import { asRecord, badRequest, handle, HttpError, readJson, requireString } from '../../lib/respond';
import { keyValueConnector, optionalInt, selectDb } from '../_common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<{ argv: string[]; result: unknown; durationMs: number }> => {
    const body = asRecord(await readJson<unknown>(req));
    const request: RedisCommandRequest = {
      connectionId: requireString(body, 'connectionId'),
      argv: parseArgv(body.argv),
    };

    const connector = await keyValueConnector(request.connectionId);
    await selectDb(connector, optionalInt(body, 'db', { min: 0, max: 255 }));

    const started = performance.now();
    try {
      const result = await connector.command(request.argv);
      return { argv: request.argv, result, durationMs: performance.now() - started };
    } catch (err) {
      throw consoleError(err);
    }
  });
}

/** The console splits the typed line; every token reaches Redis as text. */
function parseArgv(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw badRequest('"argv" must be an array, e.g. ["GET", "user:1"].');
  if (raw.length === 0) throw badRequest('"argv" must contain at least the command name.');
  const argv = raw.map((token: unknown, i: number) => {
    if (typeof token === 'string') return token;
    // Numbers and booleans are what a JSON-typed console sends for `SETEX k 60 v`.
    if (typeof token === 'number' && Number.isFinite(token)) return String(token);
    if (typeof token === 'boolean') return String(token);
    throw badRequest(`"argv[${i}]" must be a string.`);
  });
  if (argv[0].trim() === '') throw badRequest('"argv[0]" must be the command name.');
  return argv;
}

function consoleError(err: unknown): unknown {
  if (!(err instanceof DbError)) return err;
  switch (err.code) {
    case 'READONLY_CONNECTION':
      return new HttpError(err.message, 403, {
        code: err.code,
        hint: 'Clear "read-only" on the connection to run write commands against it.',
      });
    case 'CONNECTION_MODE':
      return new HttpError(err.message, 409, {
        code: err.code,
        hint: 'The Monitor and Pub/Sub panels stream over the WebSocket on their own connection.',
      });
    default:
      return err;
  }
}
