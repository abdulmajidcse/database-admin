'use client';

/**
 * The IDE shell (PLAN §2).
 *
 * Three panes: connections + object tree on the left, the editor/grid area in
 * the centre, a results/jobs drawer along the bottom. Sizes are persisted to the
 * app database through the workspace store, so the desk you left is the desk you
 * come back to.
 *
 * Feature areas (SQL editor, grid, Redis, Mongo, ER diagram, schema compare) are
 * separate modules and plug in here through `registerTabView` /
 * `registerWorkspaceSlot`, which keeps the shell free of imports from every
 * feature and lets each one ship independently.
 */

import * as React from 'react';
import { Group, Panel, Separator as PanelSeparator, useGroupRef, usePanelRef } from 'react-resizable-panels';
import { toast } from 'sonner';
import { Activity, Ban, Database, Play, Plus, Table2 } from 'lucide-react';
import { api, ApiRequestError } from '../../lib/api-client';
import type { JobSummary } from '../../lib/api-types';
import { workspaceModeFor } from '../../lib/connection';
import {
  ACTIVE_JOB_STATUSES,
  useActiveTab,
  useConnectionStateFeed,
  useJobList,
  useJobsFeed,
  useWorkspaceStore,
  type TabKind,
  type WorkspaceTab,
} from '../../state/workspace-store';
import { Badge, Button, EmptyState, Spinner, Tabs, cn } from '../ui/primitives';
import { ConnectionSidebar, openConnectionEditor, useConnections } from './connection-sidebar';
import { CommandPalette, openCommandPalette } from './command-palette';
import { StatusBar } from './status-bar';
import { ShortcutsSheet } from './shortcuts-sheet';

// ---------------------------------------------------------------------------
// Slot registry — how feature modules attach to the shell
// ---------------------------------------------------------------------------

export interface TabViewProps {
  tab: WorkspaceTab;
}

export interface SlotProps {
  connectionId: string | null;
  tab: WorkspaceTab | null;
}

/**
 * `overlays` is rendered unconditionally, outside every panel and tab — the home
 * for feature dialogs that any surface can open (the transfer wizards). A tab
 * view cannot host those: the shell mounts only the active tab, so an export
 * started from the command palette with no SQL tab open would go nowhere.
 */
export type SlotName = 'object-tree' | 'results' | 'jobs' | 'sidebar-extra' | 'overlays';

const tabViews = new Map<TabKind, React.ComponentType<TabViewProps>>();
const slots = new Map<SlotName, React.ComponentType<SlotProps>>();

let registryVersion = 0;
const registryListeners = new Set<() => void>();

function bumpRegistry(): void {
  registryVersion += 1;
  for (const l of [...registryListeners]) l();
}

/** Register the editor for a tab kind, e.g. `registerTabView('sql', SqlWorkspace)`. */
export function registerTabView(kind: TabKind, view: React.ComponentType<TabViewProps>): void {
  tabViews.set(kind, view);
  bumpRegistry();
}

/** Register a shell region, e.g. `registerWorkspaceSlot('object-tree', SchemaTree)`. */
export function registerWorkspaceSlot(name: SlotName, view: React.ComponentType<SlotProps>): void {
  slots.set(name, view);
  bumpRegistry();
}

