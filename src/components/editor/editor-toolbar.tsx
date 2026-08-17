'use client';

/**
 * The SQL editor's toolbar (PLAN §6, §8.5, §9).
 *
 * Four things here are not decoration:
 *
 *  - **Cancel is a request, not a disconnect.** It POSTs the run id to
 *    /api/query/cancel; closing the socket would leave the statement burning
 *    CPU on the server (§6 "Query cancellation").
 *  - **Transaction mode pins a session.** A pool checkout per statement puts
 *    BEGIN and COMMIT on different connections, so the atomic path runs the
 *    whole script on one pinned session (§6 "Sessions vs pools").
 *  - **The prod treatment is structural.** A production connection paints the
 *    toolbar red and every write goes through a typed confirmation (§9).
 *  - **Export belongs to the shared wizard.** This contributes the statement
 *    behind the current result and hands off to the one dialog the shell mounts
 *    (components/transfer/transfer-host.tsx), so the same Export button reaches
 *    every §7.1 scope rather than only the result set.
 */

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Ban,
  ChevronsRight,
  Download,
  Gauge,
  History as HistoryIcon,
  Lock,
  Play,
  Star,
  Wand2,
} from 'lucide-react';

import { api } from '@/lib/api-client';
import type { SchemaResponse, TreeResponse } from '@/lib/api-types';
import type { ConnectionConfig } from '@/lib/connection';
import { workspaceModeFor } from '@/lib/connection';
import type { ExplainNode, ExplainPlan } from '@/lib/results';
import {
  Badge,
  Button,
  Dialog,
  ErrorBox,
  Select,
  Separator,
  Spinner,
  Toolbar,
  cn,
} from '@/components/ui/primitives';
import { formatDuration, type QueryRunner } from '@/hooks/use-query-runner';
import {
  onWorkspaceCommand,
  useConnectionState,
  useWorkspaceStore,
  type WorkspaceTab,
} from '@/state/workspace-store';
import { useConnections } from '@/components/shell/connection-sidebar';
import { openExportDialog } from '@/components/transfer/transfer-host';
import type { EditorHandle } from './sql-editor';
import { HistoryDialog } from './history-panel';
import { SavedQueriesDialog } from './saved-queries';

export interface EditorToolbarProps {
  tab: WorkspaceTab;
  connection: ConnectionConfig | null;
  runner: QueryRunner;
  /**
   * A ref, not the handle itself: the handle only exists after the editor has
   * mounted, and a value captured during render would be null forever.
   */
  editor: React.RefObject<EditorHandle | null>;
  sql: string;
  txMode: boolean;
  onToggleTx: (next: boolean) => void;
  database?: string;
  schema?: string;
  onContextChange: (patch: { database?: string; schema?: string }) => void;
  onRunStatement: () => void;
  onRunScript: () => void;
  onRunSelection: () => void;
  onFormat: () => void;
  onLoadSql: (sql: string, name?: string) => void;
}

