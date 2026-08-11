'use client';

/**
 * The lazy object tree (PLAN §1 Navigation, §6 "one level at a time").
 *
 * Every expanded node is its own TanStack Query keyed by its path, so a schema
 * with 500 tables costs exactly one request per level the user actually opens —
 * never a whole-tree walk. Levels are cached per path, survive collapse/expand,
 * and a node's children can be prefetched on hover before the click lands.
 *
 * The query key is `['tree', connectionId, ...segments]`, which makes a node's
 * key the prefix of every key beneath it: invalidating one node invalidates its
 * whole subtree for free, and `['tree', connectionId]` is both the root level's
 * key and the "refresh everything" prefix.
 *
 * Expansion state is remembered per connection and written to localStorage, so
 * reopening the app puts you back where you were rather than at the root.
 */

import * as React from 'react';
import { useQueries, useQueryClient, type QueryKey, type UseQueryResult } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from '@/lib/api-client';
import type { TreeResponse } from '@/lib/api-types';
import type { TreeNode } from '@/lib/results';

export const TREE_QUERY_ROOT = 'tree';

/** A level is stable for a minute; DDL and explicit refreshes invalidate it. */
const LEVEL_STALE_MS = 60_000;
/** Guard against a connector that ever returns a self-referential path. */
const MAX_DEPTH = 24;

export function treeQueryKey(connectionId: string, segments: string[]): QueryKey {
  return [TREE_QUERY_ROOT, connectionId, ...segments];
}

/** The id of a level: exactly what `TreeNode.id` holds for that node. */
export function pathId(segments: string[]): string {
  return segments.join('/');
}

/**
 * A child's own segment. Derived by subtracting the parent's path from the
 * node id rather than splitting on '/', because a Redis key name may contain
 * slashes and `TreeNode.id` is authoritative.
 */
export function segmentOf(node: TreeNode, parentId: string): string {
  if (parentId === '') return node.id;
  return node.id.startsWith(`${parentId}/`) ? node.id.slice(parentId.length + 1) : node.id;
}

async function fetchLevel(connectionId: string, segments: string[]): Promise<TreeNode[]> {
  const res = await api.post<TreeResponse>('/api/tree', { connectionId, path: segments });
  return res.nodes ?? [];
}

function levelQuery(connectionId: string, segments: string[], enabled = true) {
  return {
    queryKey: treeQueryKey(connectionId, segments),
    queryFn: () => fetchLevel(connectionId, segments),
    enabled,
    staleTime: LEVEL_STALE_MS,
    gcTime: 10 * 60_000,
    retry: false as const,
  };
}

// ---------------------------------------------------------------------------
// Remembered expansion state
// ---------------------------------------------------------------------------

/** pathId → the segments that produced it (kept so a reload can re-request). */
type ExpandedPaths = Record<string, string[]>;

const STORAGE_KEY = 'dbadmin.tree.expanded';
/** A runaway expansion history must not grow the stored blob without bound. */
const MAX_REMEMBERED = 400;

const NO_PATHS: ExpandedPaths = {};

interface TreeExpansionStore {
  expanded: Record<string, ExpandedPaths>;
  setOpen: (connectionId: string, segments: string[], open: boolean) => void;
  toggle: (connectionId: string, segments: string[]) => void;
  /** Open every ancestor of `segments` so the node itself becomes visible. */
  reveal: (connectionId: string, segments: string[]) => void;
  collapseAll: (connectionId: string) => void;
}

function loadPersisted(): Record<string, ExpandedPaths> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, ExpandedPaths> = {};
    for (const [connectionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const paths: ExpandedPaths = {};
      for (const [id, segments] of Object.entries(value as Record<string, unknown>)) {
        if (!Array.isArray(segments)) continue;
        if (segments.some((s: unknown) => typeof s !== 'string')) continue;
        paths[id] = segments as string[];
      }
      out[connectionId] = paths;
    }
    return out;
  } catch {
    // A corrupt preference must never stop the tree from rendering.
    return {};
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(state: Record<string, ExpandedPaths>): void {
  if (typeof window === 'undefined') return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Private mode / quota: the tree still works, it just forgets.
    }
  }, 300);
}

