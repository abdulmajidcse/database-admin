/**
 * Shared validation for the MongoDB routes (PLAN §11: route handlers stay thin
 * — validate, call the server layer, serialize).
 *
 * Not a route: Next only treats `route.ts` / `page.tsx` as segments, so this
 * file is plain module code the sibling handlers import.
 *
 * Filters, pipelines and documents arrive as **Extended JSON text** and are
 * parsed here with `EJSON.parse` — never `eval`, never `JSON.parse` (PLAN §6
 * "Type fidelity": `{"_id":{"$oid":"…"}}` has to come back as a real ObjectId,
 * and `$numberDecimal` as a Decimal128). Malformed text is a 400 that quotes
 * the parser, not a 500.
 */

import { EJSON } from 'bson';

import type { FindOpts, Namespace } from '@/lib/results';
import { connectionManager } from '@/server/db/manager';
import { isDocumentConnector, type DocumentConnector } from '@/server/db/types';
import { asRecord, badRequest } from '../lib/respond';

// ---------------------------------------------------------------------------
// Connector + namespace
// ---------------------------------------------------------------------------

export async function documentConnector(connectionId: string): Promise<DocumentConnector> {
  const connector = await connectionManager.acquire(connectionId);
  if (!isDocumentConnector(connector)) {
    throw badRequest(`This is a ${connector.kind} connection, which has no collections.`, {
      code: 'UNSUPPORTED_CAPABILITY',
      hint: 'The MongoDB endpoints only accept connections to a document engine.',
    });
  }
  return connector;
}

export function namespaceOf(body: Record<string, unknown>): Namespace {
  return { database: requireName(body, 'database'), collection: requireName(body, 'collection') };
}

/**
 * A database or collection name. `$` and NUL are rejected outright: they cannot
 * appear in a legal name, and a name arriving with one is a sign the caller
 * concatenated something it should not have.
 */
export function requireName(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`"${field}" is required (a non-empty string).`);
  }
  if (value.includes('\0')) throw badRequest(`"${field}" contains a NUL character.`);
  return value;
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

/** Query string of a GET, so read-only routes work with `api.get()`. */
export function queryOf(req: Request): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URL(req.url).searchParams) out[key] = value;
  return out;
}

/** Accepts a number or a numeric string, because GET params are always strings. */
export function optionalInt(
  body: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw badRequest(`"${field}" must be an integer.`);
  if (opts.min !== undefined && value < opts.min) throw badRequest(`"${field}" must be at least ${opts.min}.`);
  if (opts.max !== undefined && value > opts.max) throw badRequest(`"${field}" must be at most ${opts.max}.`);
  return value;
}

export function optionalBool(body: Record<string, unknown>, field: string): boolean | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw badRequest(`"${field}" must be true or false.`);
}

// ---------------------------------------------------------------------------
// Extended JSON
// ---------------------------------------------------------------------------

/**
 * Parse Extended JSON text. Canonical (`relaxed: false`) so `$numberLong`,
 * `$oid` and `$date` decode to the BSON types they name — the same mode the
 * connector uses, which is what makes read → edit → write round-trip losslessly.
 */
function parseEjson(text: string, field: string): unknown {
  try {
    return EJSON.parse(text, { relaxed: false }) as unknown;
  } catch (err) {
    throw badRequest(`"${field}" is not valid Extended JSON: ${(err as Error).message}`, {
      code: 'BAD_EJSON',
      hint: 'Field names and strings need double quotes; ObjectIds are written {"$oid": "…"}.',
    });
  }
}

/**
 * A filter / document field. Accepts Extended JSON *text* (what the query bar
 * sends) or an already-decoded object (what the grid sends, whose tagged cells
 * the connector decodes). Absent or empty means "match everything".
 */
export function documentField(body: Record<string, unknown>, field: string, required = false): unknown {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    if (required) throw badRequest(`"${field}" is required.`);
    return {};
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') {
      if (required) throw badRequest(`"${field}" is required.`);
      return {};
    }
    const parsed = parseEjson(text, field);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest(`"${field}" must be a JSON object, e.g. {"status": "active"}.`);
    }
    return parsed;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest(`"${field}" must be a JSON object or Extended JSON text.`);
  }
  return raw;
}