function useRegistry(): number {
  return React.useSyncExternalStore(
    (l) => {
      registryListeners.add(l);
      return () => registryListeners.delete(l);
    },
    () => registryVersion,
    () => 0,
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** True for an element that owns the keystroke — a field, or a CodeMirror pane. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

export function Workspace() {
  useRegistry();
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const connections = useConnections();
  const hydrated = useWorkspaceStore((s) => s.hydrated);
  const layout = useWorkspaceStore((s) => s.layout);
  const setLayout = useWorkspaceStore((s) => s.setLayout);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const activeTab = useActiveTab();
  const activeConnectionId = useWorkspaceStore((s) => s.activeConnectionId);

  const outerRef = useGroupRef();
  const innerRef = useGroupRef();
  const sidebarRef = usePanelRef();
  const bottomRef = usePanelRef();

  React.useEffect(() => {
    void useWorkspaceStore.getState().hydrate();
  }, []);

  // Live feeds: one socket subscription each, shared by every pane.
  const connectionIds = React.useMemo(
    () => (connections.data?.connections ?? []).map((c) => c.id),
    [connections.data],
  );
  useConnectionStateFeed(connectionIds);
  useJobsFeed();

  // The stored layout arrives after the first paint, so it is applied
  // imperatively rather than through defaultLayout.
  React.useEffect(() => {
    if (!hydrated) return;
    outerRef.current?.setLayout({ sidebar: layout.sidebarPct, main: layout.mainPct });
    innerRef.current?.setLayout({ editor: layout.editorPct, bottom: layout.bottomPct });
    // Deliberately only on hydration: later user drags own the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  React.useEffect(() => {
    if (layout.sidebarCollapsed) sidebarRef.current?.collapse();
    else sidebarRef.current?.expand();
  }, [layout.sidebarCollapsed, sidebarRef]);

  React.useEffect(() => {
    if (layout.bottomCollapsed) bottomRef.current?.collapse();
    else bottomRef.current?.expand();
  }, [layout.bottomCollapsed, bottomRef]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // `?` opens the cheat sheet, but only when nothing is being typed into —
      // otherwise it would swallow a question mark in a WHERE clause.
      if (!mod && e.key === '?' && !isTypingTarget(e.target)) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        useWorkspaceStore.getState().toggleSidebar();
      } else if (key === 'j') {
        e.preventDefault();
        useWorkspaceStore.getState().toggleBottom();
      } else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        useWorkspaceStore.getState().nextTab(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ObjectTree = slots.get('object-tree');
  const Results = slots.get('results');
  const JobsSlot = slots.get('jobs');
  const SidebarExtra = slots.get('sidebar-extra');
  const Overlays = slots.get('overlays');
  const bottomTab = Results ? layout.bottomTab : 'jobs';

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--bg)]">
      <Group
        orientation="horizontal"
        groupRef={outerRef}
        className="min-h-0 flex-1"
        defaultLayout={{ sidebar: layout.sidebarPct, main: layout.mainPct }}
        onLayoutChanged={(l, meta) => {
          if (!meta.isUserInteraction) return;
          setLayout({ sidebarPct: l.sidebar ?? layout.sidebarPct, mainPct: l.main ?? layout.mainPct });
        }}
      >
        <Panel
          id="sidebar"
          panelRef={sidebarRef}
          minSize="12%"
          maxSize="45%"
          collapsible
          collapsedSize={0}
          className="min-w-0"
        >
          <div className="flex h-full min-h-0 flex-col border-r border-[var(--border)]">
            {ObjectTree ? (
              <Group orientation="vertical" className="min-h-0 flex-1">
                <Panel id="connections" minSize="15%" defaultSize="40%">
                  <ConnectionSidebar />
                </Panel>
                <PanelSeparator className="h-px bg-[var(--border)] hover:bg-[var(--accent)] data-[separator]:cursor-row-resize" />
                <Panel id="tree" minSize="20%">
                  <ObjectTree connectionId={activeConnectionId} tab={activeTab} />
                </Panel>
              </Group>
            ) : (
              <ConnectionSidebar />
            )}
            {SidebarExtra && (
              <div className="border-t border-[var(--border)]">
                <SidebarExtra connectionId={activeConnectionId} tab={activeTab} />
              </div>
            )}
          </div>
        </Panel>

        <PanelSeparator className="w-px bg-[var(--border)] transition-colors hover:bg-[var(--accent)] data-[separator]:cursor-col-resize" />

        <Panel id="main" minSize="30%" className="min-w-0">
          <Group
            orientation="vertical"
            groupRef={innerRef}
            className="h-full min-h-0"
            defaultLayout={{ editor: layout.editorPct, bottom: layout.bottomPct }}
            onLayoutChanged={(l, meta) => {
              if (!meta.isUserInteraction) return;
              setLayout({ editorPct: l.editor ?? layout.editorPct, bottomPct: l.bottom ?? layout.bottomPct });
            }}
          >
            <Panel id="editor" minSize="20%" className="min-h-0">
              <div className="flex h-full min-h-0 flex-col">
                {tabs.length > 0 && (
                  <Tabs
                    items={tabs.map((t) => ({
                      id: t.id,
                      label: (
                        <span className="flex items-center gap-1.5">
                          <TabIcon kind={t.kind} />
                          {t.title}
                          {t.status.dirty && <span className="text-[var(--warn)]">•</span>}
                        </span>
                      ),
                      detail: t.sessionId ? 'tx' : undefined,
                      closable: true,
                    }))}
                    active={activeTabId ?? ''}
                    onSelect={(id) => useWorkspaceStore.getState().setActiveTab(id)}
                    onClose={(id) => useWorkspaceStore.getState().closeTab(id)}
                    right={
                      <Button
                        size="xs"
                        variant="ghost"
                        title="New query tab"
                        onClick={() => useWorkspaceStore.getState().openTab({ kind: 'sql' })}
                      >
                        <Plus className="size-3.5" />
                      </Button>
                    }
                  />
                )}
                <div className="min-h-0 flex-1 overflow-hidden">
                  {activeTab ? <TabHost tab={activeTab} /> : <WelcomePane />}
                </div>
              </div>
            </Panel>

            <PanelSeparator className="h-px bg-[var(--border)] transition-colors hover:bg-[var(--accent)] data-[separator]:cursor-row-resize" />

            <Panel id="bottom" panelRef={bottomRef} minSize="10%" collapsible collapsedSize={0} className="min-h-0">
              <div className="flex h-full min-h-0 flex-col border-t border-[var(--border)]">
                <Tabs
                  items={[
                    ...(Results ? [{ id: 'results', label: 'Results' }] : []),
                    { id: 'jobs', label: 'Jobs' },
                  ]}
                  active={bottomTab}
                  onSelect={(id) => useWorkspaceStore.getState().setBottomTab(id === 'jobs' ? 'jobs' : 'results')}
                />
                <div className="min-h-0 flex-1 overflow-auto">
                  {bottomTab === 'results' && Results ? (
                    <Results connectionId={activeConnectionId} tab={activeTab} />
                  ) : JobsSlot ? (
                    <JobsSlot connectionId={activeConnectionId} tab={activeTab} />
                  ) : (
                    <JobsPanel />
                  )}
                </div>
              </div>
            </Panel>
          </Group>
        </Panel>
      </Group>

      <StatusBar />
      <CommandPalette />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {Overlays && <Overlays connectionId={activeConnectionId} tab={activeTab} />}
    </div>
  );
}