export function EditorToolbar(props: EditorToolbarProps) {
  const { tab, connection, runner, editor, sql, txMode } = props;
  const connections = useConnections();
  const connectionState = useConnectionState(tab.connectionId);
  const setTabConnection = useWorkspaceStore((s) => s.setTabConnection);
  const setActiveConnection = useWorkspaceStore((s) => s.setActiveConnection);

  const [explain, setExplain] = React.useState<{ open: boolean; analyze: boolean }>({ open: false, analyze: false });
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [savedOpen, setSavedOpen] = React.useState(false);
  const mod = useModifierLabel();

  const sqlConnections = (connections.data?.connections ?? []).filter((c) => workspaceModeFor(c.engine) === 'sql');
  const isProd = connection?.envTag === 'prod';
  const readOnly = connection?.readOnly === true;

  // The tree root is where databases live for every engine that has more than
  // one; SQLite answers with none, and the picker simply does not appear.
  const tree = useQuery<TreeResponse>({
    queryKey: ['tree', tab.connectionId, 'root'],
    queryFn: () => api.get<TreeResponse>(`/api/tree?connectionId=${encodeURIComponent(tab.connectionId ?? '')}`),
    enabled: !!tab.connectionId && connectionState === 'connected',
    retry: false,
    staleTime: 60_000,
  });

  const schema = useQuery<SchemaResponse>({
    queryKey: ['schema', tab.connectionId],
    queryFn: () => api.get<SchemaResponse>(`/api/schema?connectionId=${encodeURIComponent(tab.connectionId ?? '')}`),
    enabled: !!tab.connectionId && connectionState === 'connected',
    retry: false,
    staleTime: 60_000,
  });

  const databases = (tree.data?.nodes ?? []).filter((n) => n.kind === 'database').map((n) => n.label);
  const namespaces = (schema.data?.model.namespaces ?? []).map((n) => n.name);

  /** What Run/Explain/Export act on: the selection, else the statement under the caret. */
  const currentStatement = React.useCallback((): string => {
    const handle = editor.current;
    const selection = handle?.getSelection();
    if (selection && selection.text.trim() !== '') return selection.text;
    const cursor = handle?.getCursor() ?? 0;
    const text = handle?.getSql() ?? sql;
    return runner.statementAt(text, cursor)?.text ?? text;
  }, [editor, runner, sql]);

  const exportStatement = React.useCallback((): string => {
    const active = runner.results[runner.activeResult];
    if (active && !active.error) return active.statement;
    return currentStatement();
  }, [currentStatement, runner.activeResult, runner.results]);

  /**
   * The editor's contribution to the export wizard is one thing: the statement
   * behind whatever the user is looking at. Everything else — scopes, formats,
   * destinations, native dumps — belongs to the shared dialog (§7.1), which is
   * why this hands over a statement instead of rendering its own.
   */
  const openExport = React.useCallback((): void => {
    const statement = exportStatement();
    openExportDialog({
      connectionId: tab.connectionId,
      sql: statement,
      source: statement.trim() === '' ? undefined : { kind: 'query', sql: statement },
    });
  }, [exportStatement, tab.connectionId]);

  // The palette fires these at whichever pane owns them; the dialogs live here.
  // 'export' is the exception: the wizard is mounted once by the shell, and this
  // tab only contributes the statement behind the current result. The palette
  // opens it directly when no SQL tab is active, so this never double-opens.
  React.useEffect(
    () =>
      onWorkspaceCommand((command) => {
        if (useWorkspaceStore.getState().activeTabId !== tab.id) return;
        if (command === 'explain') setExplain({ open: true, analyze: false });
        else if (command === 'export') openExport();
        else if (command === 'save') setSavedOpen(true);
      }),
    [tab.id, openExport],
  );

  return (
    <div className={cn('shrink-0', isProd && 'border-l-2 border-[var(--danger)]')}>
      {isProd && (
        <div className="flex items-center gap-2 border-b border-[var(--danger)]/40 bg-[var(--danger-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--danger)]">
          Production · {connection?.name}
          <span className="font-normal normal-case tracking-normal">
            every write asks you to type the connection name first
          </span>
        </div>
      )}

      <Toolbar>
        <Select
          className="w-40 shrink-0"
          value={tab.connectionId ?? ''}
          onChange={(e) => {
            const id = e.target.value || null;
            setTabConnection(tab.id, id);
            if (id) setActiveConnection(id);
          }}
          title="Connection this tab runs against"
        >
          <option value="">No connection</option>
          {sqlConnections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>

        {databases.length > 0 && (
          <Select
            className="w-32 shrink-0"
            value={props.database ?? ''}
            onChange={(e) => props.onContextChange({ database: e.target.value || undefined })}
            title="Database this tab runs against"
          >
            <option value="">default db</option>
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        )}

        {namespaces.length > 1 && (
          <Select
            className="w-32 shrink-0"
            value={props.schema ?? ''}
            onChange={(e) => props.onContextChange({ schema: e.target.value || undefined })}
            title="Default schema / search path for this tab"
          >
            <option value="">default schema</option>
            {namespaces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        )}

        <Separator vertical />

        <Button
          size="xs"
          variant="primary"
          icon={<Play className="size-3" />}
          disabled={runner.running || !tab.connectionId}
          onClick={props.onRunStatement}
          title={`Run the statement under the cursor (${mod}↩)`}
        >
          Run
        </Button>
        <Button
          size="xs"
          icon={<ChevronsRight className="size-3" />}
          disabled={runner.running || !tab.connectionId}
          onClick={props.onRunScript}
          title={`Run every statement in the buffer (⇧${mod}↩)`}
        >
          Script
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={runner.running || !tab.connectionId}
          onClick={props.onRunSelection}
          title={`Run the selection (${mod}R)`}
        >
          Selection
        </Button>
        <Button
          size="xs"
          variant="danger"
          icon={<Ban className="size-3" />}
          disabled={!runner.running}
          onClick={() => {
            void runner.cancel();
            toast.message('Cancelling on the server…');
          }}
          title="Ask the server to stop the running statement"
        >
          Cancel
        </Button>

        <Separator vertical />

        <Button
          size="xs"
          variant={txMode ? 'primary' : 'ghost'}
          onClick={() => props.onToggleTx(!txMode)}
          disabled={readOnly}
          title={
            'Transaction mode: the whole script runs on one pinned session inside a single transaction and rolls ' +
            'back as a unit. Statement outcomes are reported instead of result grids.'
          }
        >
          Tx
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<Gauge className="size-3" />}
          disabled={runner.running || !tab.connectionId}
          onClick={() => setExplain({ open: true, analyze: false })}
          title="Show the query plan"
        >
          Explain
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={runner.running || !tab.connectionId || readOnly}
          onClick={() => setExplain({ open: true, analyze: true })}
          title="EXPLAIN ANALYZE really executes the statement"
        >
          Analyze
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<Wand2 className="size-3" />}
          onClick={props.onFormat}
          title={`Format the buffer (⇧${mod}F)`}
        >
          Format
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<Download className="size-3" />}
          disabled={!tab.connectionId}
          onClick={openExport}
          title="Export this result set, a table or the whole database"
        >
          Export
        </Button>

        <Separator vertical />

        <Button
          size="xs"
          variant="ghost"
          icon={<HistoryIcon className="size-3" />}
          onClick={() => setHistoryOpen(true)}
          title="Query history"
        >
          History
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<Star className="size-3" />}
          onClick={() => setSavedOpen(true)}
          title="Saved queries"
        >
          Saved
        </Button>

        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-[var(--fg-subtle)]">
          {readOnly && (
            <span className="flex items-center gap-1 text-[var(--fg-muted)]">
              <Lock className="size-3" /> read-only
            </span>
          )}
          {txMode && <Badge tone="accent">transaction</Badge>}
          {runner.running ? (
            <span className="flex items-center gap-1">
              <Spinner className="size-3" />
              {runner.progress ? `${runner.progress.rows.toLocaleString()} rows · ${runner.progress.phase}` : 'running'}
            </span>
          ) : (
            runner.durationMs !== null && <span>{formatDuration(runner.durationMs)}</span>
          )}
        </span>
      </Toolbar>

      <ExplainDialog
        open={explain.open}
        analyze={explain.analyze}
        onClose={() => setExplain((e) => ({ ...e, open: false }))}
        getStatement={currentStatement}
        runner={runner}
      />

      <HistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        connectionId={tab.connectionId}
        onRestore={(text) => props.onLoadSql(text)}
      />

      <SavedQueriesDialog
        open={savedOpen}
        onClose={() => setSavedOpen(false)}
        connectionId={tab.connectionId}
        currentSql={sql}
        onLoad={(text, name) => props.onLoadSql(text, name)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explain (§6 power tools)
// ---------------------------------------------------------------------------

function ExplainDialog({
  open,
  analyze,
  onClose,
  getStatement,
  runner,
}: {
  open: boolean;
  analyze: boolean;
  onClose: () => void;
  /** Resolved when the dialog opens, so the buffer is not re-lexed per keystroke. */
  getStatement: () => string;
  runner: QueryRunner;
}) {
  const [plan, setPlan] = React.useState<ExplainPlan | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [raw, setRaw] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlan(null);
    runner
      .explain(getStatement(), analyze)
      .then((result) => {
        if (!cancelled) setPlan(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not produce a plan');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // The statement is read once, when the dialog opens; re-planning on every
    // keystroke behind the dialog would hammer the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, analyze]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={analyze ? 'Explain analyze' : 'Explain'}
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={() => setRaw((v) => !v)} disabled={!plan}>
            {raw ? 'Show tree' : 'Show raw'}
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {loading && (
        <div className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
          <Spinner /> {analyze ? 'Running the statement…' : 'Planning…'}
        </div>
      )}
      {error && <ErrorBox title="Could not explain this statement" message={error} />}
      {plan && !raw && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[11px] text-[var(--fg-muted)]">
            <Badge>{plan.engine}</Badge>
            {plan.analyzed && <Badge tone="accent">analyzed</Badge>}
            {plan.planningTimeMs !== undefined && <span>planning {formatDuration(plan.planningTimeMs)}</span>}
            {plan.totalTimeMs !== undefined && <span>total {formatDuration(plan.totalTimeMs)}</span>}
          </div>
          <PlanNode node={plan.root} depth={0} />
        </div>
      )}
      {plan && raw && (
        <pre className="mono max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-[var(--fg)]">
          {plan.raw}
        </pre>
      )}
    </Dialog>
  );
}

function PlanNode({ node, depth }: { node: ExplainNode; depth: number }) {
  const share = Math.max(0, Math.min(1, node.share ?? 0));
  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <div className="flex items-center gap-2 border-b border-[var(--border)] py-1">
        {/* The flame bar: share of total runtime, so the expensive node is obvious. */}
        <span className="h-1.5 w-16 shrink-0 bg-[var(--bg-active)]">
          <span
            className="block h-full"
            style={{
              width: `${Math.round(share * 100)}%`,
              background: share > 0.5 ? 'var(--danger)' : share > 0.2 ? 'var(--warn)' : 'var(--accent)',
            }}
          />
        </span>
        <span className="text-[12px] font-medium">{node.label}</span>
        {node.detail && <span className="truncate text-[11px] text-[var(--fg-muted)]">{node.detail}</span>}
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-[var(--fg-subtle)]">
          {node.actualRows !== undefined && `${node.actualRows.toLocaleString()} rows`}
          {node.actualRows === undefined && node.estimatedRows !== undefined && `~${node.estimatedRows.toLocaleString()} rows`}
          {node.actualTimeMs !== undefined && ` · ${formatDuration(node.actualTimeMs)}`}
          {node.actualTimeMs === undefined && node.estimatedCost !== undefined && ` · cost ${Math.round(node.estimatedCost)}`}
        </span>
      </div>
      {node.children.map((child, i) => (
        <PlanNode key={i} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** ⌘ on a Mac, Ctrl+ elsewhere. Resolved after mount so SSR markup matches. */
function useModifierLabel(): string {
  const [mac, setMac] = React.useState(false);
  React.useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);
  return mac ? '⌘' : 'Ctrl+';
}
