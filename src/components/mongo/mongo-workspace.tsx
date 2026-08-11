'use client';

/**
 * The MongoDB workspace (PLAN M5) — the tab view for a connection whose
 * `workspaceModeFor(engine)` is `document`.
 *
 * Three sections over one collection: **Documents** (a find, shown as a grid or
 * as a document tree), **Aggregate** (the pipeline builder) and **Indexes**.
 * The navigator on the left is the collection browser.
 *
 * Everything the user typed — the namespace, the find parameters, the pipeline
 * — lives in the tab's own state, so it is written back to the app database and
 * a reload restores the desk that was left (PLAN §5 `workspace`). Results are
 * deliberately not persisted: they are a page of a live server, not a document.
 */

import * as React from 'react';
import { Group, Panel, Separator as PanelSeparator } from 'react-resizable-panels';
import { Database, Leaf } from 'lucide-react';
import { api } from '../../lib/api-client';
import type { MongoFindRequest } from '../../lib/api-types';
import { ENGINE_LABELS, workspaceModeFor } from '../../lib/connection';
import type { ResultSet } from '../../lib/results';
import { useWorkspaceStore } from '../../state/workspace-store';
import { Badge, Button, EmptyState, Tabs } from '../ui/primitives';
import { useConnections } from '../shell/connection-sidebar';
import { registerTabView, type TabViewProps } from '../shell/workspace';
import { CollectionBrowser } from './collection-browser';
import { DocumentView, type DocumentViewMode } from './document-view';
import { QueryBar, DEFAULT_FIND_PARAMS, formatCount, type FindParams } from './query-bar';
import { AggregationBuilder, defaultPipeline, type PipelineStage } from './aggregation-builder';
import { MongoIndexes } from './mongo-indexes';

type Section = 'documents' | 'aggregate' | 'indexes';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'documents', label: 'Documents' },
  { id: 'aggregate', label: 'Aggregate' },
  { id: 'indexes', label: 'Indexes' },
];

interface MongoTabState {
  database: string;
  collection: string;
  section: Section;
  params: FindParams;
  docMode: DocumentViewMode;
  pipeline: PipelineStage[];
  aggregateLimit: number;
}

// ---------------------------------------------------------------------------
// Persisted tab state
// ---------------------------------------------------------------------------

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The stored blob is `unknown` — it came out of SQLite and may predate any
 * field here, so every value is validated rather than trusted.
 */
function readTabState(state: Record<string, unknown>): MongoTabState {
  const rawParams = (state.params ?? {}) as Record<string, unknown>;
  const params: FindParams = {
    filter: str(rawParams.filter, DEFAULT_FIND_PARAMS.filter),
    projection: str(rawParams.projection),
    sort: str(rawParams.sort),
    limit: Math.max(1, Math.min(10_000, Math.trunc(num(rawParams.limit, DEFAULT_FIND_PARAMS.limit)))),
    skip: Math.max(0, Math.trunc(num(rawParams.skip, 0))),
  };

  const rawPipeline = Array.isArray(state.pipeline) ? state.pipeline : [];
  const pipeline: PipelineStage[] = [];
  for (const entry of rawPipeline) {
    if (typeof entry !== 'object' || entry === null) continue;
    const stage = entry as Record<string, unknown>;
    if (typeof stage.op !== 'string' || typeof stage.body !== 'string') continue;
    pipeline.push({
      id: str(stage.id) || `stage-restored-${pipeline.length}`,
      op: stage.op,
      body: stage.body,
      enabled: stage.enabled !== false,
    });
  }

  const section = state.section;
  const docMode = state.docMode;
  return {
    // The object tree opens a Mongo tab with a plain {database, collection};
    // both spellings are accepted so either entry point works.
    database: str(state.database),
    collection: str(state.collection),
    section: section === 'aggregate' || section === 'indexes' ? section : 'documents',
    params,
    docMode: docMode === 'tree' ? 'tree' : 'table',
    pipeline: pipeline.length > 0 ? pipeline : defaultPipeline(),
    aggregateLimit: Math.max(1, Math.min(10_000, Math.trunc(num(state.aggregateLimit, 50)))),
  };
}

