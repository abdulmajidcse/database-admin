/**
 * /api/saved/[id] — read, update or delete one saved query (PLAN §5).
 *
 * PUT merges onto the stored row instead of replacing it, so renaming a query
 * from a dialog that only knows the name cannot blank out its SQL. Next 16
 * hands route params in as a promise.
 */

import type { SavedQuery } from '@/lib/api-types';
import { savedQueriesRepo } from '@/server/store/db';
import { asRecord, badRequest, handle, notFound, optionalString, readJson } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await params;
    const row = findRow(id);
    if (!row) throw notFound(`No such saved query: ${id}`);
    return toSaved(row);
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await params;
    const body = asRecord(await readJson(req));
    const row = findRow(id);
    if (!row) throw notFound(`No such saved query: ${id}`);
    const current = toSaved(row);

    const name = (optionalString(body, 'name') ?? current.name).trim();
    if (name === '') throw badRequest('"name" cannot be blank.');
    const sql = optionalString(body, 'sql') ?? current.sql;
    if (sql.trim() === '') throw badRequest('"sql" cannot be blank.');
    if (body.params !== undefined && !Array.isArray(body.params)) {
      throw badRequest('"params" must be an array.');
    }

    savedQueriesRepo.upsert({
      id,
      name,
      folder: optionalString(body, 'folder') ?? current.folder,
      sql,
      connectionId: readConnectionId(body, current.connection_id),
      // Params are not part of the wire shape, so an update that ignores them
      // must not silently drop the ones already stored.
      params: Array.isArray(body.params) ? body.params : storedParams(row),
    });

    const updated = findRow(id);
    if (!updated) throw new Error('The saved query was written but could not be read back.');
    return toSaved(updated);
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await params;
    savedQueriesRepo.remove(id);
    // Idempotent on purpose: deleting a query twice is not an error worth a
    // dialog, and the tab that held it may already be gone.
    return { deleted: true, id };
  });
}

function findRow(id: string): Record<string, unknown> | undefined {
  return savedQueriesRepo.list().find((r) => String(r.id ?? '') === id);
}

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

function storedParams(row: Record<string, unknown>): unknown[] | undefined {
  if (typeof row.params_json !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(row.params_json);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `null` clears the binding; an absent field keeps whatever was stored. */
function readConnectionId(body: Record<string, unknown>, fallback: string | null): string | null {
  if (body.connectionId === null || body.connection_id === null) return null;
  if (typeof body.connectionId === 'string') return body.connectionId || null;
  if (typeof body.connection_id === 'string') return body.connection_id || null;
  return fallback;
}
