'use client';

/**
 * Workspace state (PLAN §2: "state: TanStack Query (server) + Zustand
 * (workspace/tabs)").
 *
 * Server data lives in TanStack Query. This store holds only what the *window*
 * looks like: open tabs, the active connection, the pane layout and the pinned
 * session per tab. It is written back to the app database through
 * PUT /api/workspace (debounced) so a reload restores the desk you left.
 *
 * Two small live-data stores live here too — connection state and jobs — because
 * both are fed by one WebSocket subscription mounted once by the shell and read
 * from several panes (sidebar dot, status bar, jobs drawer).
 */

import { randomId } from '@/lib/ids';
import { useEffect } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../lib/api-client';
import { wsClient } from '../lib/ws-client';
import type { ConnectionState, JobSummary, ServerMessage } from '../lib/api-types';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type TabKind = 'sql' | 'table' | 'redis' | 'mongo' | 'diagram' | 'compare';

/** What the status bar shows for the active tab; feature panes keep it current. */
export interface TabStatus {
  rowCount?: number;
  durationMs?: number;
  dirty?: boolean;
  message?: string;
}

export interface WorkspaceTab {
  id: string;
  kind: TabKind;
  title: string;
  connectionId: string | null;
  /** Dedupe key — opening the same table twice focuses the existing tab. */
  key?: string;
  /** Pinned server session id: transaction mode keeps one physical link (§6). */
  sessionId: string | null;
  /** Feature-owned state (SQL text, filters, scroll offset…). Persisted. */
  state: Record<string, unknown>;
  status: TabStatus;
  createdAt: number;
}

export interface OpenTabSpec {
  kind: TabKind;
  title?: string;
  connectionId?: string | null;
  key?: string;
  state?: Record<string, unknown>;
  sessionId?: string | null;
  /** Open in the background instead of focusing. */
  background?: boolean;
}

export interface LayoutState {
  /** Percentages of the outer horizontal group. */
  sidebarPct: number;
  mainPct: number;
  /** Percentages of the inner vertical group (centre / drawer). */
  editorPct: number;
  bottomPct: number;
  sidebarCollapsed: boolean;
  bottomCollapsed: boolean;
  bottomTab: BottomTab;
}

export type BottomTab = 'results' | 'jobs';

export const DEFAULT_LAYOUT: LayoutState = {
  sidebarPct: 22,
  mainPct: 78,
  editorPct: 62,
  bottomPct: 38,
  sidebarCollapsed: false,
  bottomCollapsed: false,
  bottomTab: 'results',
};

interface PersistedWorkspace {
  version: 1;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  activeConnectionId: string | null;
  layout: LayoutState;
}

interface WorkspaceStore {
  hydrated: boolean;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  activeConnectionId: string | null;
  layout: LayoutState;

  hydrate: () => Promise<void>;
  openTab: (spec: OpenTabSpec) => string;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  setActiveTab: (id: string) => void;
  nextTab: (delta: number) => void;
  renameTab: (id: string, title: string) => void;
  setTabState: (id: string, patch: Record<string, unknown>) => void;
  setTabStatus: (id: string, patch: TabStatus) => void;
  setTabSession: (id: string, sessionId: string | null) => void;
  setTabConnection: (id: string, connectionId: string | null) => void;
  setActiveConnection: (connectionId: string | null) => void;
  setLayout: (patch: Partial<LayoutState>) => void;
  toggleSidebar: () => void;
  toggleBottom: () => void;
  setBottomTab: (tab: BottomTab) => void;
}

function newId(): string {
  return randomId();
}

