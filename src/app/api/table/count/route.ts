/**
 * /api/table/count — the exact row count behind the current filter.
 *
 * Kept as its own request on purpose (PLAN §6): a `COUNT(*)` on a large table
 * is slow and the first page is not, so the grid renders rows immediately and
 * fills the total in when this lands. The catalog's `rowEstimate` in the schema
 * model covers the cheap-but-approximate case, which is why the response says
 * which of the two this number is.
 */

import type { TableCountResponse } from '@/lib/api-types';
import { connectionManager } from '@/server/db/manager';
import { isSqlConnector, type ColumnFilter, type FilterOperator, type TableReadRequest } from '@/server/db/types';
import { asRecord, badRequest, handle, optionalString, readJson, requireString } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPERATORS: ReadonlySet<string> = new Set<FilterOperator>([
  'eq', 'ne', 'lt', 'lte', 'gt', 'gte',
  'contains', 'startsWith', 'endsWith',
  'isNull', 'isNotNull', 'in', 'between',
]);

type CountRequest = Omit<TableReadRequest, 'offset' | 'limit' | 'orderBy'>;

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    return await count(connectionId, {
      schema: nonEmpty(optionalString(body, 'schema')),
      table: requireString(body, 'table'),
      filters: parseFilters(body.filters),
      where: nonEmpty(optionalString(body, 'where')),
    });
  });
}

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const connectionId = params.get('connectionId');
    if (!connectionId) throw badRequest('"connectionId" is required.');
    const table = params.get('table');
    if (!table) throw badRequest('"table" is required.');
    return await count(connectionId, {
      schema: nonEmpty(params.get('schema') ?? undefined),
      table,
      where: nonEmpty(params.get('where') ?? undefined),
    });
  });
}

async function count(connectionId: string, request: CountRequest): Promise<TableCountResponse> {
  const connector = await connectionManager.acquire(connectionId);
  if (!isSqlConnector(connector)) {
    throw badRequest(`${connector.kind} has no tables to count — browse it through the object tree instead.`);
  }
  const total = await connector.countTable(request);
  // countTable runs a real COUNT(*), so this is never the catalog estimate.
  return { count: total, estimated: false };
}

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

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
