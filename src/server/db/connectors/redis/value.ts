/**
 * Type-aware Redis value codec (PLAN §6 "Redis at scale").
 *
 * Every read in here is *bounded and paginated*. A single production key can
 * hold ten million list items or a 512 MB string, so there is no "just GET it"
 * path anywhere: strings come through GETRANGE with a byte budget, lists
 * through LRANGE, sets through SSCAN, sorted sets through ZRANGE WITHSCORES,
 * hashes through HSCAN and streams through XRANGE with a COUNT.
 *
 * Reply parsing is deliberately defensive. ioredis v6 negotiates RESP3 by
 * default and maps replies back to RESP2 shapes ("legacy" mapping), but a
 * server that only speaks RESP2 produces flat arrays where RESP3 produces
 * nested pairs. Every parser here accepts both.
 *
 * Server-only module: no React, no Next imports (PLAN §11).
 */

import { Buffer } from 'node:buffer';
import type { RedisValueType, TypedValue } from '../../../../lib/results';
import { DbError } from '../../types';

// ---------------------------------------------------------------------------
// The slice of ioredis this module needs
// ---------------------------------------------------------------------------

export interface PipelineLike {
  exec(): Promise<[Error | null, unknown][] | null>;
}

/**
 * Satisfied by both `Redis` and `Cluster`. Everything routes through `call()`
 * rather than the generated per-command overloads, because those overloads
 * differ enough between the two classes to make a `Redis | Cluster` union
 * painful for no benefit.
 */
export interface RedisLike {
  call(command: string, args: (string | Buffer | number)[]): Promise<unknown>;
  pipeline(commands?: unknown[][]): PipelineLike;
  multi(commands?: unknown[][]): PipelineLike;
}

/**
 * How to issue N single-key commands as one logical batch.
 *
 * - `pipeline` — one explicit pipeline, one round trip. Valid for a standalone
 *   server, and for a cluster *node* connection.
 * - `fanout` — one `call()` per command, all in flight at once. Required when
 *   the client is the `Cluster` object: ioredis rejects a cluster pipeline
 *   whose keys span more than one node group, and a scanned page of keys
 *   always does. With `enableAutoPipelining` the fan-out is still coalesced
 *   into one pipeline per node, so it costs the same round trips (§8.3).
 */
export type BatchMode = 'pipeline' | 'fanout';

// ---------------------------------------------------------------------------
// Bounds (PLAN §6: nothing unbounded ever leaves the server)
// ---------------------------------------------------------------------------

/** Largest string window a single readKey() will pull. */
export const MAX_STRING_BYTES = 1 << 20;
/** Default element count per collection page. */
export const DEFAULT_PAGE = 200;
/** Ceiling on the element count a caller may ask for. */
export const MAX_PAGE = 5000;
/** Hard stop on SSCAN/HSCAN looping, so a pathological key cannot spin forever. */
const MAX_SCAN_ITERATIONS = 200;

const VALUE_TYPES = new Set<string>(['string', 'list', 'set', 'zset', 'hash', 'stream', 'none']);

/**
 * Redis TYPE also answers with module type names (`ReJSON-RL`, `TSDB-TYPE`,
 * `MBbloom--`). The frozen `RedisValueType` union has no slot for those, so
 * they degrade to `none` and the viewer shows an empty value rather than
 * issuing a GET that would fail with WRONGTYPE.
 */
export function asValueType(raw: string): RedisValueType {
  const t = raw.trim().toLowerCase();
  return VALUE_TYPES.has(t) ? (t as RedisValueType) : 'none';
}

// ---------------------------------------------------------------------------
// Reply coercion
// ---------------------------------------------------------------------------

export function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) return v.message;
  return JSON.stringify(v) ?? '';
}

export function toInt(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : fallback;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' || Buffer.isBuffer(v)) {
    const n = Number(toText(v));
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }
  return fallback;
}

/**
 * Flatten one level of nesting and stringify. RESP2 hands back
 * `[member, score, member, score]`; RESP3 hands back `[[member, score], …]`.
 * Both collapse to the same flat list here.
 */
export function flattenStrings(reply: unknown): string[] {
  if (!Array.isArray(reply)) return [];
  const out: string[] = [];
  for (const item of reply) {
    if (Array.isArray(item)) for (const inner of item) out.push(toText(inner));
    else out.push(toText(item));
  }
  return out;
}

/** `[cursor, items]` — the shape every SCAN-family command replies with. */
export function parseScanReply(reply: unknown): { cursor: string; items: unknown[] } {
  if (!Array.isArray(reply) || reply.length < 2) return { cursor: '0', items: [] };
  const items = Array.isArray(reply[1]) ? (reply[1] as unknown[]) : [];
  return { cursor: toText(reply[0]) || '0', items };
}

