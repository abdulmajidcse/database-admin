/**
 * Schema cache (PLAN §6 "Schema cache freshness", §8.3).
 *
 * Autocomplete needs the schema in memory; introspecting on every keystroke is
 * unusable, and on a 180 ms link even a *batched* introspection costs seconds.
 * So: get-or-introspect with a TTL, persisted in the app database so the model
 * survives a restart, plus a small in-process memo so the hot path does not
 * re-parse a megabyte of JSON on every request.
 *
 * The TTL is not a constant — `connectionManager.schemaTtl()` stretches it on
 * slow links (§8.3). Invalidate after any DDL we execute, and on demand from
 * the refresh button next to the "schema from 12m ago" indicator.
 *
 * Server-side only: no React, no Next (PLAN §11).
 */

import type { IntrospectScope, SchemaModel } from '../../lib/schema-model';
import { currentUserId } from '../context';
import { schemaCacheRepo } from '../store/db';
import { connectionManager } from './manager';
import { DbError, isSqlConnector } from './types';

export interface SchemaResult {
  model: SchemaModel;
  /** When the model was introspected. */
  fetchedAt: number;
  /** Drives the "schema from 12m ago" indicator (§6). */
  ageMs: number;
  /** True when no introspection round trip happened. */
  cached: boolean;
  /** Set when a refresh failed and this is the last good model. */
  staleReason?: string;
}

export interface GetSchemaOptions {
  /** Ignore the TTL and re-introspect now (the refresh button). */
  force?: boolean;
  /** Override the adaptive TTL, e.g. for a background prefetch. */
  ttlMs?: number;
  /**
   * On a failed refresh, serve the last good model instead of throwing. On by
   * default: a dropped tunnel must not empty the autocomplete (§8.3).
   */
  allowStale?: boolean;
}

interface CachedModel {
  model: SchemaModel;
  fetchedAt: number;
}

/** Parsed models, keyed `connectionId|scope`. Bounded: models are large. */
const MEMO_MAX = 32;
const memo = new Map<string, CachedModel>();

/** In-flight introspections, so ten autocomplete requests cause one round trip. */
const inflight = new Map<string, Promise<SchemaResult>>();

/**
 * Bumped by `invalidate`. An introspection that started before a DDL statement
 * must not overwrite the cache with the pre-DDL model when it finally lands.
 */
const generations = new Map<string, number>();

/**
 * Per-scope invalidation floor: any model introspected at or before this instant
 * is stale regardless of TTL. Cheaper and safer than deleting one row, which the
 * repo cannot do — and it survives memo eviction, which a doctored timestamp
 * would not.
 */
const floors = new Map<string, number>();

/** Stable key for a scope — order of `namespaces` must not create a second entry. */
export function scopeKey(scope?: IntrospectScope): string {
  const database = scope?.database ?? '';
  const namespaces = scope?.namespaces?.length ? [...scope.namespaces].sort().join(',') : '';
  const shallow = scope?.shallow ? '1' : '0';
  return `db=${database}|ns=${namespaces}|shallow=${shallow}`;
}

/**
 * The user id is part of the key because this memo sits IN FRONT of the
 * owner-scoped persisted cache — without it, one user's introspection is served
 * straight from memory to anyone who asks for the same connection id, and the
 * scoping in store/db.ts never gets a say (§9.2).
 *
 * The connection id stays first so `invalidate` can still clear every entry for
 * a connection with one prefix match, across all users — a schema change is a
 * schema change for everyone who can see it.
 */
function memoKey(connectionId: string, key: string): string {
  return `${connectionId}|${currentUserId() ?? 'no-user'}|${key}`;
}

function memoSet(connectionId: string, key: string, value: CachedModel): void {
  const k = memoKey(connectionId, key);
  memo.delete(k);
  memo.set(k, value);
  // Map preserves insertion order, so the first key is the oldest.
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
}

/** Memo first, then the persisted cache (which survives a restart). */
function readCache(connectionId: string, key: string): CachedModel | null {
  const hit = memo.get(memoKey(connectionId, key));
  if (hit) return hit;
  const row = schemaCacheRepo.get(connectionId, key);
  if (!row) return null;
  const value: CachedModel = { model: row.model, fetchedAt: row.fetchedAt };
  memoSet(connectionId, key, value);
  return value;
}

/** Cached and neither TTL-expired nor invalidated since. */
function isFresh(k: string, cached: CachedModel, ttlMs: number): boolean {
  if (cached.fetchedAt <= (floors.get(k) ?? 0)) return false;
  return Date.now() - cached.fetchedAt < ttlMs;
}