function defaultTitle(kind: TabKind): string {
  switch (kind) {
    case 'sql':
      return 'Query';
    case 'table':
      return 'Table';
    case 'redis':
      return 'Keys';
    case 'mongo':
      return 'Collection';
    case 'diagram':
      return 'Diagram';
    case 'compare':
      return 'Compare';
  }
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  hydrated: false,
  tabs: [],
  activeTabId: null,
  activeConnectionId: null,
  layout: DEFAULT_LAYOUT,

  async hydrate() {
    if (get().hydrated) return;
    try {
      const raw = await api.get<unknown>('/api/workspace');
      const saved = normalizePersisted(raw);
      if (saved) {
        set({
          tabs: saved.tabs,
          activeTabId: saved.activeTabId,
          activeConnectionId: saved.activeConnectionId,
          layout: { ...DEFAULT_LAYOUT, ...saved.layout },
          hydrated: true,
        });
        return;
      }
    } catch {
      // A missing or unreadable workspace must never block the app; the user
      // simply starts with an empty desk.
    }
    set({ hydrated: true });
  },

  openTab(spec) {
    const { tabs } = get();
    if (spec.key) {
      const existing = tabs.find((t) => t.key === spec.key && t.connectionId === (spec.connectionId ?? null));
      if (existing) {
        set({ activeTabId: existing.id });
        schedulePersist();
        return existing.id;
      }
    }
    const tab: WorkspaceTab = {
      id: newId(),
      kind: spec.kind,
      title: spec.title ?? defaultTitle(spec.kind),
      connectionId: spec.connectionId ?? get().activeConnectionId,
      key: spec.key,
      sessionId: spec.sessionId ?? null,
      state: spec.state ?? {},
      status: {},
      createdAt: Date.now(),
    };
    set({ tabs: [...tabs, tab], activeTabId: spec.background ? get().activeTabId : tab.id });
    schedulePersist();
    return tab.id;
  },

  closeTab(id) {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const next = tabs.filter((t) => t.id !== id);
    let nextActive = activeTabId;
    if (activeTabId === id) nextActive = (next[index] ?? next[index - 1] ?? null)?.id ?? null;
    set({ tabs: next, activeTabId: nextActive });
    schedulePersist();
  },

  closeOtherTabs(id) {
    set({ tabs: get().tabs.filter((t) => t.id === id), activeTabId: id });
    schedulePersist();
  },

  setActiveTab(id) {
    set({ activeTabId: id });
    schedulePersist();
  },

  nextTab(delta) {
    const { tabs, activeTabId } = get();
    if (tabs.length === 0) return;
    const i = tabs.findIndex((t) => t.id === activeTabId);
    const target = tabs[(((i < 0 ? 0 : i) + delta) % tabs.length + tabs.length) % tabs.length];
    if (target) set({ activeTabId: target.id });
  },

  renameTab(id, title) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, title } : t)) });
    schedulePersist();
  },

  setTabState(id, patch) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, state: { ...t.state, ...patch } } : t)) });
    schedulePersist();
  },

  setTabStatus(id, patch) {
    // Status changes are per-query chatter, so they update the store but do not
    // schedule a write of the whole workspace.
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, status: { ...t.status, ...patch } } : t)) });
  },

  setTabSession(id, sessionId) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, sessionId } : t)) });
    schedulePersist();
  },

  setTabConnection(id, connectionId) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, connectionId, sessionId: null } : t)) });
    schedulePersist();
  },

  setActiveConnection(connectionId) {
    set({ activeConnectionId: connectionId });
    schedulePersist();
  },

  setLayout(patch) {
    set({ layout: { ...get().layout, ...patch } });
    schedulePersist();
  },

  toggleSidebar() {
    set({ layout: { ...get().layout, sidebarCollapsed: !get().layout.sidebarCollapsed } });
    schedulePersist();
  },

  toggleBottom() {
    set({ layout: { ...get().layout, bottomCollapsed: !get().layout.bottomCollapsed } });
    schedulePersist();
  },

  setBottomTab(tab) {
    set({ layout: { ...get().layout, bottomTab: tab, bottomCollapsed: false } });
    schedulePersist();
  },
}));

/** The tab the editor area is showing, or null when the desk is empty. */
export function useActiveTab(): WorkspaceTab | null {
  return useWorkspaceStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);
}

// ---------------------------------------------------------------------------
// Persistence: debounced PUT /api/workspace
// ---------------------------------------------------------------------------

const PERSIST_DEBOUNCE_MS = 700;
/** Per-tab state larger than this is dropped rather than written every keystroke. */
const MAX_TAB_STATE_BYTES = 64 * 1024;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (typeof window === 'undefined') return;
  if (!useWorkspaceStore.getState().hydrated) return; // never clobber with defaults
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

