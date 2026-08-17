'use client';

/**
 * Result tabs (PLAN §6, M2 "multi result tabs").
 *
 * A script is N statements, so it is N results — one tab each, in execution
 * order, each carrying its own row count and duration. A statement that failed
 * is a result too: the script may have three more after it, and the error is the
 * interesting part, so it gets a tab with the engine's message and a jump back
 * to the exact offset it blamed.
 *
 * The grid itself is `components/grid/data-grid` (owned by the grid module); this
 * pane only decides which `ResultSet` it is looking at.
 */

import * as React from 'react';
import { AlertTriangle, ArrowRightToLine, CheckCircle2, Download, Table2 } from 'lucide-react';

import type { StatementResult } from '@/lib/results';
import { Badge, Button, EmptyState, ErrorBox, Spinner, Tabs } from '@/components/ui/primitives';
import { DataGrid } from '@/components/grid/data-grid';
import { openExportDialog } from '@/components/transfer/transfer-host';
import {
  formatDuration,
  revealOffset,
  setActiveResult,
  statementLabel,
  useRunnerState,
  type RunnerState,
} from '@/hooks/use-query-runner';
import type { WorkspaceTab } from '@/state/workspace-store';

export interface ResultTabsProps {
  /**
   * The shell's active connection, from the slot contract — deliberately NOT
   * used here. Results belong to the tab that ran them, and the sidebar's
   * selection moves independently of the active tab, so everything below reads
   * `tab.connectionId` instead. Using this one would page, edit and export
   * against whichever connection happens to be highlighted.
   */
  connectionId: string | null;
  tab: WorkspaceTab | null;
}

export function ResultTabs({ tab }: ResultTabsProps) {
  const state = useRunnerState(tab?.id ?? null);

  if (!tab || tab.kind !== 'sql') {
    return (
      <EmptyState
        icon={<Table2 className="size-5" />}
        title="No query tab is active"
        description="Results for the SQL editor appear here, one tab per statement."
      />
    );
  }

  if (state.results.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {state.error && (
          <div className="p-2">
            <ErrorBox title="The run failed" message={state.error.message} hint={state.error.hint} />
          </div>
        )}
        {!state.error && (
          <EmptyState
            icon={state.running ? <Spinner className="size-5" /> : <Table2 className="size-5" />}
            title={state.running ? 'Running…' : 'No results yet'}
            description={
              state.running
                ? state.progress
                  ? `${state.progress.rows.toLocaleString()} rows · ${state.progress.phase}`
                  : 'Cancel stops the statement on the server, not just in the browser.'
                : '⌘↩ runs the statement under the cursor, ⇧⌘↩ runs the whole script.'
            }
          />
        )}
      </div>
    );
  }

  const active = Math.min(Math.max(state.activeResult, 0), state.results.length - 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        items={state.results.map((r, i) => ({
          id: String(i),
          label: (
            <span className="flex items-center gap-1.5">
              <ResultIcon result={r} />
              <span className="max-w-[18rem] truncate">{statementLabel(r.statement)}</span>
            </span>
          ),
          detail: summaryOf(r),
        }))}
        active={String(active)}
        onSelect={(id) => setActiveResult(tab.id, Number(id))}
        right={<RunSummary state={state} />}
      />
      <div className="min-h-0 flex-1">
        {/*
          The connection that PRODUCED these rows, not the sidebar's current
          selection. The two diverge freely — `setActiveTab` never syncs
          `activeConnectionId`, and clicking any connection row changes only the
          latter — so a tab bound to prod keeps showing prod's rows while the
          sidebar sits on staging. Paging, editing and now exporting all follow
          this prop, and every one of them is silent about which server it hit.
        */}
        <ResultBody tabId={tab.id} connectionId={tab.connectionId} state={state} index={active} />
      </div>
    </div>
  );
}

function ResultIcon({ result }: { result: StatementResult }) {
  if (result.error) return <AlertTriangle className="size-3 shrink-0 text-[var(--danger)]" />;
  if (result.result && result.result.columns.length > 0) {
    return <Table2 className="size-3 shrink-0 text-[var(--fg-subtle)]" />;
  }
  return <CheckCircle2 className="size-3 shrink-0 text-[var(--ok)]" />;
}