/** Open (or focus) a Mongo tab for one collection. */
export function openMongoTab(connectionId: string, database?: string, collection?: string): string {
  return useWorkspaceStore.getState().openTab({
    kind: 'mongo',
    connectionId,
    title: collection ? `${database}.${collection}` : 'Collections',
    key: collection ? `mongo:${database}.${collection}` : undefined,
    state: { database: database ?? '', collection: collection ?? '' },
  });
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export function MongoWorkspace({ tab }: TabViewProps) {
  const connections = useConnections();
  const connectionId = tab.connectionId ?? '';
  const connection = (connections.data?.connections ?? []).find((c) => c.id === connectionId);

  const [view, setView] = React.useState<MongoTabState>(() => readTabState(tab.state));
  const [result, setResult] = React.useState<ResultSet | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const update = React.useCallback(
    (patch: Partial<MongoTabState>) => {
      setView((prev) => ({ ...prev, ...patch }));
      useWorkspaceStore.getState().setTabState(tab.id, patch as Record<string, unknown>);
    },
    [tab.id],
  );

  const runFind = React.useCallback(
    async (params: FindParams, database: string, collection: string) => {
      if (!connectionId || !database || !collection) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setError(null);
      try {
        const body: MongoFindRequest = {
          connectionId,
          database,
          collection,
          // Extended JSON text: EJSON.parse decodes it server-side, so an
          // ObjectId written as {"$oid": "…"} arrives as a real ObjectId.
          filter: params.filter.trim() || '{}',
          projection: params.projection.trim() || undefined,
          sort: params.sort.trim() || undefined,
          limit: params.limit,
          skip: params.skip,
        };
        const found = await api.post<ResultSet>('/api/mongo/find', body, controller.signal);
        setResult(found);
        useWorkspaceStore.getState().setTabStatus(tab.id, {
          rowCount: found.rows.length,
          durationMs: found.durationMs,
          message: found.statement,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setResult(null);
        setError(err instanceof Error ? err.message : 'Find failed');
      } finally {
        if (!controller.signal.aborted) setRunning(false);
      }
    },
    [connectionId, tab.id],
  );

  // A restored tab already names a collection: load its first page once.
  const loaded = React.useRef(false);
  React.useEffect(() => {
    if (loaded.current || !connectionId || !view.database || !view.collection) return;
    loaded.current = true;
    void runFind(view.params, view.database, view.collection);
  }, [connectionId, view.database, view.collection, view.params, runFind]);

  function selectCollection(database: string, collection: string): void {
    const params = { ...view.params, skip: 0 };
    update({ database, collection, params });
    useWorkspaceStore.getState().renameTab(tab.id, `${database}.${collection}`);
    loaded.current = true;
    if (view.section === 'documents') void runFind(params, database, collection);
    else setResult(null);
  }

  function page(delta: number): void {
    const skip = Math.max(0, view.params.skip + delta * view.params.limit);
    if (skip === view.params.skip) return;
    const params = { ...view.params, skip };
    update({ params });
    void runFind(params, view.database, view.collection);
  }

  function setSection(section: Section): void {
    update({ section });
    // Coming back to Documents with nothing loaded (the collection was picked
    // while another section was open) should show the first page, not a blank.
    if (section === 'documents' && !result && view.database && view.collection) {
      void runFind(view.params, view.database, view.collection);
    }
  }

  // ⌘↵ anywhere in the pane, not only inside the filter editor.
  React.useEffect(() => {
    if (view.section !== 'documents') return;
    const onKey = (e: KeyboardEvent) => {
      // The filter editor binds Mod-Enter itself; it marks the event handled,
      // which is what stops the same find from running twice.
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void runFind(view.params, view.database, view.collection);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.section, view.params, view.database, view.collection, runFind]);

  if (!connectionId) {
    return (
      <EmptyState
        icon={<Database className="size-5" />}
        title="No connection"
        description="This tab is not attached to a connection. Pick one in the sidebar and open a collection."
      />
    );
  }

  if (connection && workspaceModeFor(connection.engine) !== 'document') {
    return (
      <EmptyState
        icon={<Database className="size-5" />}
        title={`${ENGINE_LABELS[connection.engine]} is not a document store`}
        description="The MongoDB workspace only opens on a MongoDB connection."
      />
    );
  }

  const hasNamespace = view.database.length > 0 && view.collection.length > 0;
  const from = view.params.skip + 1;
  const to = view.params.skip + (result?.rows.length ?? 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1">
        <span className="flex items-center gap-1.5 text-xs text-[var(--fg-muted)]">
          <Leaf className="size-3.5 text-[var(--ok)]" />
          {connection?.name ?? 'MongoDB'}
        </span>
        {connection?.envTag === 'prod' && <Badge tone="danger">prod</Badge>}
        {connection?.readOnly && <Badge tone="warn">read-only</Badge>}
        <span className="mono truncate text-[12px] text-[var(--fg)]">
          {hasNamespace ? `${view.database}.${view.collection}` : 'no collection selected'}
        </span>
      </div>

      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel id="browser" minSize="12%" maxSize="45%" defaultSize="22%" className="min-w-0">
          <CollectionBrowser
            connectionId={connectionId}
            database={view.database || null}
            collection={view.collection || null}
            onSelect={selectCollection}
          />
        </Panel>

        <PanelSeparator className="w-px bg-[var(--border)] transition-colors hover:bg-[var(--accent)] data-[separator]:cursor-col-resize" />

        <Panel id="mongo-main" minSize="40%" className="min-w-0">
          <div className="flex h-full min-h-0 flex-col">
            <Tabs
              items={SECTIONS}
              active={view.section}
              onSelect={(id) => setSection(id as Section)}
              className="shrink-0"
            />

            <div className="min-h-0 flex-1">
              {!hasNamespace ? (
                <EmptyState
                  icon={<Database className="size-5" />}
                  title="Pick a collection"
                  description="Expand a database on the left and choose a collection to browse its documents."
                />
              ) : view.section === 'documents' ? (
                <div className="flex h-full min-h-0 flex-col">
                  <QueryBar
                    connectionId={connectionId}
                    database={view.database}
                    collection={view.collection}
                    params={view.params}
                    onChange={(params) => update({ params })}
                    onRun={() => void runFind(view.params, view.database, view.collection)}
                    running={running}
                    error={error}
                  />
                  <div className="min-h-0 flex-1">
                    <DocumentView
                      connectionId={connectionId}
                      database={view.database}
                      collection={view.collection}
                      result={result}
                      loading={running}
                      error={error}
                      onRefresh={() => void runFind(view.params, view.database, view.collection)}
                      mode={view.docMode}
                      onModeChange={(docMode) => update({ docMode })}
                      toolbarExtra={
                        <span className="flex items-center gap-1">
                          <span className="tabular-nums">
                            {result && result.rows.length > 0 ? `${formatCount(from)}–${formatCount(to)}` : '—'}
                          </span>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={view.params.skip === 0 || running}
                            onClick={() => page(-1)}
                            title="Previous page"
                          >
                            Prev
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            // PLAN §8.3: paging forward lets the connector use an
                            // _id range cursor instead of a server-side skip.
                            disabled={!result?.truncated || running}
                            onClick={() => page(1)}
                            title="Next page"
                          >
                            Next
                          </Button>
                        </span>
                      }
                    />
                  </div>
                </div>
              ) : view.section === 'aggregate' ? (
                <AggregationBuilder
                  connectionId={connectionId}
                  database={view.database}
                  collection={view.collection}
                  stages={view.pipeline}
                  onStagesChange={(pipeline) => update({ pipeline })}
                  limit={view.aggregateLimit}
                  onLimitChange={(aggregateLimit) => update({ aggregateLimit })}
                  docMode={view.docMode}
                  onDocModeChange={(docMode) => update({ docMode })}
                />
              ) : (
                <MongoIndexes
                  connectionId={connectionId}
                  database={view.database}
                  collection={view.collection}
                />
              )}
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  );
}

// The shell keeps no imports of its own from feature modules; each one attaches
// itself when it is loaded (PLAN §11 "registerTabView / registerWorkspaceSlot").
registerTabView('mongo', MongoWorkspace);

export default MongoWorkspace;
