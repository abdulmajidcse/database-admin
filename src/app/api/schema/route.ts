/**
 * /api/schema — the canonical SchemaModel for a connection (PLAN §4, §6).
 *
 * Everything downstream (autocomplete, ER diagram, DDL, diff) reads this one
 * model. The cache does the thinking: get-or-introspect with an adaptive TTL,
 * and `ageMs` is what drives the "schema from 12m ago" indicator next to the
 * refresh button (§6 "Schema cache freshness").
 *
 * `force: true` IS that refresh button, so it never falls back to the stale
 * model — an explicit refresh that failed must say so rather than silently hand
 * back the same thing it already had.
 */

import type { SchemaResponse } from '@/lib/api-types';
import type { IntrospectScope } from '@/lib/schema-model';
import { getSchema, refreshSchema } from '@/server/db/schema-cache';
import { asRecord, badRequest, handle, readJson, requireString } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const connectionId = params.get('connectionId');
    if (!connectionId) throw badRequest('"connectionId" is required.');
    const namespaces = params
      .getAll('namespaces')
      .flatMap((v) => v.split(','))
      .filter((v) => v !== '');
    const scope = buildScope(params.get('database'), namespaces, isTruthy(params.get('shallow')));
    return await load(connectionId, scope, isTruthy(params.get('force')));
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');

    const raw = body.scope === undefined ? {} : asRecord(body.scope, '"scope"');
    if (raw.namespaces !== undefined && !Array.isArray(raw.namespaces)) {
      throw badRequest('"scope.namespaces" must be an array of names.');
    }
    const namespaces = Array.isArray(raw.namespaces)
      ? raw.namespaces.filter((n): n is string => typeof n === 'string' && n !== '')
      : [];
    const scope = buildScope(
      typeof raw.database === 'string' ? raw.database : null,
      namespaces,
      raw.shallow === true,
    );
    return await load(connectionId, scope, body.force === true);
  });
}

async function load(
  connectionId: string,
  scope: IntrospectScope | undefined,
  force: boolean,
): Promise<SchemaResponse> {
  const result = force ? await refreshSchema(connectionId, scope) : await getSchema(connectionId, scope);
  return { model: result.model, fetchedAt: result.fetchedAt, ageMs: result.ageMs };
}

/** An empty scope stays `undefined` so it shares the cache entry of a plain read. */
function buildScope(database: string | null, namespaces: string[], shallow: boolean): IntrospectScope | undefined {
  const scope: IntrospectScope = {};
  if (database) scope.database = database;
  if (namespaces.length > 0) scope.namespaces = namespaces;
  if (shallow) scope.shallow = true;
  return Object.keys(scope).length === 0 ? undefined : scope;
}

function isTruthy(v: string | null): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}