function toResult(cached: CachedModel, cachedFlag: boolean, staleReason?: string): SchemaResult {
  return {
    model: cached.model,
    fetchedAt: cached.fetchedAt,
    ageMs: Math.max(0, Date.now() - cached.fetchedAt),
    cached: cachedFlag,
    staleReason,
  };
}

/**
 * The canonical model for a connection, introspecting only when the cached copy
 * is missing, expired, or explicitly refused.
 */
export async function getSchema(
  connectionId: string,
  scope?: IntrospectScope,
  opts: GetSchemaOptions = {},
): Promise<SchemaResult> {
  const key = scopeKey(scope);
  const k = memoKey(connectionId, key);
  const ttlMs = opts.ttlMs ?? connectionManager.schemaTtl(connectionId);

  if (!opts.force) {
    const hit = readCache(connectionId, key);
    if (hit && isFresh(k, hit, ttlMs)) return toResult(hit, true);
  }

  const running = inflight.get(k);
  // Even a forced refresh joins one already in flight: it is the same round trip.
  if (running) return running;

  const promise = introspect(connectionId, scope, key, opts).finally(() => {
    if (inflight.get(k) === promise) inflight.delete(k);
  });
  inflight.set(k, promise);
  return promise;
}

async function introspect(
  connectionId: string,
  scope: IntrospectScope | undefined,
  key: string,
  opts: GetSchemaOptions,
): Promise<SchemaResult> {
  const generation = generations.get(connectionId) ?? 0;
  try {
    const connector = await connectionManager.acquire(connectionId);
    if (!isSqlConnector(connector)) {
      // Redis and Mongo have no relational schema; their tree comes from
      // listNodes() instead (PLAN §4 capability gating).
      throw new DbError(
        `${connector.kind} has no SQL schema model — browse it through the object tree instead.`,
        'UNSUPPORTED_CAPABILITY',
      );
    }
    // §8.3: connectors introspect in a fixed number of round trips, so this is
    // one call and never a per-table loop.
    const model = await connector.introspect(scope ?? {});
    const fetchedAt = Date.now();
    const cached: CachedModel = { model, fetchedAt };

    // A DDL statement (or an explicit invalidate) landed while we were reading:
    // the caller still gets this model, but it must not become the cached one.
    if ((generations.get(connectionId) ?? 0) === generation) {
      schemaCacheRepo.put(connectionId, key, model);
      memoSet(connectionId, key, cached);
    }
    return toResult(cached, false);
  } catch (err) {
    const stale = opts.allowStale === false ? null : readCache(connectionId, key);
    if (!stale) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    return toResult(stale, true, `Refresh failed, showing the last known schema: ${reason}`);
  }
}

/**
 * Drop the cached model(s) for a connection. Call after any DDL we execute, on
 * the refresh button, and when a connection's config changes (§6).
 */
export function invalidate(connectionId: string, scope?: IntrospectScope): void {
  generations.set(connectionId, (generations.get(connectionId) ?? 0) + 1);
  const prefix = `${connectionId}|`;
  if (scope === undefined) {
    schemaCacheRepo.invalidate(connectionId);
    for (const k of [...memo.keys()]) if (k.startsWith(prefix)) memo.delete(k);
    for (const k of [...floors.keys()]) if (k.startsWith(prefix)) floors.delete(k);
    return;
  }
  // The repo deletes per connection, not per scope, so one scope is invalidated
  // by raising its freshness floor above the stored model's timestamp.
  const k = memoKey(connectionId, scopeKey(scope));
  floors.set(k, Date.now());
  memo.delete(k);
}

/** How old the cached model is, in ms, or null when nothing usable is cached (§6). */
export function getSchemaAge(connectionId: string, scope?: IntrospectScope): number | null {
  const key = scopeKey(scope);
  const hit = readCache(connectionId, key);
  if (!hit || hit.fetchedAt <= (floors.get(memoKey(connectionId, key)) ?? 0)) return null;
  return Math.max(0, Date.now() - hit.fetchedAt);
}

/** The cached model without ever introspecting — for autocomplete on a cold path. */
export function peekSchema(connectionId: string, scope?: IntrospectScope): SchemaResult | null {
  const key = scopeKey(scope);
  const hit = readCache(connectionId, key);
  if (!hit || hit.fetchedAt <= (floors.get(memoKey(connectionId, key)) ?? 0)) return null;
  return toResult(hit, true);
}

/** Explicit refresh (the button next to the age indicator). */
export function refreshSchema(connectionId: string, scope?: IntrospectScope): Promise<SchemaResult> {
  return getSchema(connectionId, scope, { force: true, allowStale: false });
}

/** Forget every in-memory model, e.g. when the vault is locked again. */
export function invalidateAll(): void {
  memo.clear();
  floors.clear();
  for (const id of [...generations.keys()]) generations.set(id, (generations.get(id) ?? 0) + 1);
}
