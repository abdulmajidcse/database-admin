'use client';

/**
 * Redis keyspace browser (PLAN M4 · §6 "Redis at scale").
 *
 * SCAN with MATCH/COUNT and honest cursor pagination: every page carries the
 * server's `ScanCursor` forward untouched, so cluster `nodeCursors` survive the
 * round trip. There is deliberately NO "load all keys" action anywhere in this
 * file — `KEYS *` blocks the server for the whole traversal and would hang a
 * production box (PLAN §6), and an unbounded auto-scan is the same mistake with
 * extra steps, so the auto-loader stops after MAX_AUTO_PAGES and hands control
 * back to the user.
 *
 * Keys are shown either flat (arrival order — SCAN order, so nothing jumps
 * around as pages append) or grouped into a tree on the `:` separator, which is
 * the convention every Redis codebase uses for namespacing.
 *
 * This module also owns the small Redis value-formatting helpers (TTL, sizes,
 * type badge) that the value editor and the INFO panel re-use: they are
 * presentation of `KeyMeta`, which is this file's subject.
 */

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderClosed,
  FolderOpen,
  Hash,
  ListTree,
  RefreshCw,
  Search,
} from 'lucide-react';
import { api } from '../../lib/api-client';
import type { RedisScanRequest, RedisScanResponse } from '../../lib/api-types';
import type { KeyMeta, RedisValueType, ScanCursor } from '../../lib/results';
import { Badge, Button, ErrorBox, Input, Select, Spinner, Toolbar, cn } from '../ui/primitives';

// ---------------------------------------------------------------------------
// Shared Redis formatting (re-used by value-editor.tsx and redis-info.tsx)
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString();
}

/** Milliseconds as a compact duration: `1d 4h`, `12m 30s`, `450ms`. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(abs / 1000);
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const sign = ms < 0 ? '-' : '';
  if (d > 0) return `${sign}${d}d ${h}h`;
  if (h > 0) return `${sign}${h}h ${m}m`;
  if (m > 0) return `${sign}${m}m ${s}s`;
  return `${sign}${s}s`;
}

/**
 * PTTL semantics, which the whole Redis UI speaks: -1 is "no expiry" and -2 is
 * "the key is gone". They are different states and are shown differently.
 */
export function formatTtl(ttlMs: number): { text: string; tone: 'none' | 'live' | 'gone' } {
  if (ttlMs === -1) return { text: '∞', tone: 'none' };
  if (ttlMs === -2) return { text: 'gone', tone: 'gone' };
  if (ttlMs < 0) return { text: '—', tone: 'none' };
  return { text: formatDurationMs(ttlMs), tone: 'live' };
}

const TYPE_LABEL: Record<RedisValueType, string> = {
  string: 'str',
  list: 'list',
  set: 'set',
  zset: 'zset',
  hash: 'hash',
  stream: 'strm',
  none: 'none',
};

const TYPE_TONE: Record<RedisValueType, 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'> = {
  string: 'neutral',
  list: 'accent',
  set: 'ok',
  zset: 'warn',
  hash: 'accent',
  stream: 'danger',
  none: 'neutral',
};

