'use client';

/**
 * One row of the object tree (PLAN §1 Navigation).
 *
 * Rendered inside the virtualizer, so it is memoized and takes an absolute
 * `style` from its parent: thousands of rows must cost nothing to scroll past.
 * Every `TreeNodeKind` gets its own icon and tint, and `TreeNode.detail` — row
 * estimates, column types, index definitions, key TTLs — sits dimmed on the
 * right where it can be scanned without reading the names.
 */

import * as React from 'react';
import {
  Boxes,
  Braces,
  ChevronRight,
  Columns3,
  Database,
  Eye,
  Folder,
  FolderClock,
  FolderCode,
  FolderDot,
  FolderGit2,
  FolderOpen,
  FolderTree,
  Key,
  KeySquare,
  Layers,
  Link2,
  ListChecks,
  ListOrdered,
  ListTree,
  Loader2,
  Server,
  SquareFunction,
  SquareStack,
  Table2,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { TreeNodeKind } from '@/lib/results';
import { cn } from '@/components/ui/primitives';
import type { TreeRow } from '@/hooks/use-tree';

/** Fixed row height — the virtualizer measures nothing, so scrolling is exact. */
export const TREE_ROW_HEIGHT = 22;
/** Indent per level. Dense: an eight-deep Postgres path still fits the sidebar. */
const INDENT = 12;

const KIND_ICON: Record<TreeNodeKind, LucideIcon> = {
  server: Server,
  database: Database,
  schema: Layers,
  'table-folder': Folder,
  'view-folder': FolderOpen,
  'routine-folder': FolderCode,
  'sequence-folder': FolderClock,
  'trigger-folder': FolderGit2,
  'index-folder': FolderTree,
  'column-folder': FolderDot,
  table: Table2,
  view: Eye,
  'materialized-view': SquareStack,
  column: Columns3,
  index: ListTree,
  'foreign-key': Link2,
  routine: SquareFunction,
  sequence: ListOrdered,
  trigger: Zap,
  enum: ListChecks,
  keyspace: Boxes,
  key: Key,
  collection: Braces,
  'mongo-index': KeySquare,
};

/** Tints group the kinds the eye needs to separate at a glance. */
const KIND_TONE: Partial<Record<TreeNodeKind, string>> = {
  server: 'text-[var(--fg-muted)]',
  database: 'text-[var(--accent)]',
  schema: 'text-[var(--accent)]',
  table: 'text-[var(--accent)]',
  view: 'text-[var(--fg-muted)]',
  'materialized-view': 'text-[var(--fg-muted)]',
  collection: 'text-[var(--accent)]',
  key: 'text-[var(--warn)]',
  keyspace: 'text-[var(--warn)]',
  column: 'text-[var(--fg-subtle)]',
  index: 'text-[var(--ok)]',
  'mongo-index': 'text-[var(--ok)]',
  'foreign-key': 'text-[var(--ok)]',
  trigger: 'text-[var(--warn)]',
  routine: 'text-[var(--fg-muted)]',
  sequence: 'text-[var(--fg-muted)]',
  enum: 'text-[var(--fg-muted)]',
};

export function iconForKind(kind: TreeNodeKind): LucideIcon {
  return KIND_ICON[kind] ?? Folder;
}

export function TreeNodeIcon({ kind, className }: { kind: TreeNodeKind; className?: string }) {
  const Icon = iconForKind(kind);
  return <Icon className={cn('size-3.5 shrink-0', KIND_TONE[kind] ?? 'text-[var(--fg-muted)]', className)} />;
}

/** Case-insensitive first-match highlight for the filter box. */
export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-[var(--selection)] text-[var(--fg)]">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

export interface TreeRowViewProps {
  row: TreeRow;
  style: React.CSSProperties;
  expanded: boolean;
  selected: boolean;
  focused: boolean;
  /** The node's children are in flight. */
  loading: boolean;
  /** The node's children failed to load; the message is the tooltip. */
  error: string | null;
  query: string;
  onToggle: (row: TreeRow) => void;
  onSelect: (row: TreeRow) => void;
  onOpen: (row: TreeRow) => void;
  onHover: (row: TreeRow) => void;
  onContextMenu: (row: TreeRow, event: React.MouseEvent) => void;
}

function TreeRowViewImpl({
  row,
  style,
  expanded,
  selected,
  focused,
  loading,
  error,
  query,
  onToggle,
  onSelect,
  onOpen,
  onHover,
  onContextMenu,
}: TreeRowViewProps) {
  const { node, depth } = row;

  return (
    <div
      style={{ ...style, paddingLeft: 2 + depth * INDENT }}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={node.hasChildren ? expanded : undefined}
      data-node-id={node.id}
      title={node.detail ? `${node.label} — ${node.detail}` : node.label}
      onMouseDown={(e) => {
        // Select on mousedown so a right-click targets the row it opened on.
        if (e.button === 0 || e.button === 2) onSelect(row);
      }}
      // Single click only selects — expanding on click makes a mis-click fire a
      // catalog query. The chevron and double-click are the deliberate gestures.
      onDoubleClick={() => onOpen(row)}
      onMouseEnter={() => onHover(row)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(row, e);
      }}
      className={cn(
        'group absolute left-0 top-0 flex w-full cursor-default select-none items-center gap-1 pr-2 text-[13px]',
        selected ? 'bg-[var(--selection)]' : 'hover:bg-[var(--bg-hover)]',
        focused && !selected && 'bg-[var(--bg-hover)]',
      )}
    >
      {node.hasChildren ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row);
          }}
          className="flex size-4 shrink-0 items-center justify-center rounded text-[var(--fg-subtle)] hover:bg-[var(--bg-active)] hover:text-[var(--fg)]"
        >
          {loading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
          )}
        </button>
      ) : (
        <span className="size-4 shrink-0" />
      )}

      <TreeNodeIcon kind={node.kind} />

      <span className={cn('truncate', node.kind === 'column' && 'mono')}>
        <Highlight text={node.label} query={query} />
      </span>

      {error ? (
        <TriangleAlert className="size-3 shrink-0 text-[var(--danger)]" aria-label={error} />
      ) : null}

      {node.detail ? (
        <span className="ml-auto truncate pl-2 text-[11px] text-[var(--fg-subtle)]">{node.detail}</span>
      ) : null}
    </div>
  );
}

export const TreeRowView = React.memo(TreeRowViewImpl);