/** An aggregation pipeline: Extended JSON text for an array, or the array itself. */
export function pipelineField(body: Record<string, unknown>, field = 'pipeline'): unknown[] {
  const raw = body[field];
  const value =
    typeof raw === 'string'
      ? parseEjson(raw.trim() === '' ? '[]' : raw, field)
      : raw === undefined || raw === null
        ? []
        : raw;
  if (!Array.isArray(value)) {
    throw badRequest(`"${field}" must be a JSON array of stages, e.g. [{"$match": {}}].`);
  }
  value.forEach((stage: unknown, i: number) => {
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      throw badRequest(`"${field}[${i}]" must be a stage object such as {"$group": …}.`);
    }
  });
  return value as unknown[];
}

/** One or many documents, for insert. */
export function documentListField(body: Record<string, unknown>, field: string): unknown[] {
  const raw = body[field];
  if (raw === undefined || raw === null) throw badRequest(`"${field}" is required.`);

  const value = typeof raw === 'string' ? parseEjson(raw.trim() === '' ? '[]' : raw, field) : raw;
  const list: unknown[] = Array.isArray(value) ? value : [value];
  if (list.length === 0) throw badRequest(`"${field}" must contain at least one document.`);
  list.forEach((doc: unknown, i: number) => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw badRequest(`"${field}[${i}]" must be a JSON object.`);
    }
  });
  return list;
}

/** A list of `_id` values, for delete. Tagged grid cells pass through untouched. */
export function idListField(body: Record<string, unknown>, field: string): unknown[] {
  const raw = body[field];
  if (raw === undefined || raw === null) throw badRequest(`"${field}" is required (an array of _id values).`);
  const value = typeof raw === 'string' ? parseEjson(raw.trim() === '' ? '[]' : raw, field) : raw;
  if (!Array.isArray(value)) throw badRequest(`"${field}" must be an array of _id values.`);
  // `_id: null` is legal, so only `undefined` (a hole in the array) is rejected.
  value.forEach((id: unknown, i: number) => {
    if (id === undefined) throw badRequest(`"${field}[${i}]" is missing.`);
  });
  return value as unknown[];
}

// ---------------------------------------------------------------------------
// find/explain options
// ---------------------------------------------------------------------------

/**
 * `sort` and `projection` are Extended JSON text too, but their values are
 * plain direction flags — so they are parsed in relaxed mode (numbers stay
 * numbers) and then checked against what the contract allows.
 */
function specField(body: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return undefined;
    let parsed: unknown;
    try {
      parsed = EJSON.parse(text, { relaxed: true }) as unknown;
    } catch (err) {
      throw badRequest(`"${field}" is not valid JSON: ${(err as Error).message}`, { code: 'BAD_EJSON' });
    }
    return asRecord(parsed, `"${field}"`);
  }
  return asRecord(raw, `"${field}"`);
}

export function sortField(body: Record<string, unknown>, field = 'sort'): Record<string, 1 | -1> | undefined {
  const spec = specField(body, field);
  if (!spec) return undefined;
  const out: Record<string, 1 | -1> = {};
  for (const [key, value] of Object.entries(spec)) {
    const direction = value === 1 || value === '1' || value === 'asc' ? 1 : value === -1 || value === '-1' || value === 'desc' ? -1 : null;
    if (direction === null) throw badRequest(`"${field}.${key}" must be 1 (ascending) or -1 (descending).`);
    out[key] = direction;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function projectionField(
  body: Record<string, unknown>,
  field = 'projection',
): Record<string, 0 | 1> | undefined {
  const spec = specField(body, field);
  if (!spec) return undefined;
  const out: Record<string, 0 | 1> = {};
  for (const [key, value] of Object.entries(spec)) {
    const flag =
      value === 1 || value === '1' || value === true ? 1 : value === 0 || value === '0' || value === false ? 0 : null;
    if (flag === null) throw badRequest(`"${field}.${key}" must be 1 (include) or 0 (exclude).`);
    out[key] = flag;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The paging + shaping options shared by find and explain.
 *
 * PLAN §8.3: `skip` is O(n) server-side, so the connector turns forward paging
 * into an `_id` range scan when the caller imposes no sort of its own. The
 * default page size follows the measured RTT.
 */
export function findOptsOf(body: Record<string, unknown>, connectionId: string): FindOpts {
  return {
    projection: projectionField(body),
    sort: sortField(body),
    limit: optionalInt(body, 'limit', { min: 1, max: 10_000 }) ?? connectionManager.suggestedPageSize(connectionId),
    skip: optionalInt(body, 'skip', { min: 0 }) ?? 0,
  };
}