/** `[[id, [f, v, …]], …]`, tolerating the RESP3 pair-nested field list. */
export function parseStreamEntries(reply: unknown): { id: string; fields: Record<string, string> }[] {
  if (!Array.isArray(reply)) return [];
  const out: { id: string; fields: Record<string, string> }[] = [];
  for (const entry of reply) {
    if (!Array.isArray(entry) || entry.length === 0) continue;
    const flat = flattenStrings(entry[1]);
    // Null prototype: a stream field is arbitrary user bytes and may be
    // `__proto__`, which would otherwise mutate Object.prototype.
    const fields = Object.create(null) as Record<string, string>;
    for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    out.push({ id: toText(entry[0]), fields });
  }
  return out;
}

/** Redis replies carry their error class as the first word: WRONGTYPE, NOAUTH, … */
export function asDbError(err: unknown, context?: string): DbError {
  if (err instanceof DbError) return err;
  const e = err as { message?: string; code?: string } | undefined;
  const message = e?.message ?? String(err);
  const cls = /^([A-Z][A-Z0-9_]+)(?:\s|$)/.exec(message);
  return new DbError(context ? `${context}: ${message}` : message, e?.code ?? cls?.[1]);
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

/** Run a batch and keep per-command failures instead of aborting the page. */
export async function execBatch(
  client: RedisLike,
  cmds: unknown[][],
  mode: BatchMode,
): Promise<[Error | null, unknown][]> {
  if (cmds.length === 0) return [];
  if (mode === 'fanout') {
    return Promise.all(
      cmds.map(async (cmd): Promise<[Error | null, unknown]> => {
        try {
          return [null, await client.call(String(cmd[0]), cmd.slice(1) as (string | Buffer | number)[])];
        } catch (err) {
          return [err instanceof Error ? err : new Error(String(err)), null];
        }
      }),
    );
  }
  const replies = await client.pipeline(cmds).exec();
  return replies ?? cmds.map((): [Error | null, unknown] => [new Error('Pipeline returned no reply'), null]);
}

/** Run a batch where any failure is fatal (single-key reads). */
export async function execPipeline(client: RedisLike, cmds: unknown[][]): Promise<unknown[]> {
  const replies = await execBatch(client, cmds, 'pipeline');
  return replies.map(([err, value], i) => {
    if (err) throw asDbError(err, String(cmds[i]?.[0] ?? 'command').toUpperCase());
    return value;
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * SSCAN/HSCAN paging. Neither command has an index-addressable cursor, so an
 * `offset` is served by scanning forward and slicing — bounded by
 * MAX_SCAN_ITERATIONS. Elements can legitimately repeat across iterations, so
 * they are deduped on the first element of each group, which keeps `offset`
 * stable between two calls with the same arguments.
 */
async function scanGroups(
  client: RedisLike,
  cmd: 'sscan' | 'hscan',
  sizeCmd: 'scard' | 'hlen',
  key: string,
  offset: number,
  limit: number,
  stride: 1 | 2,
): Promise<{ total: number; groups: string[][] }> {
  const need = offset + limit;
  const hint = Math.min(Math.max(need * stride, 100), 1000);
  const [sizeReply, firstReply] = await execPipeline(client, [
    [sizeCmd, key],
    [cmd, key, '0', 'COUNT', hint],
  ]);

  const seen = new Map<string, string[]>();
  let page = parseScanReply(firstReply);
  for (let iterations = 0; ; iterations++) {
    const flat = page.items.map(toText);
    for (let i = 0; i + stride <= flat.length; i += stride) {
      const group = flat.slice(i, i + stride);
      if (!seen.has(group[0])) seen.set(group[0], group);
    }
    if (page.cursor === '0' || seen.size >= need || iterations + 1 >= MAX_SCAN_ITERATIONS) break;
    page = parseScanReply(await client.call(cmd, [key, page.cursor, 'COUNT', hint]));
  }

  return { total: toInt(sizeReply), groups: [...seen.values()].slice(offset, offset + limit) };
}

/**
 * Read one page of a key's value.
 *
 * For collections `offset`/`limit` count elements. For a `string` they count
 * BYTES: `offset` is a byte offset into the value and the window is always
 * MAX_STRING_BYTES wide, because a caller's element-oriented `limit` (200 rows)
 * would otherwise silently truncate text to 200 bytes. A window boundary can
 * land mid-UTF-8-sequence, which shows up as a replacement character at the
 * edges — the only alternative would be pulling the whole value, which §6
 * forbids.
 */
export async function readTypedValue(
  client: RedisLike,
  key: string,
  type: RedisValueType,
  opts: { offset?: number; limit?: number } = {},
): Promise<TypedValue> {
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_PAGE)), MAX_PAGE);

  switch (type) {
    case 'string': {
      // GETRANGE *is* the size guard: it clamps server-side, so a 4-byte value
      // and a 512 MB value cost the same one round trip and never over-fetch.
      const chunk = await client.call('getrange', [key, offset, offset + MAX_STRING_BYTES - 1]);
      return { type: 'string', value: toText(chunk) };
    }

    case 'list': {
      const [len, items] = await execPipeline(client, [
        ['llen', key],
        ['lrange', key, offset, offset + limit - 1],
      ]);
      return {
        type: 'list',
        items: (Array.isArray(items) ? items : []).map(toText),
        total: toInt(len),
      };
    }

    case 'set': {
      const { total, groups } = await scanGroups(client, 'sscan', 'scard', key, offset, limit, 1);
      return { type: 'set', members: groups.map((g) => g[0]), total };
    }

    case 'zset': {
      const [card, flat] = await execPipeline(client, [
        ['zcard', key],
        ['zrange', key, offset, offset + limit - 1, 'WITHSCORES'],
      ]);
      const pairs = flattenStrings(flat);
      const members: { member: string; score: string }[] = [];
      for (let i = 0; i + 1 < pairs.length; i += 2) members.push({ member: pairs[i], score: pairs[i + 1] });
      return { type: 'zset', members, total: toInt(card) };
    }

    case 'hash': {
      const { total, groups } = await scanGroups(client, 'hscan', 'hlen', key, offset, limit, 2);
      return {
        type: 'hash',
        fields: groups.map((g) => ({ field: g[0], value: g[1] ?? '' })),
        total,
      };
    }

    case 'stream': {
      // XRANGE has no offset, so ask for offset+limit and drop the prefix.
      const [len, entries] = await execPipeline(client, [
        ['xlen', key],
        ['xrange', key, '-', '+', 'COUNT', offset + limit],
      ]);
      return { type: 'stream', entries: parseStreamEntries(entries).slice(offset), total: toInt(len) };
    }

    default:
      return { type: 'none' };
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Args per command, so a million-field hash does not become one giant packet. */
const WRITE_CHUNK = 500;

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The exact command list `writeKey` will run, mirroring `readTypedValue`.
 * Exported so a preview/diff UI can show it before anything executes.
 *
 * Replacement semantics: DEL first, then rebuild. Redis has no "empty
 * collection", so writing an empty list/set/hash is the same as deleting the
 * key — which is what the DEL-only command list produces.
 */
export function buildWriteCommands(key: string, value: TypedValue, ttlMs?: number): unknown[][] {
  const cmds: unknown[][] = [['del', key]];

  switch (value.type) {
    case 'string':
      cmds.push(['set', key, value.value]);
      break;
    case 'list':
      for (const part of chunk(value.items, WRITE_CHUNK)) cmds.push(['rpush', key, ...part]);
      break;
    case 'set':
      for (const part of chunk(value.members, WRITE_CHUNK)) cmds.push(['sadd', key, ...part]);
      break;
    case 'zset':
      for (const part of chunk(value.members, WRITE_CHUNK))
        cmds.push(['zadd', key, ...part.flatMap((m) => [m.score, m.member])]);
      break;
    case 'hash':
      for (const part of chunk(value.fields, WRITE_CHUNK))
        cmds.push(['hset', key, ...part.flatMap((f) => [f.field, f.value])]);
      break;
    case 'stream':
      for (const entry of value.entries) {
        const fields = Object.entries(entry.fields).flat();
        // XADD requires at least one field/value pair; a field-less entry
        // cannot exist in Redis, so skipping it is lossless.
        if (fields.length === 0) continue;
        cmds.push(['xadd', key, entry.id && entry.id !== '*' ? entry.id : '*', ...fields]);
      }
      break;
    case 'none':
      return cmds;
  }

  if (ttlMs !== undefined && ttlMs > 0) cmds.push(['pexpire', key, Math.trunc(ttlMs)]);
  return cmds;
}

/**
 * Replace a key's whole value. Wrapped in MULTI so nobody ever observes a
 * half-rewritten key; every command targets the same key, so this is also
 * slot-safe under Redis Cluster.
 */
export async function writeTypedValue(
  client: RedisLike,
  key: string,
  value: TypedValue,
  ttlMs?: number,
): Promise<void> {
  const cmds = buildWriteCommands(key, value, ttlMs);
  let replies: [Error | null, unknown][] | null;
  try {
    // ioredis rejects the whole call when EXEC itself fails (EXECABORT), and
    // resolves to per-command [err, value] pairs otherwise.
    replies = await client.multi(cmds).exec();
  } catch (err) {
    throw asDbError(err, 'MULTI');
  }
  if (!replies) throw new DbError('Redis transaction was discarded', 'EXECABORT');
  replies.forEach(([err], i) => {
    if (err) throw asDbError(err, String(cmds[i]?.[0] ?? 'command').toUpperCase());
  });
}

/** Cardinality command for a key of the given type; `null` when there is none. */
export function lengthCommand(type: RedisValueType, key: string): unknown[] | null {
  switch (type) {
    case 'string':
      return ['strlen', key];
    case 'list':
      return ['llen', key];
    case 'set':
      return ['scard', key];
    case 'zset':
      return ['zcard', key];
    case 'hash':
      return ['hlen', key];
    case 'stream':
      return ['xlen', key];
    default:
      return null;
  }
}
