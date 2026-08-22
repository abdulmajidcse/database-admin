'use client';

/**
 * The `table` tab: browse one table's data (PLAN M1).
 *
 * This is the seam between three separately-built pieces — useTableData
 * (server-side paging/sort/filter), FilterBar, and DataGrid — so it lives at
 * the top level rather than inside any of them.
 *
 * Paging is OFFSET based here, unlike a query result, which pages through a
 * server-side cursor (§6 "Big results"). A table has a stable ordering to page
 * against; an arbitrary result set does not.
 */

import * as React from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { DataGrid } from './grid/data-grid';
import { openExportDialog } from './transfer/transfer-host';
import { FilterBar, EMPTY_FILTER_STATE, type GridFilterState } from './grid/filter-bar';
import { Button, EmptyState, ErrorBox, Spinner } from './ui/primitives';
import { DEFAULT_PAGE_SIZE, useTableData, type SortSpec } from '@/hooks/use-table-data';
import { useWorkspaceStore, type WorkspaceTab } from '@/state/workspace-store';

interface TableTabState {
  schema?: string;
  table?: string;
  offset?: number;
  sort?: SortSpec[];
  filter?: GridFilterState;
}

function readState(state: Record<string, unknown>): TableTabState {
  const s = state as TableTabState;
  return {
    schema: typeof s.schema === 'string' ? s.schema : undefined,
    table: typeof s.table === 'string' ? s.table : undefined,
    offset: typeof s.offset === 'number' ? s.offset : 0,
    sort: Array.isArray(s.sort) ? s.sort : [],
    filter: s.filter && typeof s.filter === 'object' ? s.filter : EMPTY_FILTER_STATE,
  };
}

export function TableTab({ tab }: { tab: WorkspaceTab }) {
  const setTabState = useWorkspaceStore((s) => s.setTabState);
  const saved = readState(tab.state);

  const [offset, setOffset] = React.useState(saved.offset ?? 0);
  const [sort, setSort] = React.useState<SortSpec[]>(saved.sort ?? []);
  const [filter, setFilter] = React.useState<GridFilterState>(saved.filter ?? EMPTY_FILTER_STATE);

  // Persist browsing position so reopening the workspace lands where you left.
  React.useEffect(() => {
    setTabState(tab.id, { ...tab.state, offset, sort, filter });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, sort, filter]);

  // A reused tab gets new state pushed into it — foreign-key navigation reuses
  // the target table's tab and hands it a filter. These are read once into
  // useState, so without this the tab would keep the filter it opened with and
  // quietly show the wrong rows.
  const incomingFilter = JSON.stringify(saved.filter ?? EMPTY_FILTER_STATE);
  React.useEffect(() => {
    setFilter((current) => {
      if (JSON.stringify(current) === incomingFilter) return current;
      // A different filter means a different result set, so page 1.
      setOffset(0);
      return JSON.parse(incomingFilter) as GridFilterState;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingFilter]);

  const data = useTableData({
    connectionId: tab.connectionId,
    schema: saved.schema,
    table: saved.table ?? '',
    offset,
    limit: DEFAULT_PAGE_SIZE,
    orderBy: sort,
    filters: filter.filters,
    where: filter.where,
    enabled: !!tab.connectionId && !!saved.table,
  });

  if (!tab.connectionId || !saved.table) {
    return <EmptyState title="No table selected" description="Open a table from the object tree." />;
  }

  if (data.error) {
    return (
      <div className="p-3">
        <ErrorBox title="Could not read the table" message={data.error.message} />
      </div>
    );
  }

  if (data.isLoading || !data.result) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[var(--fg-muted)]">
        <Spinner /> Loading {saved.schema ? `${saved.schema}.` : ''}
        {saved.table}…
      </div>
    );
  }

  return (
    <DataGrid
      connectionId={tab.connectionId}
      result={data.result}
      sort={sort}
      onSortChange={(next) => {
        setSort(next);
        setOffset(0); // a new ordering makes the current offset meaningless
      }}
      paging={{
        offset,
        pageSize: DEFAULT_PAGE_SIZE,
        total: data.total,
        estimated: data.estimated,
        loading: data.isFetching,
        onOffsetChange: setOffset,
      }}
      filterBar={
        <FilterBar
          columns={data.columns}
          value={filter}
          busy={data.isFetching}
          onApply={(next) => {
            setFilter(next);
            setOffset(0); // filtered row set is a different set
          }}
        />
      }
      toolbarExtra={
        <>
          <Button
            size="xs"
            variant="ghost"
            icon={<Download className="size-3.5" />}
            disabled={!tab.connectionId || !saved.table}
            onClick={() =>
              openExportDialog({
                connectionId: tab.connectionId,
                source: {
                  kind: 'table',
                  schema: saved.schema,
                  table: saved.table ?? '',
                  // Only the raw box carries across: the chips are parameterized
                  // server-side and there is no way to express a bound value in
                  // the export request's plain WHERE text. The wizard shows this
                  // field, so what will be exported is on screen either way.
                  where: filter.where.trim() === '' ? undefined : filter.where,
                },
              })
            }
            title={
              filter.filters.length > 0
                ? 'Export this table. The filter chips do not carry over — add them to the WHERE box in the wizard.'
                : 'Export this table'
            }
          />
          <Button
            size="xs"
            variant="ghost"
            icon={<RefreshCw className="size-3.5" />}
            onClick={data.refetch}
            title="Refresh"
          />
        </>
      }
      onApplied={() => data.refetch()}
    />
  );
}