export async function persistNow(): Promise<void> {
  const s = useWorkspaceStore.getState();
  const payload: PersistedWorkspace = {
    version: 1,
    tabs: s.tabs.map((t) => ({ ...t, state: trimState(t.state), status: {} })),
    activeTabId: s.activeTabId,
    activeConnectionId: s.activeConnectionId,
    layout: s.layout,
  };
  try {
    // The route stores `workspace` opaquely — the shape above is ours alone.
    await api.put('/api/workspace', { workspace: payload });
  } catch {
    // Layout persistence is a convenience, never a reason to interrupt work.
  }
}

function trimState(state: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(state);
    if (json.length <= MAX_TAB_STATE_BYTES) return state;
  } catch {
    return {};
  }
  return {};
}

/** The stored blob is `unknown` (workspaceRepo.get) — validate before trusting it. */
function normalizePersisted(raw: unknown): PersistedWorkspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as Record<string, unknown>;
  // Tolerate either the bare document or a `{ workspace }` / `{ state }` wrapper.
  const candidate = (isRecord(outer.workspace) ? outer.workspace : isRecord(outer.state) ? outer.state : outer) as Record<
    string,
    unknown
  >;
  const rawTabs = Array.isArray(candidate.tabs) ? candidate.tabs : [];
  const tabs: WorkspaceTab[] = [];
  for (const entry of rawTabs) {
    if (!isRecord(entry)) continue;
    const kind = entry.kind;
    if (typeof entry.id !== 'string' || !isTabKind(kind)) continue;
    tabs.push({
      id: entry.id,
      kind,
      title: typeof entry.title === 'string' ? entry.title : defaultTitle(kind),
      connectionId: typeof entry.connectionId === 'string' ? entry.connectionId : null,
      key: typeof entry.key === 'string' ? entry.key : undefined,
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
      state: isRecord(entry.state) ? entry.state : {},
      status: {},
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    });
  }
  const layout = isRecord(candidate.layout) ? (candidate.layout as Partial<LayoutState>) : {};
  const activeTabId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null;
  return {
    version: 1,
    tabs,
    activeTabId: tabs.some((t) => t.id === activeTabId) ? activeTabId : (tabs[tabs.length - 1]?.id ?? null),
    activeConnectionId: typeof candidate.activeConnectionId === 'string' ? candidate.activeConnectionId : null,
    layout: { ...DEFAULT_LAYOUT, ...layout },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const TAB_KINDS: TabKind[] = ['sql', 'table', 'redis', 'mongo', 'diagram', 'compare'];
function isTabKind(v: unknown): v is TabKind {
  return typeof v === 'string' && (TAB_KINDS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Command bus — the palette and toolbars fire, feature panes listen
// ---------------------------------------------------------------------------

export type WorkspaceCommand =
  | 'run'
  | 'run-selection'
  | 'cancel'
  | 'explain'
  | 'save'
  | 'format'
  | 'export'
  | 'refresh-schema';

type CommandListener = (command: WorkspaceCommand, payload?: unknown) => void;
const commandListeners = new Set<CommandListener>();

export function onWorkspaceCommand(listener: CommandListener): () => void {
  commandListeners.add(listener);
  return () => commandListeners.delete(listener);
}

export function emitWorkspaceCommand(command: WorkspaceCommand, payload?: unknown): void {
  for (const l of [...commandListeners]) l(command, payload);
}

// ---------------------------------------------------------------------------
// Live connection state (§8.3 "a visible connection-state indicator")
// ---------------------------------------------------------------------------

interface ConnStateStore {
  states: Record<string, ConnectionState>;
  messages: Record<string, string | undefined>;
  /** When each state was recorded, so a stale poll cannot undo a fresh event. */
  stampedAt: Record<string, number>;
  apply: (connectionId: string, state: ConnectionState, message?: string) => void;
  merge: (states: Record<string, ConnectionState>) => void;
}

/** How long an optimistic "connecting" outranks a server snapshot. */
const OPTIMISTIC_WINDOW_MS = 20_000;

export const useConnStateStore = create<ConnStateStore>((set, get) => ({
  states: {},
  messages: {},
  stampedAt: {},
  apply(connectionId, state, message) {
    set({
      states: { ...get().states, [connectionId]: state },
      messages: { ...get().messages, [connectionId]: message },
      stampedAt: { ...get().stampedAt, [connectionId]: Date.now() },
    });
  },
  merge(states) {
    // The manager's own view wins, except while one of our own connect attempts
    // is still in flight — the poll would otherwise flicker the dot back to idle.
    const { states: current, stampedAt } = get();
    const next = { ...current };
    const now = Date.now();
    for (const [id, state] of Object.entries(states)) {
      const optimistic = current[id] === 'connecting' && now - (stampedAt[id] ?? 0) < OPTIMISTIC_WINDOW_MS;
      if (!optimistic) next[id] = state;
    }
    set({ states: next });
  },
}));

export function useConnectionState(connectionId: string | null | undefined): ConnectionState {
  return useConnStateStore((s) => (connectionId ? (s.states[connectionId] ?? 'idle') : 'idle'));
}

/**
 * One socket subscription for every connection dot in the app. Subscribes both
 * globally and per connection id because the hub keys subscriptions by
 * (channel, connectionId) and a broadcaster may fan out either way.
 */
export function useConnectionStateFeed(connectionIds: string[]): void {
  const key = connectionIds.join(',');
  useEffect(() => {
    const apply = useConnStateStore.getState().apply;
    const off = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === 'connection-state') apply(msg.connectionId, msg.state, msg.message);
    });
    const unsubs = [wsClient.subscribe({ channel: 'connection-state' })];
    for (const id of key ? key.split(',') : []) {
      unsubs.push(wsClient.subscribe({ channel: 'connection-state', connectionId: id }));
    }
    return () => {
      off();
      for (const u of unsubs) u();
    };
  }, [key]);
}