function TabIcon({ kind }: { kind: TabKind }) {
  const className = 'size-3 text-[var(--fg-subtle)]';
  switch (kind) {
    case 'table':
      return <Table2 className={className} />;
    case 'sql':
      return <Play className={className} />;
    default:
      return <Database className={className} />;
  }
}

/**
 * Renders the feature module that owns this tab kind. Nothing is stubbed: when a
 * module has not been registered the tab says exactly which one is missing,
 * which is a build-wiring problem rather than a user-facing state.
 */
function TabHost({ tab }: { tab: WorkspaceTab }) {
  useRegistry();
  const View = tabViews.get(tab.kind);
  if (View) return <View tab={tab} />;
  return (
    <EmptyState
      title={`No view registered for "${tab.kind}" tabs`}
      description={`The feature module for this tab kind has not called registerTabView('${tab.kind}', …). Close the tab or load the module.`}
      action={
        <Button onClick={() => useWorkspaceStore.getState().closeTab(tab.id)} size="sm">
          Close tab
        </Button>
      }
    />
  );
}

function WelcomePane() {
  const connections = useConnections();
  const openTab = useWorkspaceStore((s) => s.openTab);
  const activeConnectionId = useWorkspaceStore((s) => s.activeConnectionId);
  const setActiveConnection = useWorkspaceStore((s) => s.setActiveConnection);
  const recent = (connections.data?.connections ?? []).slice(0, 8);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="flex items-center gap-2 text-[var(--fg-muted)]">
        <Database className="size-5" />
        <h1 className="text-[13px] font-semibold">Database Admin</h1>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="primary"
          size="md"
          icon={<Plus className="size-3.5" />}
          onClick={() => openTab({ kind: 'sql' })}
          disabled={!activeConnectionId}
        >
          New query tab
        </Button>
        <Button size="md" onClick={() => openConnectionEditor(null)}>
          New connection
        </Button>
        <Button size="md" variant="ghost" onClick={openCommandPalette}>
          Command palette ⌘K
        </Button>
      </div>
      {recent.length > 0 && (
        <div className="w-full max-w-md">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">Connections</p>
          <div className="border border-[var(--border)]">
            {recent.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveConnection(c.id)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-[var(--bg-hover)]',
                  activeConnectionId === c.id && 'bg-[var(--selection)]',
                )}
              >
                <span
                  className="size-2 rounded-full border border-[var(--border-strong)]"
                  style={c.color ? { background: c.color, borderColor: c.color } : undefined}
                />
                <span className="truncate">{c.name}</span>
                <Badge className="ml-auto">{workspaceModeFor(c.engine)}</Badge>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Built-in jobs drawer (§7.3) — replaced by the transfer module when it
// registers a richer 'jobs' slot.
// ---------------------------------------------------------------------------

async function cancelJob(id: string): Promise<void> {
  try {
    await api.post(`/api/jobs/${id}/cancel`);
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 404 || err.status === 405)) {
      await api.del(`/api/jobs/${id}`);
      return;
    }
    throw err;
  }
}

