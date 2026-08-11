'use client';

/**
 * The database object tree (PLAN §1 Navigation, §6).
 *
 * Lazy: every level is one POST /api/tree for the node that was expanded, never
 * a walk of the whole catalog — a 500-table schema opens instantly because
 * nothing behind the visible level has been read yet.
 *
 * Virtualized with @tanstack/react-virtual, so a keyspace with ten thousand
 * nodes scrolls at the same cost as one with ten. Rows are a fixed height,
 * which keeps the scrollbar honest and the arrow keys exact.
 *
 * Keyboard: ↑/↓ move, →/← expand/collapse (← on a leaf jumps to the parent),
 * Enter opens the object's editor, Space toggles, ⇧F10 opens the context menu.
 */

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronsDownUp, Database, RefreshCw } from 'lucide-react';
import { Button, EmptyState, ErrorBox, Spinner, Toolbar, cn } from '@/components/ui/primitives';
import { EngineIcon, StateDot, useConnections } from '@/components/shell/connection-sidebar';
import { formatSchemaAge, useSchema } from '@/hooks/use-schema';
import { useTree, type TreeRow } from '@/hooks/use-tree';
import { useConnectionState, useWorkspaceStore } from '@/state/workspace-store';
import { qualifiedName, type SchemaModel } from '@/lib/schema-model';
import { TREE_ROW_HEIGHT, TreeRowView } from './tree-node';
import { TreeSearch, treePathForTable, type SearchHit } from './tree-search';
import { ObjectContextMenu, openObjectTab, type ObjectTarget } from './object-context-menu';

/** Hover-to-prefetch delay: long enough that sweeping the mouse costs nothing. */
const PREFETCH_DELAY_MS = 120;

interface MenuState {
  target: ObjectTarget;
  x: number;
  y: number;
}