// ---------------------------------------------------------------------------
// Live jobs (§7.3 "a jobs drawer that survives page reloads")
// ---------------------------------------------------------------------------

export const ACTIVE_JOB_STATUSES: JobSummary['status'][] = ['queued', 'running', 'cancelling'];

interface JobsStore {
  jobs: Record<string, JobSummary>;
  upsert: (job: JobSummary) => void;
  replaceAll: (jobs: JobSummary[]) => void;
  remove: (id: string) => void;
}

export const useJobsStore = create<JobsStore>((set, get) => ({
  jobs: {},
  upsert(job) {
    set({ jobs: { ...get().jobs, [job.id]: job } });
  },
  replaceAll(jobs) {
    set({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) });
  },
  remove(id) {
    const next = { ...get().jobs };
    delete next[id];
    set({ jobs: next });
  },
}));

/**
 * `useShallow` is required, not decoration: a zustand v5 selector that builds a
 * new array on every call breaks React's getSnapshot caching and loops.
 */
export function useJobList(): JobSummary[] {
  return useJobsStore(
    useShallow((s) =>
      Object.values(s.jobs).sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt)),
    ),
  );
}

export function useActiveJobCount(): number {
  return useJobsStore((s) => Object.values(s.jobs).filter((j) => ACTIVE_JOB_STATUSES.includes(j.status)).length);
}

/** Mounted once by the shell: seeds from HTTP, then follows the `jobs` channel. */
export function useJobsFeed(): void {
  useEffect(() => {
    const { upsert, replaceAll } = useJobsStore.getState();
    let cancelled = false;
    void api
      .get<unknown>('/api/jobs')
      .then((payload) => {
        if (cancelled) return;
        const jobs = normalizeJobs(payload);
        if (jobs) replaceAll(jobs);
      })
      .catch(() => undefined);

    const off = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === 'job-update') upsert(msg.job);
    });
    const unsub = wsClient.subscribe({ channel: 'jobs' });
    return () => {
      cancelled = true;
      off();
      unsub();
    };
  }, []);
}

function normalizeJobs(payload: unknown): JobSummary[] | null {
  if (Array.isArray(payload)) return payload as JobSummary[];
  if (isRecord(payload) && Array.isArray(payload.jobs)) return payload.jobs as JobSummary[];
  return null;
}
