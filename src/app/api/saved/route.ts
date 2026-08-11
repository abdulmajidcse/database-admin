/**
 * /api/saved — saved queries (PLAN §5), folder-organised and optionally bound
 * to a connection.
 *
 * GET lists them; POST creates one, or upserts when the body carries an id, so
 * "save" and "save as" are the same call. Single-record edits live in
 * /api/saved/[id].
 */

import type { SavedQuery } from '@/lib/api-types';
import { savedQueriesRepo } from '@/server/store/db';
import { asRecord, badRequest, handle, optionalString, readJson, requireString } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(() => ({ queries: savedQueriesRepo.list().map(toSaved) }));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const name = requireString(body, 'name').trim();
    if (name === '') throw badRequest('"name" cannot be blank.');
    const sql = requireString(body, 'sql');
    if (sql.trim() === '') throw badRequest('"sql" cannot be blank.');
    if (body.params !== undefined && !Array.isArray(body.params)) {
      throw badRequest('"params" must be an array.');
    }

    const id = savedQueriesRepo.upsert({
      id: nonEmpty(optionalString(body, 'id')),
      name,
      folder: optionalString(body, 'folder') ?? '',
      sql,
      connectionId: readConnectionId(body),
      params: Array.isArray(body.params) ? body.params : undefined,
    });

    const saved = savedQueriesRepo.list().map(toSaved).find((q) => q.id === id);
    if (!saved) throw new Error('The saved query was written but could not be read back.');
    return saved;
  });
}

/** The wire shape is the app database's own columns, so map it explicitly. */
function toSaved(row: Record<string, unknown>): SavedQuery {
  return {
    id: typeof row.id === 'string' ? row.id : String(row.id ?? ''),
    name: typeof row.name === 'string' ? row.name : '',
    folder: typeof row.folder === 'string' ? row.folder : '',
    sql: typeof row.sql === 'string' ? row.sql : '',
    connection_id: typeof row.connection_id === 'string' ? row.connection_id : null,
    updated_at: typeof row.updated_at === 'number' ? row.updated_at : 0,
  };
}

/** Accepts either spelling: the wire shape is snake_case, the repo is camel. */
function readConnectionId(body: Record<string, unknown>): string | null {
  if (typeof body.connectionId === 'string') return body.connectionId || null;
  if (typeof body.connection_id === 'string') return body.connection_id || null;
  return null;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