export function SchemaTree({
  connectionId: connectionIdProp,
  className,
}: {
  /** Defaults to the workspace's active connection. */
  connectionId?: string | null;
  className?: string;
}) {
  const activeConnectionId = useWorkspaceStore((s) => s.activeConnectionId);
  const connectionId = connectionIdProp !== undefined ? connectionIdProp : activeConnectionId;

  const connections = useConnections();
  const connection = connections.data?.connections.find((c) => c.id === connectionId) ?? null;
  const connectionState = useConnectionState(connectionId);

  const tree = useTree(connectionId);
  // Disabled by default: the tree must never trigger a full introspection just
  // by being mounted (§8.3). It still reads whatever is already cached, which
  // is what makes the age chip and "search everywhere" instant afterwards.
  const schema = useSchema(connectionId, { enabled: false });

  const [filter, setFilter] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  /** Set by "search everywhere": scroll to this node once its level arrives. */
  const [pendingReveal, setPendingReveal] = React.useState<string | null>(null);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    setFilter('');
    setSelectedId(null);
    setMenu(null);
  }, [connectionId]);

  React.useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const rows = React.useMemo(() => filterRows(tree.rows, filter), [tree.rows, filter]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  const indexOf = React.useCallback((id: string | null) => (id ? rows.findIndex((r) => r.id === id) : -1), [rows]);

  const focus = React.useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, index));
      const row = rows[clamped];
      if (!row) return;
      setSelectedId(row.id);
      virtualizer.scrollToIndex(clamped, { align: 'auto' });
    },
    [rows, virtualizer],
  );

  // A revealed node only exists once its parent level has loaded, so the scroll
  // waits for it to appear rather than firing into an empty list.
  React.useEffect(() => {
    if (!pendingReveal) return;
    const index = rows.findIndex((r) => r.id === pendingReveal);
    if (index < 0) return;
    setSelectedId(pendingReveal);
    virtualizer.scrollToIndex(index, { align: 'center' });
    setPendingReveal(null);
  }, [pendingReveal, rows, virtualizer]);

  const targetFor = React.useCallback(
    (row: TreeRow): ObjectTarget | null =>
      connectionId ? { connectionId, connection, node: row.node, segments: row.segments } : null,
    [connectionId, connection],
  );

  const openRow = React.useCallback(
    (row: TreeRow) => {
      const target = targetFor(row);
      // Kinds with no editor of their own (folders, schemas) expand instead.
      if (!target || !openObjectTab(target)) {
        if (row.node.hasChildren) tree.toggle(row.segments);
      }
    },
    [targetFor, tree],
  );

  const onHover = React.useCallback(
    (row: TreeRow) => {
      if (!row.node.hasChildren || tree.isExpanded(row.id)) return;
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => tree.prefetch(row.segments), PREFETCH_DELAY_MS);
    },
    [tree],
  );

  // Stable handlers: the rows are memoized, so inline arrows would undo it.
  const onSelectRow = React.useCallback((row: TreeRow) => setSelectedId(row.id), []);

  const onToggleRow = React.useCallback(
    (row: TreeRow) => {
      setSelectedId(row.id);
      tree.toggle(row.segments);
    },
    [tree],
  );

  const onContextMenuRow = React.useCallback(
    (row: TreeRow, event: React.MouseEvent) => {
      const target = targetFor(row);
      if (!target) return;
      setSelectedId(row.id);
      setMenu({ target, x: event.clientX, y: event.clientY });
    },
    [targetFor],
  );

  const closeMenu = React.useCallback(() => setMenu(null), []);

  const refreshSubtree = React.useCallback(
    (segments: string[]) => void tree.refresh(segments.length > 0 ? segments : undefined),
    [tree],
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (rows.length === 0) return;
    const current = indexOf(selectedId);
    const index = current < 0 ? 0 : current;
    const row = rows[index];

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focus(index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focus(index - 1);
        return;
      case 'Home':
        event.preventDefault();
        focus(0);
        return;
      case 'End':
        event.preventDefault();
        focus(rows.length - 1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (row?.node.hasChildren && !tree.isExpanded(row.id)) tree.setOpen(row.segments, true);
        else focus(index + 1);
        return;
      case 'ArrowLeft': {
        event.preventDefault();
        if (!row) return;
        if (row.node.hasChildren && tree.isExpanded(row.id)) {
          tree.setOpen(row.segments, false);
          return;
        }
        const parent = rows.findIndex((r) => r.id === row.parentId);
        if (parent >= 0) focus(parent);
        return;
      }
      case ' ':
        event.preventDefault();
        if (row?.node.hasChildren) tree.toggle(row.segments);
        return;
      case 'Enter':
        event.preventDefault();
        if (row) openRow(row);
        return;
      case 'Escape':
        setMenu(null);
        return;
      case 'F10':
        if (!event.shiftKey || !row) return;
        event.preventDefault();
        openMenuForRow(row);
        return;
      default:
    }
  }

  function openMenuForRow(row: TreeRow): void {
    const target = targetFor(row);
    if (!target) return;
    const element = scrollRef.current?.querySelector(`[data-node-id="${CSS.escape(row.id)}"]`);
    const rect = element?.getBoundingClientRect();
    setSelectedId(row.id);
    setMenu({ target, x: rect ? rect.left + 24 : 80, y: rect ? rect.bottom : 80 });
  }

  /** A hit may name an object nobody has expanded: reveal it, then open it. */
  function onPickSearchHit(hit: SearchHit, model: SchemaModel): void {
    setFilter('');
    const path = treePathForTable(model, hit.table);
    if (path) {
      tree.reveal(path);
      setPendingReveal(path.join('/'));
    }
    if (connectionId) {
      useWorkspaceStore.getState().openTab({
        kind: 'table',
        title: hit.table.name,
        key: `table:${qualifiedName(hit.table)}`,
        connectionId,
        state: {
          schema: hit.table.schema,
          table: hit.table.name,
          tableKind: hit.table.kind,
          ...(hit.column ? { focusColumn: hit.column.name } : {}),
        },
      });
    }
  }

  function refreshAll(): void {
    void tree.refresh();
    // Only re-introspect when something was already read; the button must not
    // become a way to accidentally trigger a first full introspection.
    if (schema.fetchedAt !== null) void schema.refresh();
  }

  if (!connectionId) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col bg-[var(--bg-panel)]', className)}>
        <EmptyState
          icon={<Database className="size-6" />}
          title="No connection selected"
          description="Pick a connection to browse its databases, schemas and tables."
        />
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-[var(--bg-panel)]', className)}>
      <Toolbar>
        {connection && <EngineIcon engine={connection.engine} className="size-3.5 text-[var(--fg-muted)]" />}
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
          {connection?.name ?? 'Objects'}
        </span>
        <StateDot state={connectionState} />
        <span className="ml-auto flex items-center gap-0.5">
          <Button
            size="xs"
            variant="ghost"
            title="Collapse all"
            aria-label="Collapse all"
            onClick={() => tree.collapseAll()}
          >
            <ChevronsDownUp className="size-3.5" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title="Refresh the tree (and re-introspect if the schema was read)"
            aria-label="Refresh"
            loading={schema.isRefreshing}
            onClick={refreshAll}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </span>
      </Toolbar>

      <TreeSearch
        connectionId={connectionId}
        value={filter}
        onChange={setFilter}
        matched={rows.length}
        total={tree.rows.length}
        onPick={onPickSearchHit}
        onEscape={() => scrollRef.current?.focus()}
      />

      <div
        ref={scrollRef}
        role="tree"
        aria-label="Database objects"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="focus-ring min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
      >
        {tree.rootLevel.isLoading && (
          <div className="flex items-center gap-2 p-3 text-xs text-[var(--fg-muted)]">
            <Spinner className="size-3" /> Reading the catalog…
          </div>
        )}

        {tree.rootLevel.error && (
          <div className="p-2">
            <ErrorBox
              title="Could not read this connection"
              message={tree.rootLevel.error}
              hint="Check the connection settings, then refresh."
            />
          </div>
        )}

        {!tree.rootLevel.isLoading && !tree.rootLevel.error && rows.length === 0 && (
          <p className="p-3 text-xs text-[var(--fg-subtle)]">
            {filter ? 'Nothing loaded matches that filter. Try “search everywhere”.' : 'This server reports no objects.'}
          </p>
        )}

        <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const level = tree.levels.get(row.id);
            return (
              <TreeRowView
                key={item.key}
                row={row}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
                expanded={tree.isExpanded(row.id)}
                selected={selectedId === row.id}
                focused={false}
                loading={level?.isLoading ?? false}
                error={level?.error ?? null}
                query={filter}
                onToggle={onToggleRow}
                onSelect={onSelectRow}
                onOpen={openRow}
                onHover={onHover}
                onContextMenu={onContextMenuRow}
              />
            );
          })}
        </div>
      </div>

      {schema.fetchedAt !== null && (
        <div className="shrink-0 border-t border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--fg-subtle)]">
          schema from {formatSchemaAge(schema.ageMs)}
        </div>
      )}

      <ObjectContextMenu
        target={menu?.target ?? null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={closeMenu}
        onRefresh={refreshSubtree}
      />
    </div>
  );
}

/**
 * Client-side filter over the loaded rows. Ancestors of a match are kept so the
 * hierarchy still reads as a tree rather than a flat list of orphans.
 */
function filterRows(rows: TreeRow[], query: string): TreeRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return rows;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const keep = new Set<string>();

  for (const row of rows) {
    if (!row.node.label.toLowerCase().includes(needle)) continue;
    keep.add(row.id);
    let parentId = row.parentId;
    while (parentId !== '' && !keep.has(parentId)) {
      keep.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? '';
    }
  }

  return rows.filter((r) => keep.has(r.id));
}
