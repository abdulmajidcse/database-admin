'use client';

/**
 * Table paging for the grid (PLAN §6 "Big results").
 *
 * One page at a time, sorted and filtered by the server. The count is a
 * SEPARATE query on purpose: `COUNT(*)` on a big table can take seconds while
 * the first page comes back immediately, so the rows render first and the total
 * fills in when it lands — never the other way round.
 *
 * `keepPreviousData` is what makes paging feel like paging: the old page stays
 * on screen (dimmed by the caller via `isPlaceholderData`) instead of the grid
 * collapsing to a spinner and losing scroll position on every click.
 */

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { api } from '../lib/api-client';
import type { TableCountResponse } from '../lib/api-types';
import type { ColumnMeta, ResultSet } from '../lib/results';
import type { Row } from '../lib/wire';
// Type-only (erased at build time): the same filter shape /api/table/read validates.
import type { ColumnFilter } from '../server/db/types';

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export interface TableDataParams {
  /** Null disables the queries — nothing is fetched until a connection exists. */
  connectionId: string | null;
  schema?: string;
  table: string;
  offset: number;
  limit: number;
  orderBy?: SortSpec[];
  filters?: ColumnFilter[];
  /** Raw WHERE from the filter bar, without the keyword. */
  where?: string;
  enabled?: boolean;
}

export const DEFAULT_PAGE_SIZE = 200;

/** Everything that changes the rows — the page key — vs. the count key. */
function filterKey(p: TableDataParams) {
  return { filters: p.filters ?? [], where: p.where ?? '' };
}

export const tableDataKeys = {
  root: ['table-data'] as const,
  table: (connectionId: string | null, schema: string | undefined, table: string) =>
    ['table-data', connectionId ?? '', schema ?? '', table] as const,
  page: (p: TableDataParams) =>
    [
      ...tableDataKeys.table(p.connectionId, p.schema, p.table),
      'page',
      { offset: p.offset, limit: p.limit, orderBy: p.orderBy ?? [], ...filterKey(p) },
    ] as const,
  count: (p: TableDataParams) =>
    [...tableDataKeys.table(p.connectionId, p.schema, p.table), 'count', filterKey(p)] as const,
};

function readBody(p: TableDataParams) {
  return {
    connectionId: p.connectionId,
    schema: p.schema,
    table: p.table,
    offset: p.offset,
    limit: p.limit,
    orderBy: p.orderBy && p.orderBy.length > 0 ? p.orderBy : undefined,
    filters: p.filters && p.filters.length > 0 ? p.filters : undefined,
    where: p.where && p.where.trim() !== '' ? p.where : undefined,
  };
}

export function useTablePage(p: TableDataParams) {
  const enabled = (p.enabled ?? true) && !!p.connectionId && p.table !== '';
  return useQuery<ResultSet>({
    queryKey: tableDataKeys.page(p),
    queryFn: () => api.post<ResultSet>('/api/table/read', readBody(p)),
    enabled,
    // Smooth paging: keep showing the page we have while the next one loads.
    placeholderData: keepPreviousData,
    // Table rows go stale the moment anyone writes; re-read on remount rather
    // than trusting a cached page that may be minutes old.
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
  });
}

export function useTableCount(p: TableDataParams) {
  const enabled = (p.enabled ?? true) && !!p.connectionId && p.table !== '';
  return useQuery<TableCountResponse>({
    queryKey: tableDataKeys.count(p),
    queryFn: () =>
      api.post<TableCountResponse>('/api/table/count', {
        connectionId: p.connectionId,
        schema: p.schema,
        table: p.table,
        filters: p.filters && p.filters.length > 0 ? p.filters : undefined,
        where: p.where && p.where.trim() !== '' ? p.where : undefined,
      }),
    enabled,
    placeholderData: keepPreviousData,
    // The count survives paging (it does not depend on offset), so it is worth
    // holding on to for a while — it is the expensive half of the pair.
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

export interface TableData {
  result: ResultSet | undefined;
  columns: ColumnMeta[];
  rows: Row[];
  /** Exact row count behind the current filter, once /api/table/count lands. */
  total: number | undefined;
  estimated: boolean;
  isLoading: boolean;
  isFetching: boolean;
  /** True while showing the previous page's rows under a new page key. */
  isPlaceholderData: boolean;
  error: Error | null;
  countError: Error | null;
  refetch: () => void;
}

/**
 * The pair, as the grid consumes it. Both halves are also exported on their own
 * for callers that want only one (e.g. a row-count badge in the tree).
 */
export function useTableData(p: TableDataParams): TableData {
  const page = useTablePage(p);
  const count = useTableCount(p);

  // `refetch` is stable in TanStack Query v5, so the callback stays stable too.
  const refetchPage = page.refetch;
  const refetchCount = count.refetch;
  const refetch = React.useCallback(() => {
    void refetchPage();
    void refetchCount();
  }, [refetchPage, refetchCount]);

  return {
    result: page.data,
    columns: page.data?.columns ?? [],
    rows: page.data?.rows ?? [],
    total: count.data?.count,
    estimated: count.data?.estimated ?? false,
    isLoading: page.isLoading,
    isFetching: page.isFetching || count.isFetching,
    isPlaceholderData: page.isPlaceholderData,
    error: page.error,
    countError: count.error,
    refetch,
  };
}

/**
 * Invalidate every page and the count for one table — call it after a changeset
 * applies or a DDL statement runs, because both make the cached page a lie.
 */
export function useInvalidateTable(connectionId: string | null, schema: string | undefined, table: string) {
  const client = useQueryClient();
  return React.useCallback(() => {
    void client.invalidateQueries({ queryKey: tableDataKeys.table(connectionId, schema, table) });
  }, [client, connectionId, schema, table]);
}