/** Oldest entries drop out first — insertion order is Object.keys order here. */
function capped(paths: ExpandedPaths): ExpandedPaths {
  const keys = Object.keys(paths);
  if (keys.length <= MAX_REMEMBERED) return paths;
  const out: ExpandedPaths = {};
  for (const key of keys.slice(keys.length - MAX_REMEMBERED)) out[key] = paths[key];
  return out;
}

export const useTreeExpansionStore = create<TreeExpansionStore>((set, get) => ({
  expanded: loadPersisted(),

  setOpen(connectionId, segments, open) {
    const id = pathId(segments);
    if (id === '') return; // the root level is always open
    const current = get().expanded[connectionId] ?? NO_PATHS;
    if (open === (id in current)) return;
    const next = { ...current };
    if (open) next[id] = segments;
    else delete next[id];
    const all = { ...get().expanded, [connectionId]: capped(next) };
    set({ expanded: all });
    schedulePersist(all);
  },

  toggle(connectionId, segments) {
    const current = get().expanded[connectionId] ?? NO_PATHS;
    get().setOpen(connectionId, segments, !(pathId(segments) in current));
  },

  reveal(connectionId, segments) {
    const current = { ...(get().expanded[connectionId] ?? NO_PATHS) };
    // Ancestors only: expanding the target itself would fire a needless request
    // for the children of something the user only wants to see selected.
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i);
      current[pathId(ancestor)] = ancestor;
    }
    const all = { ...get().expanded, [connectionId]: capped(current) };
    set({ expanded: all });
    schedulePersist(all);
  },

  collapseAll(connectionId) {
    const all = { ...get().expanded, [connectionId]: {} };
    set({ expanded: all });
    schedulePersist(all);
  },
}));

// ---------------------------------------------------------------------------
// The flattened, virtualization-ready view
// ---------------------------------------------------------------------------

export interface TreeRow {
  /** `TreeNode.id`, which is also the node's path. Unique, so it is the key. */
  id: string;
  node: TreeNode;
  segments: string[];
  depth: number;
  /** '' for a top-level row. */
  parentId: string;
}

export interface TreeLevel {
  nodes: TreeNode[];
  isLoading: boolean;
  error: string | null;
}

/** Stable identity so a missing level never re-triggers a memo downstream. */
const EMPTY_LEVEL: TreeLevel = { nodes: [], isLoading: false, error: null };

export interface UseTreeResult {
  /** Depth-first, only what is currently visible. Feed this to the virtualizer. */
  rows: TreeRow[];
  levels: Map<string, TreeLevel>;
  expandedIds: Set<string>;
  rootLevel: TreeLevel;
  isExpanded: (id: string) => boolean;
  toggle: (segments: string[]) => void;
  setOpen: (segments: string[], open: boolean) => void;
  collapseAll: () => void;
  /** Expand every ancestor of a path (used by "search everywhere"). */
  reveal: (segments: string[]) => void;
  /** Warm a node's children before the click — called on hover. */
  prefetch: (segments: string[]) => void;
  /** Re-read one level and everything under it; omit for the whole connection. */
  refresh: (segments?: string[]) => Promise<void>;
}

