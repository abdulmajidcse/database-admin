'use client';

/**
 * The canonical SchemaModel, cached client-side (PLAN §4, §6).
 *
 * One query per (connection, scope) so that every consumer — autocomplete, the
 * "search everywhere" box, DDL generation, the ER diagram — shares a single
 * introspection rather than each triggering its own. The key is deliberately
 * `['schema', connectionId]` for the unscoped read: the command palette and the
 * shell already use that key, and a prefix invalidation of `['schema']` still
 * catches the scoped variants.
 *
 * `ageMs` is the number behind "schema from 12m ago" (§6 "Schema cache
 * freshness"). The server reports the age at the moment it answered, so the
 * hook adds the time elapsed since and re-renders on a slow tick — a value that
 * froze at "0m ago" would be worse than none.
 */

import * as React from 'react';
import { useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { SchemaResponse } from '@/lib/api-types';
import type { IntrospectScope, SchemaModel } from '@/lib/schema-model';

export const SCHEMA_QUERY_ROOT = 'schema';

/** How often the age label re-renders. Minute-grained text needs no more. */
const AGE_TICK_MS = 20_000;

/** Introspection is expensive on a remote link, so a cached model stays put. */
const SCHEMA_STALE_MS = 5 * 60_000;

export function schemaQueryKey(connectionId: string | null | undefined, scope?: IntrospectScope): QueryKey {
  const base = [SCHEMA_QUERY_ROOT, connectionId ?? ''];
  const extra = scopeKey(scope);
  return extra === null ? base : [...base, extra];
}

/** An empty scope must hash to the same key as no scope at all (see /api/schema). */
function scopeKey(scope: IntrospectScope | undefined): string | null {
  if (!scope) return null;
  const database = scope.database ?? '';
  const namespaces = (scope.namespaces ?? []).join(',');
  const shallow = scope.shallow ? '1' : '';
  if (database === '' && namespaces === '' && shallow === '') return null;
  return `${database}|${namespaces}|${shallow}`;
}

async function requestSchema(
  connectionId: string,
  scope: IntrospectScope | undefined,
  force: boolean,
): Promise<SchemaResponse> {
  return api.post<SchemaResponse>('/api/schema', {
    connectionId,
    ...(scopeKey(scope) === null ? {} : { scope }),
    ...(force ? { force: true } : {}),
  });
}

/**
 * Imperative read for code outside a component (context menus, command
 * handlers). Shares the hook's cache entry, so an open tree does not pay for a
 * second introspection.
 */
export async function fetchSchema(
  client: QueryClient,
  connectionId: string,
  opts: { scope?: IntrospectScope; force?: boolean } = {},
): Promise<SchemaResponse> {
  const key = schemaQueryKey(connectionId, opts.scope);
  if (opts.force) {
    const fresh = await requestSchema(connectionId, opts.scope, true);
    client.setQueryData(key, fresh);
    return fresh;
  }
  return client.fetchQuery({
    queryKey: key,
    queryFn: () => requestSchema(connectionId, opts.scope, false),
    staleTime: SCHEMA_STALE_MS,
  });
}

export interface UseSchemaOptions {
  scope?: IntrospectScope;
  /**
   * Default false: mounting a panel must never trigger a full introspection.
   * Consumers turn it on when the user asks for something that needs the model.
   * A disabled hook still reads whatever another consumer has already cached.
   */
  enabled?: boolean;
  staleTime?: number;
}

export interface UseSchemaResult {
  model: SchemaModel | null;
  /** Live age of the cached model, ms. Null when nothing is cached yet. */
  ageMs: number | null;
  fetchedAt: number | null;
  isPending: boolean;
  isFetching: boolean;
  /** True only for an explicit refresh(), so the button can spin on its own. */
  isRefreshing: boolean;
  error: Error | null;
  /** Force re-introspection (the refresh button, §6) and drop the stale tree. */
  refresh: () => Promise<SchemaModel | null>;
}

export function useSchema(
  connectionId: string | null | undefined,
  options: UseSchemaOptions = {},
): UseSchemaResult {
  const { scope, enabled = false, staleTime = SCHEMA_STALE_MS } = options;
  const client = useQueryClient();
  const [isRefreshing, setRefreshing] = React.useState(false);

  const query = useQuery<SchemaResponse>({
    queryKey: schemaQueryKey(connectionId, scope),
    queryFn: () => requestSchema(connectionId as string, scope, false),
    enabled: enabled && !!connectionId,
    staleTime,
    retry: false,
  });

  // `ageMs` from the server is the age at answer time; the clock keeps running.
  const fetchedAt = query.data ? query.dataUpdatedAt - query.data.ageMs : null;
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (fetchedAt === null) return;
    const timer = setInterval(() => setTick((n) => n + 1), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [fetchedAt]);

  const refresh = React.useCallback(async (): Promise<SchemaModel | null> => {
    if (!connectionId) return null;
    setRefreshing(true);
    try {
      const fresh = await fetchSchema(client, connectionId, { scope, force: true });
      // A re-introspection invalidates every lazily loaded tree level too (§6).
      await client.invalidateQueries({ queryKey: ['tree', connectionId] });
      return fresh.model;
    } finally {
      setRefreshing(false);
    }
  }, [client, connectionId, scope]);

  return {
    model: query.data?.model ?? null,
    ageMs: fetchedAt === null ? null : Math.max(0, Date.now() - fetchedAt),
    fetchedAt,
    isPending: query.isPending && query.fetchStatus !== 'idle',
    isFetching: query.isFetching,
    isRefreshing,
    error: query.error instanceof Error ? query.error : null,
    refresh,
  };
}

/** "schema from 12m ago" (§6). Compact on purpose — it lives in the status bar. */
export function formatSchemaAge(ageMs: number | null): string {
  if (ageMs === null) return 'not read yet';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
