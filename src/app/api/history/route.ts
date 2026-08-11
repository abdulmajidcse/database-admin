/**
 * /api/history — the query log (PLAN §5: it lives in the app database, so it
 * survives a restart and stays searchable).
 *
 * Every execution that goes through /api/query is written here, including the
 * ones that failed or were cancelled — the query you got wrong is usually the
 * one you want back.
 */

import type { HistoryEntry } from '@/lib/api-types';
import { historyRepo } from '@/server/store/db';
import { badRequest, handle } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The list is a palette, not an archive view; a huge page helps nobody. */
const MAX_LIMIT = 1_000;
const DEFAULT_LIMIT = 200;

export async function GET(req: Request): Promise<Response> {
  return handle(() => {
    const params = new URL(req.url).searchParams;
    const rows = historyRepo.list({
      connectionId: params.get('connectionId') || undefined,
      search: params.get('search') || undefined,
      limit: clampLimit(params.get('limit')),
    });
    const entries: HistoryEntry[] = rows.map(toEntry);
    return { entries };
  });
}

/** Clear everything, or just one connection's rows with `?connectionId=`. */
export async function DELETE(req: Request): Promise<Response> {
  return handle(async () => {
    const connectionId = (await connectionIdFor(req)) ?? undefined;
    historyRepo.clear(connectionId);
    return { cleared: true, connectionId: connectionId ?? null };
  });
}

/**
 * A DELETE may carry the scope in the query string or in a JSON body; a body
 * that is absent or unparseable means "clear everything", which is exactly what
 * a bodyless DELETE asks for.
 */
async function connectionIdFor(req: Request): Promise<string | null> {
  const fromQuery = new URL(req.url).searchParams.get('connectionId');
  if (fromQuery) return fromQuery;
  const text = await req.text().catch(() => '');
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = (parsed as Record<string, unknown>).connectionId;
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The repo hands back raw rows, so the snake_case wire shape is built here
 * rather than trusting the column list to match the contract by accident.
 */
function toEntry(row: Record<string, unknown>): HistoryEntry {
  return {
    id: Number(row.id ?? 0),
    connection_id: typeof row.connection_id === 'string' ? row.connection_id : null,
    sql: typeof row.sql === 'string' ? row.sql : '',
    db_context: typeof row.db_context === 'string' ? row.db_context : null,
    started_at: Number(row.started_at ?? 0),
    duration_ms: numberOrNull(row.duration_ms),
    row_count: numberOrNull(row.row_count),
    status: typeof row.status === 'string' ? row.status : 'unknown',
    error: typeof row.error === 'string' ? row.error : null,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest('"limit" must be a number.');
  return Math.max(1, Math.min(Math.floor(n), MAX_LIMIT));
}
