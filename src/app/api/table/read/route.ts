/**
 * /api/table/read — a page of a table with server-side sort and filter
 * (PLAN §6 "Big results": the grid never receives a whole table).
 *
 * The connector builds the SQL, because only it knows the engine's quoting and
 * placeholder style — the route just validates the request shape. Sorting and
 * filtering are deliberately server-side: sorting 40 million rows in the
 * browser is not a feature, it is a hang.
 *
 * Table reads are not user-written SQL, so they are NOT recorded in the query
 * history — scrolling a grid would otherwise bury the queries you actually typed.
 */

import type { ResultSet } from '@/lib/results';
import { connectionManager } from '@/server/db/manager';
import { isSqlConnector, type ColumnFilter, type FilterOperator, type TableReadRequest } from '@/server/db/types';
import { asRecord, badRequest, handle, optionalString, readJson, requireString } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** §6: a page is a page. Above this the cursor exists for a reason. */
const MAX_ROWS_CEILING = 100_000;

const OPERATORS: ReadonlySet<string> = new Set<FilterOperator>([
  'eq', 'ne', 'lt', 'lte', 'gt', 'gte',
  'contains', 'startsWith', 'endsWith',
  'isNull', 'isNotNull', 'in', 'between',
]);

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    const request: TableReadRequest = {
      schema: nonEmpty(optionalString(body, 'schema')),
      table: requireString(body, 'table'),
      offset: clampOffset(body.offset),
      limit: clampRows(body.limit, connectionManager.suggestedPageSize(connectionId)),
      orderBy: parseOrderBy(body.orderBy),
      filters: parseFilters(body.filters),
      where: nonEmpty(optionalString(body, 'where')),
    };
    return await read(connectionId, request);
  });
}

/**
 * GET covers the plain "open this table" case so the grid can use a cacheable
 * URL: `?orderBy=name:asc,id:desc`. Structured filters need the POST body.
 */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const connectionId = params.get('connectionId');
    if (!connectionId) throw badRequest('"connectionId" is required.');
    const table = params.get('table');
    if (!table) throw badRequest('"table" is required.');

    const request: TableReadRequest = {
      schema: nonEmpty(params.get('schema') ?? undefined),
      table,
      offset: clampOffset(numberParam(params.get('offset'), 'offset')),
      limit: clampRows(numberParam(params.get('limit'), 'limit'), connectionManager.suggestedPageSize(connectionId)),
      orderBy: parseOrderByParam(params.get('orderBy')),
      where: nonEmpty(params.get('where') ?? undefined),
    };
    return await read(connectionId, request);
  });
}

async function read(connectionId: string, request: TableReadRequest): Promise<ResultSet> {
  const connector = await connectionManager.acquire(connectionId);
  if (!isSqlConnector(connector)) {
    throw badRequest(
      `${connector.kind} has no tables to page through — browse it through the object tree instead.`,
    );
  }
  return connector.readTable(request);
}

// ---------------------------------------------------------------------------
// Validation. Nothing here is interpolated into SQL — the connector quotes the
// identifiers and binds the values — but a malformed shape must fail loudly
// rather than reach the driver.
// ---------------------------------------------------------------------------

function parseFilters(raw: unknown): ColumnFilter[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw badRequest('"filters" must be an array.');
  const out: ColumnFilter[] = [];
  for (const item of raw) {
    const f = asRecord(item, 'Each filter');
    const column = typeof f.column === 'string' && f.column !== '' ? f.column : '';
    if (!column) throw badRequest('Each filter needs a "column".');
    const op = typeof f.op === 'string' ? f.op : '';
    if (!OPERATORS.has(op)) throw badRequest(`Unknown filter operator: ${op || '(none)'}`);
    const filter: ColumnFilter = { column, op: op as FilterOperator };
    if (typeof f.value === 'string') filter.value = f.value;
    if (typeof f.value2 === 'string') filter.value2 = f.value2;
    if (Array.isArray(f.values)) filter.values = f.values.filter((v): v is string => typeof v === 'string');
    if (filter.op === 'between' && (filter.value === undefined || filter.value2 === undefined)) {
      throw badRequest(`The "between" filter on ${column} needs both bounds.`);
    }
    if (filter.op === 'in' && (filter.values === undefined || filter.values.length === 0)) {
      throw badRequest(`The "in" filter on ${column} needs at least one value.`);
    }
    out.push(filter);
  }
  return out.length > 0 ? out : undefined;
}

function parseOrderBy(raw: unknown): TableReadRequest['orderBy'] {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw badRequest('"orderBy" must be an array.');
  const out: { column: string; direction: 'asc' | 'desc' }[] = [];
  for (const item of raw) {
    const o = asRecord(item, 'Each orderBy entry');
    const column = typeof o.column === 'string' ? o.column : '';
    if (!column) throw badRequest('Each orderBy entry needs a "column".');
    out.push({ column, direction: o.direction === 'desc' ? 'desc' : 'asc' });
  }
  return out.length > 0 ? out : undefined;
}

/** `name:asc,created_at:desc` — the URL form of the same thing. */
function parseOrderByParam(raw: string | null): TableReadRequest['orderBy'] {
  if (!raw) return undefined;
  const out: { column: string; direction: 'asc' | 'desc' }[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    // Split on the LAST colon: a quoted column name may contain one.
    const idx = trimmed.lastIndexOf(':');
    const column = idx === -1 ? trimmed : trimmed.slice(0, idx);
    const direction = idx === -1 ? 'asc' : trimmed.slice(idx + 1).toLowerCase();
    if (column === '') throw badRequest('Each orderBy entry needs a column.');
    out.push({ column, direction: direction === 'desc' ? 'desc' : 'asc' });
  }
  return out.length > 0 ? out : undefined;
}

function clampOffset(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest('"offset" must be a number.');
  return Math.max(0, Math.floor(value));
}

function clampRows(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest('"limit" must be a number.');
  return Math.max(1, Math.min(Math.floor(value), MAX_ROWS_CEILING));
}

function numberParam(raw: string | null, field: string): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`"${field}" must be a number.`);
  return n;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
