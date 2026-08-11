/**
 * Shared validation for the Redis routes (PLAN §11: route handlers stay thin —
 * validate, call the server layer, serialize).
 *
 * Not a route: Next only treats `route.ts` / `page.tsx` as segments, so this
 * file is plain module code the sibling handlers import.
 *
 * Everything here throws `HttpError` (from ../lib/respond) rather than
 * returning, so `handle()` turns a bad body into a 400 that names the field.
 */

import type { ScanCursor, TypedValue } from '@/lib/results';
import { connectionManager } from '@/server/db/manager';
import { isKeyValueConnector, type KeyValueConnector } from '@/server/db/types';
import { asRecord, badRequest, oneOf } from '../lib/respond';

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/**
 * The keyspace connector for a connection. PLAN §4: capabilities are gated, so
 * a Postgres connection id sent to a Redis route is a client mistake (400), not
 * a crash.
 */
export async function keyValueConnector(connectionId: string): Promise<KeyValueConnector> {
  const connector = await connectionManager.acquire(connectionId);
  if (!isKeyValueConnector(connector)) {
    throw badRequest(`This is a ${connector.kind} connection, which has no keyspace.`, {
      code: 'UNSUPPORTED_CAPABILITY',
      hint: 'The Redis endpoints only accept connections to a key/value engine.',
    });
  }
  return connector;
}

/**
 * Point the connector at a database before a key operation.
 *
 * `readKey`/`writeKey` act on the connector's *active* database, which SCAN
 * sets. A key panel opened straight from the tree has to name its database
 * itself, so the routes accept an optional `db`. SELECT is intercepted by the
 * connector (it pins a per-database connection instead of re-pointing the
 * shared one — PLAN §6 "Sessions vs pools").
 */
export async function selectDb(connector: KeyValueConnector, db: number | undefined): Promise<void> {
  if (db === undefined) return;
  if (!connector.capabilities.has('multipleDatabases')) {
    // Redis Cluster has one logical database, so asking for db 0 there is not a
    // mistake — it is the only answer. Anything else is.
    if (db === 0) return;
    throw badRequest(`This connection has a single database, so db ${db} does not exist.`, {
      code: 'CLUSTER_NO_SELECT',
    });
  }
  await connector.command(['select', String(db)]);
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

/**
 * A string field that is allowed to be empty — an empty Redis string value and
 * an empty key name are different things, and only the second is invalid.
 */
export function text(obj: Record<string, unknown>, field: string, label = field): string {
  const value = obj[field];
  if (typeof value !== 'string') throw badRequest(`"${label}" must be a string.`);
  return value;
}

export function optionalInt(
  obj: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number; label?: string } = {},
): number | undefined {
  const raw = obj[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return intFrom(raw, opts.label ?? field, opts);
}

/** Accepts a number or a numeric string, because GET params are always strings. */
export function intFrom(
  raw: unknown,
  label: string,
  opts: { min?: number; max?: number } = {},
): number {
  const value = typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw badRequest(`"${label}" must be an integer.`);
  }
  if (opts.min !== undefined && value < opts.min) throw badRequest(`"${label}" must be at least ${opts.min}.`);
  if (opts.max !== undefined && value > opts.max) throw badRequest(`"${label}" must be at most ${opts.max}.`);
  return value;
}

export function stringList(obj: Record<string, unknown>, field: string): string[] {
  const raw = obj[field];
  if (!Array.isArray(raw)) throw badRequest(`"${field}" must be an array of strings.`);
  return raw.map((item: unknown, i: number) => {
    if (typeof item !== 'string') throw badRequest(`"${field}[${i}]" must be a string.`);
    return item;
  });
}

// ---------------------------------------------------------------------------
// SCAN cursor (PLAN §6 "Redis at scale")
// ---------------------------------------------------------------------------

/**
 * A `ScanCursor` off the wire. The cursor is an opaque server token — never a
 * number — because Redis cursors exceed 2^53 on a large keyspace, and in
 * cluster mode `nodeCursors` carries one per master.
 */
