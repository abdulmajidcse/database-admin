/**
 * POST /api/compare — schema compare (PLAN §6 power tools, M8).
 *
 * Introspect both sides into the canonical `SchemaModel`, diff the models, then
 * render migration DDL from the diff. The whole point of §4's engine-neutral
 * model is that the differ never touches a driver: it compares two plain
 * objects, so MySQL↔Postgres works for free and the engine quirks stay behind
 * the connector boundary.
 *
 * Direction: `source` is the desired state (usually dev), `target` is the
 * database that would be changed (usually prod). The generated statements are
 * written for the TARGET's engine, because that is where they would run.
 *
 * Both introspections go through the schema cache, so comparing twice in a row
 * costs no round trips, and they run in parallel — on a 180 ms link doing them
 * one after the other doubles the wait for nothing (§8.3).
 */

import type { CompareResponse } from '@/lib/api-types';
import type { IntrospectScope } from '@/lib/schema-model';
import { getSchema } from '@/server/db/schema-cache';
import { diffSchemas } from '@/server/db/schema/differ';
import { generateMigration } from '@/server/db/schema/migration';
import { asRecord, badRequest, handle, readJson, requireString } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<CompareResponse> => {
    const body = asRecord(await readJson(req));
    const sourceConnectionId = requireString(body, 'sourceConnectionId');
    const targetConnectionId = requireString(body, 'targetConnectionId');
    const sourceScope = parseScope(body.sourceScope, 'sourceScope');
    const targetScope = parseScope(body.targetScope, 'targetScope');
    const options = parseOptions(body.options);

    // Two independent connections: introspect them at the same time.
    const [source, target] = await Promise.all([
      getSchema(sourceConnectionId, sourceScope),
      getSchema(targetConnectionId, targetScope),
    ]);

    const diff = diffSchemas(source.model, target.model, options);
    const migration = generateMigration(diff, target.model.engine);

    const warnings = [...migration.warnings];
    if (source.model.engine !== target.model.engine) {
      warnings.unshift(
        `Source is ${source.model.engine} and target is ${target.model.engine}: the script is generated for ${target.model.engine}, and type mapping between two engines can be lossy — review every column type before running it.`,
      );
    }
    // A stale side silently produces a wrong migration, so say so loudly.
    if (target.staleReason) warnings.unshift(`Target schema: ${target.staleReason}`);
    if (source.staleReason) warnings.unshift(`Source schema: ${source.staleReason}`);

    return { diff, migration: { ...migration, warnings } };
  });
}

function parseScope(value: unknown, label: string): IntrospectScope | undefined {
  if (value === undefined || value === null) return undefined;
  const s = asRecord(value, `"${label}"`);

  if (s.database !== undefined && typeof s.database !== 'string') {
    throw badRequest(`"${label}.database" must be a string.`);
  }
  if (s.namespaces !== undefined) {
    if (!Array.isArray(s.namespaces) || s.namespaces.some((n) => typeof n !== 'string')) {
      throw badRequest(`"${label}.namespaces" must be an array of namespace names.`);
    }
  }
  return {
    database: s.database as string | undefined,
    namespaces: s.namespaces as string[] | undefined,
    shallow: s.shallow === true,
  };
}

/** Unknown option keys are dropped rather than passed through to the differ. */
function parseOptions(value: unknown): {
  ignoreCase: boolean;
  ignoreCollation: boolean;
  ignoreComments: boolean;
  ignoreIndexNames: boolean;
} {
  const o = value === undefined || value === null ? {} : asRecord(value, '"options"');
  return {
    ignoreCase: o.ignoreCase === true,
    ignoreCollation: o.ignoreCollation === true,
    ignoreComments: o.ignoreComments === true,
    ignoreIndexNames: o.ignoreIndexNames === true,
  };
}