function JobsPanel() {
  const jobs = useJobList();
  if (jobs.length === 0) {
    return (
      <EmptyState
        icon={<Activity className="size-5" />}
        title="No jobs"
        description="Imports, exports and restores run here in the background and survive a page reload."
      />
    );
  }
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-[var(--grid-header)] text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
        <tr>
          <th className="px-2 py-1 text-left font-medium">Job</th>
          <th className="px-2 py-1 text-left font-medium">Status</th>
          <th className="px-2 py-1 text-left font-medium">Progress</th>
          <th className="px-2 py-1 text-right font-medium">Rows</th>
          <th className="px-2 py-1 text-right font-medium">Out</th>
          <th className="px-2 py-1" />
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
      </tbody>
    </table>
  );
}

function JobRow({ job }: { job: JobSummary }) {
  const active = ACTIVE_JOB_STATUSES.includes(job.status);
  const pct =
    job.progress.tablesTotal > 0
      ? Math.min(100, Math.round((job.progress.tablesDone / job.progress.tablesTotal) * 100))
      : null;
  const tone =
    job.status === 'failed' ? 'danger' : job.status === 'done' ? 'ok' : job.status === 'cancelled' ? 'neutral' : 'accent';

  return (
    <tr className="border-b border-[var(--border)] last:border-0 even:bg-[var(--row-alt)]">
      <td className="max-w-[24rem] truncate px-2 py-1" title={job.title}>
        {job.title}
      </td>
      <td className="px-2 py-1">
        <span className="flex items-center gap-1.5">
          {active && <Spinner className="size-3" />}
          <Badge tone={tone}>{job.status}</Badge>
        </span>
      </td>
      <td className="px-2 py-1">
        <div className="flex items-center gap-2">
          <div className="h-1 w-24 shrink-0 bg-[var(--bg-active)]">
            <div className="h-full bg-[var(--accent)]" style={{ width: `${pct ?? (active ? 100 : 0)}%` }} />
          </div>
          <span className="truncate text-[10px] text-[var(--fg-muted)]">
            {job.progress.phase}
            {job.progress.tablesTotal > 0 && ` ${job.progress.tablesDone}/${job.progress.tablesTotal}`}
            {job.progress.etaMs !== undefined && active && ` · ${Math.round(job.progress.etaMs / 1000)}s left`}
          </span>
        </div>
        {job.error && <p className="mono mt-0.5 text-[10px] text-[var(--danger)]">{job.error}</p>}
      </td>
      <td className="px-2 py-1 text-right tabular-nums">{job.progress.rowsDone.toLocaleString()}</td>
      <td className="px-2 py-1 text-right tabular-nums">{formatBytes(job.progress.bytesOut)}</td>
      <td className="px-2 py-1 text-right">
        {active && (
          <Button
            size="xs"
            variant="ghost"
            icon={<Ban className="size-3" />}
            onClick={() =>
              void cancelJob(job.id).catch((err: unknown) =>
                toast.error(err instanceof Error ? err.message : 'Could not cancel the job'),
              )
            }
          >
            Cancel
          </Button>
        )}
      </td>
    </tr>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