export function parseCursor(input: unknown, defaultCount: number): ScanCursor {
  if (input === undefined || input === null) return { cursor: '0', count: defaultCount };
  const obj = asRecord(input, '"cursor"');

  const raw = obj.cursor;
  const cursor = raw === undefined || raw === null ? '0' : typeof raw === 'string' ? raw : String(intFrom(raw, 'cursor.cursor'));

  const out: ScanCursor = { cursor: cursor || '0' };

  const match = obj.match;
  if (match !== undefined && match !== null) {
    if (typeof match !== 'string') throw badRequest('"cursor.match" must be a glob string, e.g. "user:*".');
    if (match.length > 0) out.match = match;
  }

  out.count = optionalInt(obj, 'count', { min: 1, max: 10_000, label: 'cursor.count' }) ?? defaultCount;

  const db = optionalInt(obj, 'db', { min: 0, max: 255, label: 'cursor.db' });
  if (db !== undefined) out.db = db;

  const nodeCursors = obj.nodeCursors;
  if (nodeCursors !== undefined && nodeCursors !== null) {
    const record = asRecord(nodeCursors, '"cursor.nodeCursors"');
    const mapped: Record<string, string> = {};
    for (const [node, value] of Object.entries(record)) {
      if (typeof value !== 'string') throw badRequest(`"cursor.nodeCursors.${node}" must be a string.`);
      mapped[node] = value;
    }
    out.nodeCursors = mapped;
  }

  return out;
}

// ---------------------------------------------------------------------------
// TypedValue (PLAN §6: type-aware Redis editors)
// ---------------------------------------------------------------------------

const VALUE_TYPES = ['string', 'list', 'set', 'zset', 'hash', 'stream', 'none'] as const;

/**
 * Validate an edited value before it reaches `writeKey`, which replaces the key
 * inside a MULTI. `total` is recomputed from the payload: a write always sends
 * the whole value, so the count the client last *read* is not authoritative.
 */
export function parseTypedValue(input: unknown): TypedValue {
  const obj = asRecord(input, '"value"');
  const type = oneOf(obj.type, VALUE_TYPES, 'value.type');

  switch (type) {
    case 'string':
      return { type, value: text(obj, 'value', 'value.value') };

    case 'list': {
      const items = stringList(obj, 'items');
      return { type, items, total: items.length };
    }

    case 'set': {
      const members = stringList(obj, 'members');
      return { type, members, total: members.length };
    }

    case 'zset': {
      const raw = obj.members;
      if (!Array.isArray(raw)) throw badRequest('"members" must be an array of { member, score }.');
      const members = raw.map((entry: unknown, i: number) => {
        const item = asRecord(entry, `"members[${i}]"`);
        const score = item.score;
        // ZADD takes the score as text so a 17-digit score is not rounded by
        // JSON's double (PLAN §6 "Type fidelity").
        const scoreText = typeof score === 'number' ? String(score) : typeof score === 'string' ? score : null;
        if (scoreText === null || !isRedisScore(scoreText)) {
          throw badRequest(`"members[${i}].score" must be a number, "inf", "-inf" or "nan".`);
        }
        return { member: text(item, 'member', `members[${i}].member`), score: scoreText };
      });
      return { type, members, total: members.length };
    }

    case 'hash': {
      const raw = obj.fields;
      if (!Array.isArray(raw)) throw badRequest('"fields" must be an array of { field, value }.');
      const fields = raw.map((entry: unknown, i: number) => {
        const item = asRecord(entry, `"fields[${i}]"`);
        return {
          field: text(item, 'field', `fields[${i}].field`),
          value: text(item, 'value', `fields[${i}].value`),
        };
      });
      return { type, fields, total: fields.length };
    }

    case 'stream': {
      const raw = obj.entries;
      if (!Array.isArray(raw)) throw badRequest('"entries" must be an array of { id, fields }.');
      const entries = raw.map((entry: unknown, i: number) => {
        const item = asRecord(entry, `"entries[${i}]"`);
        const fieldMap = asRecord(item.fields ?? {}, `"entries[${i}].fields"`);
        const fields: Record<string, string> = {};
        for (const [name, value] of Object.entries(fieldMap)) {
          if (typeof value !== 'string') throw badRequest(`"entries[${i}].fields.${name}" must be a string.`);
          fields[name] = value;
        }
        // '*' asks the server for the next id, which is what a new entry wants.
        const id = item.id === undefined || item.id === null ? '*' : text(item, 'id', `entries[${i}].id`);
        return { id, fields };
      });
      return { type, entries, total: entries.length };
    }

    case 'none':
      // Writing `none` deletes the key: Redis has no empty value.
      return { type };
  }
}

/** Redis accepts these three literals wherever a score is expected. */
function isRedisScore(value: string): boolean {
  const token = value.trim().toLowerCase();
  if (token === 'inf' || token === '+inf' || token === '-inf' || token === 'infinity' || token === '-infinity') {
    return true;
  }
  if (token === 'nan') return true;
  return token.length > 0 && Number.isFinite(Number(token));
}
