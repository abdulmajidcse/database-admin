/**
 * POST /api/ddl/plan — PLAN §6 (DDL generation) and §6 trap 3.
 *
 * Takes the current table shape (null for a new table) and the shape the user
 * drew in the table editor, and returns the exact statements that would turn
 * one into the other, plus the warnings the review pane must show before
 * anybody presses Run.
 *
 * Nothing is executed and nothing is rewritten here: for SQLite this is the
 * documented 12-step rebuild, and the plan's value comes from being the literal
 * script, comments and all. The route surfaces what the connector returns and
 * adds only what the connector cannot know — that the connection is read-only,
 * that the script manages its own transaction, that a statement is destructive.
 */

import type { DdlResponse } from '@/lib/api-types';
import type { ColumnModel, EngineKind, TableKind, TableModel } from '@/lib/schema-model';
import { connectionManager } from '@/server/db/manager';
import { classifyStatement, dialectForEngine, isDestructive } from '@/server/db/sql/lexer';
import { connectionsRepo } from '@/server/store/db';
import { asRecord, badRequest, handle, notFound, readJson, requireString } from '../../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TABLE_KINDS: readonly TableKind[] = ['table', 'view', 'materialized_view', 'foreign_table', 'system'];

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<DdlResponse> => {
    const body = asRecord(await readJson(req));
    const connectionId = requireString(body, 'connectionId');
    const desired = parseTable(body.desired, 'desired');
    // `current: null` means CREATE TABLE; anything else must be a real model.
    const current =
      body.current === null || body.current === undefined ? null : parseTable(body.current, 'current');

    const config = connectionsRepo.get(connectionId);
    if (!config) throw notFound(`No such connection: ${connectionId}`);

    const connector = await connectionManager.acquireSql(connectionId);
    if (!connector.capabilities.has('ddl')) {
      throw badRequest(`${connector.kind} connections do not support DDL generation.`);
    }

    const statements = await connector.planTableDdl(current, desired);
    return { statements, warnings: collectWarnings(statements, connector.kind, config.readOnly) };
  });
}

/**
 * Everything the review pane needs that is not in the SQL itself.
 *
 * SQLite's rebuild embeds `-- WARNING:` lines in its copy step (a new NOT NULL
 * column with no default will fail the INSERT), so those are lifted out of the
 * script rather than left for the user to spot inside a 14-statement listing.
 */
function collectWarnings(statements: string[], engine: EngineKind, readOnly: boolean): string[] {
  const warnings: string[] = [];
  const dialect = dialectForEngine(engine);

  if (readOnly) {
    warnings.push('This connection is marked read-only, so executing this script will be refused.');
  }

  for (const stmt of statements) {
    for (const line of stmt.split('\n')) {
      const trimmed = line.trim();
      if (/^--\s*WARNING\b/i.test(trimmed)) warnings.push(trimmed.replace(/^--\s*/, ''));
    }
  }

  // §9: name every destructive statement, so the editor can demand the typed
  // confirmation before it posts the script to /api/ddl/execute.
  statements.forEach((stmt, i) => {
    const verdict = isDestructive(stmt, dialect);
    if (!verdict.destructive) return;
    warnings.push(`Statement ${i + 1} is destructive: ${verdict.reason ?? 'data will be lost'}`);
  });

  // Trap 3: the 12-step rebuild owns its BEGIN/COMMIT and keeps the
  // `PRAGMA foreign_keys` toggles outside it, because that pragma is a no-op
  // inside a transaction. The executor must not wrap it in a second one.
  if (statements.some((s) => classifyStatement(s, dialect) === 'transaction')) {
    warnings.push(
      'This script manages its own transaction (SQLite cannot alter the table in place, so this is the 12-step rebuild); it will be run exactly as written, not wrapped in another transaction.',
    );
  }

  // MySQL/MariaDB commit implicitly around DDL, so a multi-statement plan is
  // not atomic there however it is run.
  if ((engine === 'mysql' || engine === 'mariadb') && statements.length > 1) {
    warnings.push(
      'MySQL commits implicitly before and after each DDL statement, so these statements cannot be rolled back as a group — a failure part-way leaves the earlier ones applied.',
    );
  }

  return warnings;
}

/**
 * The table editor may omit the collections it did not touch; the DDL
 * generators iterate them unconditionally, so they are filled in here instead
 * of being guarded at a dozen call sites inside the connectors.
 */
function parseTable(value: unknown, label: string): TableModel {
  const t = asRecord(value, `"${label}"`);

  const name = requireString(t, 'name', `${label} field`);
  if (t.schema !== undefined && t.schema !== null && typeof t.schema !== 'string') {
    throw badRequest(`"${label}.schema" must be a string when present.`);
  }
  if (t.kind !== undefined && !TABLE_KINDS.includes(t.kind as TableKind)) {
    throw badRequest(`"${label}.kind" must be one of: ${TABLE_KINDS.join(', ')}.`);
  }
  if (!Array.isArray(t.columns) || t.columns.length === 0) {
    throw badRequest(`"${label}.columns" must be a non-empty array.`);
  }

  const columns = t.columns.map((c, i) => parseColumn(c, `${label}.columns[${i}]`, i));
  const names = new Set<string>();
  for (const c of columns) {
    if (names.has(c.name)) throw badRequest(`"${label}" has two columns named "${c.name}".`);
    names.add(c.name);
  }

  const primaryKey = Array.isArray(t.primaryKey)
    ? t.primaryKey.filter((k): k is string => typeof k === 'string')
    : [];
  for (const k of primaryKey) {
    if (!names.has(k)) {
      throw badRequest(`"${label}.primaryKey" names "${k}", which is not one of its columns.`);
    }
  }

  return {
    ...(t as unknown as TableModel),
    name,
    schema: typeof t.schema === 'string' ? t.schema : undefined,
    kind: (t.kind as TableKind | undefined) ?? 'table',
    columns,
    indexes: Array.isArray(t.indexes) ? (t.indexes as TableModel['indexes']) : [],
    foreignKeys: Array.isArray(t.foreignKeys) ? (t.foreignKeys as TableModel['foreignKeys']) : [],
    checks: Array.isArray(t.checks) ? (t.checks as TableModel['checks']) : [],
    primaryKey,
  };
}

function parseColumn(value: unknown, label: string, position: number): ColumnModel {
  const c = asRecord(value, `"${label}"`);
  const name = requireString(c, 'name', `${label} field`);

  const type = asRecord(c.type, `"${label}.type"`);
  if (typeof type.raw !== 'string' || type.raw === '') {
    throw badRequest(`"${label}.type.raw" must be the engine's own spelling of the type.`);
  }

  return {
    ...(c as unknown as ColumnModel),
    name,
    // A column with no declared position keeps the order it was sent in.
    position: typeof c.position === 'number' ? c.position : position + 1,
    // SQL's default is nullable; only an explicit `false` means NOT NULL.
    nullable: c.nullable !== false,
    defaultValue: typeof c.defaultValue === 'string' ? c.defaultValue : null,
  };
}