function summaryOf(result: StatementResult): string {
  if (result.error) return 'error';
  const set = result.result;
  if (!set) return formatDuration(result.durationMs);
  if (set.columns.length > 0) {
    return `${set.rows.length.toLocaleString()}${set.truncated ? '+' : ''} rows · ${formatDuration(set.durationMs)}`;
  }
  const affected = set.affectedRows ?? 0;
  return `${affected.toLocaleString()} affected · ${formatDuration(set.durationMs)}`;
}

function RunSummary({ state }: { state: RunnerState }) {
  return (
    <span className="flex items-center gap-2 text-[10px] text-[var(--fg-subtle)]">
      {state.running && <Spinner className="size-3" />}
      {state.running && state.progress && <span>{state.progress.rows.toLocaleString()} rows</span>}
      {state.atomic && <Badge tone="accent">transaction</Badge>}
      {!state.running && state.durationMs !== null && <span>total {formatDuration(state.durationMs)}</span>}
    </span>
  );
}

function ResultBody({
  tabId,
  connectionId,
  state,
  index,
}: {
  tabId: string;
  connectionId: string | null;
  state: RunnerState;
  index: number;
}) {
  const entry = state.results[index];
  if (!entry) return null;

  if (entry.error) {
    const base = state.offsets[index] ?? 0;
    const position = entry.error.position;
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-2">
        <ErrorBox
          title={entry.error.code ? `${entry.error.code}` : 'The statement failed'}
          message={entry.error.message}
          hint={entry.error.detail}
        />
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            icon={<ArrowRightToLine className="size-3" />}
            onClick={() => revealOffset(tabId, base + Math.max(0, (position ?? 1) - 1))}
          >
            {position === undefined ? 'Show the statement' : `Show position ${position}`}
          </Button>
          <span className="text-[10px] text-[var(--fg-subtle)]">{formatDuration(entry.durationMs)}</span>
        </div>
        <pre className="mono whitespace-pre-wrap break-words rounded border border-[var(--border)] bg-[var(--bg-subtle)] p-2 text-[var(--fg-muted)]">
          {entry.statement}
        </pre>
      </div>
    );
  }

  const set = entry.result;
  if (!set) {
    return <EmptyState title="No result" description="The statement returned nothing at all." />;
  }

  if (set.columns.length === 0) {
    // DML and DDL: there is no grid, and pretending otherwise (an empty table
    // with no columns) reads as "it returned nothing" rather than "it worked".
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-[var(--ok)]" />
          <span className="text-[13px]">
            {set.affectedRows !== undefined
              ? `${set.affectedRows.toLocaleString()} row${set.affectedRows === 1 ? '' : 's'} affected`
              : 'Statement completed'}
          </span>
          <span className="text-[11px] text-[var(--fg-subtle)]">{formatDuration(set.durationMs)}</span>
          {set.insertId && <Badge tone="accent">insert id {set.insertId}</Badge>}
        </div>
        {set.notices?.map((notice, i) => (
          <p key={i} className="text-[11px] text-[var(--warn)]">
            {notice}
          </p>
        ))}
        <pre className="mono whitespace-pre-wrap break-words rounded border border-[var(--border)] bg-[var(--bg-subtle)] p-2 text-[var(--fg-muted)]">
          {entry.statement}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(set.notices?.length ?? 0) > 0 && (
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--warn-bg)] px-2 py-1">
          {set.notices?.map((notice, i) => (
            <p key={i} className="text-[11px] text-[var(--warn)]">
              {notice}
            </p>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {/*
          The grid owns virtualization, cursor paging, sorting and cell editing —
          including stating `readOnlyReason` itself, so this pane does not repeat
          it. It only needs the ResultSet and the connection it came from.
        */}
        {connectionId ? (
          <DataGrid
            connectionId={connectionId}
            result={set}
            toolbarExtra={
              <Button
                size="xs"
                variant="ghost"
                icon={<Download className="size-3.5" />}
                disabled={set.statement.trim() === ''}
                onClick={() =>
                  openExportDialog({
                    connectionId,
                    sql: set.statement,
                    // The statement, not the fetched page: an export re-runs it
                    // and streams every row by cursor, so what you get is the
                    // whole result rather than the 500 rows on screen (§7.4).
                    source: { kind: 'query', sql: set.statement },
                  })
                }
                title="Export every row this statement returns"
              />
            }
          />
        ) : (
          <EmptyState title="No connection" description="This result came from a connection that is no longer open." />
        )}
      </div>
    </div>
  );
}