export function useTree(connectionId: string | null | undefined): UseTreeResult {
  const client = useQueryClient();
  const expandedPaths = useTreeExpansionStore((s) =>
    connectionId ? (s.expanded[connectionId] ?? NO_PATHS) : NO_PATHS,
  );
  const store = useTreeExpansionStore;

  const expandedIds = React.useMemo(() => new Set(Object.keys(expandedPaths)), [expandedPaths]);

  /**
   * Which levels to request: the root, plus every remembered expansion whose
   * ancestors are all expanded too. The filter is pure string work, so a
   * restored session never fetches levels hidden behind a collapsed parent.
   */
  const requested = React.useMemo(() => {
    const visible: string[][] = [[]];
    for (const [id, segments] of Object.entries(expandedPaths)) {
      let ok = true;
      for (let i = 1; i < segments.length; i++) {
        if (!expandedIds.has(pathId(segments.slice(0, i)))) {
          ok = false;
          break;
        }
      }
      if (ok && id !== '') visible.push(segments);
    }
    // Shallow levels first so React Query issues the requests in tree order.
    return visible.sort((a, b) => a.length - b.length || pathId(a).localeCompare(pathId(b)));
  }, [expandedPaths, expandedIds]);

  // Always the same shape, disabled rather than absent when there is no
  // connection: a homogeneous array keeps useQueries' inference predictable.
  const results = useQueries({
    queries: requested.map((segments) => levelQuery(connectionId ?? '', segments, !!connectionId)),
  }) as UseQueryResult<TreeNode[], Error>[];

  /**
   * `results` is a fresh array on every render, so the rows would lose their
   * identity — and with them the memoized virtual rows — several times a
   * second. The signature captures what actually changed.
   */
  const signature = results
    .map((r) => `${r.dataUpdatedAt}:${r.errorUpdatedAt}:${r.isFetching ? 1 : 0}`)
    .join('|');

  const levels = React.useMemo(() => {
    const map = new Map<string, TreeLevel>();
    requested.forEach((segments, i) => {
      const result = results[i];
      if (!result) return;
      map.set(pathId(segments), {
        nodes: result.data ?? [],
        isLoading: result.isFetching && result.data === undefined,
        error: result.error instanceof Error ? result.error.message : null,
      });
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, signature]);

  const rows = React.useMemo(() => flatten(levels, expandedIds), [levels, expandedIds]);

  const rootLevel = levels.get('') ?? EMPTY_LEVEL;

  const setOpen = React.useCallback(
    (segments: string[], open: boolean) => {
      if (connectionId) store.getState().setOpen(connectionId, segments, open);
    },
    [connectionId, store],
  );

  const toggle = React.useCallback(
    (segments: string[]) => {
      if (connectionId) store.getState().toggle(connectionId, segments);
    },
    [connectionId, store],
  );

  const collapseAll = React.useCallback(() => {
    if (connectionId) store.getState().collapseAll(connectionId);
  }, [connectionId, store]);

  const reveal = React.useCallback(
    (segments: string[]) => {
      if (connectionId) store.getState().reveal(connectionId, segments);
    },
    [connectionId, store],
  );

  const prefetch = React.useCallback(
    (segments: string[]) => {
      if (!connectionId) return;
      // prefetchQuery honours staleTime, so a warm level costs nothing. It takes
      // fetch options rather than query options, hence the explicit shape.
      void client.prefetchQuery({
        queryKey: treeQueryKey(connectionId, segments),
        queryFn: () => fetchLevel(connectionId, segments),
        staleTime: LEVEL_STALE_MS,
      });
    },
    [client, connectionId],
  );

  const refresh = React.useCallback(
    async (segments?: string[]) => {
      if (!connectionId) return;
      await client.invalidateQueries({
        queryKey: segments ? treeQueryKey(connectionId, segments) : [TREE_QUERY_ROOT, connectionId],
      });
    },
    [client, connectionId],
  );

  const isExpanded = React.useCallback((id: string) => expandedIds.has(id), [expandedIds]);

  // Memoized as a whole: the rows are handed to memoized virtual items, and a
  // fresh object here would re-render every visible row on every render.
  return React.useMemo(
    () => ({
      rows,
      levels,
      expandedIds,
      rootLevel,
      isExpanded,
      toggle,
      setOpen,
      collapseAll,
      reveal,
      prefetch,
      refresh,
    }),
    [rows, levels, expandedIds, rootLevel, isExpanded, toggle, setOpen, collapseAll, reveal, prefetch, refresh],
  );
}

/** Depth-first walk of the loaded levels, honouring the expansion set. */
function flatten(levels: Map<string, TreeLevel>, expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (parentId: string, parentSegments: string[], depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const level = levels.get(parentId);
    if (!level) return;
    for (const node of level.nodes) {
      const segments = [...parentSegments, segmentOf(node, parentId)];
      rows.push({ id: node.id, node, segments, depth, parentId });
      if (node.hasChildren && expanded.has(node.id)) walk(node.id, segments, depth + 1);
    }
  };

  walk('', [], 0);
  return rows;
}