export function TypeBadge({ type, className }: { type: RedisValueType; className?: string }) {
  return (
    <Badge tone={TYPE_TONE[type]} className={cn('w-10 justify-center', className)}>
      {TYPE_LABEL[type]}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

export interface KeyspaceBrowserProps {
  connectionId: string;
  /** Selected database index; undefined means "whatever the connection opened". */
  db: number | undefined;
  selectedKey: string | null;
  onSelect: (meta: KeyMeta) => void;
  /** Bumped by the value editor / console after a write so the page re-scans. */
  reloadToken: number;
}

const ROW_HEIGHT = 22;
/**
 * A MATCH that hits nothing returns empty pages for a long time, and the
 * bottom-of-list trigger would then fire forever. Twenty pages of automatic
 * scanning, then the user asks for more explicitly.
 */
const MAX_AUTO_PAGES = 20;

const PAGE_SIZES = ['', '100', '250', '500', '1000'] as const;

type BrowserRow =
  | { kind: 'folder'; path: string; label: string; depth: number; count: number; open: boolean }
  | { kind: 'key'; label: string; depth: number; meta: KeyMeta };

export function KeyspaceBrowser({ connectionId, db, selectedKey, onSelect, reloadToken }: KeyspaceBrowserProps) {
  const [patternDraft, setPatternDraft] = React.useState('');
  const [pattern, setPattern] = React.useState('');
  const [pageSize, setPageSize] = React.useState<string>('');
  const [grouped, setGrouped] = React.useState(true);
  const [toggled, setToggled] = React.useState<Set<string>>(() => new Set());

  /** Bumped by the refresh button; the restart effect watches it. */
  const [nonce, setNonce] = React.useState(0);

  const [keys, setKeys] = React.useState<KeyMeta[]>([]);
  const [cursor, setCursor] = React.useState<ScanCursor | null>(null);
  const [done, setDone] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Refs rather than state: none of these should trigger a render.
  const seen = React.useRef<Set<string>>(new Set());
  const autoPages = React.useRef(0);
  const runId = React.useRef(0);

  const fetchPage = React.useCallback(
    async (from: ScanCursor, replace: boolean) => {
      const token = runId.current;
      setLoading(true);
      setError(null);
      try {
        const body: RedisScanRequest = { connectionId, cursor: from };
        const res = await api.post<RedisScanResponse>('/api/redis/scan', body);
        if (token !== runId.current) return; // a newer scan superseded this page
        // SCAN only guarantees "at least once" per key, so duplicates across
        // iterations are normal and must be filtered, not rendered twice.
        const fresh: KeyMeta[] = [];
        for (const meta of res.keys) {
          if (seen.current.has(meta.key)) continue;
          seen.current.add(meta.key);
          fresh.push(meta);
        }
        setKeys((prev) => (replace ? fresh : prev.concat(fresh)));
        setCursor(res.next);
        setDone(res.done);
      } catch (err) {
        if (token !== runId.current) return;
        setError(err instanceof Error ? err.message : 'Scan failed');
        // Stop the auto-loader hammering an endpoint that is already failing.
        setDone(true);
      } finally {
        if (token === runId.current) setLoading(false);
      }
    },
    [connectionId],
  );

  // Any change of target (connection, database, MATCH, COUNT) or an external
  // mutation restarts the traversal from cursor 0 — a Redis cursor is only
  // meaningful for the scan that produced it.
  React.useEffect(() => {
    runId.current += 1;
    seen.current = new Set();
    autoPages.current = 0;
    setKeys([]);
    setCursor(null);
    setDone(false);
    const first: ScanCursor = { cursor: '0' };
    if (pattern) first.match = pattern;
    if (pageSize) first.count = Number(pageSize);
    if (db !== undefined) first.db = db;
    void fetchPage(first, true);
  }, [fetchPage, pattern, pageSize, db, reloadToken, nonce]);

  const loadMore = React.useCallback(
    (auto: boolean) => {
      if (loading || done || !cursor) return;
      if (auto) {
        if (autoPages.current >= MAX_AUTO_PAGES) return;
        autoPages.current += 1;
      } else {
        autoPages.current = 0;
      }
      void fetchPage(cursor, false);
    },
    [cursor, done, loading, fetchPage],
  );

  const rows = React.useMemo<BrowserRow[]>(() => {
    if (!grouped) {
      return keys.map((meta) => ({ kind: 'key' as const, label: meta.key, depth: 0, meta }));
    }
    const isOpen = (path: string, depth: number) => (toggled.has(path) ? depth !== 0 : depth === 0);
    return flattenTree(buildTree(keys), 0, isOpen, []);
  }, [keys, grouped, toggled]);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Auto-advance the cursor when the viewport reaches the tail of what we have.
  // An empty result set also qualifies: MATCH commonly skips whole pages.
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  React.useEffect(() => {
    if (rows.length === 0 || lastIndex >= rows.length - 5) loadMore(true);
  }, [lastIndex, rows.length, loadMore]);

  const applyPattern = () => {
    autoPages.current = 0;
    setPattern(patternDraft.trim());
  };

  const toggleFolder = (path: string) => {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const copyKey = (key: string) => {
    void navigator.clipboard
      .writeText(key)
      .then(() => toast.success('Key copied'))
      .catch(() => toast.error('Clipboard is not available'));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-panel)]">
      <Toolbar>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">Keyspace</span>
        {db !== undefined && <Badge tone="accent">db {db}</Badge>}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          title={grouped ? 'Show a flat key list' : 'Group keys on “:”'}
          onClick={() => setGrouped((g) => !g)}
        >
          {grouped ? <ListTree className="size-3.5" /> : <Hash className="size-3.5" />}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          title="Restart the scan"
          onClick={() => setNonce((n) => n + 1)}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
      </Toolbar>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            className="mono pl-6"
            placeholder="MATCH pattern, e.g. user:*"
            value={patternDraft}
            spellCheck={false}
            onChange={(e) => setPatternDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyPattern();
              if (e.key === 'Escape') {
                setPatternDraft('');
                setPattern('');
              }
            }}
            onBlur={applyPattern}
          />
        </div>
        <Select
          className="w-[5.5rem] shrink-0"
          value={pageSize}
          title="SCAN COUNT — a hint per iteration, not a limit"
          onChange={(e) => setPageSize(e.target.value)}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size || 'auto'} value={size}>
              {size === '' ? 'auto' : size}
            </option>
          ))}
        </Select>
      </div>

      {error && (
        <div className="p-2">
          <ErrorBox title="Scan failed" message={error} />
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && !loading && !error && (
          <p className="px-3 py-4 text-xs text-[var(--fg-subtle)]">
            {pattern ? `No keys matched ${pattern}.` : 'No keys in this database.'}
          </p>
        )}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((item) => {
            const row = rows[item.index];
            return (
              <div
                key={item.key}
                className="absolute left-0 top-0 w-full"
                style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
              >
                {row.kind === 'folder' ? (
                  <FolderRow row={row} onToggle={() => toggleFolder(row.path)} />
                ) : (
                  <KeyRow
                    row={row}
                    selected={row.meta.key === selectedKey}
                    onSelect={() => onSelect(row.meta)}
                    onCopy={() => copyKey(row.meta.key)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-muted)]">
        {loading && <Spinner className="size-3" />}
        <span className="tabular-nums">{formatCount(keys.length)} keys</span>
        <span className="text-[var(--fg-subtle)]">
          {done ? 'scan complete' : cursor ? `cursor ${shortCursor(cursor)}` : 'scanning…'}
        </span>
        {!done && (
          <Button size="xs" variant="ghost" className="ml-auto" disabled={loading} onClick={() => loadMore(false)}>
            Scan more
          </Button>
        )}
      </div>
    </div>
  );
}

function FolderRow({ row, onToggle }: { row: Extract<BrowserRow, { kind: 'folder' }>; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-full w-full items-center gap-1 pr-2 text-left text-xs hover:bg-[var(--bg-hover)]"
      style={{ paddingLeft: 6 + row.depth * 12 }}
    >
      {row.open ? (
        <ChevronDown className="size-3 shrink-0 text-[var(--fg-subtle)]" />
      ) : (
        <ChevronRight className="size-3 shrink-0 text-[var(--fg-subtle)]" />
      )}
      {row.open ? (
        <FolderOpen className="size-3 shrink-0 text-[var(--fg-muted)]" />
      ) : (
        <FolderClosed className="size-3 shrink-0 text-[var(--fg-muted)]" />
      )}
      <span className="mono truncate text-[var(--fg)]">{row.label}</span>
      <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--fg-subtle)]">{formatCount(row.count)}</span>
    </button>
  );
}

function KeyRow({
  row,
  selected,
  onSelect,
  onCopy,
}: {
  row: Extract<BrowserRow, { kind: 'key' }>;
  selected: boolean;
  onSelect: () => void;
  onCopy: () => void;
}) {
  const ttl = formatTtl(row.meta.ttlMs);
  return (
    <div
      onClick={onSelect}
      title={row.meta.key}
      className={cn(
        'group flex h-full cursor-pointer items-center gap-1.5 pr-2 text-xs',
        selected ? 'bg-[var(--selection)]' : 'hover:bg-[var(--bg-hover)]',
      )}
      style={{ paddingLeft: 6 + row.depth * 12 + 12 }}
    >
      <TypeBadge type={row.meta.type} className="shrink-0" />
      <span className="mono truncate">{row.label}</span>
      <button
        type="button"
        title="Copy key name"
        aria-label="Copy key name"
        onClick={(e) => {
          e.stopPropagation();
          onCopy();
        }}
        className="shrink-0 rounded p-0.5 text-[var(--fg-subtle)] opacity-0 hover:bg-[var(--bg-active)] hover:text-[var(--fg)] group-hover:opacity-100"
      >
        <Copy className="size-3" />
      </button>
      <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] tabular-nums">
        {row.meta.length !== undefined && (
          <span className="text-[var(--fg-subtle)]" title={`${row.meta.length} elements`}>
            {formatCount(row.meta.length)}
          </span>
        )}
        <span
          className={cn(
            'w-12 text-right',
            ttl.tone === 'live' ? 'text-[var(--warn)]' : 'text-[var(--fg-subtle)]',
          )}
          title={row.meta.ttlMs >= 0 ? `Expires in ${row.meta.ttlMs} ms` : 'No expiry'}
        >
          {ttl.text}
        </span>
        <span className="w-14 text-right text-[var(--fg-subtle)]" title="MEMORY USAGE">
          {formatBytes(row.meta.sizeBytes)}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grouping on the ":" convention
// ---------------------------------------------------------------------------

interface KeyTreeNode {
  label: string;
  path: string;
  count: number;
  folders: Map<string, KeyTreeNode>;
  keys: { label: string; meta: KeyMeta }[];
}

function newNode(label: string, path: string): KeyTreeNode {
  return { label, path, count: 0, folders: new Map(), keys: [] };
}

function buildTree(keys: KeyMeta[]): KeyTreeNode {
  const root = newNode('', '');
  for (const meta of keys) {
    const parts = meta.key.split(':');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      const path = parts.slice(0, i + 1).join(':');
      let child = node.folders.get(segment);
      if (!child) {
        child = newNode(segment, path);
        node.folders.set(segment, child);
      }
      node = child;
      node.count += 1;
    }
    node.keys.push({ label: parts[parts.length - 1], meta });
  }
  return root;
}

/**
 * Depth-first flatten into the virtualized row list. Sorted, unlike flat mode:
 * a tree whose branches moved every time a page arrived would be unusable.
 */
function flattenTree(
  node: KeyTreeNode,
  depth: number,
  isOpen: (path: string, depth: number) => boolean,
  out: BrowserRow[],
): BrowserRow[] {
  const folders = [...node.folders.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const folder of folders) {
    const open = isOpen(folder.path, depth);
    out.push({ kind: 'folder', path: folder.path, label: folder.label, depth, count: folder.count, open });
    if (open) flattenTree(folder, depth + 1, isOpen, out);
  }
  const leaves = node.keys.slice().sort((a, b) => a.label.localeCompare(b.label));
  for (const leaf of leaves) out.push({ kind: 'key', label: leaf.label, depth, meta: leaf.meta });
  return out;
}

/** Cursors are opaque and can be long in cluster mode; the status line shows a stub. */
function shortCursor(cursor: ScanCursor): string {
  const nodes = cursor.nodeCursors ? Object.keys(cursor.nodeCursors).length : 0;
  if (nodes > 0) return `${nodes} nodes`;
  return cursor.cursor.length > 12 ? `${cursor.cursor.slice(0, 12)}…` : cursor.cursor;
}
